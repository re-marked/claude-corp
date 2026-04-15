import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UNIVERSAL_SOUL } from '../packages/shared/src/templates/soul.js';
import { defaultRules } from '../packages/shared/src/templates/rules.js';
import { buildCeoAgents } from '../packages/shared/src/ceo.js';

/**
 * Integration tests for `cc-cli refresh`. The command mutates user
 * files on disk, so the test builds a minimal corp layout in tmpdir,
 * runs cmdRefresh against it, and asserts file state.
 *
 * getCorpRoot() is stubbed via a spy so the command reads our tmpdir
 * instead of probing a running daemon or a real corp.
 */

// Stub getCorpRoot before importing cmdRefresh — the module resolves
// the import at call time, so we inject into its module resolution.
let tmpCorpRoot: string;
vi.mock('../packages/cli/src/client.js', () => ({
  getCorpRoot: vi.fn(async () => tmpCorpRoot),
}));

// Stub process.exit so `cmdRefresh`'s error paths don't kill vitest.
// Throw instead — each test can catch and assert on the code.
const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code ?? 0})`);
}) as never);

const { cmdRefresh } = await import('../packages/cli/src/commands/refresh.js');

function createAgent(
  corpRoot: string,
  opts: {
    id: string;
    displayName: string;
    rank: string;
    agentDir: string;
    harness?: string;
    soulContent?: string;
    agentsContent?: string;
  },
) {
  const dir = join(corpRoot, opts.agentDir);
  mkdirSync(dir, { recursive: true });
  if (opts.soulContent !== undefined) {
    writeFileSync(join(dir, 'SOUL.md'), opts.soulContent, 'utf-8');
  }
  if (opts.agentsContent !== undefined) {
    writeFileSync(join(dir, 'AGENTS.md'), opts.agentsContent, 'utf-8');
  }
  return {
    id: opts.id,
    displayName: opts.displayName,
    rank: opts.rank,
    status: 'active',
    type: 'agent',
    scope: 'corp',
    scopeId: 'test',
    agentDir: opts.agentDir,
    spawnedBy: 'mark',
    port: null,
    harness: opts.harness,
  };
}

function writeMembers(corpRoot: string, members: unknown[]) {
  writeFileSync(join(corpRoot, 'members.json'), JSON.stringify(members), 'utf-8');
}

describe('cmdRefresh', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpCorpRoot = join(tmpdir(), `refresh-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpCorpRoot, { recursive: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    try { rmSync(tmpCorpRoot, { recursive: true, force: true }); } catch {}
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockClear();
  });

  it('exits with usage when called with no agent and no --all', async () => {
    writeMembers(tmpCorpRoot, []);
    await expect(cmdRefresh({})).rejects.toThrow(/process\.exit\(1\)/);
    const usage = errSpy.mock.calls.flat().join('\n');
    expect(usage).toMatch(/Usage: cc-cli refresh/);
  });

  it('exits when the named agent does not exist', async () => {
    writeMembers(tmpCorpRoot, []);
    await expect(cmdRefresh({ agent: 'ghost' })).rejects.toThrow(/process\.exit\(1\)/);
  });

  it('reports "up to date" when SOUL.md + AGENTS.md already match templates', async () => {
    const ceo = createAgent(tmpCorpRoot, {
      id: 'ceo',
      displayName: 'CEO',
      rank: 'master',
      agentDir: 'agents/ceo/',
      harness: 'openclaw',
      soulContent: UNIVERSAL_SOUL,
      agentsContent: buildCeoAgents('openclaw'),
    });
    writeMembers(tmpCorpRoot, [ceo]);

    await cmdRefresh({ agent: 'ceo', dryRun: true });

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toMatch(/SOUL\.md: up to date/);
    expect(out).toMatch(/AGENTS\.md: up to date/);
  });

  it('--dry-run detects drift but does NOT write', async () => {
    const stalesSoul = '# Soul\n\nOld content that will drift.\n';
    const ceo = createAgent(tmpCorpRoot, {
      id: 'ceo',
      displayName: 'CEO',
      rank: 'master',
      agentDir: 'agents/ceo/',
      harness: 'openclaw',
      soulContent: stalesSoul,
      agentsContent: buildCeoAgents('openclaw'),
    });
    writeMembers(tmpCorpRoot, [ceo]);

    await cmdRefresh({ agent: 'ceo', dryRun: true });

    // File on disk unchanged
    const current = readFileSync(join(tmpCorpRoot, 'agents/ceo/SOUL.md'), 'utf-8');
    expect(current).toBe(stalesSoul);

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toMatch(/SOUL\.md: DRIFT/);
    expect(out).toMatch(/dry run/);
  });

  it('--force overwrites without prompting', async () => {
    const ceo = createAgent(tmpCorpRoot, {
      id: 'ceo',
      displayName: 'CEO',
      rank: 'master',
      agentDir: 'agents/ceo/',
      harness: 'openclaw',
      soulContent: '# Old Soul\n',
      agentsContent: '# Old Rules\n',
    });
    writeMembers(tmpCorpRoot, [ceo]);

    await cmdRefresh({ agent: 'ceo', force: true });

    const newSoul = readFileSync(join(tmpCorpRoot, 'agents/ceo/SOUL.md'), 'utf-8');
    const newAgents = readFileSync(join(tmpCorpRoot, 'agents/ceo/AGENTS.md'), 'utf-8');
    expect(newSoul).toBe(UNIVERSAL_SOUL);
    expect(newAgents).toBe(buildCeoAgents('openclaw'));
  });

  it('CEO refresh (rank=master) uses buildCeoAgents — keeps authority bullets', async () => {
    const ceo = createAgent(tmpCorpRoot, {
      id: 'ceo',
      displayName: 'CEO',
      rank: 'master',
      agentDir: 'agents/ceo/',
      harness: 'claude-code',
      soulContent: UNIVERSAL_SOUL,
      agentsContent: '# Old Rules\n',
    });
    writeMembers(tmpCorpRoot, [ceo]);

    await cmdRefresh({ agent: 'ceo', force: true });

    const written = readFileSync(join(tmpCorpRoot, 'agents/ceo/AGENTS.md'), 'utf-8');
    expect(written).toContain('## CEO Authority');
    expect(written).toContain('You can create agents at leader rank or below.');
    expect(written).toContain('## Speaking with tool calls');
    expect(written).toContain('(Claude Code substrate)');
  });

  it('non-CEO refresh uses defaultRules (no CEO Authority section)', async () => {
    const worker = createAgent(tmpCorpRoot, {
      id: 'w1',
      displayName: 'Worker One',
      rank: 'worker',
      agentDir: 'agents/worker-one/',
      harness: 'openclaw',
      soulContent: UNIVERSAL_SOUL,
      agentsContent: '# Old Rules\n',
    });
    writeMembers(tmpCorpRoot, [worker]);

    await cmdRefresh({ agent: 'worker-one', force: true });

    const written = readFileSync(join(tmpCorpRoot, 'agents/worker-one/AGENTS.md'), 'utf-8');
    expect(written).toBe(defaultRules({ rank: 'worker', harness: 'openclaw' }));
    expect(written).not.toContain('## CEO Authority');
    expect(written).toContain('## Speaking with tool calls');
  });

  it('--all iterates every agent in the corp', async () => {
    const ceo = createAgent(tmpCorpRoot, {
      id: 'ceo',
      displayName: 'CEO',
      rank: 'master',
      agentDir: 'agents/ceo/',
      harness: 'openclaw',
      soulContent: '# Stale\n',
      agentsContent: '# Stale\n',
    });
    const worker = createAgent(tmpCorpRoot, {
      id: 'w1',
      displayName: 'Worker One',
      rank: 'worker',
      agentDir: 'agents/worker-one/',
      harness: 'openclaw',
      soulContent: '# Stale\n',
      agentsContent: '# Stale\n',
    });
    writeMembers(tmpCorpRoot, [ceo, worker]);

    await cmdRefresh({ all: true, force: true });

    expect(readFileSync(join(tmpCorpRoot, 'agents/ceo/SOUL.md'), 'utf-8')).toBe(UNIVERSAL_SOUL);
    expect(readFileSync(join(tmpCorpRoot, 'agents/worker-one/SOUL.md'), 'utf-8')).toBe(UNIVERSAL_SOUL);
    expect(readFileSync(join(tmpCorpRoot, 'agents/ceo/AGENTS.md'), 'utf-8')).toBe(buildCeoAgents('openclaw'));
    expect(readFileSync(join(tmpCorpRoot, 'agents/worker-one/AGENTS.md'), 'utf-8')).toBe(defaultRules({ rank: 'worker', harness: 'openclaw' }));
  });

  it('resolves harness from config.json when Member.harness is unset', async () => {
    const ceo = createAgent(tmpCorpRoot, {
      id: 'ceo',
      displayName: 'CEO',
      rank: 'master',
      agentDir: 'agents/ceo/',
      // NOTE: no `harness` on the Member — must fall through to config.json
      soulContent: UNIVERSAL_SOUL,
      agentsContent: '# Stale\n',
    });
    writeMembers(tmpCorpRoot, [ceo]);
    // Drop a config.json that says claude-code
    writeFileSync(
      join(tmpCorpRoot, 'agents/ceo/config.json'),
      JSON.stringify({ harness: 'claude-code', model: 'sonnet', provider: 'anthropic' }),
      'utf-8',
    );

    await cmdRefresh({ agent: 'ceo', force: true });

    const written = readFileSync(join(tmpCorpRoot, 'agents/ceo/AGENTS.md'), 'utf-8');
    expect(written).toContain('(Claude Code substrate)');
    expect(written).not.toContain('(OpenClaw substrate)');
  });

  it('writes missing files from the template', async () => {
    // Agent dir exists but SOUL.md / AGENTS.md do NOT
    const ceo = createAgent(tmpCorpRoot, {
      id: 'ceo',
      displayName: 'CEO',
      rank: 'master',
      agentDir: 'agents/ceo/',
      harness: 'openclaw',
    });
    writeMembers(tmpCorpRoot, [ceo]);

    await cmdRefresh({ agent: 'ceo', force: true });

    expect(readFileSync(join(tmpCorpRoot, 'agents/ceo/SOUL.md'), 'utf-8')).toBe(UNIVERSAL_SOUL);
    expect(readFileSync(join(tmpCorpRoot, 'agents/ceo/AGENTS.md'), 'utf-8')).toBe(buildCeoAgents('openclaw'));
  });
});
