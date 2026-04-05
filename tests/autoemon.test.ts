/**
 * Autoemon state machine tests.
 *
 * Tests the core logic of the autonomous tick engine:
 * - Global state transitions (activate/deactivate/pause/resume/block/unblock)
 * - Agent enrollment and discharge
 * - Adaptive interval calculation
 * - Tick response parsing (productive/idle/sleep detection)
 * - Tick recording and counter management
 * - Sleep/wake mechanics
 * - Duration and budget guards
 *
 * Uses a minimal mock daemon — no real network, no real filesystem.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AutoemonManager,
  DEFAULT_TICK_INTERVAL_MS,
  MIN_TICK_INTERVAL_MS,
  MAX_TICK_INTERVAL_MS,
  SLEEP_PATTERN,
  type AutoemonGlobalState,
} from '../packages/daemon/src/autoemon.js';
import {
  buildTickMessage,
  buildFirstTickMessage,
  buildSleepWakeTick,
  buildBatchedTickMessage,
} from '../packages/daemon/src/autoemon-prompt.js';

// ── Minimal mock daemon ────────────────────────────────────────────
// AutoemonManager reads state from disk and uses daemon services.
// We mock just enough to make the state machine testable.

function createMockDaemon(corpRoot?: string): any {
  return {
    corpRoot: corpRoot ?? '/tmp/test-corp',
    events: {
      broadcast: () => {},
      getClientCount: () => 0,
    },
    clocks: {
      register: () => {},
      remove: () => {},
    },
    inbox: {
      peekNext: () => null,
    },
    dreams: {
      schedulePostSlumberDreams: () => {},
    },
    lastFounderInteractionAt: 0,
    getPort: () => 3000,
    getAgentWorkStatus: () => 'idle',
  };
}

// AutoemonManager loads state from disk in constructor.
// We need to make sure it doesn't crash on missing files.
// The loadState() method returns defaults if file doesn't exist.

describe('AutoemonManager — state transitions', () => {
  let manager: AutoemonManager;
  let mockDaemon: any;

  beforeEach(() => {
    mockDaemon = createMockDaemon();
    manager = new AutoemonManager(mockDaemon);
  });

  it('starts in inactive state', () => {
    expect(manager.getGlobalState()).toBe('inactive');
    expect(manager.isActive()).toBe(false);
    expect(manager.isOn()).toBe(false);
  });

  it('activates from inactive → active', () => {
    manager.activate('slumber');
    expect(manager.getGlobalState()).toBe('active');
    expect(manager.isActive()).toBe(true);
    expect(manager.isOn()).toBe(true);
  });

  it('ignores double activation', () => {
    manager.activate('slumber');
    manager.activate('manual'); // Should be ignored
    expect(manager.getGlobalState()).toBe('active');
    const status = manager.getStatus();
    expect(status.activatedBy).toBe('slumber'); // First activation wins
  });

  it('deactivates from active → inactive', () => {
    manager.activate('slumber');
    manager.deactivate();
    expect(manager.getGlobalState()).toBe('inactive');
    expect(manager.isActive()).toBe(false);
    expect(manager.isOn()).toBe(false);
  });

  it('deactivate from inactive is no-op', () => {
    manager.deactivate(); // Should not throw
    expect(manager.getGlobalState()).toBe('inactive');
  });

  it('pauses from active → paused', () => {
    manager.activate('slumber');
    manager.pause();
    expect(manager.getGlobalState()).toBe('paused');
    expect(manager.isActive()).toBe(false);
    expect(manager.isOn()).toBe(true); // paused is still "on"
  });

  it('cannot pause from inactive', () => {
    manager.pause(); // Should be ignored
    expect(manager.getGlobalState()).toBe('inactive');
  });

  it('resumes from paused → active', () => {
    manager.activate('slumber');
    manager.pause();
    manager.resume();
    expect(manager.getGlobalState()).toBe('active');
    expect(manager.isActive()).toBe(true);
  });

  it('cannot resume from inactive', () => {
    manager.resume(); // Should be ignored
    expect(manager.getGlobalState()).toBe('inactive');
  });

  it('activates from paused → active (re-activation)', () => {
    manager.activate('slumber');
    manager.pause();
    manager.activate('manual');
    expect(manager.getGlobalState()).toBe('active');
  });

  it('blocks from active → blocked', () => {
    manager.activate('slumber');
    manager.block('rate limit hit');
    expect(manager.getGlobalState()).toBe('blocked');
    const status = manager.getStatus();
    expect(status.blockReason).toBe('rate limit hit');
  });

  it('cannot block from inactive', () => {
    manager.block('should not work');
    expect(manager.getGlobalState()).toBe('inactive');
  });

  it('unblocks from blocked → active', () => {
    manager.activate('slumber');
    manager.block('rate limit');
    manager.unblock();
    expect(manager.getGlobalState()).toBe('active');
    const status = manager.getStatus();
    expect(status.blockReason).toBeNull();
  });

  it('cannot unblock from non-blocked', () => {
    manager.activate('slumber');
    manager.unblock(); // Already active, should be no-op
    expect(manager.getGlobalState()).toBe('active');
  });

  it('deactivate clears all state', () => {
    manager.activate('slumber', 60_000);
    manager.deactivate();
    const status = manager.getStatus();
    expect(status.activatedBy).toBeNull();
    expect(status.activatedAt).toBeNull();
    expect(status.activeProfileId).toBeNull();
    expect(status.blockReason).toBeNull();
  });
});

describe('AutoemonManager — agent enrollment', () => {
  let manager: AutoemonManager;

  beforeEach(() => {
    manager = new AutoemonManager(createMockDaemon());
  });

  it('enrolls an agent', () => {
    manager.activate('slumber');
    manager.enroll('agent-001');
    expect(manager.isEnrolled('agent-001')).toBe(true);
    expect(manager.getEnrolledAgents()).toContain('agent-001');
  });

  it('ignores duplicate enrollment', () => {
    manager.activate('slumber');
    manager.enroll('agent-001');
    manager.enroll('agent-001'); // Duplicate
    expect(manager.getEnrolledAgents()).toHaveLength(1);
  });

  it('creates default agent state on enroll', () => {
    manager.activate('slumber');
    manager.enroll('agent-001');
    const state = manager.getAgentState('agent-001');
    expect(state).not.toBeNull();
    expect(state!.state).toBe('active');
    expect(state!.tickCount).toBe(0);
    expect(state!.productiveTickCount).toBe(0);
    expect(state!.consecutiveIdleTicks).toBe(0);
    expect(state!.consecutiveErrors).toBe(0);
    expect(state!.sleepUntil).toBeNull();
    expect(state!.tickIntervalMs).toBe(DEFAULT_TICK_INTERVAL_MS);
  });

  it('discharges an agent', () => {
    manager.activate('slumber');
    manager.enroll('agent-001');
    manager.discharge('agent-001');
    expect(manager.isEnrolled('agent-001')).toBe(false);
    expect(manager.getAgentState('agent-001')).toBeNull();
  });

  it('discharge of non-enrolled agent is no-op', () => {
    manager.discharge('nonexistent'); // Should not throw
    expect(manager.isEnrolled('nonexistent')).toBe(false);
  });

  it('deactivation discharges all agents', () => {
    manager.activate('slumber');
    manager.enroll('agent-001');
    manager.enroll('agent-002');
    manager.enroll('agent-003');
    expect(manager.getEnrolledAgents()).toHaveLength(3);
    manager.deactivate();
    expect(manager.getEnrolledAgents()).toHaveLength(0);
  });
});

describe('AutoemonManager — tick recording', () => {
  let manager: AutoemonManager;

  beforeEach(() => {
    manager = new AutoemonManager(createMockDaemon());
    manager.activate('slumber');
    manager.enroll('agent-001');
  });

  it('records productive tick', () => {
    manager.recordTick('agent-001', true);
    const state = manager.getAgentState('agent-001')!;
    expect(state.tickCount).toBe(1);
    expect(state.productiveTickCount).toBe(1);
    expect(state.consecutiveIdleTicks).toBe(0);
    const status = manager.getStatus();
    expect(status.totalTicks).toBe(1);
    expect(status.totalProductiveTicks).toBe(1);
  });

  it('records idle tick', () => {
    manager.recordTick('agent-001', false);
    const state = manager.getAgentState('agent-001')!;
    expect(state.tickCount).toBe(1);
    expect(state.productiveTickCount).toBe(0);
    expect(state.consecutiveIdleTicks).toBe(1);
  });

  it('productive tick resets consecutive idle counter', () => {
    manager.recordTick('agent-001', false);
    manager.recordTick('agent-001', false);
    manager.recordTick('agent-001', true); // Productive resets idle counter
    const state = manager.getAgentState('agent-001')!;
    expect(state.consecutiveIdleTicks).toBe(0);
    expect(state.tickCount).toBe(3);
    expect(state.productiveTickCount).toBe(1);
  });

  it('consecutive idle ticks accumulate', () => {
    for (let i = 0; i < 5; i++) {
      manager.recordTick('agent-001', false);
    }
    const state = manager.getAgentState('agent-001')!;
    expect(state.consecutiveIdleTicks).toBe(5);
    expect(state.tickCount).toBe(5);
    expect(state.productiveTickCount).toBe(0);
  });

  it('error recording increments consecutiveErrors', () => {
    manager.recordError('agent-001');
    manager.recordError('agent-001');
    const state = manager.getAgentState('agent-001')!;
    expect(state.consecutiveErrors).toBe(2);
  });

  it('productive tick resets consecutiveErrors', () => {
    manager.recordError('agent-001');
    manager.recordError('agent-001');
    manager.recordTick('agent-001', true);
    const state = manager.getAgentState('agent-001')!;
    expect(state.consecutiveErrors).toBe(0);
  });

  it('recording on non-enrolled agent is no-op', () => {
    manager.recordTick('nonexistent', true); // Should not throw
    manager.recordError('nonexistent'); // Should not throw
  });
});

describe('AutoemonManager — sleep/wake', () => {
  let manager: AutoemonManager;

  beforeEach(() => {
    manager = new AutoemonManager(createMockDaemon());
    manager.activate('slumber');
    manager.enroll('agent-001');
  });

  it('puts agent to sleep', () => {
    const until = Date.now() + 300_000; // 5 minutes
    manager.setSleeping('agent-001', until, 'waiting for build');
    expect(manager.isSleeping('agent-001')).toBe(true);
    const state = manager.getAgentState('agent-001')!;
    expect(state.state).toBe('sleeping');
    expect(state.sleepUntil).toBe(until);
    expect(state.sleepReason).toBe('waiting for build');
  });

  it('getSleepInfo returns sleep details', () => {
    const until = Date.now() + 300_000;
    manager.setSleeping('agent-001', until, 'thinking');
    const info = manager.getSleepInfo('agent-001');
    expect(info).not.toBeNull();
    expect(info!.reason).toBe('thinking');
    expect(info!.remainingMs).toBeGreaterThan(0);
    expect(info!.remainingMs).toBeLessThanOrEqual(300_000);
  });

  it('getSleepInfo returns null for non-sleeping agent', () => {
    expect(manager.getSleepInfo('agent-001')).toBeNull();
  });

  it('wakes agent from sleep', () => {
    manager.setSleeping('agent-001', Date.now() + 300_000, 'build wait');
    manager.wakeAgent('agent-001', 'user_message', 'founder sent DM');
    expect(manager.isSleeping('agent-001')).toBe(false);
    const state = manager.getAgentState('agent-001')!;
    expect(state.state).toBe('active');
    expect(state.sleepUntil).toBeNull();
    expect(state.sleepReason).toBeNull();
    expect(state.nextTickAt).toBeLessThanOrEqual(Date.now()); // Immediate tick
  });

  it('wake reason is consumable', () => {
    manager.setSleeping('agent-001', Date.now() + 300_000, 'build wait');
    manager.wakeAgent('agent-001', 'urgent_task', 'P0 task assigned');
    const reason = manager.consumeWakeReason('agent-001');
    expect(reason).not.toBeNull();
    expect(reason!.reason).toBe('urgent_task');
    expect(reason!.detail).toBe('P0 task assigned');
    // Second consume returns null
    expect(manager.consumeWakeReason('agent-001')).toBeNull();
  });

  it('waking a non-sleeping agent is no-op', () => {
    manager.wakeAgent('agent-001', 'manual_wake');
    const state = manager.getAgentState('agent-001')!;
    expect(state.state).toBe('active'); // Was already active
  });

  it('isSleeping returns false for non-enrolled agent', () => {
    expect(manager.isSleeping('nonexistent')).toBe(false);
  });
});

describe('AutoemonManager — interval adaptation', () => {
  let manager: AutoemonManager;

  beforeEach(() => {
    manager = new AutoemonManager(createMockDaemon());
    manager.activate('slumber');
    manager.enroll('agent-001');
  });

  it('setTickInterval clamps to min/max', () => {
    manager.setTickInterval('agent-001', 1_000); // Way below min
    expect(manager.getAgentState('agent-001')!.tickIntervalMs).toBe(MIN_TICK_INTERVAL_MS);

    manager.setTickInterval('agent-001', 999_999_999); // Way above max
    expect(manager.getAgentState('agent-001')!.tickIntervalMs).toBe(MAX_TICK_INTERVAL_MS);
  });

  it('setNextTick updates nextTickAt', () => {
    const future = Date.now() + 60_000;
    manager.setNextTick('agent-001', future);
    expect(manager.getAgentState('agent-001')!.nextTickAt).toBe(future);
  });

  it('setTickInterval on non-enrolled agent is no-op', () => {
    manager.setTickInterval('nonexistent', 60_000); // Should not throw
  });
});

describe('AutoemonManager — status reporting', () => {
  let manager: AutoemonManager;

  beforeEach(() => {
    manager = new AutoemonManager(createMockDaemon());
  });

  it('getStatus reflects full state', () => {
    manager.activate('afk', 3_600_000);
    manager.enroll('agent-001');
    manager.enroll('agent-002');
    manager.recordTick('agent-001', true);
    manager.recordTick('agent-002', false);

    const status = manager.getStatus();
    expect(status.globalState).toBe('active');
    expect(status.activatedBy).toBe('afk');
    expect(status.activatedAt).toBeGreaterThan(0);
    expect(status.enrolledCount).toBe(2);
    expect(status.enrolledAgents).toHaveLength(2);
    expect(status.totalTicks).toBe(2);
    expect(status.totalProductiveTicks).toBe(1);
    expect(status.blockReason).toBeNull();
  });

  it('getStatus returns copy, not reference', () => {
    manager.activate('slumber');
    manager.enroll('agent-001');
    const s1 = manager.getStatus();
    const s2 = manager.getStatus();
    expect(s1.agents).not.toBe(s2.agents); // Different objects
  });
});

describe('SLEEP_PATTERN — agent sleep command parsing', () => {
  it('parses basic SLEEP with duration', () => {
    const match = 'SLEEP 5m — waiting for build'.match(SLEEP_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('5m');
    expect(match![2]).toBe('waiting for build');
  });

  it('parses SLEEP without reason', () => {
    const match = 'SLEEP 10m'.match(SLEEP_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('10m');
    expect(match![2]).toBeUndefined();
  });

  it('parses seconds', () => {
    const match = 'SLEEP 30s — quick break'.match(SLEEP_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('30s');
  });

  it('parses hours', () => {
    const match = 'SLEEP 2h — long running task'.match(SLEEP_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2h');
  });

  it('parses compound duration (1h30m)', () => {
    const match = 'SLEEP 1h30m — overnight'.match(SLEEP_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('1h30m');
  });

  it('is case-insensitive', () => {
    const match = 'sleep 5m — reason'.match(SLEEP_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('5m');
  });

  it('matches SLEEP embedded in longer response', () => {
    const response = 'Nothing to do right now. SLEEP 15m — no pending tasks. Will check back later.';
    const match = response.match(SLEEP_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('15m');
    expect(match![2]).toBe('no pending tasks. Will check back later.');
  });

  it('does not match non-SLEEP text', () => {
    expect('I will sleep now'.match(SLEEP_PATTERN)).toBeNull();
    expect('SLEEPING 5m'.match(SLEEP_PATTERN)).toBeNull();
    expect('SLEEP — no duration'.match(SLEEP_PATTERN)).toBeNull();
  });
});

describe('buildTickMessage — tick prompt construction', () => {
  const fixedTime = new Date('2026-04-05T14:30:00Z');

  it('builds basic tick with presence', () => {
    const msg = buildTickMessage({ presence: 'away', time: fixedTime });
    expect(msg).toContain('<tick>');
    expect(msg).toContain('</tick>');
    expect(msg).toContain('<presence>away</presence>');
    expect(msg).toContain('2026-04-05');
  });

  it('includes context attributes', () => {
    const msg = buildTickMessage({
      presence: 'idle',
      context: { pendingTasks: 3, unreadInbox: 1 },
      time: fixedTime,
    });
    expect(msg).toContain('tasks="3"');
    expect(msg).toContain('inbox="1"');
  });

  it('includes mood and focus from profile', () => {
    const msg = buildTickMessage({
      presence: 'away',
      context: {
        mood: 'You are in night owl mode. Be quiet and deep.',
        focus: 'Focus on code quality over speed.',
      },
      time: fixedTime,
    });
    expect(msg).toContain('<mood>You are in night owl mode');
    expect(msg).toContain('<focus>Focus on code quality');
  });

  it('includes previous tick result', () => {
    const msg = buildTickMessage({
      presence: 'away',
      previousResult: 'Built 3 files successfully',
      time: fixedTime,
    });
    expect(msg).toContain('<previous-tick-result>Built 3 files successfully</previous-tick-result>');
  });

  it('includes last action for continuity', () => {
    const msg = buildTickMessage({
      presence: 'idle',
      context: { lastAction: 'reviewing PR #42' },
      time: fixedTime,
    });
    expect(msg).toContain('<last-action>reviewing PR #42</last-action>');
  });
});

describe('buildFirstTickMessage — session start', () => {
  it('includes session-start block', () => {
    const msg = buildFirstTickMessage({
      presence: 'away',
      agentName: 'CEO',
      source: 'slumber',
    });
    expect(msg).toContain('<session-start>');
    expect(msg).toContain('SLUMBER mode');
    expect(msg).toContain('</session-start>');
    expect(msg).toContain('first="true"');
  });

  it('includes goal when provided', () => {
    const msg = buildFirstTickMessage({
      presence: 'away',
      agentName: 'CEO',
      source: 'slumber',
      goal: 'Ship the auth module',
    });
    expect(msg).toContain('Ship the auth module');
  });

  it('includes enrolled count', () => {
    const msg = buildFirstTickMessage({
      presence: 'away',
      agentName: 'CEO',
      source: 'afk',
      enrolledCount: 5,
    });
    expect(msg).toContain('5 agents conscripted');
    expect(msg).toContain('AFK mode');
  });
});

describe('buildSleepWakeTick — wake-up message', () => {
  it('includes sleep duration and reason', () => {
    const msg = buildSleepWakeTick({
      presence: 'away',
      sleptForMs: 15 * 60_000,
      wakeReason: 'timer',
    });
    expect(msg).toContain('slept="15m"');
    expect(msg).toContain('sleep timer expired');
  });

  it('includes while-asleep summary', () => {
    const msg = buildSleepWakeTick({
      presence: 'idle',
      sleptForMs: 5 * 60_000,
      wakeReason: 'user_message',
      whileAsleep: '2 new tasks assigned',
    });
    expect(msg).toContain('founder sent a message');
    expect(msg).toContain('While you slept: 2 new tasks assigned');
  });

  it('handles urgent task wake', () => {
    const msg = buildSleepWakeTick({
      presence: 'away',
      sleptForMs: 30_000,
      wakeReason: 'urgent_task',
    });
    expect(msg).toContain('urgent task assigned');
  });
});

describe('buildBatchedTickMessage — missed ticks', () => {
  const fixedTime = new Date('2026-04-05T14:30:00Z');

  it('includes batch count', () => {
    const msg = buildBatchedTickMessage({
      batchCount: 3,
      presence: 'away',
      time: fixedTime,
    });
    expect(msg).toContain('batched="3"');
  });

  it('single tick has no batch attribute', () => {
    const msg = buildBatchedTickMessage({
      batchCount: 1,
      presence: 'away',
      time: fixedTime,
    });
    expect(msg).not.toContain('batched');
  });
});
