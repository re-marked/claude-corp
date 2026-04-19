import { describe, it, expect } from 'vitest';
import {
  agentSessionKey,
  isAgentSession,
  AGENT_SESSION_PREFIX,
} from '../packages/shared/src/session-key.js';

// One brain per agent — every reasoning dispatch funnels through the
// same `agent:<slug>` key. These tests pin the normalization contract
// so migration sites that feed in display names, pre-slugged strings,
// or mixed-case inputs all land on the identical key.

describe('agentSessionKey', () => {
  it('returns agent:<slug> for a normalized input', () => {
    expect(agentSessionKey('ceo')).toBe('agent:ceo');
  });

  it('lowercases display names', () => {
    expect(agentSessionKey('CEO')).toBe('agent:ceo');
    expect(agentSessionKey('Herald')).toBe('agent:herald');
  });

  it('collapses whitespace to dashes (multi-word display names)', () => {
    expect(agentSessionKey('Lead Coder')).toBe('agent:lead-coder');
    expect(agentSessionKey('Git Janitor')).toBe('agent:git-janitor');
  });

  it('collapses multiple whitespace runs into single dashes', () => {
    expect(agentSessionKey('Foo   Bar  Baz')).toBe('agent:foo-bar-baz');
  });

  it('trims surrounding whitespace', () => {
    expect(agentSessionKey('  ceo  ')).toBe('agent:ceo');
  });

  it('is idempotent — feeding an already-normalized slug returns it unchanged', () => {
    expect(agentSessionKey('lead-coder')).toBe('agent:lead-coder');
    // Double-applying the normalization must not produce agent:agent:...
    const once = agentSessionKey('CEO');
    expect(agentSessionKey(once.replace(AGENT_SESSION_PREFIX, ''))).toBe(once);
  });
});

describe('isAgentSession', () => {
  it('recognizes agent: keys', () => {
    expect(isAgentSession('agent:ceo')).toBe(true);
    expect(isAgentSession('agent:lead-coder')).toBe(true);
  });

  it('rejects legacy prefixes', () => {
    expect(isAgentSession('jack:ceo')).toBe(false);
    expect(isAgentSession('say:mark:ceo')).toBe(false);
    expect(isAgentSession('cron:daily')).toBe(false);
    expect(isAgentSession('heartbeat:herald')).toBe(false);
  });

  it('rejects unrelated strings', () => {
    expect(isAgentSession('')).toBe(false);
    expect(isAgentSession('agent')).toBe(false);
    expect(isAgentSession('AGENT:ceo')).toBe(false); // case-sensitive
  });
});

describe('AGENT_SESSION_PREFIX', () => {
  it('is the canonical prefix string', () => {
    expect(AGENT_SESSION_PREFIX).toBe('agent:');
  });

  it('is what agentSessionKey prefixes', () => {
    expect(agentSessionKey('x').startsWith(AGENT_SESSION_PREFIX)).toBe(true);
  });
});
