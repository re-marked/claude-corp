import { describe, it, expect } from 'vitest';
import { buildDreamPrompt } from '../packages/daemon/src/dream-prompt.js';
import type { CultureCandidate } from '../packages/shared/src/culture.js';

function baseOpts() {
  return {
    agentName: 'alice',
    agentDir: '/corp/agents/alice',
    corpRoot: '/corp',
    sessionsSince: 3,
    hoursSinceLast: 2,
    dmChannelPath: null,
    generalChannelPath: null,
    tasksChannelPath: null,
    agentSummaries: [],
  };
}

const STRONG_CANDIDATE: CultureCandidate = {
  sharedTags: ['commits', 'granular'],
  agents: ['alice', 'bob', 'charlie'],
  entries: [
    {
      agent: 'alice', file: 'granular-commits', type: 'correction',
      source: 'correction', confidence: 'high', timesHeard: 2,
      updated: '2026-04-10', excerpt: 'one logical change per commit',
      tags: ['commits', 'granular'],
    },
    {
      agent: 'bob', file: 'commit-style', type: 'correction',
      source: 'correction', confidence: 'medium', timesHeard: 1,
      updated: '2026-04-12', excerpt: 'mark wants one fix per commit',
      tags: ['commits', 'granular'],
    },
    {
      agent: 'charlie', file: 'tiny-commits', type: 'correction',
      source: 'correction', confidence: 'high', timesHeard: 1,
      updated: '2026-04-15', excerpt: 'no bundled commits',
      tags: ['commits', 'granular'],
    },
  ],
  maxTimesHeard: 2, totalTimesHeard: 4, strength: 'strong',
};

describe('dream-prompt: Phase 0 feedback repetition', () => {
  it('pending feedback phase includes times_heard increment instruction', () => {
    const prompt = buildDreamPrompt({
      ...baseOpts(),
      pendingFeedback: '## 2026-04-18T10:00:00Z\n**Quote:**\n> stop summarizing',
    });
    expect(prompt).toContain('times_heard');
    expect(prompt).toContain('Increment');
  });

  it('pending feedback phase instructs to check existing BRAIN FIRST', () => {
    const prompt = buildDreamPrompt({
      ...baseOpts(),
      pendingFeedback: '## x\n**Quote:** > test',
    });
    expect(prompt).toContain('Check for a matching existing BRAIN entry FIRST');
  });

  it('does NOT render Phase 0 when no pending feedback', () => {
    const prompt = buildDreamPrompt(baseOpts());
    expect(prompt).not.toContain('Phase 0 — Pending Feedback');
  });
});

describe('dream-prompt: Phase 5 culture synthesis', () => {
  it('renders Phase 5 when isCeo=true AND candidates exist', () => {
    const prompt = buildDreamPrompt({
      ...baseOpts(),
      isCeo: true,
      cultureCandidates: [STRONG_CANDIDATE],
    });
    expect(prompt).toContain('Phase 5 — Culture Synthesis');
    expect(prompt).toContain('CULTURE.md');
    expect(prompt).toContain('commits, granular'); // shared tags shown
  });

  it('does NOT render Phase 5 when isCeo=false', () => {
    const prompt = buildDreamPrompt({
      ...baseOpts(),
      isCeo: false,
      cultureCandidates: [STRONG_CANDIDATE],
    });
    expect(prompt).not.toContain('Phase 5 — Culture Synthesis');
  });

  it('does NOT render Phase 5 when isCeo=true but no candidates', () => {
    const prompt = buildDreamPrompt({
      ...baseOpts(),
      isCeo: true,
      cultureCandidates: [],
    });
    expect(prompt).not.toContain('Phase 5 — Culture Synthesis');
  });

  it('shows candidate agents + strength + counts', () => {
    const prompt = buildDreamPrompt({
      ...baseOpts(),
      isCeo: true,
      cultureCandidates: [STRONG_CANDIDATE],
    });
    expect(prompt).toContain('alice, bob, charlie');
    expect(prompt).toContain('strong');
    expect(prompt).toContain('heard 4×');
  });

  it('instructs CEO to prune contradicted rules and keep CULTURE.md tight', () => {
    const prompt = buildDreamPrompt({
      ...baseOpts(),
      isCeo: true,
      cultureCandidates: [STRONG_CANDIDATE],
    });
    expect(prompt).toContain('tight');
  });

  it('truncates when > 10 candidates shown', () => {
    const many: CultureCandidate[] = Array.from({ length: 15 }, (_, i) => ({
      ...STRONG_CANDIDATE,
      sharedTags: [`tag-${i}-a`, `tag-${i}-b`],
    }));
    const prompt = buildDreamPrompt({
      ...baseOpts(),
      isCeo: true,
      cultureCandidates: many,
    });
    expect(prompt).toContain('weaker cluster(s) hidden');
  });
});
