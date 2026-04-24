import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression tests for session key determinism.
 *
 * v2.1.11 fixed three dispatchers that used to mint timestamp-based
 * keys (fresh claude session every fire, no memory across calls).
 *
 * v2.5.0 goes further — unifies every reasoning dispatch onto a single
 * per-agent session (`agent:<slug>`). One brain per agent, period. No
 * more per-channel split, no more per-kind split (cron/loop/heartbeat
 * were all separate sessions before). These tests now verify the
 * unified shape: every site calls `agentSessionKey()` instead of
 * hand-rolling a prefix.
 */

const REPO_ROOT = join(__dirname, '..');

function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8');
}

describe('pulse escalation/recovery route into CEO main thread', () => {
  const pulse = readSource('packages/daemon/src/pulse.ts');

  it('escalation uses agentSessionKey — not a timestamp-based key', () => {
    expect(pulse).not.toMatch(/sessionKey:\s*`pulse-escalation/);
    expect(pulse).toMatch(/ESCALATION from Pulse[\s\S]*?sessionKey:\s*agentSessionKey\('ceo'\)/);
  });

  it('recovery uses agentSessionKey — not a timestamp-based key', () => {
    expect(pulse).not.toMatch(/sessionKey:\s*`pulse-recovery/);
    expect(pulse).toMatch(/RECOVERY: Agent[\s\S]*?sessionKey:\s*agentSessionKey\('ceo'\)/);
  });
});

describe('router @mention lands on the agent session', () => {
  const router = readSource('packages/daemon/src/router.ts');

  it('does not bake msg.id into the key (would reset session every message)', () => {
    expect(router).not.toMatch(/sessionKey:\s*`agent:[^`]*\$\{[^}]*msg\.id/);
    expect(router).not.toMatch(/sessionKey:\s*`[^`]*-\$\{msg\.id\}/);
  });

  it('uses agentSessionKey() — no more per-channel split', () => {
    // v2.5.0 collapsed the previous `agent:<id>:channel-<cid>` scoping
    // into one session per agent. The agent's #general replies and DMs
    // now share memory.
    expect(router).not.toMatch(/channel-\$\{channel\.id\}/);
    expect(router).toMatch(/agentSessionKey\(target\.displayName\)/);
  });
});

describe('ambient work unifies on agent session (one brain per agent)', () => {
  it('crons.ts routes through agentSessionKey', () => {
    const crons = readSource('packages/daemon/src/crons.ts');
    expect(crons).not.toMatch(/sessionKey:\s*`cron:/);
    expect(crons).toMatch(/sessionKey:\s*agentSessionKey\(clock\.targetAgent\)/);
  });

  it('loops.ts routes through agentSessionKey', () => {
    const loops = readSource('packages/daemon/src/loops.ts');
    expect(loops).not.toMatch(/sessionKey:\s*`loop:/);
    expect(loops).toMatch(/sessionKey:\s*agentSessionKey\(clock\.targetAgent\)/);
  });

  it('pulse heartbeat routes through agentSessionKey', () => {
    const pulse = readSource('packages/daemon/src/pulse.ts');
    expect(pulse).not.toMatch(/sessionKey:\s*`heartbeat:/);
    expect(pulse).toMatch(/sessionKey:\s*agentSessionKey\(agentSlug\)/);
  });

  it('autoemon ticks route through agentSessionKey', () => {
    const autoemon = readSource('packages/daemon/src/autoemon.ts');
    expect(autoemon).not.toMatch(/sessionKey\s*=\s*`jack:/);
    expect(autoemon).toMatch(/sessionKey\s*=\s*agentSessionKey\(agentSlug\)/);
  });

  it('dreams route through agentSessionKey', () => {
    const dreams = readSource('packages/daemon/src/dreams.ts');
    expect(dreams).not.toMatch(/sessionKey:\s*`jack:/);
    expect(dreams).toMatch(/sessionKey:\s*agentSessionKey\(slug\)/);
  });

  it('herald in daemon.ts routes through agentSessionKey', () => {
    // Project 1.9.2: the failsafe assertion that used to accompany
    // herald here was removed when hireFailsafe + the
    // dispatchFailsafeHeartbeat method were deleted. Sexton's dispatch
    // path lands in a later 1.9 PR (Pulse/Alarum/Sexton runtime
    // skeleton); when it does, add an equivalent sexton assertion here.
    const daemon = readSource('packages/daemon/src/daemon.ts');
    expect(daemon).not.toMatch(/sessionKey:\s*`herald-narration:/);
    expect(daemon).toMatch(/sessionKey:\s*agentSessionKey\('herald'\)/);
  });
});
