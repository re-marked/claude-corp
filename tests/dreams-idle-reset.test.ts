import { describe, it, expect } from 'vitest';
import { DreamManager } from '../packages/daemon/src/dreams.js';

/**
 * Regression for v2.1.12: Dream cycle fired after only 3 min of
 * perceived idle. Root cause was a polling-only busy check: the 2-min
 * dream poll sampled `getAgentWorkStatus`, and if the agent's busy
 * window fell entirely between two polls (claude-code turns are often
 * 30-60s), the poll never saw 'busy' and `idleSince` was never reset.
 *
 * Fix: DreamManager's constructor registers listeners on
 * `daemon.onAgentBusy` + `daemon.onAgentIdle` so every work transition
 * updates `idleSince` immediately. The polling loop is still there as
 * a fallback for agents that were idle at daemon startup (no
 * transition will fire for them).
 *
 * These tests verify the wiring by constructing DreamManager with a
 * stub daemon that captures the registered callbacks, then invoking
 * them to prove the internal `idleSince` map reacts correctly.
 */

interface StubDaemon {
  busyCb: ((memberId: string, displayName: string) => void) | null;
  idleCb: ((memberId: string, displayName: string) => void) | null;
  onAgentBusy: (cb: (memberId: string, displayName: string) => void) => void;
  onAgentIdle: (cb: (memberId: string, displayName: string) => void) => void;
  clocks: { register: () => void };
  corpRoot: string;
  inbox: unknown;
  processManager: unknown;
  events: unknown;
}

function makeStub(): StubDaemon {
  const stub: StubDaemon = {
    busyCb: null,
    idleCb: null,
    onAgentBusy: (cb) => { stub.busyCb = cb; },
    onAgentIdle: (cb) => { stub.idleCb = cb; },
    clocks: { register: () => {} },
    corpRoot: '/tmp/fake-corp',
    inbox: {},
    processManager: {},
    events: { broadcast: () => {} },
  };
  return stub;
}

describe('DreamManager idle tracking — event-driven', () => {
  it('registers both onAgentBusy and onAgentIdle on construction', () => {
    const stub = makeStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new DreamManager(stub as any);
    expect(stub.busyCb).toBeTypeOf('function');
    expect(stub.idleCb).toBeTypeOf('function');
  });

  it('onAgentIdle sets idleSince to current time', () => {
    const stub = makeStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dreams = new DreamManager(stub as any);

    const before = Date.now();
    stub.idleCb!('ceo', 'CEO');
    const after = Date.now();

    // Access internal map via bracket notation (private but present at runtime)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idleSince = (dreams as any).idleSince as Map<string, number>;
    const t = idleSince.get('ceo');
    expect(t).toBeDefined();
    expect(t!).toBeGreaterThanOrEqual(before);
    expect(t!).toBeLessThanOrEqual(after);
  });

  it('onAgentBusy clears idleSince — a brief busy spike resets the 5-min clock', () => {
    const stub = makeStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dreams = new DreamManager(stub as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idleSince = (dreams as any).idleSince as Map<string, number>;

    // Simulate agent was marked idle 10 min ago
    idleSince.set('ceo', Date.now() - 10 * 60_000);
    expect(idleSince.has('ceo')).toBe(true);

    // A brief busy spike — this is what the old poll-only code missed
    stub.busyCb!('ceo', 'CEO');
    expect(idleSince.has('ceo')).toBe(false);
  });

  it('busy→idle→busy→idle sequence resets timer on each idle transition', () => {
    const stub = makeStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dreams = new DreamManager(stub as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idleSince = (dreams as any).idleSince as Map<string, number>;

    stub.idleCb!('ceo', 'CEO');
    const first = idleSince.get('ceo')!;

    // Force a small time gap so the second timestamp is observably larger
    const sleepUntil = first + 2;
    while (Date.now() < sleepUntil) { /* spin */ }

    stub.busyCb!('ceo', 'CEO');
    expect(idleSince.has('ceo')).toBe(false);

    stub.idleCb!('ceo', 'CEO');
    const second = idleSince.get('ceo')!;
    expect(second).toBeGreaterThan(first);
  });
});
