import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupAgentWorkspace } from '../packages/shared/src/agent-setup.js';
import type { GlobalConfig } from '../packages/shared/src/types/global-config.js';

/**
 * Integration tests for setupAgentWorkspace — the bulk of PR 4 lives here.
 *
 * Verifies that:
 *   - Workspace files land with OpenClaw-recognized basenames (AGENTS.md,
 *     TOOLS.md) — NOT the legacy RULES.md / ENVIRONMENT.md.
 *   - CLAUDE.md is generated ONLY when harness='claude-code'.
 *   - Templates are harness-aware (claude-code vs openclaw vocabulary).
 */

const GLOBAL_CONFIG: GlobalConfig = {
  apiKeys: { anthropic: 'test-key' },
  daemon: { portRange: [7800, 7900], logLevel: 'info' },
  defaults: { model: 'claude-haiku-4-5', provider: 'anthropic' },
};

function makeOpts(corpRoot: string, overrides: Partial<Parameters<typeof setupAgentWorkspace>[0]> = {}) {
  return {
    corpRoot,
    agentName: 'ceo',
    displayName: 'CEO',
    rank: 'master' as const,
    scope: 'corp' as const,
    scopeId: '',
    spawnedBy: '',
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    soulContent: 'SOUL placeholder',
    // agentsContent omitted — setupAgentWorkspace falls back to the
    // harness-aware rulesTemplate when this is nullish (`??`), which is
    // what we want to assert harness-specific vocabulary on. Cast to
    // bypass the AgentSetupOpts.agentsContent: string type which is
    // stricter than the runtime behavior.
    agentsContent: undefined as unknown as string,
    heartbeatContent: 'HEARTBEAT placeholder',
    globalConfig: GLOBAL_CONFIG,
    remote: true, // skip .openclaw/ state dir — simpler fixtures
    ...overrides,
  };
}

describe('setupAgentWorkspace', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = join(tmpdir(), `corp-setup-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(corpRoot, { recursive: true });
    // members.json is read when resolving spawnedBy — give it an empty array so reads succeed
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  describe('OpenClaw-recognized basenames (PR 4 core)', () => {
    it('writes AGENTS.md, NOT RULES.md', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot));
      const agentAbs = join(corpRoot, agentDir);

      expect(existsSync(join(agentAbs, 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(agentAbs, 'RULES.md'))).toBe(false);
    });

    it('writes TOOLS.md, NOT ENVIRONMENT.md', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot));
      const agentAbs = join(corpRoot, agentDir);

      expect(existsSync(join(agentAbs, 'TOOLS.md'))).toBe(true);
      expect(existsSync(join(agentAbs, 'ENVIRONMENT.md'))).toBe(false);
    });

    it('writes all always-on identity files', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot));
      const agentAbs = join(corpRoot, agentDir);

      for (const basename of ['SOUL.md', 'AGENTS.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md']) {
        expect(existsSync(join(agentAbs, basename))).toBe(true);
      }
    });
  });

  describe('CLAUDE.md gating by harness', () => {
    it('writes CLAUDE.md when harness=claude-code', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'claude-code' }));
      const agentAbs = join(corpRoot, agentDir);

      expect(existsSync(join(agentAbs, 'CLAUDE.md'))).toBe(true);
      const content = readFileSync(join(agentAbs, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('# I am CEO');
      expect(content).toContain('@./SOUL.md');
      expect(content).toContain('@./AGENTS.md');
      expect(content).toContain('@./TOOLS.md');
    });

    it('does NOT write CLAUDE.md when harness=openclaw', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'openclaw' }));
      const agentAbs = join(corpRoot, agentDir);

      expect(existsSync(join(agentAbs, 'CLAUDE.md'))).toBe(false);
    });

    it('does NOT write CLAUDE.md when harness is omitted (defaults to openclaw)', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot));
      const agentAbs = join(corpRoot, agentDir);

      expect(existsSync(join(agentAbs, 'CLAUDE.md'))).toBe(false);
    });

    it('CLAUDE.md embeds the agent-specific displayName in the heading', () => {
      const { agentDir } = setupAgentWorkspace(
        makeOpts(corpRoot, { agentName: 'herald', displayName: 'Herald', rank: 'worker', harness: 'claude-code' })
      );
      const agentAbs = join(corpRoot, agentDir);

      const content = readFileSync(join(agentAbs, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('# I am Herald');
    });
  });

  describe('harness-aware template content', () => {
    it('claude-code harness generates Claude-Code-substrate AGENTS.md', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'claude-code' }));
      const agentAbs = join(corpRoot, agentDir);
      const agents = readFileSync(join(agentAbs, 'AGENTS.md'), 'utf-8');

      expect(agents).toContain('Claude Code substrate');
      expect(agents).not.toContain('OpenClaw substrate');
    });

    it('openclaw harness generates OpenClaw-substrate AGENTS.md', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'openclaw' }));
      const agentAbs = join(corpRoot, agentDir);
      const agents = readFileSync(join(agentAbs, 'AGENTS.md'), 'utf-8');

      expect(agents).toContain('OpenClaw substrate');
      expect(agents).not.toContain('Claude Code substrate');
    });

    it('claude-code harness generates Claude-Code-substrate TOOLS.md', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'claude-code' }));
      const agentAbs = join(corpRoot, agentDir);
      const tools = readFileSync(join(agentAbs, 'TOOLS.md'), 'utf-8');

      expect(tools).toContain('## Tools Available (Claude Code substrate)');
      expect(tools).not.toContain('## Tools Available (OpenClaw substrate)');
    });

    it('openclaw harness generates OpenClaw-substrate TOOLS.md', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'openclaw' }));
      const agentAbs = join(corpRoot, agentDir);
      const tools = readFileSync(join(agentAbs, 'TOOLS.md'), 'utf-8');

      expect(tools).toContain('## Tools Available (OpenClaw substrate)');
      expect(tools).not.toContain('## Tools Available (Claude Code substrate)');
    });
  });

  describe('agent config persistence', () => {
    it('persists harness in config.json when provided', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'claude-code' }));
      const agentAbs = join(corpRoot, agentDir);

      const config = JSON.parse(readFileSync(join(agentAbs, 'config.json'), 'utf-8'));
      expect(config.harness).toBe('claude-code');
    });

    it('omits harness in config.json when not provided', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot));
      const agentAbs = join(corpRoot, agentDir);

      const config = JSON.parse(readFileSync(join(agentAbs, 'config.json'), 'utf-8'));
      expect(config.harness).toBeUndefined();
    });

    it('propagates harness to returned Member record', () => {
      const { member } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'claude-code' }));

      expect(member.harness).toBe('claude-code');
    });
  });
});
