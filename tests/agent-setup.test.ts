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
    it('writes CLAUDE.md (thin 0.7 shape) when harness=claude-code', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'claude-code' }));
      const agentAbs = join(corpRoot, agentDir);

      expect(existsSync(join(agentAbs, 'CLAUDE.md'))).toBe(true);
      const content = readFileSync(join(agentAbs, 'CLAUDE.md'), 'utf-8');
      // Thin shell has the displayName heading (not the old "# I am X" form)
      expect(content).toContain('# CEO');
      // Agent-authored soul files ARE @imported
      expect(content).toContain('@./SOUL.md');
      expect(content).toContain('@./IDENTITY.md');
      expect(content).toContain('@./USER.md');
      expect(content).toContain('@./MEMORY.md');
      // But AGENTS.md / TOOLS.md are intentionally NOT imported — their
      // content lives in CORP.md, rendered dynamically by cc-cli wtf
      expect(content).not.toContain('@./AGENTS.md');
      expect(content).not.toContain('@./TOOLS.md');
    });

    it('writes .claude/settings.json with hook wiring when harness=claude-code', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'claude-code' }));
      const agentAbs = join(corpRoot, agentDir);
      const settingsPath = join(agentAbs, '.claude', 'settings.json');

      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      // Master rank → Partner kind → full hook set
      expect(settings.hooks).toHaveProperty('SessionStart');
      expect(settings.hooks).toHaveProperty('Stop');
      expect(settings.hooks).toHaveProperty('PreCompact');
      expect(settings.hooks).toHaveProperty('UserPromptSubmit');
      // Nested shape: hooks.Event[0] is a matcher-group whose `hooks`
      // array holds the actual {type, command} entries.
      expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('cc-cli wtf');
    });

    it('does NOT write .claude/settings.json when harness=openclaw', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'openclaw' }));
      const agentAbs = join(corpRoot, agentDir);
      expect(existsSync(join(agentAbs, '.claude', 'settings.json'))).toBe(false);
    });
  });

  describe('0.7.2 workspace file initialization (both kinds)', () => {
    it('creates STATUS.md placeholder so thin CLAUDE.md @import resolves', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'claude-code' }));
      const agentAbs = join(corpRoot, agentDir);
      expect(existsSync(join(agentAbs, 'STATUS.md'))).toBe(true);
      const content = readFileSync(join(agentAbs, 'STATUS.md'), 'utf-8');
      // Placeholder is agent-rewriteable — just assert it's non-empty and
      // carries the "update me" intent so agents know what to do.
      expect(content.length).toBeGreaterThan(0);
      expect(content.toLowerCase()).toMatch(/status|focus|update/);
    });

    it('creates TASKS.md placeholder that points at cc-cli task list', () => {
      const { agentDir } = setupAgentWorkspace(
        makeOpts(corpRoot, { harness: 'claude-code', agentName: 'toast' }),
      );
      const agentAbs = join(corpRoot, agentDir);
      expect(existsSync(join(agentAbs, 'TASKS.md'))).toBe(true);
      const content = readFileSync(join(agentAbs, 'TASKS.md'), 'utf-8');
      // Points the agent at the live query source
      expect(content).toContain('cc-cli task list');
      // Interpolates the agent slug into the query hint
      expect(content).toContain('--assigned toast');
    });

    it('writes .gitignore excluding CORP.md (regenerated every dispatch; would otherwise churn git)', () => {
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'claude-code' }));
      const agentAbs = join(corpRoot, agentDir);
      const gitignorePath = join(agentAbs, '.gitignore');
      expect(existsSync(gitignorePath)).toBe(true);
      const content = readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('CORP.md');
      // Intentional NOT: .claude/ — settings.json is deterministic +
      // needs to survive clones so Claude Code hooks work.
      expect(content).not.toContain('.claude/');
    });

    it('preserves an existing .gitignore when one is already present (append-if-missing, not clobber)', () => {
      // Simulate an agent workspace that already has a .gitignore with
      // user-custom entries (maybe from an earlier setup pass or a
      // founder hand-edit). Running setupAgentWorkspace must add CORP.md
      // WITHOUT destroying the existing entries.
      const opts = makeOpts(corpRoot, { harness: 'claude-code' });
      const agentAbs = join(corpRoot, opts.scope === 'corp' ? `agents/${opts.agentName}` : `${opts.scope}s/${opts.scopeId}/agents/${opts.agentName}`);
      const gitignorePath = join(agentAbs, '.gitignore');
      mkdirSync(agentAbs, { recursive: true });
      writeFileSync(gitignorePath, '# User-custom\nmy-secret-note.md\nscratch/\n', 'utf-8');

      setupAgentWorkspace(opts);

      const content = readFileSync(gitignorePath, 'utf-8');
      // User's original entries survive
      expect(content).toContain('my-secret-note.md');
      expect(content).toContain('scratch/');
      // CORP.md added
      expect(content).toContain('CORP.md');
    });

    it('does not duplicate CORP.md when .gitignore already contains it (idempotent)', () => {
      const opts = makeOpts(corpRoot, { harness: 'claude-code' });
      const agentAbs = join(corpRoot, opts.scope === 'corp' ? `agents/${opts.agentName}` : `${opts.scope}s/${opts.scopeId}/agents/${opts.agentName}`);
      const gitignorePath = join(agentAbs, '.gitignore');
      mkdirSync(agentAbs, { recursive: true });
      writeFileSync(gitignorePath, '# Existing\nCORP.md\n', 'utf-8');

      setupAgentWorkspace(opts);

      const content = readFileSync(gitignorePath, 'utf-8');
      // Only one CORP.md entry, not two
      const matches = content.split(/\r?\n/).filter((l) => l.trim() === 'CORP.md');
      expect(matches).toHaveLength(1);
    });

    it('STATUS.md + TASKS.md + .gitignore exist for OpenClaw agents too', () => {
      // OpenClaw doesn't @import these files but the agent can still
      // read them via tools; writing them unconditionally keeps the
      // workspace shape consistent across harnesses.
      const { agentDir } = setupAgentWorkspace(makeOpts(corpRoot, { harness: 'openclaw' }));
      const agentAbs = join(corpRoot, agentDir);
      expect(existsSync(join(agentAbs, 'STATUS.md'))).toBe(true);
      expect(existsSync(join(agentAbs, 'TASKS.md'))).toBe(true);
      expect(existsSync(join(agentAbs, '.gitignore'))).toBe(true);
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
      // Thin shell: bare "# <displayName>" (was "# I am X" under the fat template)
      expect(content).toContain('# Herald');
      // Identity line carries kind inferred from rank (worker → employee)
      expect(content).toContain('You are Herald, a worker (employee)');
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
