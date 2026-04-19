/**
 * InflightRegistry — bookkeeping for in-flight /cc/say dispatches.
 *
 * One dispatch per sessionKey at a time. Registering a new controller
 * against an existing key aborts the previous one — the "one turn per
 * session" invariant that PR 2/3 will build on. Testable in isolation
 * (no FS, no network) so the interrupt stack has verifiable correctness
 * without spinning a full Daemon.
 */

import { log } from './logger.js';

export interface InflightAbortResult {
  /** Was a controller registered under this sessionKey? */
  found: boolean;
  /** Did this call actually trigger abort (false if already aborted)? */
  aborted: boolean;
}

export class InflightRegistry {
  private controllers = new Map<string, AbortController>();

  /**
   * Register a new in-flight dispatch. If an existing controller was
   * registered under the same key, it is aborted first so no two
   * turns race for the same session.
   */
  register(sessionKey: string, controller: AbortController): void {
    const prior = this.controllers.get(sessionKey);
    if (prior && !prior.signal.aborted) {
      log(`[inflight] overlapping dispatch for session "${sessionKey}" — aborting the previous one`);
      try { prior.abort(); } catch { /* best-effort */ }
    }
    this.controllers.set(sessionKey, controller);
  }

  /**
   * Remove an in-flight dispatch from the registry. Only removes if
   * this is still the active controller — a newer dispatch may have
   * overwritten us already. Idempotent.
   */
  clear(sessionKey: string, controller: AbortController): void {
    if (this.controllers.get(sessionKey) === controller) {
      this.controllers.delete(sessionKey);
    }
  }

  /**
   * Fire the abort for an in-flight dispatch, if one exists. Returns
   * whether a controller was found and whether this call actually
   * triggered the abort (second interrupt on already-aborted = found
   * but not aborted-this-call).
   */
  abort(sessionKey: string): InflightAbortResult {
    const controller = this.controllers.get(sessionKey);
    if (!controller) return { found: false, aborted: false };
    if (controller.signal.aborted) return { found: true, aborted: false };
    try { controller.abort(); } catch { return { found: true, aborted: false }; }
    log(`[inflight] aborted dispatch for session "${sessionKey}"`);
    return { found: true, aborted: true };
  }

  /** Diagnostic — list all currently active (non-aborted) session keys. */
  list(): string[] {
    const keys: string[] = [];
    for (const [key, controller] of this.controllers) {
      if (!controller.signal.aborted) keys.push(key);
    }
    return keys;
  }
}
