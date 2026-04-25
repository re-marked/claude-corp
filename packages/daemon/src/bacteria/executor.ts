/**
 * Bacteria — executor module.
 *
 * Applies the side effects of `BacteriaAction[]` returned by the
 * decision module:
 *
 *   Mitose    — generate a unique slug, build the Employee workspace
 *               via setupAgentWorkspace, add the Member record,
 *               create the casket, claim the assigned chit (assignee
 *               rewrite + workflow → 'dispatched'), call
 *               processManager.spawnAgent.
 *
 *   Apoptose  — read the slot's Member for obituary fields, stop any
 *               running session, write the obituary observation chit,
 *               strip the slug from channel memberIds, archive the
 *               sandbox dir, remove the Member from members.json.
 *
 * Failures are logged and skipped per-action — one bad mitose
 * shouldn't abort apoptoses queued in the same batch. The next
 * decision tick will re-evaluate and retry whatever didn't land.
 *
 * Concurrency: the reactor serializes executor calls behind a single
 * mutex per daemon instance, so this module can read-then-write
 * members.json without optimistic-concurrency boilerplate. If we ever
 * shard bacteria across processes, that contract changes — but until
 * then, "single in-flight executor call at a time" is enough.
 */

import { rmSync, renameSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  readConfig,
  writeConfig,
  setupAgentWorkspace,
  addMemberToRegistry,
  addChannelToRegistry,
  addMemberToChannel,
  createDmChannel,
  advanceCurrentStep,
  createChit,
  updateChit,
  findChitById,
  chitScopeFromPath,
  getTheme,
  UNIVERSAL_SOUL,
  defaultRules,
  defaultHeartbeat,
  MEMBERS_JSON,
  CHANNELS_JSON,
  CORP_JSON,
  type Member,
  type Channel,
  type GlobalConfig,
  type Corporation,
  type ThemeId,
  type TaskFields,
} from '@claudecorp/shared';
import type { ProcessManager } from '../process-manager.js';
import { log, logError } from '../logger.js';
import type {
  BacteriaAction,
  MitoseAction,
  ApoptoseAction,
} from './types.js';

export interface ExecutorContext {
  readonly corpRoot: string;
  readonly globalConfig: GlobalConfig;
  readonly processManager: ProcessManager;
}

/**
 * Apply a list of actions in order. Each action is awaited; failures
 * are logged + skipped so a single broken slot doesn't poison the
 * batch. Returns a count of {applied, failed} for reactor-level
 * observability.
 */
export async function executeBacteriaActions(
  ctx: ExecutorContext,
  actions: readonly BacteriaAction[],
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (const action of actions) {
    try {
      if (action.kind === 'mitose') {
        await executeMitose(ctx, action);
      } else {
        await executeApoptose(ctx, action);
      }
      applied++;
    } catch (err) {
      failed++;
      logError(`[bacteria] ${action.kind} failed: ${(err as Error).message}`);
    }
  }
  return { applied, failed };
}

// ─── Mitose ─────────────────────────────────────────────────────────

async function executeMitose(
  ctx: ExecutorContext,
  action: MitoseAction,
): Promise<void> {
  const { corpRoot, globalConfig, processManager } = ctx;

  const slug = pickFreshSlug(corpRoot, action.role);
  const corpHarness = readCorpHarness(corpRoot);

  // Build the Employee workspace. setupAgentWorkspace writes the
  // sandbox directory + workspace files (AGENTS.md / TOOLS.md /
  // HEARTBEAT.md / STATUS.md / TASKS.md), creates an empty Casket,
  // and constructs the Member record. Employees skip soul files
  // (SOUL/MEMORY/IDENTITY/USER) per 1.1's kind-aware routing.
  //
  // displayName starts as the slug — the "needs naming" signal that
  // PR 3's first-dispatch fragment keys off (`displayName === id`).
  // Once the agent runs `cc-cli whoami rename Toast`, the equality
  // breaks and the prompt fragment stops firing.
  const setup = setupAgentWorkspace({
    corpRoot,
    agentName: slug,
    displayName: slug,
    rank: 'worker',
    scope: 'corp',
    scopeId: '',
    spawnedBy: action.parentSlug ?? 'bacteria',
    model: globalConfig.defaults.model,
    provider: globalConfig.defaults.provider,
    soulContent: UNIVERSAL_SOUL,
    agentsContent: defaultRules({
      rank: 'worker',
      harness: corpHarness === 'claude-code' ? 'claude-code' : 'openclaw',
    }),
    heartbeatContent: defaultHeartbeat('worker'),
    globalConfig,
    harness: corpHarness,
    kind: 'employee',
    role: action.role,
  });

  // Apply bacteria-specific fields the standard hire path doesn't
  // populate. setupAgentWorkspace builds a Member but doesn't carry
  // the lineage edge — write it in before we register.
  const member: Member = {
    ...setup.member,
    parentSlot: action.parentSlug,
    generation: action.generation,
  };
  addMemberToRegistry(corpRoot, member);

  // Channel registration. Without this, dispatchTaskToDm has no DM
  // channel to deliver the wakeup message into and the new slot
  // sits busy-but-never-woken. Mirror hire.ts's flow: founder DM +
  // pool channels (#general, #tasks, #logs themed). The founder DM
  // is the dispatch path's hard requirement; the pool channels are
  // for visibility (Sexton + founder can see the new slot in
  // membership lists).
  registerSlotChannels(corpRoot, member);

  // Casket already exists (setupAgentWorkspace created it idle).
  // Claim the assigned chit: advance casket pointer + rewrite the
  // chit's assignee from role-id to slot-id + bump workflowStatus
  // to 'dispatched' so the next decision tick correctly excludes it
  // from the "unprocessed" queue (assignee != role.id) AND treats
  // the slot as busy (currentStep != null).
  advanceCurrentStep(corpRoot, slug, action.assignedChit, slug);
  claimAssignedChit(corpRoot, action.assignedChit, slug);

  log(
    `[bacteria] mitose: ${slug} (role=${action.role}, gen=${action.generation}, parent=${action.parentSlug ?? 'none'}, chit=${action.assignedChit})`,
  );

  // Spawn the session. processManager.spawnAgent reads the now-
  // committed Member record. Errors propagate so executor's outer
  // try/catch can log them.
  await processManager.spawnAgent(slug);
}

// ─── Apoptose ───────────────────────────────────────────────────────

async function executeApoptose(
  ctx: ExecutorContext,
  action: ApoptoseAction,
): Promise<void> {
  const { corpRoot, processManager } = ctx;

  // Snapshot Member state BEFORE we mutate anything — obituary needs
  // it.
  const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  const member = members.find((m) => m.id === action.slug);
  if (!member) {
    // Already gone — earlier action removed it, or external mutation.
    // Not a failure; idempotent no-op.
    return;
  }

  // Stop any running session first. Best-effort — a stopAgent failure
  // shouldn't block the rest of the apoptosis.
  try {
    await processManager.stopAgent(action.slug);
  } catch (err) {
    logError(
      `[bacteria] stopAgent failed during apoptosis of ${action.slug}: ${(err as Error).message}`,
    );
  }

  // Write the obituary observation chit BEFORE removing the Member —
  // if creation fails, the Member stays alive and next tick retries.
  // Apoptose-then-fail-to-write would orphan the lineage record.
  writeObituary(corpRoot, member, action);

  // Strip slug from any channel memberIds so dispatch doesn't try
  // routing to a dead slot.
  stripFromChannels(corpRoot, action.slug);

  // Archive the sandbox dir. Apoptosis is graceful death — artifacts
  // (worklogs, partial drafts, Dredge handoffs) might inform later
  // pattern detection (Project 4 conjugation) or just debugging.
  // Archive matches `cc-cli fire`'s "fire" mode, not "remove".
  archiveSandbox(corpRoot, member);

  // Finally remove the Member record. Name returns to the pool by
  // virtue of no-longer-existing in members.json.
  const updated = members.filter((m) => m.id !== action.slug);
  writeConfig(join(corpRoot, MEMBERS_JSON), updated);

  log(
    `[bacteria] apoptose: ${action.slug} (${action.reason}, idle since ${action.idleSince}, gen ${member.generation ?? 0})`,
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Generate a fresh `<role>-<2 lowercase letters>` slug that doesn't
 * collide with any current Member id. 676 combinations per role; with
 * recycling on apoptosis, only the active pool size matters for
 * collision probability. Retries up to 100 times before falling back
 * to a longer suffix — at which point the corp has > 200 active slots
 * of the same role and we're well outside v1's design space anyway.
 */
function pickFreshSlug(corpRoot: string, role: string): string {
  const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  const taken = new Set(members.map((m) => m.id));
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = randomTwoLetters();
    const slug = `${role}-${suffix}`;
    if (!taken.has(slug)) return slug;
  }
  // Fallback: 4-letter suffix. Vanishingly unlikely to land here.
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = randomTwoLetters() + randomTwoLetters();
    const slug = `${role}-${suffix}`;
    if (!taken.has(slug)) return slug;
  }
  throw new Error(
    `bacteria: could not allocate unique slug for role '${role}' after 200 attempts — pool is improbably large`,
  );
}

function randomTwoLetters(): string {
  const a = 97; // 'a'
  const c1 = String.fromCharCode(a + Math.floor(Math.random() * 26));
  const c2 = String.fromCharCode(a + Math.floor(Math.random() * 26));
  return c1 + c2;
}

function readCorpHarness(corpRoot: string): string | undefined {
  try {
    return readConfig<Corporation>(join(corpRoot, CORP_JSON)).harness;
  } catch {
    return undefined;
  }
}

/**
 * Register the new slot in the founder DM (required — `dispatchTaskToDm`
 * looks up a direct channel containing the assignee and bails when none
 * exists; without this the spawned slot is busy-but-never-woken) plus
 * the corp-themed pool channels (#general / #tasks / #logs).
 *
 * Mirrors hire.ts's channel flow. Founder is required for the DM —
 * Employees never get founder-direct interaction in normal corp
 * operation (Model A: founder DMs Partners, Partners DM Employees),
 * but the channel needs to EXIST for the dispatch wakeup path. Quiet
 * channel; founder doesn't have to use it.
 */
function registerSlotChannels(corpRoot: string, member: Member): void {
  let members: Member[];
  try {
    members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  } catch {
    return;
  }
  const founder = members.find((m) => m.rank === 'owner');
  if (founder) {
    try {
      const dm = createDmChannel(
        corpRoot,
        founder.id,
        member.id,
        founder.displayName.toLowerCase(),
        member.id,
      );
      addChannelToRegistry(corpRoot, dm);
    } catch (err) {
      logError(
        `[bacteria] failed to create founder DM for ${member.id}: ${(err as Error).message}`,
      );
    }
  }

  // Pool channels — best-effort. Missing #general/#tasks/#logs would
  // be unusual but isn't worth aborting the spawn over.
  try {
    const channels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));
    const corp = readConfig<Corporation>(join(corpRoot, CORP_JSON));
    const theme = getTheme((corp.theme || 'corporate') as ThemeId);
    const general = channels.find((c) => c.name === theme.channels.general);
    if (general) addMemberToChannel(corpRoot, general.id, member.id);
    const tasksChannel = channels.find((c) => c.name === theme.channels.tasks);
    if (tasksChannel) addMemberToChannel(corpRoot, tasksChannel.id, member.id);
    const logsChannel = channels.find((c) => c.name === theme.channels.logs);
    if (logsChannel) addMemberToChannel(corpRoot, logsChannel.id, member.id);
  } catch (err) {
    logError(
      `[bacteria] failed to register pool channels for ${member.id}: ${(err as Error).message}`,
    );
  }
}

/**
 * Rewrite the assigned chit's assignee field from `role.id` to the
 * spawned slot's id, and bump workflowStatus to 'dispatched' so the
 * next bacteria decision tick correctly excludes the chit from
 * unprocessed-queue counting.
 */
function claimAssignedChit(
  corpRoot: string,
  chitId: string,
  slug: string,
): void {
  const hit = findChitById(corpRoot, chitId);
  if (!hit) {
    // Chit went missing between the decision and execution — log and
    // proceed. The slot is still spawned; it'll go idle on first
    // dispatch and the role-resolver will land another chit on it.
    logError(`[bacteria] mitose: assigned chit ${chitId} not found at execute time`);
    return;
  }
  if (hit.chit.type !== 'task') {
    logError(`[bacteria] mitose: assigned chit ${chitId} is not a task (${hit.chit.type})`);
    return;
  }
  const fields = hit.chit.fields.task as TaskFields;
  const scope = chitScopeFromPath(corpRoot, hit.path);
  updateChit(corpRoot, scope, 'task', chitId, {
    updatedBy: 'bacteria',
    fields: {
      task: {
        ...fields,
        assignee: slug,
        workflowStatus: 'dispatched',
      },
    },
  });
}

function stripFromChannels(corpRoot: string, slug: string): void {
  // Wrapped: a corrupted channels.json or transient fs error here
  // shouldn't abort apoptose AFTER the obituary was written. The
  // worst case from a swallow is a stale memberId entry — a future
  // chit-hygiene sweeper pass cleans it up.
  try {
    const path = join(corpRoot, CHANNELS_JSON);
    if (!existsSync(path)) return;
    const channels = readConfig<Channel[]>(path);
    let touched = false;
    for (const ch of channels) {
      const idx = ch.memberIds.indexOf(slug);
      if (idx >= 0) {
        ch.memberIds.splice(idx, 1);
        touched = true;
      }
    }
    if (touched) writeConfig(path, channels);
  } catch (err) {
    logError(
      `[bacteria] stripFromChannels failed for ${slug} (apoptose continuing): ${(err as Error).message}`,
    );
  }
}

function archiveSandbox(corpRoot: string, member: Member): void {
  if (!member.agentDir) return;
  const abs = isAbsolute(member.agentDir)
    ? member.agentDir
    : join(corpRoot, member.agentDir);
  if (!existsSync(abs)) return;
  // Full ISO timestamp (with `:` and `.` replaced — invalid on Windows
  // paths) so a recycled-then-re-apoptosed slug on the same day doesn't
  // collide with its prior archive. Without uniqueness the rename
  // fails, and the catch-block falls through to rmSync of the LIVE
  // workspace — silently dropping the new lifecycle's artifacts.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parent = abs.replace(/[\\/][^\\/]+[\\/]?$/, '');
  const archiveName = `.archived-${member.id}-${stamp}`;
  try {
    renameSync(abs, join(parent, archiveName));
  } catch (err) {
    // Fall back to delete if rename fails (Windows quirks, in-use
    // file handles, etc.). Apoptosis must not leave a Member-removed
    // / sandbox-still-present split that confuses the next tick.
    try {
      rmSync(abs, { recursive: true, force: true });
    } catch (err2) {
      logError(
        `[bacteria] could not archive or remove sandbox ${abs}: ${(err2 as Error).message}`,
      );
    }
  }
}

/**
 * Write the obituary observation chit. NOTICE category, low importance
 * (1) — these are mechanical lifetime records, not interventions.
 * Subject = the slug so dreams (Project 4) can compound observations
 * by slot lifetime. Title carries the headline for `cc-cli observe
 * list`-style scans; body carries the full record.
 */
function writeObituary(
  corpRoot: string,
  member: Member,
  action: ApoptoseAction,
): void {
  const generation = member.generation ?? 0;
  const parentLine = member.parentSlot
    ? `parent: ${member.parentSlot}`
    : 'parent: none (first of lineage)';

  const body =
    `Slot lifetime record.\n\n` +
    `- born:        ${member.createdAt}\n` +
    `- apoptosed:   ${new Date().toISOString()}\n` +
    `- idle since:  ${action.idleSince}\n` +
    `- ${parentLine}\n` +
    `- generation:  ${generation}\n` +
    `- role:        ${member.role ?? 'unknown'}\n` +
    `- reason:      ${action.reason}\n`;

  createChit(corpRoot, {
    type: 'observation',
    scope: 'corp',
    createdBy: 'bacteria',
    fields: {
      observation: {
        category: 'NOTICE',
        subject: member.id,
        importance: 1,
        title: `${member.id}: apoptosed (${action.reason}, gen ${generation})`,
      },
    },
    body,
  });
}
