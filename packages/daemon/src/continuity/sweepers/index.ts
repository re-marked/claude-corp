/**
 * Public surface of the sweeper-execution module.
 *
 * One entry point — `runSweeper(daemon, name)` — plus the types and
 * registry the API layer needs. Everything else is module-internal.
 *
 * The runner handles:
 *   - Name validation (via parseSweeperName)
 *   - Module lookup + invocation
 *   - Last-resort error containment (a throwing sweeper produces a
 *     failed SweeperResult instead of taking the caller down)
 *   - Observation-chit writes for the observations the sweeper
 *     returns (sweeper modules don't touch filesystem directly;
 *     the runner threads createChit calls so observations are
 *     queryable by the standard observation-chit surface)
 *
 * Caller (e.g. the /sweeper/run endpoint or Sexton's patrol) gets
 * back a SweeperResult it can JSON-serialize + log + surface in
 * response bodies without any additional orchestration.
 */

import { createChit } from '@claudecorp/shared';
import type { Daemon } from '../../daemon.js';
import { log, logError } from '../../logger.js';
import { SWEEPER_REGISTRY, parseSweeperName, SWEEPER_NAMES } from './registry.js';
import type { SweeperResult, SweeperName, SweeperObservation } from './types.js';

export type { SweeperContext, SweeperResult, SweeperModule, SweeperName, SweeperObservation, SweeperStatus } from './types.js';
export { SWEEPER_REGISTRY, SWEEPER_NAMES, parseSweeperName } from './registry.js';

/**
 * Thrown when `runSweeper` is called with a name that isn't in the
 * registry. Caller catches this and surfaces a clear error with the
 * valid names. Throw (not return a failed SweeperResult) because
 * the caller made a programming-level mistake — an unknown name
 * isn't a runtime failure of the sweeper chain, it's a bad input.
 */
export class UnknownSweeperError extends Error {
  constructor(readonly name: string, readonly known: readonly string[]) {
    super(`Unknown sweeper "${name}". Known sweepers: ${known.join(', ')}`);
    this.name = 'UnknownSweeperError';
  }
}

/**
 * Invoke a sweeper by name. Validates the name, runs the module,
 * writes its observations as chits, returns the result.
 *
 * Behavior on sweeper-internal failures:
 *   - If the module throws (programming error / unexpected state):
 *     catch, log, return a synthetic SweeperResult { status:
 *     'failed', observations: [], summary: '<error message>' }.
 *     A single broken sweeper never propagates its error up past
 *     the runtime boundary.
 *   - If the module returns { status: 'failed' } explicitly: pass
 *     through. Any observations it emitted still get written —
 *     failure + observations is a valid combination (a respawn
 *     attempt that itself failed still wants to leave a breadcrumb).
 *
 * Observation writes are best-effort per chit: one write failure
 * logs + skips that observation, doesn't abort the run. A sweeper
 * that produced 5 observations and had 1 chit write fail still
 * returns a completed SweeperResult with the 5 observations in its
 * response — the caller sees what was intended; the logs show what
 * actually landed on disk.
 */
export async function runSweeper(
  daemon: Daemon,
  name: string,
): Promise<SweeperResult> {
  const validated = parseSweeperName(name);
  if (!validated) {
    throw new UnknownSweeperError(name, SWEEPER_NAMES);
  }

  const module = SWEEPER_REGISTRY[validated];

  log(`[sweeper] run ${validated} — starting`);
  let result: SweeperResult;
  try {
    result = await module({ daemon });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[sweeper] run ${validated} — threw: ${message}`);
    return {
      status: 'failed',
      observations: [],
      summary: `${validated}: internal error — ${message}`,
    };
  }

  log(`[sweeper] run ${validated} — ${result.status}: ${result.summary}`);

  // Write observations as chits (best-effort per item).
  for (const obs of result.observations) {
    try {
      writeSweeperObservation(daemon, validated, obs);
    } catch (err) {
      logError(
        `[sweeper] run ${validated} — observation-write failed: ${err instanceof Error ? err.message : String(err)} (title=${JSON.stringify(obs.title)})`,
      );
      // Intentionally swallowed — other observations still get a chance.
    }
  }

  return result;
}

/**
 * Convert a SweeperObservation into a chit-create call. Scope is
 * `corp` (observations the sweeper writes are corp-wide patrol
 * findings, not per-agent diary entries). createdBy uses the
 * sweeper-run-style id `sweeper:<name>` so the observations are
 * attributable + filterable.
 */
function writeSweeperObservation(
  daemon: Daemon,
  sweeperName: SweeperName,
  obs: SweeperObservation,
): void {
  createChit(daemon.corpRoot, {
    type: 'observation',
    scope: 'corp',
    createdBy: `sweeper:${sweeperName}`,
    fields: {
      observation: {
        title: obs.title,
        category: obs.category,
        subject: obs.subject,
        importance: obs.importance,
      },
    },
    body: obs.body,
    ...(obs.tags && obs.tags.length > 0 ? { tags: [...obs.tags] } : {}),
  });
}
