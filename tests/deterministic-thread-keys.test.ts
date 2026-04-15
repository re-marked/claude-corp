import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression tests for v2.1.11. Three dispatchers used to mint
 * timestamp-based session keys that derived a fresh UUIDv5 on every
 * fire, so the target agent's claude-code conversation forgot prior
 * context: (1) pulse escalation to CEO, (2) pulse recovery to CEO,
 * (3) router @mention in a channel. Unified them to deterministic
 * keys so the CEO thread and per-channel @mention threads accumulate
 * history across fires.
 *
 * Herald narration and failsafe heartbeat intentionally keep
 * timestamp keys — they're noisy one-off pings that should NOT land
 * in the CEO's main thread.
 */

const REPO_ROOT = join(__dirname, '..');

function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8');
}

describe('pulse escalation/recovery route into CEO main thread', () => {
  const pulse = readSource('packages/daemon/src/pulse.ts');

  it('escalation sessionKey is deterministic (jack:ceo, not pulse-escalation:${ts})', () => {
    expect(pulse).not.toMatch(/sessionKey:\s*`pulse-escalation/);
    expect(pulse).toMatch(/ESCALATION from Pulse[\s\S]*?sessionKey:\s*`jack:ceo`/);
  });

  it('recovery sessionKey is deterministic (jack:ceo, not pulse-recovery:${ts})', () => {
    expect(pulse).not.toMatch(/sessionKey:\s*`pulse-recovery/);
    expect(pulse).toMatch(/RECOVERY: Agent[\s\S]*?sessionKey:\s*`jack:ceo`/);
  });
});

describe('router @mention uses per-channel deterministic session key', () => {
  const router = readSource('packages/daemon/src/router.ts');

  it('sessionKey does not include msg.id (which changes every message)', () => {
    // The old key baked msg.id → fresh session every @mention.
    expect(router).not.toMatch(/sessionKey:\s*`agent:[^`]*\$\{[^}]*msg\.id/);
    expect(router).not.toMatch(/sessionKey:\s*`[^`]*-\$\{msg\.id\}/);
  });

  it('sessionKey is agent+channel scoped (persistent across mentions)', () => {
    expect(router).toMatch(/agent:\$\{targetId\}:channel-\$\{channel\.id\}/);
  });
});
