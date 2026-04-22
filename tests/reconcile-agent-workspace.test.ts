import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcileAgentWorkspace } from '../packages/shared/src/reconcile-agent-workspace.js';

describe('reconcileAgentWorkspace', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = join(tmpdir(), `agent-reconcile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function setMtime(path: string, secondsAgo: number): void {
    const when = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(path, when, when);
  }

  function backupFilesFor(basename: string): string[] {
    return readdirSync(agentDir).filter(f => f.startsWith(`${basename}.backup.`));
  }

  describe('filename migration (no conflict)', () => {
    it('renames RULES.md → AGENTS.md when only legacy exists', () => {
      writeFileSync(join(agentDir, 'RULES.md'), 'rules content', 'utf-8');

      const result = reconcileAgentWorkspace({ agentDir, displayName: 'Pilot', harness: 'openclaw' });

      expect(existsSync(join(agentDir, 'RULES.md'))).toBe(false);
      expect(existsSync(join(agentDir, 'AGENTS.md'))).toBe(true);
      expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8')).toBe('rules content');
      expect(result.renamed).toEqual([{ from: 'RULES.md', to: 'AGENTS.md' }]);
      expect(result.conflicts).toEqual([]);
    });

    it('renames ENVIRONMENT.md → TOOLS.md', () => {
      writeFileSync(join(agentDir, 'ENVIRONMENT.md'), 'env content', 'utf-8');

      reconcileAgentWorkspace({ agentDir, displayName: 'Pilot', harness: 'openclaw' });

      expect(existsSync(join(agentDir, 'ENVIRONMENT.md'))).toBe(false);
      expect(readFileSync(join(agentDir, 'TOOLS.md'), 'utf-8')).toBe('env content');
    });

    it('no-op when only the new name exists', () => {
      writeFileSync(join(agentDir, 'AGENTS.md'), 'already current', 'utf-8');

      const result = reconcileAgentWorkspace({ agentDir, displayName: 'Pilot', harness: 'openclaw' });

      expect(result.renamed).toEqual([]);
      expect(result.conflicts).toEqual([]);
      expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8')).toBe('already current');
    });
  });

  describe('conflict resolution (both files present)', () => {
    it('keeps the newer file when AGENTS.md is newer — backs up RULES.md', () => {
      writeFileSync(join(agentDir, 'RULES.md'), 'stale legacy content', 'utf-8');
      setMtime(join(agentDir, 'RULES.md'), 3600); // 1h ago
      writeFileSync(join(agentDir, 'AGENTS.md'), 'fresh content', 'utf-8');
      // AGENTS.md is implicitly now (current time)

      const result = reconcileAgentWorkspace({ agentDir, displayName: 'Pilot', harness: 'openclaw' });

      expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8')).toBe('fresh content');
      expect(existsSync(join(agentDir, 'RULES.md'))).toBe(false);
      const backups = backupFilesFor('RULES.md');
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(agentDir, backups[0]!), 'utf-8')).toBe('stale legacy content');
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.from).toBe('RULES.md');
    });

    it('promotes RULES.md when it is newer than AGENTS.md — backs up AGENTS.md', () => {
      // Order matters: create AGENTS.md first (older), then RULES.md (newer)
      writeFileSync(join(agentDir, 'AGENTS.md'), 'stale current content', 'utf-8');
      setMtime(join(agentDir, 'AGENTS.md'), 3600);
      writeFileSync(join(agentDir, 'RULES.md'), 'recently edited legacy', 'utf-8');

      reconcileAgentWorkspace({ agentDir, displayName: 'Pilot', harness: 'openclaw' });

      // The recently-edited content should now be at AGENTS.md
      expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8')).toBe('recently edited legacy');
      expect(existsSync(join(agentDir, 'RULES.md'))).toBe(false);
      const backups = backupFilesFor('AGENTS.md');
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(agentDir, backups[0]!), 'utf-8')).toBe('stale current content');
    });
  });

  describe('CLAUDE.md handling', () => {
    it('writes CLAUDE.md (thin 0.7 shape) when target=claude-code', () => {
      const result = reconcileAgentWorkspace({ agentDir, displayName: 'CEO', harness: 'claude-code', rank: 'master' });

      expect(existsSync(join(agentDir, 'CLAUDE.md'))).toBe(true);
      const content = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8');
      // Thin shell: "# <displayName>" heading (not old "# I am X"); keeps
      // agent-authored @imports; deliberately omits AGENTS.md / TOOLS.md.
      expect(content).toContain('# CEO');
      expect(content).toContain('@./SOUL.md');
      expect(content).not.toContain('@./AGENTS.md');
      expect(content).not.toContain('@./TOOLS.md');
      expect(result.claudeMdWritten).toBe(true);
      expect(result.claudeMdBackedUp).toBeNull();
    });

    it('writes .claude/settings.json with hook wiring when target=claude-code', () => {
      reconcileAgentWorkspace({ agentDir, displayName: 'CEO', harness: 'claude-code', rank: 'master', agentSlug: 'ceo' });

      const settingsPath = join(agentDir, '.claude', 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();
      // master rank → partner kind → full hook set
      expect(settings.hooks.PreCompact).toBeDefined();
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
      expect(settings.hooks.SessionStart[0].command).toContain('cc-cli wtf --agent ceo');
    });

    it('overwrites existing CLAUDE.md with fresh content on every call', () => {
      writeFileSync(join(agentDir, 'CLAUDE.md'), 'old stale content', 'utf-8');

      reconcileAgentWorkspace({ agentDir, displayName: 'Herald', harness: 'claude-code', rank: 'leader' });

      const content = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('# Herald');
      expect(content).not.toContain('old stale content');
    });

    it('moves CLAUDE.md aside when target!=claude-code', () => {
      writeFileSync(join(agentDir, 'CLAUDE.md'), 'claude-code content', 'utf-8');

      const result = reconcileAgentWorkspace({ agentDir, displayName: 'Pilot', harness: 'openclaw' });

      expect(existsSync(join(agentDir, 'CLAUDE.md'))).toBe(false);
      expect(result.claudeMdBackedUp).toMatch(/CLAUDE\.md\.backup\./);
      expect(readFileSync(result.claudeMdBackedUp!, 'utf-8')).toBe('claude-code content');
    });

    it('no-op on CLAUDE.md when target!=claude-code and no CLAUDE.md present', () => {
      const result = reconcileAgentWorkspace({ agentDir, displayName: 'Pilot', harness: 'openclaw' });

      expect(result.claudeMdWritten).toBe(false);
      expect(result.claudeMdBackedUp).toBeNull();
    });
  });

  describe('idempotency + edge cases', () => {
    it('second run after a clean first is a no-op', () => {
      writeFileSync(join(agentDir, 'RULES.md'), 'content', 'utf-8');

      const first = reconcileAgentWorkspace({ agentDir, displayName: 'CEO', harness: 'claude-code' });
      const second = reconcileAgentWorkspace({ agentDir, displayName: 'CEO', harness: 'claude-code' });

      expect(first.renamed).toHaveLength(1);
      expect(second.renamed).toHaveLength(0);
      expect(second.conflicts).toHaveLength(0);
      // CLAUDE.md gets rewritten on every call — that's fine, content is identical
      expect(second.claudeMdWritten).toBe(true);
    });

    it('missing agent workspace directory returns empty result (no throw)', () => {
      const missingDir = join(tmpdir(), `never-created-${Date.now()}`);

      const result = reconcileAgentWorkspace({ agentDir: missingDir, displayName: 'X', harness: 'claude-code' });

      expect(result.renamed).toEqual([]);
      expect(result.conflicts).toEqual([]);
      expect(result.claudeMdWritten).toBe(false);
      expect(existsSync(missingDir)).toBe(false);
    });

    it('handles both files migrated + CLAUDE.md generated in a single call', () => {
      writeFileSync(join(agentDir, 'RULES.md'), 'rules', 'utf-8');
      writeFileSync(join(agentDir, 'ENVIRONMENT.md'), 'env', 'utf-8');

      const result = reconcileAgentWorkspace({ agentDir, displayName: 'Herald', harness: 'claude-code' });

      expect(existsSync(join(agentDir, 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(agentDir, 'TOOLS.md'))).toBe(true);
      expect(existsSync(join(agentDir, 'CLAUDE.md'))).toBe(true);
      expect(result.renamed).toHaveLength(2);
      expect(result.claudeMdWritten).toBe(true);
    });

    it('backup files use ISO timestamp with filesystem-safe characters', () => {
      writeFileSync(join(agentDir, 'CLAUDE.md'), 'x', 'utf-8');

      const result = reconcileAgentWorkspace({ agentDir, displayName: 'X', harness: 'openclaw' });

      expect(result.claudeMdBackedUp).toMatch(
        /CLAUDE\.md\.backup\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
      );
    });
  });
});
