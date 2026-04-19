/**
 * Interrupt Registry — one Esc owner, register-to-interrupt.
 *
 * Why: Ink registers each `useInput` as an independent stdin listener.
 * There's no native "stopPropagation" across hooks, so a view handling
 * Esc (e.g., chat.tsx interrupting a streaming dispatch) couldn't
 * prevent the app-level handler from also firing and popping the view
 * stack. The first implementation tried to coordinate via conditional
 * state reads inside multiple useInputs — classic dual-handler race.
 *
 * Fix: centralize. App.tsx owns the single Esc handler. Views that
 * want to claim Esc publish their "interruptible" to this registry
 * while they're interruptible, and unregister when they're not.
 * App.tsx's Esc first calls `consume()` — if an interruptible was
 * registered, its `abort()` runs and Esc is consumed; else fall
 * through to nav-back.
 *
 * Contract:
 *   - Single slot. The last `register` wins if multiple fire (rare —
 *     typically only one view streams at a time).
 *   - `register(entry)` returns an unregister function. Views unregister
 *     in their cleanup (useEffect return).
 *   - `consume()` runs the registered abort and clears the slot.
 *     Returns true if something was registered, false otherwise.
 *   - No timing hacks. No TTLs. No shared refs read from multiple
 *     handlers. Just one bookkeeping slot + two methods.
 */

export interface InterruptibleEntry {
  /** Session being interrupted — useful for logs + future observability. */
  sessionKey: string;
  /** Closure-captured side effect that actually stops the thing. */
  abort: () => void;
}

const state: { current: InterruptibleEntry | null } = { current: null };

/**
 * Publish that a view is currently interruptible. Returns an unregister
 * function — call it in useEffect cleanup or when the turn completes
 * naturally. Safe to call repeatedly; the last registration wins.
 */
export function register(entry: InterruptibleEntry): () => void {
  state.current = entry;
  return () => {
    // Only clear if we're still the active entry — a later register
    // may have replaced us, and we must not evict its slot.
    if (state.current === entry) state.current = null;
  };
}

/**
 * If something is registered, run its abort and clear the slot.
 * Returns true when consumed so callers can short-circuit (e.g., skip
 * nav-back). Returns false when the slot was empty.
 */
export function consume(): boolean {
  const entry = state.current;
  if (!entry) return false;
  state.current = null;
  try { entry.abort(); } catch { /* swallow — abort implementations own their own error handling */ }
  return true;
}

/**
 * Peek at the current slot without consuming. Useful for diagnostics
 * and for UI hints ("Esc: interrupt" vs "Esc: back"). Returns a
 * read-only snapshot; mutating the returned object doesn't affect the
 * registry.
 */
export function peek(): Readonly<InterruptibleEntry> | null {
  return state.current;
}

/**
 * Test-only: reset the singleton. Prevents state leak between test
 * cases. Never call from production code.
 */
export function __resetForTests(): void {
  state.current = null;
}
