/**
 * Bacteria — public surface for daemon consumers.
 *
 * The daemon imports `BacteriaReactor` and constructs one with its
 * ExecutorContext at boot; nothing else in the codebase should depend
 * directly on decision.ts / executor.ts. Tests import the inner
 * modules to drive specific functions in isolation.
 */

export { BacteriaReactor } from './reactor.js';
export type { ExecutorContext } from './executor.js';
export type { BacteriaState, BacteriaAction } from './types.js';
