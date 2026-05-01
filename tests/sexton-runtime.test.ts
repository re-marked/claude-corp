import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchSexton } from '../packages/daemon/src/continuity/sexton-runtime.js';
import { dispatchMessageFor } from '../packages/daemon/src/continuity/sexton-wake-prompts.js';

/**
 * Project 1.9.4 — Sexton-runtime coverage.
 *
 * dispatchSexton is pure plumbing (members lookup → busy-skip → maybe
 * spawn → HTTP POST to /cc/say), and the real failure modes (network,
 * spawn crash, Sexton deregistered) are all caught and logged, never
 * thrown. The value of mocking the happy path (global fetch, spawn
 * promise resolution, /cc/say response shape) is low — the bugs that
 * machinery would catch are either trivial or get caught at runtime
 * against the real chain.
 *
 * What's worth testing:
 *   1. Defensive 'nothing' short-circuit — if someone removes the
 *      early return, Pulse starts double-dispatching on no-op ticks.
 *   2. Missing-Sexton fail-soft — the members.json read path is the
 *      one real early-failure mode; a regression here would silently
 *      propagate up to Pulse.
 *   3. Busy-skip — the specific guard against piling dispatches on a
 *      mid-turn Sexton; dropping this wastes tokens + confuses her
 *      session.
 *   4. dispatchMessageFor resolver — trivial enum coverage + contract
 *      that 'nothing' throws (upstream filter is supposed to catch
 *      it first; the throw is a backstop).
 *
 * Not tested: the spawn-on-'start' path and the /cc/say fetch. Those
 * need ProcessManager + http stubs that carry more test-only
 * machinery than real bug coverage. They get exercised end-to-end the
 * moment Pulse ticks against a real daemon.
 */

// ─── dispatchMessageFor resolver ────────────────────────────────────

describe('dispatchMessageFor', () => {
  it('returns a distinct prose block for each live action', () => {
    const start = dispatchMessageFor('start');
    const wake = dispatchMessageFor('wake');
    const nudge = dispatchMessageFor('nudge');

    // Each should be a non-trivial prose block
    expect(start.length).toBeGreaterThan(100);
    expect(wake.length).toBeGreaterThan(50);
    expect(nudge.length).toBeGreaterThan(50);

    // And distinct from each other — a regression where two collapse
    // to the same content would silently dilute the semantic difference
    // between start/wake/nudge.
    expect(start).not.toBe(wake);
    expect(wake).not.toBe(nudge);
    expect(start).not.toBe(nudge);
  });

  it("throws on 'nothing' — the no-dispatch case must not reach here", () => {
    // This is a contract with upstream: whoever calls dispatchMessageFor
    // is supposed to filter 'nothing' themselves. If they don't, the
    // throw is louder than silently returning empty string — it turns
    // a missed-filter into a visible stack trace instead of a wordless
    // dispatch.
    expect(() => dispatchMessageFor('nothing')).toThrow(/nothing/i);
  });
});

// ─── dispatchSexton early-return guards ─────────────────────────────

describe('dispatchSexton', () => {
  it("short-circuits on 'nothing' without touching the daemon", async () => {
    // Proxy that throws on any property access. If dispatchSexton
    // touches `corpRoot`, `processManager`, `getAgentWorkStatus`, or
    // `getPort` before checking the action, this test fails loudly.
    const throwingDaemon = new Proxy(
      {},
      {
        get: () => {
          throw new Error("dispatchSexton reached daemon on 'nothing' — early return removed");
        },
      },
    ) as Parameters<typeof dispatchSexton>[0];

    await expect(
      dispatchSexton(throwingDaemon, { action: 'nothing', reason: 'quiet tick' }),
    ).resolves.toBeUndefined();
  });

  describe('with a tmpdir corp', () => {
    let corpRoot: string;

    afterEach(() => {
      try {
        rmSync(corpRoot, { recursive: true, force: true });
      } catch {
        // Windows fs-handle race — best effort cleanup.
      }
    });

    it('fails soft when Sexton is missing from members.json', async () => {
      corpRoot = mkdtempSync(join(tmpdir(), 'dispatch-sexton-missing-'));
      // members.json without a Sexton entry — simulates the corp-init
      // failure mode where hireSexton didn't run.
      writeFileSync(
        join(corpRoot, 'members.json'),
        JSON.stringify([
          { id: 'mark', displayName: 'Mark', rank: 'owner', type: 'user' },
          { id: 'ceo', displayName: 'CEO', rank: 'master', type: 'agent' },
        ]),
        'utf-8',
      );

      const spawnSpy = vi.fn();
      const fetchSideEffect = vi.fn();
      const daemon = {
        corpRoot,
        processManager: {
          spawnAgent: spawnSpy,
          getAgent: () => null,
        },
        getAgentWorkStatus: () => {
          throw new Error('should not reach workStatus when Sexton is absent');
        },
        getPort: () => {
          fetchSideEffect();
          return 0;
        },
      } as unknown as Parameters<typeof dispatchSexton>[0];

      await expect(
        dispatchSexton(daemon, { action: 'wake', reason: 'test' }),
      ).resolves.toBeUndefined();

      // No spawn, no fetch — early return swallowed cleanly.
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(fetchSideEffect).not.toHaveBeenCalled();
    });

    it("skips dispatch entirely when Sexton is 'busy' (no spawn, no fetch)", async () => {
      corpRoot = mkdtempSync(join(tmpdir(), 'dispatch-sexton-busy-'));
      writeFileSync(
        join(corpRoot, 'members.json'),
        JSON.stringify([
          {
            id: 'sexton',
            displayName: 'Sexton',
            rank: 'worker',
            type: 'agent',
            status: 'active',
          },
        ]),
        'utf-8',
      );

      const spawnSpy = vi.fn();
      const fetchSideEffect = vi.fn();
      const daemon = {
        corpRoot,
        processManager: {
          spawnAgent: spawnSpy,
          getAgent: () => null,
        },
        getAgentWorkStatus: () => 'busy' as const,
        getPort: () => {
          fetchSideEffect();
          return 0;
        },
      } as unknown as Parameters<typeof dispatchSexton>[0];

      // 'start' is the most aggressive action — it would normally call
      // spawnAgent before fetch. Busy-skip must cut in before either.
      await expect(
        dispatchSexton(daemon, { action: 'start', reason: 'test' }),
      ).resolves.toBeUndefined();

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(fetchSideEffect).not.toHaveBeenCalled();
    });
  });
});
