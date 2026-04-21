import { cmdChitCreate } from './chit/create.js';

/**
 * `cc-cli observe` — thin alias for `cc-cli chit create --type observation`.
 *
 * Introduced at 0.2 time as a new top-level command (no prior meaning).
 * Retained explicitly because "observe" matches the verb agents naturally
 * reach for when capturing noticed-state: what they saw, felt, surfaced.
 * The alias exists so muscle memory lands right — agents don't have to
 * remember `--type observation` as a modal; the verb IS the type.
 *
 * All flags pass through to chit create. Users can still pass --type if
 * they really want, though it's redundant.
 */
export async function cmdObserve(rawArgs: string[]): Promise<void> {
  // Inject --type observation unless the user already passed it explicitly.
  const hasTypeFlag = rawArgs.some((arg, i) => arg === '--type' || arg.startsWith('--type='));
  const args = hasTypeFlag ? rawArgs : ['--type', 'observation', ...rawArgs];
  await cmdChitCreate(args);
}
