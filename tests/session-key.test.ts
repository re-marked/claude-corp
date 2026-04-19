import { describe, it, expect } from 'vitest';
import {
  agentSessionKey,
  isAgentSession,
  AGENT_SESSION_PREFIX,
} from '../packages/shared/src/session-key.js';

describe('agentSessionKey — one brain per agent', () => {
  it('produces a stable agent: prefix', () => {
    expect(agentSessionKey('ceo')).toBe('agent:ceo');
    expect(agentSessionKey('herald')).toBe('agent:herald');
  });

  it('lowercases display names', () => {
    expect(agentSessionKey('CEO')).toBe('agent:ceo');
    expect(agentSessionKey('Herald')).toBe('agent:herald');
  });

  it('collapses whitespace to dashes', () => {
    expect(agentSessionKey('Lead Coder')).toBe('agent:lead-coder');
    expect(agentSessionKey('Project   Manager')).toBe('agent:project-manager');
  });

  it('trims surrounding whitespace', () => {
    expect(agentSessionKey('  ceo  ')).toBe('agent:ceo');
  });

  it('is idempotent (feeding an already-normalized slug is a fixed point)', () => {
    const once = agentSessionKey('Lead Coder');
    const twice = agentSessionKey('lead-coder');
    expect(once).toBe(twice);
    expect(once).toBe('agent:lead-coder');
  });

  it('converges across every path an agent can be named', () => {
    // Router resolves by displayName, CLI by slug, dispatch by ceoSlug,
    // etc. All must collapse to the same key.
    const displayName = 'CEO';
    const slug = 'ceo';
    const normalized = 'ceo';
    expect(agentSessionKey(displayName))
      .toBe(agentSessionKey(slug))
      .toBe(agentSessionKey(normalized));
  });
});

describe('isAgentSession', () => {
  it('recognizes unified session keys', () => {
    expect(isAgentSession('agent:ceo')).toBe(true);
    expect(isAgentSession('agent:lead-coder')).toBe(true);
  });

  it('rejects legacy session keys from before the migration', () => {
    expect(isAgentSession('jack:ceo')).toBe(false);
    expect(isAgentSession('cron:slug')).toBe(false);
    expect(isAgentSession('heartbeat:slug')).toBe(false);
    expect(isAgentSession('pulse-escalation:1234')).toBe(false);
    expect(isAgentSession('say:founder:ceo')).toBe(false);
  });
});

describe('AGENT_SESSION_PREFIX constant', () => {
  it('matches what agentSessionKey emits', () => {
    expect(agentSessionKey('anything').startsWith(AGENT_SESSION_PREFIX)).toBe(true);
  });
});
