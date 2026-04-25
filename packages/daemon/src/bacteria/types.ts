/**
 * Bacteria — auto-scaling Employee pool organism (Project 1.10).
 *
 * ### What it is
 *
 * A separate, deterministic, code-not-AI daemon-internal reactor that
 * watches the chit store + members.json for the Employee role pools
 * and decides when to mitose (spawn a new slot) or apoptose (retire
 * an idle slot). Pure mechanical organism — no model calls, no
 * voice, no prompts. Sexton observes; bacteria acts.
 *
 * ### Why a separate module instead of a sweeper
 *
 * Sweepers OBSERVE state and emit kink chits for downstream actors
 * (Sexton, founder) to consume. Bacteria MUTATES state — spawns and
 * decommissions Member records, writes obituary observations. Putting
 * those at the same layer would conflate "diagnose" with "treat" —
 * different responsibilities. Bacteria runs at its own cadence
 * (event-driven on chit writes + 30s safety tick) and answers to
 * nobody but the queue.
 *
 * ### The action contract
 *
 * `decideBacteriaActions` (decision.ts) is pure: given a snapshot of
 * the corp's filesystem state plus the reactor's accumulated
 * hysteresis bookkeeping, it returns a list of actions for the
 * executor (executor.ts) to apply this tick. Every action carries
 * the full context the executor needs — no round-trip disk reads,
 * no second-pass resolution. Tests exercise the decision over
 * fixture states without touching the executor; integration tests
 * assert the executor faithfully translates actions into filesystem
 * mutations.
 *
 * ### Why the assignment is singular per Mitose
 *
 * The push model says "bacteria spawns slots WITH work" so lineage
 * has a reason ("toast was born to handle chit-X"). But Casket holds
 * exactly one currentStep — there's no multi-task casket queue.
 * Pattern: bacteria assigns ONE chit per mitose; remaining queue
 * items stay unassigned for the role and get picked up by the
 * existing role-resolver (idle-first phase) as the new slot drains.
 * The "push" is the spawn moment; pull semantics resume the moment
 * the slot finishes its first task.
 *
 *   5 trivials at target_per_slot=2.0 → 1 mitose → new slot starts
 *   on chit-A; chits B-E sit unassigned; new slot finishes A, goes
 *   idle, role-resolver picks chit-B for it; repeat.
 *
 * The N-slot case (8 mediums needing 4 slots) emits 4 separate
 * Mitose actions, each carrying one chit; the remaining 4 stay
 * queued and get distributed naturally as the new slots finish their
 * first task.
 */

// ─── Action shapes ──────────────────────────────────────────────────

/**
 * Mitose — birth a new Employee slot for `role`. Slot is born with
 * `displayName: null` (self-naming arrives in PR 3 / 1.10.3) and the
 * triggering task chit is pre-loaded into the freshly-created Casket.
 *
 * The genealogy fields (`parentSlug`, `generation`) get written into
 * the new Member record as-is; they're computed at decision time so
 * the executor doesn't need to re-read members.json to pick a parent.
 *
 *   role         — registered worker-tier role id (backend-engineer, etc.)
 *   parentSlug   — id of the slot whose queue triggered this spawn,
 *                  or null when the role's pool was empty (the new
 *                  slot is the first of its lineage).
 *   generation   — parent.generation + 1 when parentSlug is set,
 *                  otherwise 0.
 *   assignedChit — chit id the new slot's casket starts on. Always
 *                  set; bacteria spawning a slot with no work would
 *                  immediately apoptose it on the next tick (pure
 *                  waste of a context-load).
 */
export interface MitoseAction {
  readonly kind: 'mitose';
  readonly role: string;
  readonly parentSlug: string | null;
  readonly generation: number;
  readonly assignedChit: string;
}

/**
 * Apoptose — programmed cell death. An idle slot whose hysteresis
 * window has elapsed gets decommissioned: Member record purged from
 * members.json, sandbox dir cleared, name returned to the pool.
 *
 * Before the data is wiped, the executor writes an obituary
 * observation chit so dreams (Project 4.2) can compound the slot's
 * lifetime into pool-level patterns ("backend pool turned over 47
 * employees today, mean lifespan 47 minutes").
 *
 *   slug         — Member.id being decommissioned. Must currently
 *                  reference an active Employee (executor asserts
 *                  this; decision module is responsible for not
 *                  emitting apoptosis on a busy or already-archived
 *                  slot).
 *   idleSince    — ISO timestamp the slot first went idle on this
 *                  reactor's run. Travels into the obituary so the
 *                  observation captures the full active period.
 *   reason       — short prose ("queue drained, hysteresis 3min
 *                  elapsed"). Travels into the obituary body. Helps
 *                  later operators distinguish "natural drain" from
 *                  "explicit founder shrink" if we ever add manual
 *                  apoptosis triggers.
 */
export interface ApoptoseAction {
  readonly kind: 'apoptose';
  readonly slug: string;
  readonly idleSince: string;
  readonly reason: string;
}

export type BacteriaAction = MitoseAction | ApoptoseAction;

// ─── Reactor state ──────────────────────────────────────────────────

/**
 * In-memory state the reactor maintains across ticks. The decision
 * module reads this in to know which idle slots have been idle for
 * how long; the reactor updates it after each tick.
 *
 * Cleared on daemon restart — that's fine. Queue state itself is
 * on-disk in chits + members.json; bacteria just re-evaluates from
 * current state on first post-restart tick. Hysteresis timers reset
 * (every idle slot reads as "freshly idle as of this tick") is a
 * deliberate fail-safe: better to keep slots a bit longer after an
 * unrelated daemon bounce than to apoptose them prematurely against
 * a stale-looking idle clock.
 */
export interface BacteriaState {
  /**
   * slug → ISO timestamp the slot was first observed idle on this
   * reactor run. Slots in this map are idle now or were last seen
   * idle; entries are removed when the slot is observed busy again
   * (hysteresis window reset) or when the slot apoptoses.
   *
   * ReadonlyMap so the decision module can't mutate state mid-tick;
   * reactor wraps a mutable Map and snapshots into this shape per
   * tick.
   */
  readonly idleSince: ReadonlyMap<string, string>;
}

/**
 * Constructor for an empty reactor state. Called by the reactor on
 * daemon boot and by tests that need a clean baseline.
 */
export function emptyBacteriaState(): BacteriaState {
  return { idleSince: new Map<string, string>() };
}

// ─── Tunables ───────────────────────────────────────────────────────

/**
 * Weighted work units of "queue ownership" each slot is allowed to
 * accumulate before bacteria splits. Computed against the sum of
 * `weight(complexity)` across active task chits assigned to the role
 * minus what's already on busy slots' Caskets.
 *
 *   1 trivial   = 0.25 units
 *   1 small     = 0.50 units
 *   1 medium    = 1.00 units
 *   1 large     = 2.00 units
 *
 * Default 1.5: aggressive-leaning scaling, chosen for VISIBILITY in
 * v1. Bacteria fires often enough that the founder watches it work
 * (mitoses + apoptoses observable in the TUI / Sexton's summaries)
 * rather than rarely enough that the organism feels dormant. Cost
 * trade-off: each marginal slot pays one context-load; 1.5 spends a
 * bit more on parallelism than the strict cost-optimal middle (2.0)
 * would. That's a deliberate v1 choice — "see it move" beats "save
 * tokens you didn't notice."
 *
 * Tuning intuition: each context-load is roughly 1 medium-task's
 * worth of tokens, so TARGET=1.5 means "spawn a new slot when work
 * exceeds ~1.5 medium-equivalents — saves 1.5 medium of wall-clock
 * for 1 medium of context-load. ~1.5:1 trade." Future: per-role
 * override on RoleEntry, observation-driven auto-tuning in Project 4.
 */
export const TARGET_WEIGHTED_PER_SLOT = 1.5;

/**
 * How long a slot must be continuously idle before apoptosis. The
 * point of hysteresis isn't warmth (claude-code sessions are
 * ephemeral; no warmth to preserve) — it's IDENTITY CONTINUITY across
 * burst-quiet-burst cycles. Toast does task A, goes idle, 90 seconds
 * later task B lands; with hysteresis Toast picks it up as still
 * Toast. Without hysteresis, Toast apoptoses and Crumb is born to
 * handle B. The corp would be full of strangers.
 *
 * 3 minutes covers most human-driven burst patterns while still
 * making decommission genuine rather than perpetually deferred.
 * Configurable per-role via RoleEntry in a follow-up; ships as a
 * constant in v1.
 */
export const APOPTOSIS_HYSTERESIS_MS = 3 * 60 * 1000;

/**
 * Reactor cadence — how often the bacteria tick fires when no
 * external event triggers it. 5 seconds is fast enough that a task
 * landing in an empty queue gets a slot spawned within 5s of the
 * write, slow enough that a quiet corp doesn't burn disk-read cycles
 * scanning chits hundreds of times per minute.
 *
 * v1 is interval-only (no fs.watch event hook); future iterations
 * may overlay an event-driven trigger atop the safety tick when
 * sub-second responsiveness becomes worth the Windows fs.watch
 * complexity (the existing watchers in this daemon all carry workarounds
 * for "fires 3-5 times per change" / "misses appends" — bacteria avoids
 * that surface by polling.)
 */
export const BACTERIA_TICK_INTERVAL_MS = 5_000;

/**
 * Per-complexity weight lookup. Null/undefined complexity defaults
 * to medium so pre-0.5.1 tasks (or tasks an agent forgot to assess)
 * still trigger sensible scaling instead of silently weighting zero.
 */
export const COMPLEXITY_WEIGHTS: Record<
  'trivial' | 'small' | 'medium' | 'large',
  number
> = {
  trivial: 0.25,
  small: 0.5,
  medium: 1.0,
  large: 2.0,
};

/**
 * Resolve a complexity value to a weight. Null/undefined/unknown
 * complexity reads as medium (1.0) — see COMPLEXITY_WEIGHTS comment
 * for the rationale.
 */
export function weightFor(
  complexity: 'trivial' | 'small' | 'medium' | 'large' | null | undefined,
): number {
  if (!complexity) return COMPLEXITY_WEIGHTS.medium;
  return COMPLEXITY_WEIGHTS[complexity] ?? COMPLEXITY_WEIGHTS.medium;
}
