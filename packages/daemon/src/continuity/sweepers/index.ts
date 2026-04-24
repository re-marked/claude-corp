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

import { writeOrBumpKink } from '@claudecorp/shared';
import type { Daemon } from '../../daemon.js';
import { log, logError } from '../../logger.js';
import { SWEEPER_REGISTRY, parseSweeperName, SWEEPER_NAMES } from './registry.js';
import type { SweeperResult, SweeperName, SweeperFinding } from './types.js';

export type { SweeperContext, SweeperResult, SweeperModule, SweeperName, SweeperFinding, SweeperStatus } from './types.js';
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
 * writes its findings as kink chits, returns the result.
 *
 * Behavior on sweeper-internal failures:
 *   - If the module throws (programming error / unexpected state):
 *     catch, log, return a synthetic SweeperResult { status:
 *     'failed', findings: [], summary: '<error message>' }.
 *     A single broken sweeper never propagates its error up past
 *     the runtime boundary.
 *   - If the module returns { status: 'failed' } explicitly: pass
 *     through. Any findings it emitted still get written —
 *     failure + findings is a valid combination (a respawn attempt
 *     that itself failed still wants to leave a kink breadcrumb).
 *
 * Kink writes are best-effort per chit: one write failure logs +
 * skips that finding, doesn't abort the run. A sweeper that
 * produced 5 findings and had 1 chit write fail still returns a
 * completed SweeperResult with the 5 findings in its response —
 * the caller sees what was intended; the logs show what actually
 * landed on disk.
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
      findings: [],
      summary: `${validated}: internal error — ${message}`,
    };
  }

  log(`[sweeper] run ${validated} — ${result.status}: ${result.summary}`);

  // Write findings as kink chits (best-effort per item).
  for (const finding of result.findings) {
    try {
      writeSweeperKink(daemon, validated, finding);
    } catch (err) {
      logError(
        `[sweeper] run ${validated} — kink-write failed: ${err instanceof Error ? err.message : String(err)} (title=${JSON.stringify(finding.title)})`,
      );
      // Intentionally swallowed — other findings still get a chance.
    }
  }

  return result;
}

/**
 * Project a SweeperFinding onto the shared writeOrBumpKink helper.
 * The helper owns dedup logic — if an existing active kink matches
 * (source, subject), it increments occurrenceCount and refreshes
 * severity/title/body instead of creating a duplicate. This is
 * what keeps agentstuck from filing 60 identical kinks when the
 * same 5 slots stay stuck across an hour of patrols.
 *
 * Scope is `corp` (enforced by the helper) — operational kinks
 * belong at the corp level, not per-agent. createdBy + source
 * both use `sweeper:<name>` so queries filter either way.
 */
function writeSweeperKink(
  daemon: Daemon,
  sweeperName: SweeperName,
  finding: SweeperFinding,
): void {
  writeOrBumpKink({
    corpRoot: daemon.corpRoot,
    source: `sweeper:${sweeperName}`,
    subject: finding.subject,
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
  });
}
