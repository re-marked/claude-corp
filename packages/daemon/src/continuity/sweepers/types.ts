/**
 * Sweeper module contract — the shape every code sweeper implements.
 *
 * A sweeper is a single-purpose daemon-side function Sexton invokes
 * from her patrol. Each sweeper reads some slice of corp state,
 * takes some action (respawn, cleanup, reconcile), and returns
 * structured observations + a summary. The invoker (the
 * /sweeper/run endpoint) writes the observations as chits and
 * returns the summary to the caller.
 *
 * ### Why code sweepers vs AI sweepers
 *
 * Most of what a sweeper does is mechanical — "for each agent whose
 * status is crashed, call spawnAgent." Cheap, deterministic, no
 * reasoning required. Code sweepers ship as TS modules in this
 * directory; a static registry maps `name` → module so the runtime
 * lookup is one map get and the set of invocable names is knowable
 * at build time.
 *
 * AI sweepers (for the `conflict-triage` case and future
 * `cc-cli sweeper new --prompt` authored ones) use a separate path —
 * they're blueprints that cast into agent dispatches, not code
 * modules. This registry only covers the code side.
 *
 * ### Separation from the blueprint layer
 *
 * REFACTOR.md 1.9 says "sweepers are blueprints." The blueprint
 * layer (1.8 + the 1.9 sweeper-substrate PR) produces a sweeper-run
 * chit when cast. This module — the EXECUTION layer — takes the
 * module name and runs its code. In the current ship, the two
 * layers are only loosely coupled: `cc-cli sweeper run <name>`
 * invokes the module directly by name, bypassing the blueprint cast
 * for simplicity. Later PRs can wire `cc-cli sweeper cast <blueprint>`
 * through to this same module-invocation path once the full
 * blueprint-seeding flow lands.
 */

import type { Daemon } from '../../daemon.js';

/**
 * Context the runtime passes to every sweeper module. Just the
 * Daemon instance for now — everything else (chit writes, process
 * manager calls, member reads) threads through that single handle.
 * Keeping the context minimal means a new sweeper doesn't need to
 * guess what utility bag it'll get.
 */
export interface SweeperContext {
  readonly daemon: Daemon;
}

/**
 * A single observation a sweeper wants written to the corp's chit
 * store. The runtime maps these onto `createChit` calls after the
 * sweeper returns; the sweeper itself never touches filesystem
 * directly (pure in terms of side effects it chooses to take —
 * e.g. spawnAgent — but doesn't own chit writes).
 *
 * Matches the shape `cc-cli observe` produces so the observations
 * are queryable alongside human + agent ones without any special
 * category.
 */
export interface SweeperObservation {
  /** Observation category — ObservationFields.category enum values. */
  readonly category: 'FEEDBACK' | 'DECISION' | 'DISCOVERY' | 'PREFERENCE' | 'NOTICE' | 'CORRECTION';
  /** Subject — who / what the observation is about. Typically a slug. */
  readonly subject: string;
  /** Short title, shown in list views. */
  readonly title: string;
  /** Markdown body — the substantive observation. */
  readonly body: string;
  /** 1-5; higher = more important. Sexton uses this to prioritize. */
  readonly importance: 1 | 2 | 3 | 4 | 5;
  /** Tags to thread the observation through queries. Optional. */
  readonly tags?: readonly string[];
}

export type SweeperStatus = 'completed' | 'failed' | 'noop';

/**
 * What a sweeper returns. Structured so the runtime can:
 *   - Write each `SweeperObservation` as an observation chit
 *   - Surface `summary` in logs + /sweeper/run's JSON response
 *   - Distinguish "ran and did work" (completed), "ran and found
 *     nothing" (noop), and "ran and hit an error" (failed) cleanly
 *     in the caller's output
 */
export interface SweeperResult {
  readonly status: SweeperStatus;
  readonly observations: readonly SweeperObservation[];
  /** One-line human summary of what happened this run. */
  readonly summary: string;
}

/**
 * The function signature every code sweeper exports. Async because
 * sweepers may do process spawns, fetches, long file walks.
 * Expected to never throw — wrap internal errors and return
 * `status: 'failed'` with an explanatory summary instead.
 *
 * If a sweeper DOES throw, the runtime catches it and synthesizes
 * a failed SweeperResult so a buggy sweeper doesn't take the
 * /sweeper/run endpoint down.
 */
export type SweeperModule = (ctx: SweeperContext) => Promise<SweeperResult>;

/**
 * Canonical names of the code sweepers we ship. The registry
 * (registry.ts) maps each name to its module. Adding a new sweeper
 * means: (1) add the module in this directory, (2) add the name
 * here, (3) add the mapping to SWEEPER_REGISTRY in registry.ts.
 *
 * Kept as a union type (not an enum) so it works naturally with
 * `Record<SweeperName, SweeperModule>` in the registry + narrows
 * cleanly in switches.
 */
export type SweeperName = 'silentexit';
