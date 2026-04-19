import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  register,
  consume,
  peek,
  __resetForTests,
} from '../packages/tui/src/lib/interrupt-registry.js';

beforeEach(() => {
  __resetForTests();
});

// The whole point of this registry is to make Esc-routing bulletproof
// without relying on timing hacks or multi-handler coordination.
// Behavior that matters:
//   - consume() with nothing registered → false (app falls through to nav)
//   - register → consume runs abort + clears slot
//   - re-register replaces the slot (last view wins)
//   - unregister is idempotent and slot-aware (late cleanup from a
//     stale registrant must NOT evict a newer one)
//   - peek is a read-only snapshot

describe('interrupt-registry', () => {
  describe('consume()', () => {
    it('returns false on empty registry', () => {
      expect(consume()).toBe(false);
    });

    it('runs the registered abort and returns true', () => {
      const abort = vi.fn();
      register({ sessionKey: 'jack:ceo', abort });

      expect(consume()).toBe(true);
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it('clears the slot after consuming (second consume is a no-op)', () => {
      const abort = vi.fn();
      register({ sessionKey: 'jack:ceo', abort });

      expect(consume()).toBe(true);
      expect(consume()).toBe(false);
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it('swallows errors from the abort implementation', () => {
      // Abort paths do their own cleanup; throwing out of consume()
      // would cause the Esc handler to leak an unhandled exception.
      register({
        sessionKey: 'jack:ceo',
        abort: () => { throw new Error('boom'); },
      });
      expect(() => consume()).not.toThrow();
      expect(consume()).toBe(false); // slot cleared despite the throw
    });
  });

  describe('register()', () => {
    it('returns an unregister function that clears the slot', () => {
      const abort = vi.fn();
      const unregister = register({ sessionKey: 'jack:ceo', abort });

      expect(peek()).not.toBeNull();
      unregister();
      expect(peek()).toBeNull();
      // And now consume is a no-op since we unregistered.
      expect(consume()).toBe(false);
      expect(abort).not.toHaveBeenCalled();
    });

    it('last register wins — previous entry is replaced', () => {
      const firstAbort = vi.fn();
      const secondAbort = vi.fn();
      register({ sessionKey: 'jack:ceo', abort: firstAbort });
      register({ sessionKey: 'jack:herald', abort: secondAbort });

      // consume triggers the LATEST one
      expect(consume()).toBe(true);
      expect(firstAbort).not.toHaveBeenCalled();
      expect(secondAbort).toHaveBeenCalledTimes(1);
    });

    it('stale unregister after replacement does NOT evict the newer entry', () => {
      // The "late cleanup" case: view A registers, view B registers
      // (replacing A's slot), then A's useEffect cleanup runs belatedly
      // and calls A's unregister. Must not clear B's slot.
      const firstAbort = vi.fn();
      const secondAbort = vi.fn();
      const unregisterFirst = register({ sessionKey: 'jack:ceo', abort: firstAbort });
      register({ sessionKey: 'jack:herald', abort: secondAbort });

      unregisterFirst(); // late cleanup — should NOT evict the newer entry

      expect(peek()?.sessionKey).toBe('jack:herald');
      expect(consume()).toBe(true);
      expect(secondAbort).toHaveBeenCalledTimes(1);
    });

    it('unregister is idempotent (calling twice is a no-op)', () => {
      const unregister = register({
        sessionKey: 'jack:ceo',
        abort: () => {},
      });
      unregister();
      expect(() => unregister()).not.toThrow();
    });
  });

  describe('peek()', () => {
    it('returns null when empty', () => {
      expect(peek()).toBeNull();
    });

    it('returns the current entry without consuming', () => {
      const abort = vi.fn();
      register({ sessionKey: 'jack:ceo', abort });

      const snapshot = peek();
      expect(snapshot?.sessionKey).toBe('jack:ceo');
      expect(abort).not.toHaveBeenCalled();
      // Still there — peek didn't clear
      expect(peek()?.sessionKey).toBe('jack:ceo');
    });
  });
});
