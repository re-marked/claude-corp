/**
 * cc-cli hand — durable chit forwarding on the Casket substrate.
 *
 * Project 1.4, full rewrite. Hand is the mechanism the founder + CEO +
 * Partners use to give work to a target; post-1.4, it's a Casket-pointer
 * write routed through an optional role-resolver, not a chat @mention
 * with channel dispatch. The old daemon-round-trip path via
 * `/tasks/:id/hand` is retained one version for back-compat but is no
 * longer invoked by this CLI — this command writes chits directly per
 * CLAUDE.md's file-first principle (daemon only owns process management).
 *
 * ### Target modes
 *
 *   Slot:   `--to toast`              → named Employee or Partner.
 *   Role:   `--to backend-engineer`   → role-resolver picks an Employee.
 *                                        Partner-by-role targets error with
 *                                        "address by name" + candidate list.
 *
 * ### What hand does, in order
 *
 *   1. Resolve target (slot direct, role via resolveRoleToEmployee).
 *   2. Validate chit exists + is non-terminal + is hand-eligible state.
 *   3. Write target's Casket.currentStep = chitId (via advanceCurrentStep).
 *   4. Transition chit workflowStatus via state machine:
 *        - `draft`      → assign   → `queued`
 *        - `queued`     → dispatch → `dispatched`
 *        - `dispatched` → (no-op — already delivered; idempotent re-hand)
 *        - other        → reject (can't re-hand in-progress/blocked/
 *                                 under-review/terminal tasks)
 *      Two-step (draft → queued → dispatched) happens in one call —
 *      the caller thinks of hand as "deliver," not "two-phase enqueue."
 *   5. Stamp fields.task.assignee + handedBy + handedAt on task chits.
 *   6. Fire Tier 2 inbox-item on target's inbox (unless --no-announce).
 *      Inbox-item is the "you have work" signal; Casket is the work itself.
 *
 * ### What hand doesn't do
 *
 *   - No chat channel broadcast. The pre-1.4 #tasks event message path
 *     is skipped. Founder wanting corp-wide visibility can consume the
 *     audit log or inbox events directly.
 *   - No daemon heartbeat refresh. Heartbeat ticks pick up Casket
 *     changes on their next cycle (a few seconds). Not load-bearing.
 *   - No autoemon wake. Future 1.9/1.10 work.
 */

import { parseArgs } from 'node:util';
import { isAbsolute, join } from 'node:path';
import {
  type Chit,
  type Member,
  advanceCurrentStep,
  findChitById,
  updateChit,
  chitScopeFromPath,
  resolveRoleToEmployee,
  validateTransition,
  TaskTransitionError,
  createInboxItem,
  getRole,
  type TaskFields,
  type TaskWorkflowStatus,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers, getFounder } from '../client.js';

export interface HandOpts {
  to?: string;
  chit?: string;
  reason?: string;
  from?: string;
  noAnnounce?: boolean;
  corp?: string;
  json?: boolean;
}

export async function cmdHand(rawArgs: string[]): Promise<void>;
export async function cmdHand(opts: HandOpts): Promise<void>;
export async function cmdHand(input: string[] | HandOpts): Promise<void> {
  const opts = Array.isArray(input) ? parseOpts(input) : input;

  if (!opts.to) fail('--to <slug-or-role> required');
  if (!opts.chit) fail('--chit <chit-id> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const members = safeGetMembers(corpRoot);
  const founder = getFounder(corpRoot);
  const handerId = opts.from ?? founder.id;

  // 1. Resolve target.
  const resolution = resolveTarget(corpRoot, members, opts.to);
  if (resolution.kind === 'error') fail(resolution.message);
  const target = resolution.target;
  const targetMode = resolution.mode;

  // 2. Validate chit + state-machine eligibility.
  const hit = findChitById(corpRoot, opts.chit);
  if (!hit) fail(`chit "${opts.chit}" not found`);
  const chit = hit.chit;

  // Hand eligibility: only task / contract / escalation are eligible
  // work-chits for routing. Handing a Casket or observation is
  // nonsense — reject at the boundary with an actionable message.
  if (!isHandableType(chit.type)) {
    fail(
      `cannot hand a chit of type "${chit.type}" — hand is for work chits ` +
        `(task, contract, escalation). Got ${opts.chit}.`,
    );
  }

  // 3. Write Casket.currentStep on target BEFORE transitioning the
  // chit's workflow state, so an intermediate failure at the task
  // transition leaves the Casket pointing at a real (if not-yet-
  // dispatched) chit rather than the wrong id.
  try {
    advanceCurrentStep(corpRoot, target.id, opts.chit, handerId);
  } catch (err) {
    fail(`casket advance failed: ${(err as Error).message}`);
  }

  // 4. + 5. Transition workflowStatus (task chits only) + stamp
  // assignee / handedBy / handedAt.
  let finalState: TaskWorkflowStatus | null = null;
  if (chit.type === 'task') {
    finalState = handTaskChit(corpRoot, hit, target.id, handerId);
  }

  // 6. Announcement. Tier 2 inbox-item — "you have new work." Fire-
  // and-log: failure here doesn't undo the hand, it's observability.
  let announced = false;
  if (!opts.noAnnounce) {
    try {
      createInboxItem({
        corpRoot,
        recipient: target.id,
        tier: 2,
        from: handerId,
        subject: renderAnnounceSubject(chit, opts.reason),
        source: 'hand',
        sourceRef: opts.chit,
      });
      announced = true;
    } catch {
      // Inbox failure is non-fatal — the Casket write IS delivery.
    }
  }

  // Output.
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          chit: opts.chit,
          target: target.id,
          targetDisplayName: target.displayName,
          targetMode,
          finalWorkflowStatus: finalState,
          announced,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `handed ${opts.chit} → ${target.displayName} (${target.id})` +
        (targetMode === 'role' ? ` [role: ${opts.to}]` : ''),
    );
    if (finalState) console.log(`  workflowStatus: ${finalState}`);
    if (announced) console.log(`  announced: Tier 2 inbox-item`);
    if (opts.reason) console.log(`  reason: ${opts.reason}`);
  }
}

// ─── Target resolution ──────────────────────────────────────────────

type TargetResolution =
  | { kind: 'resolved'; target: Member; mode: 'slot' | 'role' }
  | { kind: 'error'; message: string };

function resolveTarget(
  corpRoot: string,
  members: Member[],
  to: string,
): TargetResolution {
  // Slot mode: exact id match on an active agent Member.
  const slotTarget = members.find(
    (m) => m.type === 'agent' && m.status === 'active' && m.id === to,
  );
  if (slotTarget) {
    return { kind: 'resolved', target: slotTarget, mode: 'slot' };
  }

  // Role mode: is `to` a registered role id? If yes, resolve via pool.
  if (getRole(to)) {
    const pick = resolveRoleToEmployee(corpRoot, to);
    switch (pick.kind) {
      case 'resolved': {
        const member = members.find((m) => m.id === pick.slug);
        if (!member) {
          return {
            kind: 'error',
            message: `role resolver returned "${pick.slug}" but members.json doesn't have that slug (stale index?)`,
          };
        }
        return { kind: 'resolved', target: member, mode: 'role' };
      }
      case 'role-is-partner-only': {
        const list = pick.partnerCandidates.length
          ? pick.partnerCandidates.map((p) => p.slug).join(', ')
          : '<none hired>';
        return {
          kind: 'error',
          message:
            `role "${to}" is a Partner role — Partners are slot targets, ` +
            `not pool-resolvable. Address by name. Candidates: ${list}.`,
        };
      }
      case 'no-candidates':
        return {
          kind: 'error',
          message:
            `no Employees of role "${to}" exist yet. Hire one with ` +
            `\`cc-cli hire --role ${to} --kind employee\` or wait for bacteria (Project 1.9).`,
        };
      case 'unknown-role':
        // Can't happen — we gated on getRole above. Belt + suspenders.
        return { kind: 'error', message: `unknown role "${to}"` };
    }
  }

  // Not a known slot and not a known role.
  return {
    kind: 'error',
    message:
      `no agent or role matches "${to}". Use the member id (e.g. \`ceo\`, \`toast\`) ` +
      `or a registered role id (e.g. \`backend-engineer\`).`,
  };
}

// ─── Task-chit transition + assignee stamp ──────────────────────────

function handTaskChit(
  corpRoot: string,
  hit: { chit: Chit; path: string },
  assigneeId: string,
  handerId: string,
): TaskWorkflowStatus {
  const fields = hit.chit.fields as { task: TaskFields };
  const currentWs = fields.task.workflowStatus ?? 'draft';
  const now = new Date().toISOString();

  // Hand is idempotent at `dispatched`. A second hand to the same
  // Casket re-stamps handedBy / handedAt (audit trail of re-handing)
  // but workflowStatus stays put.
  if (currentWs === 'dispatched') {
    writeTaskFieldUpdate(corpRoot, hit, {
      assignee: assigneeId,
      handedBy: handerId,
      handedAt: now,
    });
    return 'dispatched';
  }

  // Two-phase for `draft`: assign → queued, then dispatch → dispatched.
  // One call from the caller's perspective; two validated transitions.
  let nextWs: TaskWorkflowStatus = currentWs;
  try {
    if (nextWs === 'draft') {
      nextWs = validateTransition(nextWs, 'assign', hit.chit.id);
    }
    if (nextWs === 'queued') {
      nextWs = validateTransition(nextWs, 'dispatch', hit.chit.id);
    }
  } catch (err) {
    if (err instanceof TaskTransitionError) {
      fail(
        `task ${hit.chit.id} is in state "${currentWs}" and cannot be handed. ` +
          `${err.message}`,
      );
    }
    throw err;
  }

  if (nextWs === currentWs) {
    // Unreachable given the switch above, but type-level belt-and-suspenders.
    return currentWs;
  }

  writeTaskFieldUpdate(corpRoot, hit, {
    workflowStatus: nextWs,
    assignee: assigneeId,
    handedBy: handerId,
    handedAt: now,
  });
  return nextWs;
}

function writeTaskFieldUpdate(
  corpRoot: string,
  hit: { chit: Chit; path: string },
  partial: Partial<TaskFields>,
): void {
  const scope = chitScopeFromPath(corpRoot, hit.path);
  updateChit(corpRoot, scope, 'task', hit.chit.id, {
    fields: { task: partial } as never,
    updatedBy: (partial.handedBy as string) ?? 'system',
  });
}

// ─── Helpers ────────────────────────────────────────────────────────

function isHandableType(type: string): boolean {
  return type === 'task' || type === 'contract' || type === 'escalation';
}

function renderAnnounceSubject(chit: Chit, reason?: string): string {
  const title =
    chit.type === 'task'
      ? (chit.fields as { task: TaskFields }).task.title
      : chit.id;
  return reason ? `${title} — handed (${reason})` : `${title} — handed to you`;
}

function safeGetMembers(corpRoot: string): Member[] {
  try {
    return getMembers(corpRoot);
  } catch {
    return [];
  }
}

function parseOpts(rawArgs: string[]): HandOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      to: { type: 'string' },
      chit: { type: 'string' },
      // Back-compat: --task was the legacy flag name; alias it to --chit
      // so existing scripts don't break on the name change. Agents should
      // migrate to --chit in new writing.
      task: { type: 'string' },
      reason: { type: 'string' },
      from: { type: 'string' },
      'no-announce': { type: 'boolean', default: false },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;
  return {
    to: (v.to as string | undefined) ?? undefined,
    chit: (v.chit as string | undefined) ?? (v.task as string | undefined),
    reason: v.reason as string | undefined,
    from: v.from as string | undefined,
    noAnnounce: v['no-announce'] === true,
    corp: v.corp as string | undefined,
    json: v.json === true,
  };
}

function fail(msg: string): never {
  console.error(`cc-cli hand: ${msg}`);
  process.exit(1);
}
