/**
 * Alarum state primitives — pure functions that read corp state into a
 * structured summary Alarum's prompt composer consumes.
 *
 * ### Scope
 *
 * These primitives answer the *baseline* questions Alarum needs to
 * reason before deciding. They do NOT attempt to answer "what should
 * Alarum do?" — that's her job. They answer:
 *
 *   - Is Sexton's session alive? (yes/no)
 *   - When did Sexton last hand off? (timestamp or never)
 *   - How many agents are in each work state? (rough activity gauge)
 *   - How many observations have landed since Sexton's last exit? (delta)
 *
 * Alarum receives these as context in her user prompt + has Bash tool
 * access to dig deeper via `cc-cli` if her decision needs more. The
 * prompt pre-bakes the things she'd always want, not everything she
 * might need.
 *
 * ### Why pre-summarize at all
 *
 * Alarum runs Haiku with a short turn budget. Every tool-call round-
 * trip costs latency + tokens. Facts she *always* wants (is Sexton
 * alive? when did she last hand off?) should arrive in the prompt so
 * her first-turn decision doesn't need a Bash call just to get
 * started. Facts that are conditionally relevant (which specific
 * agent is stuck? what tools did they last call?) she fetches herself
 * when the decision-tree branches toward them.
 *
 * ### Fail-soft by convention
 *
 * Every primitive returns a sane default when the underlying query
 * fails (null for optional data, 0 for counts, `{ idle: 0, busy: 0, ... }`
 * for tallies). Alarum's prompt can always be composed — a corrupt
 * chit store should not break the continuity chain.
 */

import type { Daemon } from '../daemon.js';
import { readConfig, peekLatestHandoffChit, queryChits, type Member, MEMBERS_JSON } from '@claudecorp/shared';
import { join } from 'node:path';

// ─── Primitive 1: Sexton session liveness ───────────────────────────

/**
 * Is Sexton's process currently running?
 *
 * Returns true when she's registered in the process manager AND her
 * status is 'ready' (spawned, not starting/stopped/crashed). False
 * when she's never been hired (fresh corp pre-1.9.2 boot), has been
 * hired but isn't running, or has crashed.
 *
 * Implementation: look up her member record by displayName='Sexton'
 * (stable identifier under 1.9.2) then ask the process manager for
 * her state. If the lookup or status check throws, treat as not-alive
 * (conservative — Alarum should default to "maybe she needs a start"
 * when unsure, not assume she's fine).
 */
export function sextonSessionAlive(daemon: Daemon): boolean {
  try {
    const members = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
    // Filter archived — a fired Sexton shouldn't register as "dead
    // and needing a start." dispatchSexton applies the same filter;
    // keeping them consistent means Alarum's decision and the
    // downstream dispatch agree on whether a Sexton exists to wake.
    const sexton = members.find(
      (m) => m.displayName === 'Sexton' && m.type === 'agent' && m.status !== 'archived',
    );
    if (!sexton) return false;

    const proc = daemon.processManager.getAgent(sexton.id);
    if (!proc) return false;

    return proc.status === 'ready';
  } catch {
    return false;
  }
}

// ─── Primitive 2: Sexton's last handoff ─────────────────────────────

/**
 * Summary of Sexton's most recent handoff chit.
 *
 * Returns `{ chitId, createdAt, ageMs }` when she has an active
 * handoff on record (written at the end of a prior session). Null
 * when she's never handed off (fresh Sexton, never run a patrol) OR
 * the handoff was consumed (active → closed via consumeHandoffChit).
 *
 * The age is the delta from `createdAt` to now — Alarum reads this
 * to distinguish "Sexton exited normally 3 min ago" (recent, healthy)
 * from "her last handoff was 4 hours ago" (stale; she's been dead
 * or ignored for a while).
 *
 * Uses `peekLatestHandoffChit` — the same primitive wtf uses, so
 * Alarum sees the same handoff state Sexton herself would read on
 * next wake.
 */
export function sextonLastHandoff(
  corpRoot: string,
): { chitId: string; createdAt: string; ageMs: number } | null {
  try {
    const chit = peekLatestHandoffChit(corpRoot, 'sexton');
    if (!chit) return null;

    const createdAt = chit.createdAt;
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs)) return null;

    return {
      chitId: chit.id,
      createdAt,
      ageMs: Date.now() - createdMs,
    };
  } catch {
    return null;
  }
}

// ─── Primitive 3: Agent status counts ───────────────────────────────

/**
 * Shape of the agent-status tally Alarum receives. All four counts
 * sum to total-registered-agents when the count is consistent; when
 * the process manager and members.json disagree the sum may diverge,
 * which itself is a signal Alarum should notice.
 *
 * `broken` counts agents whose process entry is 'crashed' or
 * 'errored' — the class of failure Sexton's silentexit sweeper
 * will eventually reconcile. `offline` counts agents with NO process
 * entry (spawn never completed / was stopped) — different from
 * broken; offline is intentional, broken is unexpected.
 */
export interface AgentStatusCounts {
  readonly idle: number;
  readonly busy: number;
  readonly broken: number;
  readonly offline: number;
}

/**
 * Tally of agent process states as of this call.
 *
 * Walks the process manager's agent list + joins with the computed
 * work-status map to classify each member. Pure snapshot — no
 * side effects, no state mutation.
 *
 * Classification rules (follows the `AgentProcessStatus` enum in
 * process-manager.ts: `'starting' | 'ready' | 'stopped' | 'crashed'`):
 *   - status === 'crashed'              → broken
 *   - status === 'stopped'              → offline (intentional)
 *   - status === 'starting'             → offline (not-yet-ready)
 *   - status === 'ready' + busy worker  → busy
 *   - status === 'ready' + idle worker  → idle
 *
 * Alarum uses these numbers as a rough activity gauge: a corp with 5
 * idle + 0 busy + 0 broken + 0 offline is in a quieter state than
 * 2 busy + 3 idle + 1 broken. The shape of the delta between
 * consecutive ticks is her signal for "is something developing or
 * is this a stable moment."
 */
export function agentStatusCounts(daemon: Daemon): AgentStatusCounts {
  try {
    const agents = daemon.processManager.listAgents();

    let idle = 0;
    let busy = 0;
    let broken = 0;
    let offline = 0;

    for (const a of agents) {
      if (a.status === 'crashed') {
        broken++;
        continue;
      }
      if (a.status === 'stopped' || a.status === 'starting') {
        offline++;
        continue;
      }
      // status === 'ready'
      const workStatus = daemon.getAgentWorkStatus(a.memberId);
      if (workStatus === 'busy') busy++;
      else idle++;
    }

    return { idle, busy, broken, offline };
  } catch {
    return { idle: 0, busy: 0, broken: 0, offline: 0 };
  }
}

// ─── Primitive 4: Observation count since timestamp ─────────────────

/**
 * Count of observation chits authored since the given ISO timestamp.
 *
 * Uses queryChits with `createdSince` (not updatedSince — lifecycle
 * scanner cooling mutations bump updatedAt but not createdAt, so
 * createdAt is the stable birth-timestamp for "new since X" queries).
 *
 * Alarum reads this delta to measure "how much has happened in the
 * corp since Sexton's last exit." Zero observations since last handoff
 * + short handoff age = corp is genuinely quiet, Alarum can exit cheap.
 * High observation count = something's going on, Sexton should probably
 * wake up and integrate.
 *
 * `sinceIso` null or undefined is explicitly supported and interpreted
 * as "since daemon startup" — useful on a fresh Sexton who has no prior
 * handoff to anchor against.
 */
export function observationCountSince(
  corpRoot: string,
  sinceIso: string | null | undefined,
): number {
  try {
    const { chits } = queryChits(corpRoot, {
      types: ['observation'],
      ...(sinceIso ? { createdSince: sinceIso } : {}),
      limit: 0, // unlimited — we only need the count
    });
    return chits.length;
  } catch {
    return 0;
  }
}

// ─── Composer: AlarumContext ────────────────────────────────────────

/**
 * The full baseline state Alarum receives in her user prompt. One
 * struct so the prompt composer doesn't need to invoke each primitive
 * directly — tests stub this shape, primitives stay testable on their own.
 */
export interface AlarumContext {
  readonly sextonAlive: boolean;
  readonly sextonHandoff: { chitId: string; createdAt: string; ageMs: number } | null;
  readonly agentStatus: AgentStatusCounts;
  readonly observationsSinceHandoff: number;
  readonly generatedAt: string;
}

/**
 * Build the Alarum context for this tick. Composes all primitives into
 * one struct; primitives fail soft so the context always builds.
 *
 * `observationsSinceHandoff` is sliced from Sexton's last handoff
 * timestamp. When she has no handoff (never ran), the count is
 * against all observations currently in the store (a high number
 * there is less actionable but still surfaced — Alarum can reason
 * about it).
 */
export function buildAlarumContext(daemon: Daemon): AlarumContext {
  const sextonAlive = sextonSessionAlive(daemon);
  const sextonHandoff = sextonLastHandoff(daemon.corpRoot);
  const agentStatus = agentStatusCounts(daemon);
  const observationsSinceHandoff = observationCountSince(
    daemon.corpRoot,
    sextonHandoff?.createdAt ?? null,
  );

  return {
    sextonAlive,
    sextonHandoff,
    agentStatus,
    observationsSinceHandoff,
    generatedAt: new Date().toISOString(),
  };
}
