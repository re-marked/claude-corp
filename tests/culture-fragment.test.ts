import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cultureFragment } from '../packages/daemon/src/fragments/culture.js';
import type { FragmentContext } from '../packages/daemon/src/fragments/types.js';

let counter = 0;
let CORP_ROOT = '';

beforeEach(() => {
  CORP_ROOT = join(tmpdir(), `claude-corp-test-culture-frag-${process.pid}-${++counter}`);
  if (existsSync(CORP_ROOT)) rmSync(CORP_ROOT, { recursive: true, force: true });
  mkdirSync(CORP_ROOT, { recursive: true });
});

function ctx(): FragmentContext {
  return {
    agentDir: join(CORP_ROOT, 'agents/alice'),
    corpRoot: CORP_ROOT,
    channelName: 'dm',
    channelMembers: ['alice', 'mark'],
    corpMembers: [],
    recentHistory: [],
    agentDisplayName: 'alice',
    channelKind: 'direct',
    supervisorName: 'ceo',
  };
}

describe('culture fragment', () => {
  it('does NOT apply when CULTURE.md is missing', () => {
    expect(cultureFragment.applies(ctx())).toBe(false);
  });

  it('applies when CULTURE.md exists at corp root', () => {
    writeFileSync(join(CORP_ROOT, 'CULTURE.md'), '# Corp Culture\n\n## rule\n\nexample', 'utf-8');
    expect(cultureFragment.applies(ctx())).toBe(true);
  });

  it('renders the CULTURE.md body', () => {
    writeFileSync(
      join(CORP_ROOT, 'CULTURE.md'),
      '# Corp Culture\n\n## no summaries\n\nMark reads the diff.',
      'utf-8',
    );
    const out = cultureFragment.render(ctx());
    expect(out).toContain('no summaries');
    expect(out).toContain('Mark reads the diff.');
  });

  it('returns empty when file exists but is blank', () => {
    writeFileSync(join(CORP_ROOT, 'CULTURE.md'), '   \n\n  ', 'utf-8');
    // `applies` returns true (file exists), but render guards against empty.
    expect(cultureFragment.applies(ctx())).toBe(true);
    expect(cultureFragment.render(ctx())).toBe('');
  });

  it('truncates very long CULTURE.md to a soft cap', () => {
    const huge = '# Corp Culture\n\n' + 'a'.repeat(10_000);
    writeFileSync(join(CORP_ROOT, 'CULTURE.md'), huge, 'utf-8');
    const out = cultureFragment.render(ctx());
    expect(out).toContain('truncated');
    // Should still include the opening framing line.
    expect(out).toContain('shared law');
  });

  it('renders the framing line only when CULTURE.md is non-empty', () => {
    writeFileSync(join(CORP_ROOT, 'CULTURE.md'), '## rule\n\nbody', 'utf-8');
    const out = cultureFragment.render(ctx());
    expect(out).toContain('# Corp Culture');
    expect(out).toContain('shared law');
  });

  it('has a low-ish order so culture sits before most task guidance', () => {
    // Brain is 14, context is 90 — culture should land before context.
    expect(cultureFragment.order).toBeLessThan(14);
  });
});
