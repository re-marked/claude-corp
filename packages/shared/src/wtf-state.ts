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
import type { Chit } from './types/chit.js';
import type { Member } from './types/member.js';
import { buildCorpMd, type CorpMdKind, type CorpMdOpts } from './templates/corp-md.js';
import {
  buildWtfHeader,
  type WtfCurrentTask,
  type WtfInboxPeek,
  type WtfInboxSummary,
} from './templates/wtf-header.js';

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
  /** MemberRank string — used for kind inference + role display. */
  rank: string;
  /** Absolute workspace path for this agent (from member.agentDir). */
  workspacePath: string;
  /** ISO timestamp of invocation (caller-provided for determinism/testing). */
  generatedAt: string;
  /** Current time (caller-provided — used for inbox age labels). */
  now: Date;
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
  const kind = inferKind(opts.rank);
  const corpMdPath = join(opts.workspacePath, 'CORP.md');

  const currentTask = resolveCurrentTask(opts.corpRoot, opts.agentSlug);
  const handoffXml = kind === 'employee' ? readWorklogHandoff(opts.workspacePath) : undefined;
  const inboxSummary = resolveInboxSummary(opts.corpRoot, opts.agentSlug, opts.now);

  const corpOpts: CorpMdOpts = {
    kind,
    agentSlug: opts.agentSlug,
    displayName: opts.displayName,
    role: opts.rank,
    corpName: opts.corpName,
    workspacePath: opts.workspacePath,
    rolePreBrainPath:
      kind === 'employee' ? join(opts.corpRoot, 'roles', opts.rank, 'pre-brain') : undefined,
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
