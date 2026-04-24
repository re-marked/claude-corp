/**
 * Static registry mapping sweeper names to their modules.
 *
 * Adding a new code sweeper:
 *   1. Implement `(ctx: SweeperContext) => Promise<SweeperResult>`
 *      in a new file in this directory.
 *   2. Add the name to `SweeperName` in types.ts.
 *   3. Add the mapping here.
 *
 * Why static and not dynamic-import:
 *   - The set of invocable sweeper names is knowable at build time.
 *     TS enforces the `Record<SweeperName, SweeperModule>` type so
 *     every declared name has a module + vice versa. An unmapped
 *     name is a compile error, not a runtime surprise.
 *   - No arbitrary-path-injection concern — the CLI accepts only
 *     names defined in this union, and the registry can only
 *     resolve those names. User-authored AI sweepers (future
 *     `cc-cli sweeper new --prompt`) go through a different path
 *     entirely (blueprint cast → agent dispatch), not this map.
 *   - Tiny; listing every shipped sweeper in one file keeps the
 *     system legible. When the registry grows past ~15 entries we
 *     can revisit.
 */

import type { SweeperModule, SweeperName } from './types.js';
import { runSilentexit } from './silentexit.js';
import { runAgentstuck } from './agentstuck.js';
import { runOrphantask } from './orphantask.js';

export const SWEEPER_REGISTRY: Record<SweeperName, SweeperModule> = {
  silentexit: runSilentexit,
  agentstuck: runAgentstuck,
  orphantask: runOrphantask,
};

/** All registered sweeper names — useful for help output + listings. */
export const SWEEPER_NAMES: readonly SweeperName[] = Object.keys(SWEEPER_REGISTRY) as SweeperName[];

/**
 * Narrow a raw string to a valid `SweeperName`. Returns the typed
 * name or null. Callers (`/sweeper/run` endpoint, CLI arg parser)
 * use this to validate the user-supplied name before looking it up.
 */
export function parseSweeperName(raw: string): SweeperName | null {
  return raw in SWEEPER_REGISTRY ? (raw as SweeperName) : null;
}
