import { describe, it, expect } from 'vitest';
import { fixNowFragment } from '../packages/daemon/src/fragments/fix-now.js';
import type { FragmentContext } from '../packages/daemon/src/fragments/types.js';

function ctx(): FragmentContext {
  return {
    agentDir: '/tmp/agent',
    corpRoot: '/tmp/corp',
    channelName: 'dm',
    channelMembers: ['alice', 'mark'],
    corpMembers: [],
    recentHistory: [],
    agentDisplayName: 'alice',
    channelKind: 'direct',
    supervisorName: 'ceo',
  };
}

describe('fix-now fragment', () => {
  it('always applies — core behavioral default, universal', () => {
    expect(fixNowFragment.applies(ctx())).toBe(true);
  });

  it('orders before anti-rationalization (55 < 60)', () => {
    expect(fixNowFragment.order).toBe(55);
  });

  const body = fixNowFragment.render(ctx());

  it('names the anti-pattern explicitly (not "got it" / "will do" / "next time")', () => {
    expect(body).toMatch(/got it/i);
    expect(body).toMatch(/will do|I'll remember|noted/i);
    expect(body).toMatch(/next time/i);
  });

  it('prescribes the tool call as the response', () => {
    expect(body).toMatch(/tool call is the response/i);
  });

  it('names the single diagnostic question the agent should ask', () => {
    expect(body).toMatch(/still fixable in this turn/i);
  });

  it('carves out legitimate acknowledgment cases (past decisions, future preferences, behavioral feedback)', () => {
    expect(body).toMatch(/past decision/i);
    expect(body).toMatch(/future.*call|architectural/i);
  });

  it('provides a fallback when in doubt (ask, don\'t assume)', () => {
    expect(body).toMatch(/fix that now|in doubt/i);
  });
});
