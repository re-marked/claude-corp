import { describe, it, expect } from 'vitest';
import { InflightRegistry } from '../packages/daemon/src/inflight-registry.js';

// Interrupt stack — registry is the testable core of the /cc/interrupt
// flow. Everything above it (HTTP handler, client fetch, TUI Esc) just
// reads/writes this one structure. If the semantics here hold, the
// rest is wiring. Full end-to-end interrupt (HTTP round-trip, SIGINT
// propagation to a child process, WS chat.abort delivery) requires a
// live daemon + gateway and doesn't fit a vitest unit.

describe('InflightRegistry', () => {
  describe('abort without registration', () => {
    it('returns not-found for unknown sessionKey', () => {
      const r = new InflightRegistry();
      expect(r.abort('never-registered')).toEqual({
        found: false,
        aborted: false,
      });
    });
  });

  describe('register + abort', () => {
    it('aborts the registered controller', () => {
      const r = new InflightRegistry();
      const ctrl = new AbortController();
      r.register('sess-a', ctrl);

      expect(ctrl.signal.aborted).toBe(false);
      const res = r.abort('sess-a');
      expect(res).toEqual({ found: true, aborted: true });
      expect(ctrl.signal.aborted).toBe(true);
    });

    it('is idempotent on already-aborted sessions', () => {
      const r = new InflightRegistry();
      const ctrl = new AbortController();
      r.register('sess-a', ctrl);
      ctrl.abort();

      expect(r.abort('sess-a')).toEqual({ found: true, aborted: false });
    });
  });

  describe('clear', () => {
    it('removes a session — subsequent aborts miss', () => {
      const r = new InflightRegistry();
      const ctrl = new AbortController();
      r.register('sess-a', ctrl);
      r.clear('sess-a', ctrl);

      expect(r.abort('sess-a')).toEqual({ found: false, aborted: false });
    });

    it('with a different controller is a no-op', () => {
      // Guards the "late cleanup of replaced controller" case: a newer
      // dispatch overwrote the registry entry, then the old dispatch's
      // finally block fires clear() for its own controller. We must
      // NOT delete the newer entry.
      const r = new InflightRegistry();
      const first = new AbortController();
      const second = new AbortController();
      r.register('sess-a', first);
      r.register('sess-a', second);

      expect(first.signal.aborted).toBe(true); // overlap-abort side effect

      r.clear('sess-a', first); // late cleanup — must not evict `second`
      expect(r.abort('sess-a')).toEqual({ found: true, aborted: true });
      expect(second.signal.aborted).toBe(true);
    });
  });

  describe('one-turn-per-session invariant', () => {
    it('overlapping register aborts the previous controller', () => {
      const r = new InflightRegistry();
      const first = new AbortController();
      const second = new AbortController();
      r.register('sess-a', first);
      r.register('sess-a', second);

      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(false);
    });

    it('overlapping register with already-aborted prior is a no-op on abort', () => {
      // Previous controller was already aborted (e.g., via /cc/interrupt)
      // — register() shouldn't try to abort it again (idempotent).
      const r = new InflightRegistry();
      const first = new AbortController();
      first.abort();
      const second = new AbortController();
      r.register('sess-a', first);
      r.register('sess-a', second);

      expect(second.signal.aborted).toBe(false);
    });
  });

  describe('list', () => {
    it('enumerates active sessions and skips aborted entries', () => {
      const r = new InflightRegistry();
      const a = new AbortController();
      const b = new AbortController();
      const c = new AbortController();
      r.register('sess-a', a);
      r.register('sess-b', b);
      r.register('sess-c', c);

      // b is still registered but aborted — shouldn't show up as "active"
      b.abort();

      const list = r.list().sort();
      expect(list).toEqual(['sess-a', 'sess-c']);
    });

    it('is empty on a fresh registry', () => {
      expect(new InflightRegistry().list()).toEqual([]);
    });
  });
});
