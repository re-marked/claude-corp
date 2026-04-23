/**
 * Shared state-resolution + orchestration for the wtf output, consumed
 * by both the Claude Code CLI path (cc-cli wtf) and the OpenClaw daemon
 * harness dispatch-prepend (0.7.2). Both substrates compute the same
 * three inputs — current task, predecessor handoff, inbox summary —
 * and compose the same (header + CORP.md) output. Centralizing here
 * guarantees they can't drift.
 *
 * All helpers are synchronous and degrade gracefully on failure — they
 * catch errors and return empty/safe fallbacks without throwing. The
 * consumer layers its own logging on top (stderr for the CLI, daemon
 * log for the OpenClaw harness), since the "right place to log" depends
 * on the substrate.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findChitById, queryChits } from './chits.js';
import type { Chit, HandoffFields } from './types/chit.js';
import type { Member } from './types/member.js';
import { buildCorpMd, type CorpMdKind, type CorpMdOpts } from './templates/corp-md.js';
import { getRole } from './roles.js';
import {
  buildWtfHeader,
  type WtfCurrentTask,
  type WtfInboxPeek,
  type WtfInboxSummary,
} from './templates/wtf-header.js';
import { peekLatestHandoffChit, consumeHandoffChit } from './audit/handoff-promotion.js';

// ─── State resolution (pure within each call; degrades on failure) ──

/**
 * Resolve the agent's Casket → current task. Returns undefined when:
 * - no Casket chit exists (agent never dispatched)
 * - Casket's current_step is null (agent idle)
 * - current_step chit is missing, deleted, or malformed
 *
 * Silent on error — caller decides whether to log. The wtf command
 * logs to stderr; the daemon harness logs to daemon.log.
 */
export function resolveCurrentTask(
  corpRoot: string,
  agentSlug: string,
): WtfCurrentTask | undefined {
  const casketId = `chit-cask-${agentSlug}`;
  let casket: Chit | null = null;
  try {
    const hit = findChitById(corpRoot, casketId);
    casket = hit?.chit ?? null;
  } catch {
    return undefined;
  }

  if (!casket || casket.type !== 'casket') return undefined;

  const currentStepId = (casket.fields as { casket: { currentStep: string | null } }).casket
    ?.currentStep;
  if (!currentStepId) return undefined;

  try {
    const taskHit = findChitById(corpRoot, currentStepId);
    if (!taskHit || taskHit.chit.type !== 'task') return undefined;
    const title =
      (taskHit.chit.fields as { task: { title: string } }).task?.title ?? currentStepId;
    return { chitId: currentStepId, title };
  } catch {
    return undefined;
  }
}

/**
 * Read the agent's WORKLOG.md and extract the first `<handoff>...</handoff>`
 * block. Returns undefined when WORKLOG is absent, unreadable, or
 * contains no handoff block — fresh-slot normal states, not errors.
 *
 * @deprecated Project 1.6 — the handoff chit is the canonical signal
 * now. wtf uses resolveHandoffFromChit() below. This helper stays
 * exported for legacy callers (heartbeat's pre-1.6 observability
 * paths, diagnostic tooling) until 6.1 removes the WORKLOG XML
 * emission entirely.
 */
export function readWorklogHandoff(workspacePath: string): string | undefined {
  const worklogPath = join(workspacePath, 'WORKLOG.md');
  if (!existsSync(worklogPath)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(worklogPath, 'utf-8');
  } catch {
    return undefined;
  }

  const match = raw.match(/<handoff>[\s\S]*?<\/handoff>/);
  return match ? match[0] : undefined;
}

/**
 * Read the agent's latest active handoff chit and synthesize the XML
 * payload wtf-header's handoffBlock already knows how to render. When
 * `consume` is true, the chit is closed in the same call (post-1.6
 * wtf semantics: one-shot handoff delivery per session boundary).
 * When `consume` is false, the chit stays active for a subsequent
 * session to consume (--peek inspection path, diagnostic tooling).
 *
 * Returns undefined when no active handoff exists. The XML format is
 * preserved (not replaced with structured markdown) so agents see
 * the same shape in wtf output during the 1.6 transition — the
 * storage layer moved, the prompt-layer presentation did not.
 */
function resolveHandoffFromChit(
  corpRoot: string,
  agentSlug: string,
  consume: boolean,
): string | undefined {
  const chit = consume
    ? consumeHandoffChit(corpRoot, agentSlug, agentSlug)
    : peekLatestHandoffChit(corpRoot, agentSlug);
  if (!chit) return undefined;
  return handoffChitToXml(chit);
}

function handoffChitToXml(chit: Chit<'handoff'>): string {
  const f = chit.fields.handoff as HandoffFields;
  const lines: string[] = ['<handoff>'];
  lines.push(`  <predecessor-session>${xmlEscape(f.predecessorSession)}</predecessor-session>`);
  lines.push(`  <current-step>${xmlEscape(f.currentStep)}</current-step>`);
  lines.push(`  <completed>`);
  for (const c of f.completed) lines.push(`    <item>${xmlEscape(c)}</item>`);
  lines.push(`  </completed>`);
  lines.push(`  <next-action>${xmlEscape(f.nextAction)}</next-action>`);
  if (f.openQuestion) lines.push(`  <open-question>${xmlEscape(f.openQuestion)}</open-question>`);
  if (f.sandboxState) lines.push(`  <sandbox-state>${xmlEscape(f.sandboxState)}</sandbox-state>`);
  if (f.notes) lines.push(`  <notes>${xmlEscape(f.notes)}</notes>`);
  lines.push(`  <created-at>${chit.createdAt}</created-at>`);
  lines.push(`  <created-by>${xmlEscape(chit.createdBy)}</created-by>`);
  lines.push(`</handoff>`);
  return lines.join('\n');
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Query open inbox-item chits, group by tier, compute peek items with
 * relative age labels. Degrades to empty summary on any failure.
 *
 * `now` injected so the function is deterministic under test.
 */
export function resolveInboxSummary(
  corpRoot: string,
  agentSlug: string,
  now: Date,
): WtfInboxSummary {
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
  } catch {
    return empty;
  }

  const byTier: Record<1 | 2 | 3, Array<{ chit: Chit; createdAt: string }>> = {
    1: [],
    2: [],
    3: [],
  };
  for (const entry of chits) {
    const tier = (entry.chit.fields as { 'inbox-item': { tier: 1 | 2 | 3 } })['inbox-item']?.tier;
    if (tier === 1 || tier === 2 || tier === 3) {
      byTier[tier].push(entry);
    }
  }

  const toPeek = (
    items: Array<{ chit: Chit; createdAt: string }>,
    limit: number,
  ): WtfInboxPeek[] =>
    items.slice(0, limit).map(({ chit, createdAt }) => {
      const fields = (chit.fields as { 'inbox-item': { from: string; subject: string } })[
        'inbox-item'
      ];
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

// ─── Pure helpers ──────────────────────────────────────────────────

/**
 * Format an ISO timestamp as a relative "Nunit ago" label. Caller
 * supplies `now` so the function stays testable without clock stubbing.
 * Granularity: seconds / minutes / hours / days.
 */
export function formatAge(createdAt: string, now: Date): string {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return 'unknown age';

  const deltaMs = now.getTime() - createdMs;
  if (deltaMs < 0) return 'just now';

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return seconds <= 1 ? 'just now' : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Infer Partner vs Employee from MemberRank. Rank-based fallback for
 * callers that only have a rank string in scope (e.g. the hire flow
 * before a Member record exists). Owner/master/leader → Partner;
 * worker/subagent → Employee. Unknown ranks default to Partner
 * (safer — keeps soul-file paths in play).
 *
 * Prefer `resolveKind(member)` when you have a Member — it honors the
 * explicit `Member.kind` field first and only falls back here when
 * kind is absent (pre-1.1 agents on disk).
 */
export function inferKind(rank: string): CorpMdKind {
  if (rank === 'worker' || rank === 'subagent') return 'employee';
  return 'partner';
}

/**
 * Canonical kind lookup for a Member. Introduced in Project 1.1 when
 * `Member.kind` became a structural field. Order of preference:
 *
 *   1. Explicit `member.kind` — the post-1.1 normal case.
 *   2. Rank-based inference via inferKind — the pre-1.1 compat path.
 *      Every agent that predates the split is persistent-named by
 *      profile; ranks owner/master/leader all resolve to Partner,
 *      matching real-world state.
 *
 * Use this everywhere a consumer previously called inferKind but had
 * the full Member in hand. Migration is gradual — inferKind stays for
 * the hire flow and other rank-only call sites.
 */
export function resolveKind(member: Pick<Member, 'rank' | 'kind'>): CorpMdKind {
  return member.kind ?? inferKind(member.rank);
}

// ─── Orchestrator — the main entry both consumers call ────────────

export interface WtfOutputOpts {
  /** Absolute path to the corp root. */
  corpRoot: string;
  /** Display corp name (last segment of corpRoot, or a caller override). */
  corpName: string;
  /** Agent slug (members.json id). */
  agentSlug: string;
  /** Display name — founder-given for Partners, self-chosen for Employees. */
  displayName: string;
  /** MemberRank string — used for kind inference fallback + role display when roleId is absent. */
  rank: string;
  /** Absolute workspace path for this agent (from member.agentDir). */
  workspacePath: string;
  /** ISO timestamp of invocation (caller-provided for determinism/testing). */
  generatedAt: string;
  /** Current time (caller-provided — used for inbox age labels). */
  now: Date;
  /**
   * Structural agent kind (Project 1.1). When set, takes precedence
   * over the rank-based inferKind heuristic. Callers with a Member in
   * hand should pass `resolveKind(member)` here for the honest value.
   * Legacy callers that only have a rank string keep the inferred
   * fallback.
   */
  kind?: import('./types/member.js').AgentKind;
  /**
   * Role registry id (Project 1.1). When set, CORP.md renders the
   * "Your Role" section from the registry entry. Callers with a
   * Member pass `member.role` verbatim; absent means the section
   * is skipped (graceful for pre-1.1 agents without role set).
   */
  roleId?: string;
  /**
   * Project 1.6. When true, consume the handoff chit as part of
   * building the output — flip its status to 'closed' so subsequent
   * wtf invocations don't re-inject it. When false (default-safe),
   * peek only; the handoff stays active for someone / something
   * else to consume.
   *
   * `cc-cli wtf` (agent-facing, session-boot) sets true.
   * `cc-cli wtf --peek` (founder / diagnostic) sets false.
   * Dispatch-time fragment callers that don't own consumption stay
   * false and let the SessionStart hook / CLI pipeline handle it.
   */
  consumeHandoff?: boolean;
}

export interface WtfOutput {
  /** Situational header (identity + task + inbox + optional handoff + footer). */
  header: string;
  /** Full CORP.md content (flat manual). */
  corpMd: string;
  /** Where CORP.md should be written on disk. */
  corpMdPath: string;
}

/**
 * The single orchestrator both substrates call. Reads live state,
 * composes the two pure templates, returns header + corpMd + target
 * path. No I/O beyond state reads — caller owns writing CORP.md +
 * emitting the system-reminder.
 */
export function buildWtfOutput(opts: WtfOutputOpts): WtfOutput {
  // Prefer explicit kind (post-1.1 callers with Member.kind set);
  // fall back to rank-based inference for legacy callers.
  const kind = opts.kind ?? inferKind(opts.rank);
  const corpMdPath = join(opts.workspacePath, 'CORP.md');

  const currentTask = resolveCurrentTask(opts.corpRoot, opts.agentSlug);
  // Project 1.6: handoff sourced from the `handoff` chit, not
  // WORKLOG.md's `<handoff>` XML block. Dredge fragment deletion
  // (commit 4) makes wtf the single reader; consumption semantics
  // drive by opts.consumeHandoff (default false for peek-safe calls).
  const handoffXml =
    kind === 'employee'
      ? resolveHandoffFromChit(opts.corpRoot, opts.agentSlug, opts.consumeHandoff ?? false)
      : undefined;
  const inboxSummary = resolveInboxSummary(opts.corpRoot, opts.agentSlug, opts.now);

  const corpOpts: CorpMdOpts = {
    kind,
    agentSlug: opts.agentSlug,
    displayName: opts.displayName,
    // `role` is the human-readable display label (shown in heading);
    // `roleId` is the registry key (drives the dynamic "Your Role"
    // section). When opts.roleId is set we derive a nice display
    // label from the registry; otherwise fall back to opts.rank as
    // the old pre-1.1 stand-in.
    role: opts.roleId ? (getRole(opts.roleId)?.displayName ?? opts.rank) : opts.rank,
    roleId: opts.roleId,
    corpName: opts.corpName,
    workspacePath: opts.workspacePath,
    rolePreBrainPath:
      kind === 'employee'
        ? join(opts.corpRoot, 'roles', opts.roleId ?? opts.rank, 'pre-brain')
        : undefined,
  };

  const corpMd = buildCorpMd(corpOpts);
  const header = buildWtfHeader({
    kind,
    displayName: opts.displayName,
    role: opts.rank,
    workspacePath: opts.workspacePath,
    corpMdPath,
    generatedAt: opts.generatedAt,
    currentTask,
    handoffXml,
    inboxSummary,
  });

  return { header, corpMd, corpMdPath };
}
