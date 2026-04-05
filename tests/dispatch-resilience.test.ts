import { describe, it, expect } from 'vitest';
import {
  categorizeError,
  getBackoffMs,
  isRetryable,
  ContextBlocker,
  DispatchHealthTracker,
  GraduatedUnblocker,
} from '../packages/daemon/src/dispatch-resilience.js';

describe('categorizeError', () => {
  it('detects rate limit', () => {
    expect(categorizeError(new Error('429 Too Many Requests'))).toBe('rate_limit');
    expect(categorizeError(new Error('rate limit reached'))).toBe('rate_limit');
  });

  it('detects auth errors', () => {
    expect(categorizeError(new Error('401 Unauthorized'))).toBe('auth');
    expect(categorizeError(new Error('403 Forbidden'))).toBe('auth');
  });

  it('detects timeout', () => {
    expect(categorizeError(new Error('Request timed out'))).toBe('timeout');
  });

  it('detects overloaded', () => {
    expect(categorizeError(new Error('service overloaded'))).toBe('overloaded');
    expect(categorizeError(new Error('503 Service Unavailable'))).toBe('overloaded');
  });

  it('detects network errors', () => {
    expect(categorizeError(new Error('ECONNREFUSED'))).toBe('network');
    expect(categorizeError(new Error('fetch failed'))).toBe('network');
  });

  it('returns unknown for unrecognized', () => {
    expect(categorizeError(new Error('something weird'))).toBe('unknown');
  });
});

describe('getBackoffMs', () => {
  it('increases exponentially for rate_limit', () => {
    const b0 = getBackoffMs('rate_limit', 0);
    const b1 = getBackoffMs('rate_limit', 1);
    const b2 = getBackoffMs('rate_limit', 2);
    expect(b0).toBe(5000);
    expect(b1).toBeGreaterThan(b0);
    expect(b2).toBeGreaterThan(b1);
  });

  it('returns 0 for auth (no retry)', () => {
    expect(getBackoffMs('auth', 0)).toBe(0);
    expect(isRetryable('auth')).toBe(false);
  });

  it('caps at maxMs', () => {
    const b10 = getBackoffMs('rate_limit', 10);
    expect(b10).toBeLessThanOrEqual(300_000); // 5 min max
  });
});

describe('ContextBlocker', () => {
  it('starts unblocked', () => {
    const cb = new ContextBlocker();
    expect(cb.isBlocked()).toBe(false);
  });

  it('blocks and unblocks', () => {
    const cb = new ContextBlocker();
    cb.block('rate_limit');
    expect(cb.isBlocked()).toBe(true);
    expect(cb.getBlockReason()).toBe('rate_limit');
    cb.unblock();
    expect(cb.isBlocked()).toBe(false);
  });

  it('shouldBlock returns true for auth/rate_limit/overloaded', () => {
    expect(ContextBlocker.shouldBlock('auth')).toBe(true);
    expect(ContextBlocker.shouldBlock('rate_limit')).toBe(true);
    expect(ContextBlocker.shouldBlock('timeout')).toBe(false);
    expect(ContextBlocker.shouldBlock('network')).toBe(false);
  });
});

describe('DispatchHealthTracker', () => {
  it('starts healthy', () => {
    const ht = new DispatchHealthTracker();
    expect(ht.getScore('ceo')).toBe(1.0);
    expect(ht.getStatus('ceo')).toBe('healthy');
  });

  it('degrades on failures', () => {
    const ht = new DispatchHealthTracker({ windowSize: 4 });
    ht.recordFailure('ceo', new Error('timeout'));
    ht.recordFailure('ceo', new Error('timeout'));
    ht.recordFailure('ceo', new Error('timeout'));
    expect(ht.getScore('ceo')).toBeLessThan(0.5);
    expect(ht.getStatus('ceo')).toBe('degraded');
  });

  it('recovers with successes', () => {
    const ht = new DispatchHealthTracker({ windowSize: 4 });
    ht.recordFailure('ceo', new Error('timeout'));
    ht.recordFailure('ceo', new Error('timeout'));
    ht.recordSuccess('ceo');
    ht.recordSuccess('ceo');
    ht.recordSuccess('ceo');
    ht.recordSuccess('ceo');
    expect(ht.getScore('ceo')).toBe(1.0);
  });
});

describe('GraduatedUnblocker', () => {
  it('starts inactive', () => {
    const gu = new GraduatedUnblocker();
    expect(gu.isInGracePeriod()).toBe(false);
    expect(gu.getThrottleMultiplier()).toBe(1);
  });

  it('activates grace period and clears after N successes', () => {
    const gu = new GraduatedUnblocker(2);
    gu.startGrace();
    expect(gu.isInGracePeriod()).toBe(true);
    expect(gu.getThrottleMultiplier()).toBe(2);

    gu.recordSuccess();
    expect(gu.isInGracePeriod()).toBe(true); // 1/2

    gu.recordSuccess();
    expect(gu.isInGracePeriod()).toBe(false); // 2/2 — done
    expect(gu.getThrottleMultiplier()).toBe(1);
  });

  it('failure during grace returns true (should re-block)', () => {
    const gu = new GraduatedUnblocker(3);
    gu.startGrace();
    const shouldReblock = gu.recordFailure();
    expect(shouldReblock).toBe(true);
    expect(gu.isInGracePeriod()).toBe(false);
  });
});
