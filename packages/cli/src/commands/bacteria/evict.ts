/**
 * `cc-cli bacteria evict <slug> --reason "..."` — manual apoptose for
 * an idle slot the bacteria reactor isn't naturally cleaning up.
 *
 * v1 scope: idle slots only. Busy slots (currentStep != null) require
 * cc-cli fire / chit re-routing, which is out of scope here. The
 * evict path inlines the disk mutations (member removal, channel
 * strip, sandbox archive, obituary chit, apoptose event) without the
 * daemon's processManager.stopAgent — idle slots have no running
 * session to stop.
 *
 * Project 1.10.4.
 */

import {
  rmSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  appendBacteriaEvent,
  closeBreakerForSlug,
  createChit,
  formatDuration,
  getCurrentStep,
  queryChits,
  readConfig,
  writeConfig,
  CHANNELS_JSON,
  MEMBERS_JSON,
  type Channel,
  type Member,
  type TaskFields,
} from '@claudecorp/shared';
import { isDaemonRunning } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface EvictOpts {
  slug?: string;
  reason?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdBacteriaEvict(rawArgs: string[]): Promise<void> {
  const opts = parseEvictOpts(rawArgs);
  if (!opts.slug) {
    console.error('cc-cli bacteria evict: <slug> required (positional or --slug)');
    process.exit(1);
  }
  const reason = opts.reason ?? 'manual eviction';

  // Codex P1: refuse to evict while the daemon is running. The
  // disk-only mutation path doesn't update the daemon's in-memory
  // processManager.agents Map; the evicted slug stays registered
  // there and a future bacteria mitose that recycles the same
  // 2-letter suffix would short-circuit on the stale entry instead
  // of registering the new slot cleanly. Routing eviction through
  // a daemon endpoint is the right long-term fix; for v1 the
  // pragmatic stance is "stop the daemon first."
  const { running } = isDaemonRunning();
  if (running) {
    console.error(
      `cc-cli bacteria evict: daemon is running. The disk-only eviction path can't ` +
        `clear processManager state for ${opts.slug}, which would leave the slug ` +
        `registered in memory and break a future mitose that recycles the suffix. ` +
        `Stop the daemon first:\n` +
        `\n` +
        `  cc-cli stop\n` +
        `  cc-cli bacteria evict ${opts.slug}\n` +
        `  cc-cli start\n` +
        `\n` +
        `(Future versions will route eviction through a daemon endpoint so this ` +
        `restriction goes away.)`,
    );
    process.exit(1);
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  const member = members.find((m) => m.id === opts.slug);

  if (!member) {
    console.error(`cc-cli bacteria evict: member "${opts.slug}" not found`);
    process.exit(1);
  }
  if (member.type !== 'agent') {
    console.error(`cc-cli bacteria evict: "${opts.slug}" is type=${member.type}, not an agent`);
    process.exit(1);
  }
  if ((member.kind ?? 'partner') !== 'employee') {
    console.error(
      `cc-cli bacteria evict: "${opts.slug}" is kind=partner — eviction is for Employees. ` +
        `Use \`cc-cli fire\` for Partners.`,
    );
    process.exit(1);
  }
  if (member.status === 'archived') {
    console.error(`cc-cli bacteria evict: "${opts.slug}" is already archived`);
    process.exit(1);
  }

  // v1 restriction: idle slots only. Busy-slot eviction needs Casket
  // unwinding (re-route the chit, transition workflowStatus back to
  // queued) which is out of scope for the bacteria CLI.
  //
  // Fail CLOSED when the casket is unreadable or missing (Codex P2):
  // assuming "idle" on a corrupted-casket slot would orphan
  // assignment state if the slot actually had work pinned to a
  // currentStep we couldn't read. The founder should investigate
  // the substrate gap before evicting.
  let currentStep: string | null;
  try {
    const step = getCurrentStep(corpRoot, opts.slug);
    if (step === undefined) {
      console.error(
        `cc-cli bacteria evict: "${opts.slug}" has no casket chit on disk. ` +
          `That's a substrate gap — investigate via \`cc-cli wtf --agent ${opts.slug}\` ` +
          `before evicting. Refusing to evict; the missing casket might be hiding ` +
          `unresolved work.`,
      );
      process.exit(1);
    }
    currentStep = step;
  } catch (err) {
    console.error(
      `cc-cli bacteria evict: cannot read casket for "${opts.slug}" — ${(err as Error).message}. ` +
        `Refusing to evict; assuming idle on a corrupted casket could orphan assignment state.`,
    );
    process.exit(1);
  }
  if (currentStep) {
    console.error(
      `cc-cli bacteria evict: "${opts.slug}" is busy (currentStep=${currentStep}). ` +
        `v1 only supports idle slots — cancel/reroute the task first, or use \`cc-cli fire\`.`,
    );
    process.exit(1);
  }

  // Snapshot lifetime metrics BEFORE removing the Member.
  const apoptoseTs = new Date();
  const lifetimeMs = Math.max(
    0,
    apoptoseTs.getTime() - new Date(member.createdAt).getTime(),
  );
  const tasksCompleted = countCompletedTasksFor(corpRoot, member.id);
  const chosenName = member.displayName !== member.id ? member.displayName : null;

  // Obituary observation. Same shape as bacteria's executor writes.
  writeObituary(corpRoot, member, reason, apoptoseTs.toISOString());

  // Strip from channels.
  stripFromChannels(corpRoot, member.id);

  // Archive the sandbox dir.
  archiveSandbox(corpRoot, member);

  // Remove the Member record.
  const updated = members.filter((m) => m.id !== member.id);
  writeConfig(join(corpRoot, MEMBERS_JSON), updated);

  // Project 1.11: close any active crash-loop breaker. Otherwise an
  // orphan trip blocks the slug from being reused by bacteria's
  // pickFreshSlug avoid-set and clutters `cc-cli breaker list`.
  // Best-effort — eviction's success doesn't hinge on this.
  try {
    closeBreakerForSlug({
      corpRoot,
      slug: member.id,
      reason: `slot evicted via cc-cli bacteria evict: ${reason}`,
      clearedBy: 'cli:evict',
    });
  } catch {
    // swallow — chit-hygiene will surface any anomaly
  }

  // Apoptose event with manual-eviction reason.
  try {
    appendBacteriaEvent(corpRoot, {
      kind: 'apoptose',
      ts: apoptoseTs.toISOString(),
      role: member.role ?? 'unknown',
      slug: member.id,
      generation: member.generation ?? 0,
      parentSlug: member.parentSlot ?? null,
      chosenName,
      reason: `manual eviction: ${reason}`,
      idleSince: apoptoseTs.toISOString(),
      lifetimeMs,
      tasksCompleted,
    });
  } catch (err) {
    process.stderr.write(
      `[bacteria evict] event log failed (slot already removed): ${(err as Error).message}\n`,
    );
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          slug: member.id,
          chosenName,
          generation: member.generation ?? 0,
          lifetimeMs,
          tasksCompleted,
          reason,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Evicted ${chosenName ?? member.id} (${member.id}).`);
  console.log(`  generation: ${member.generation ?? 0}`);
  console.log(`  lived:      ${formatDuration(lifetimeMs)}`);
  console.log(`  tasks:      ${tasksCompleted}`);
  console.log(`  reason:     ${reason}`);
}

// ─── Helpers (mirror bacteria/executor.ts; shared with that module
//     would be cleaner but the duplication is ~30 lines and the v1
//     refactor cost wasn't justified) ─────────────────────────────

function countCompletedTasksFor(corpRoot: string, slug: string): number {
  try {
    const result = queryChits<'task'>(corpRoot, { types: ['task'], limit: 0 });
    let count = 0;
    for (const cwb of result.chits) {
      const fields = cwb.chit.fields.task as TaskFields;
      if (fields.assignee !== slug) continue;
      if (fields.workflowStatus !== 'completed') continue;
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function writeObituary(
  corpRoot: string,
  member: Member,
  reason: string,
  apoptoseTs: string,
): void {
  const generation = member.generation ?? 0;
  const parentLine = member.parentSlot
    ? `parent: ${member.parentSlot}`
    : 'parent: none (first of lineage)';
  const body =
    `Slot lifetime record (manual eviction).\n\n` +
    `- born:        ${member.createdAt}\n` +
    `- evicted:     ${apoptoseTs}\n` +
    `- ${parentLine}\n` +
    `- generation:  ${generation}\n` +
    `- role:        ${member.role ?? 'unknown'}\n` +
    `- reason:      ${reason}\n`;

  try {
    createChit(corpRoot, {
      type: 'observation',
      scope: 'corp',
      createdBy: 'founder',
      fields: {
        observation: {
          category: 'NOTICE',
          subject: member.id,
          importance: 1,
          title: `${member.id}: evicted (${reason}, gen ${generation})`,
        },
      },
      body,
    });
  } catch (err) {
    process.stderr.write(
      `[bacteria evict] obituary write failed (eviction continuing): ${(err as Error).message}\n`,
    );
  }
}

function stripFromChannels(corpRoot: string, slug: string): void {
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
    process.stderr.write(
      `[bacteria evict] stripFromChannels failed for ${slug}: ${(err as Error).message}\n`,
    );
  }
}

function archiveSandbox(corpRoot: string, member: Member): void {
  if (!member.agentDir) return;
  const abs = isAbsolute(member.agentDir) ? member.agentDir : join(corpRoot, member.agentDir);
  if (!existsSync(abs)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parent = dirname(abs);
  const archiveName = `.archived-${member.id}-${stamp}`;
  try {
    renameSync(abs, join(parent, archiveName));
  } catch {
    try {
      rmSync(abs, { recursive: true, force: true });
    } catch (err2) {
      process.stderr.write(
        `[bacteria evict] could not archive or remove sandbox: ${(err2 as Error).message}\n`,
      );
    }
  }
}

function parseEvictOpts(rawArgs: string[]): EvictOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      slug: { type: 'string' },
      reason: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  const positional = parsed.positionals[0];
  return {
    slug: (parsed.values.slug as string | undefined) ?? positional,
    reason: parsed.values.reason as string | undefined,
    corp: parsed.values.corp as string | undefined,
    json: !!parsed.values.json,
  };
}
