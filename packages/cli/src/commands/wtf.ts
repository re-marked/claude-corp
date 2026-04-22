/**
 * cc-cli wtf — the "where tf am I, what tf do I need to do" command.
 *
 * Project 0.7.1 C3b. The I/O layer that ties the two pure templates
 * (buildCorpMd + buildWtfHeader) to live corp state: member record,
 * Casket chit, predecessor WORKLOG handoff, inbox-item chits.
 *
 * Writes CORP.md to the agent's workspace (gitignored — that's handled
 * by agent-setup in 0.7.2) and prints a <system-reminder> block to
 * stdout. Claude Code's SessionStart / PreCompact hooks fire this
 * command and capture the stdout as injected context for the session.
 *
 * Failure modes are the load-bearing part (per the 0.7 spec):
 *   - Missing --agent → exit 1 with usage.
 *   - Member not found → emit visible error + exit 1.
 *   - Corrupted Casket → emit degraded context + exit 0 so hooks
 *     don't fail catastrophically.
 *   - Daemon not running → fine, wtf reads local files + chit store.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCorpMd,
  buildWtfHeader,
  queryChits,
  findChitById,
  atomicWriteSync,
  type CorpMdKind,
  type CorpMdOpts,
  type WtfInboxPeek,
  type WtfInboxSummary,
  type WtfCurrentTask,
  type Chit,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers } from '../client.js';

// ─── CLI entry ──────────────────────────────────────────────────────

export interface WtfOpts {
  agent?: string;
  corp?: string;
  hook: boolean;
  json: boolean;
}

export async function cmdWtf(opts: WtfOpts): Promise<void> {
  if (!opts.agent) {
    emitUsageError();
    process.exit(1);
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const corpName = corpRoot.split(/[/\\]/).pop() ?? 'corp';

  const members = getMembers(corpRoot);
  const member = members.find((m) => m.id === opts.agent);
  if (!member) {
    emitMemberNotFoundError(opts.agent, members.map((m) => m.id));
    process.exit(1);
  }

  if (member.type !== 'agent') {
    emitNonAgentError(opts.agent, member.type);
    process.exit(1);
  }

  if (!member.agentDir) {
    emitNoWorkspaceError(opts.agent);
    process.exit(1);
  }

  const kind = inferKind(member.rank);
  const workspacePath = member.agentDir;
  const corpMdPath = join(workspacePath, 'CORP.md');
  const generatedAt = new Date().toISOString();
  const now = new Date();

  // Load live state with per-source degradation — a single corrupted
  // chit shouldn't blind the whole wtf output. Each helper returns a
  // safe fallback on any failure and logs to stderr so operators see
  // the problem without the agent's context being poisoned.
  const currentTask = resolveCurrentTask(corpRoot, opts.agent);
  const handoffXml = kind === 'employee' ? readWorklogHandoff(workspacePath) : undefined;
  const inboxSummary = resolveInboxSummary(corpRoot, opts.agent, now);

  const corpOpts: CorpMdOpts = {
    kind,
    agentSlug: opts.agent,
    displayName: member.displayName,
    role: member.rank,
    corpName,
    workspacePath,
    rolePreBrainPath: kind === 'employee' ? resolveRolePreBrainPath(corpRoot, member.rank) : undefined,
  };

  const corpMdContent = buildCorpMd(corpOpts);
  const headerContent = buildWtfHeader({
    kind,
    displayName: member.displayName,
    role: member.rank,
    workspacePath,
    corpMdPath,
    generatedAt,
    currentTask,
    handoffXml,
    inboxSummary,
  });

  // Write CORP.md for the agent to re-read cheaply without spawning wtf again.
  try {
    atomicWriteSync(corpMdPath, corpMdContent);
  } catch (err) {
    // Non-fatal: stdout injection still works even if disk write fails.
    process.stderr.write(
      `wtf: could not write ${corpMdPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ header: headerContent, corpMd: corpMdContent, corpMdPath }, null, 2) + '\n',
    );
    return;
  }

  emitSystemReminder(headerContent, corpMdContent);
}

// ─── Output ─────────────────────────────────────────────────────────

function emitSystemReminder(header: string, corpMd: string): void {
  process.stdout.write('<system-reminder>\n');
  process.stdout.write(header);
  process.stdout.write('\n---\n\n');
  process.stdout.write(corpMd);
  process.stdout.write('</system-reminder>\n');
}

function emitUsageError(): void {
  process.stderr.write(
    [
      'Usage: cc-cli wtf --agent <slug> [--corp <name>] [--hook] [--json]',
      '',
      'Emits the agent\'s orchestration manual + situational header.',
      'Wired to SessionStart / PreCompact hooks for automatic injection.',
      '',
      '  --agent <slug>   Member id to render for (required).',
      '  --corp <name>    Explicit corp (defaults to daemon\'s corp, or only corp).',
      '  --hook           Set when invoked by a Claude Code hook (reserved; same output today).',
      '  --json           Emit {header, corpMd, corpMdPath} JSON instead of system-reminder.',
      '',
    ].join('\n'),
  );
}

function emitMemberNotFoundError(slug: string, available: readonly string[]): void {
  process.stdout.write('<system-reminder>\n');
  process.stdout.write(`cc-cli wtf: no member with id "${slug}".\n`);
  if (available.length > 0) {
    process.stdout.write('\nAvailable members:\n');
    for (const id of available.slice(0, 20)) process.stdout.write(`  ${id}\n`);
    if (available.length > 20) {
      process.stdout.write(`  ... and ${available.length - 20} more\n`);
    }
  } else {
    process.stdout.write('\nThis corp has no members yet. Run `cc-cli init` or hire an agent first.\n');
  }
  process.stdout.write('</system-reminder>\n');
}

function emitNonAgentError(slug: string, memberType: string): void {
  process.stdout.write('<system-reminder>\n');
  process.stdout.write(
    `cc-cli wtf: member "${slug}" is a ${memberType}, not an agent. wtf is for agents.\n`,
  );
  process.stdout.write('</system-reminder>\n');
}

function emitNoWorkspaceError(slug: string): void {
  process.stdout.write('<system-reminder>\n');
  process.stdout.write(
    `cc-cli wtf: agent "${slug}" has no workspace directory (agentDir is null). Re-hire or run 'cc-cli agent repair --agent ${slug}'.\n`,
  );
  process.stdout.write('</system-reminder>\n');
}

// ─── State resolution (each helper degrades gracefully) ─────────────

/**
 * Resolve the agent's Casket → current task. Returns undefined if:
 * - no Casket chit exists (agent never dispatched)
 * - Casket's current_step is null (idle)
 * - current_step chit is missing or malformed
 *
 * Degradation is silent to stdout (keeps the agent's context clean);
 * stderr gets a short diagnostic so operators can see the cause.
 */
function resolveCurrentTask(corpRoot: string, agentSlug: string): WtfCurrentTask | undefined {
  const casketId = `chit-cask-${agentSlug}`;
  let casket: Chit | null = null;
  try {
    const hit = findChitById(corpRoot, casketId);
    casket = hit?.chit ?? null;
  } catch (err) {
    process.stderr.write(`wtf: casket read failed for ${agentSlug}: ${errString(err)}\n`);
    return undefined;
  }

  if (!casket) return undefined;
  if (casket.type !== 'casket') return undefined;

  const currentStepId = (casket.fields as { casket: { currentStep: string | null } }).casket?.currentStep;
  if (!currentStepId) return undefined;

  try {
    const taskHit = findChitById(corpRoot, currentStepId);
    if (!taskHit) return undefined;
    if (taskHit.chit.type !== 'task') return undefined;
    const title = (taskHit.chit.fields as { task: { title: string } }).task?.title ?? currentStepId;
    return { chitId: currentStepId, title };
  } catch (err) {
    process.stderr.write(`wtf: current-step task read failed: ${errString(err)}\n`);
    return undefined;
  }
}

/**
 * Read the agent's WORKLOG.md and extract the first <handoff>...</handoff>
 * block. Returns undefined when WORKLOG is absent, empty, or contains no
 * handoff block — any of these is a normal fresh-slot state, not an error.
 */
function readWorklogHandoff(workspacePath: string): string | undefined {
  const worklogPath = join(workspacePath, 'WORKLOG.md');
  if (!existsSync(worklogPath)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(worklogPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`wtf: WORKLOG read failed: ${errString(err)}\n`);
    return undefined;
  }

  const match = raw.match(/<handoff>[\s\S]*?<\/handoff>/);
  return match ? match[0] : undefined;
}

/**
 * Query open inbox-item chits, group by tier, pick peek items.
 * Degrades to empty summary on any failure.
 */
function resolveInboxSummary(corpRoot: string, agentSlug: string, now: Date): WtfInboxSummary {
  const empty: WtfInboxSummary = { tier3Count: 0, tier2Count: 0, tier1Count: 0 };

  let chits: Array<{ chit: Chit; createdAt: string }>;
  try {
    const result = queryChits(corpRoot, {
      types: ['inbox-item'],
      scopes: [`agent:${agentSlug}`],
      statuses: ['active'],
      sortBy: 'createdAt',
      sortOrder: 'desc',
      limit: 0,
    });
    chits = result.chits.map(({ chit }) => ({ chit, createdAt: chit.createdAt }));
  } catch (err) {
    process.stderr.write(`wtf: inbox query failed: ${errString(err)}\n`);
    return empty;
  }

  const byTier: Record<1 | 2 | 3, Array<{ chit: Chit; createdAt: string }>> = { 1: [], 2: [], 3: [] };
  for (const entry of chits) {
    const tier = (entry.chit.fields as { 'inbox-item': { tier: 1 | 2 | 3 } })['inbox-item']?.tier;
    if (tier === 1 || tier === 2 || tier === 3) {
      byTier[tier].push(entry);
    }
  }

  const toPeek = (items: Array<{ chit: Chit; createdAt: string }>, limit: number): WtfInboxPeek[] =>
    items.slice(0, limit).map(({ chit, createdAt }) => {
      const fields = (chit.fields as { 'inbox-item': { from: string; subject: string } })['inbox-item'];
      return {
        from: fields?.from ?? 'unknown',
        subject: fields?.subject ?? '(no subject)',
        ageLabel: formatAge(createdAt, now),
      };
    });

  return {
    tier3Count: byTier[3].length,
    tier2Count: byTier[2].length,
    tier1Count: byTier[1].length,
    tier3Peek: toPeek(byTier[3], 3),
    tier2Peek: toPeek(byTier[2], 3),
  };
}

/**
 * Resolve the role-level pre-BRAIN path for an Employee. Roles
 * infrastructure isn't fully built out in Project 0 (arrives in
 * Project 1 + Project 4); for now synthesize a plausible path from
 * the rank so the CORP.md template doesn't render an empty pointer.
 */
function resolveRolePreBrainPath(corpRoot: string, rank: string): string {
  return join(corpRoot, 'roles', rank, 'pre-brain');
}

// ─── Pure helpers (unit-testable) ───────────────────────────────────

/**
 * Infer Partner vs Employee from MemberRank. Project 1.1 will add an
 * explicit \`kind\` field; until then we derive it so wtf works today.
 * Owner/master/leader → Partner; worker/subagent → Employee.
 */
export function inferKind(rank: string): CorpMdKind {
  if (rank === 'worker' || rank === 'subagent') return 'employee';
  return 'partner';
}

/**
 * Format an ISO timestamp as a relative "N{unit} ago" label. Caller
 * supplies \`now\` so the function stays testable without clock stubbing.
 * Granularity: seconds / minutes / hours / days. Older than that:
 * "Nd ago" (not weeks/months — keeps the label short).
 */
export function formatAge(createdAt: string, now: Date): string {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return 'unknown age';

  const deltaMs = now.getTime() - createdMs;
  if (deltaMs < 0) return 'just now'; // future timestamp — clock skew; don't show negative

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return seconds <= 1 ? 'just now' : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
