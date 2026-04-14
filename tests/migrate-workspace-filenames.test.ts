import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateAgentWorkspaceFilenames } from '../packages/shared/src/migrate-workspace-filenames.js';

describe('migrateAgentWorkspaceFilenames', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = join(tmpdir(), `corp-migration-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(corpRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  function seedAgent(scope: { project?: string; name: string }, files: Record<string, string>) {
    const agentDir = scope.project
      ? join(corpRoot, 'projects', scope.project, 'agents', scope.name)
      : join(corpRoot, 'agents', scope.name);
    mkdirSync(agentDir, { recursive: true });
    for (const [basename, content] of Object.entries(files)) {
      writeFileSync(join(agentDir, basename), content, 'utf-8');
    }
    return agentDir;
  }

  describe('corp-scoped agents', () => {
    it('renames RULES.md → AGENTS.md when only legacy exists', () => {
      const agentDir = seedAgent({ name: 'ceo' }, { 'RULES.md': 'rules content' });

      const result = migrateAgentWorkspaceFilenames(corpRoot);

      expect(existsSync(join(agentDir, 'RULES.md'))).toBe(false);
      expect(existsSync(join(agentDir, 'AGENTS.md'))).toBe(true);
      expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8')).toBe('rules content');
      expect(result.renamed).toHaveLength(1);
      expect(result.renamed[0]).toMatchObject({ from: 'RULES.md', to: 'AGENTS.md' });
      expect(result.conflicts).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('renames ENVIRONMENT.md → TOOLS.md when only legacy exists', () => {
      const agentDir = seedAgent({ name: 'ceo' }, { 'ENVIRONMENT.md': 'env content' });

      const result = migrateAgentWorkspaceFilenames(corpRoot);

      expect(existsSync(join(agentDir, 'ENVIRONMENT.md'))).toBe(false);
      expect(existsSync(join(agentDir, 'TOOLS.md'))).toBe(true);
      expect(readFileSync(join(agentDir, 'TOOLS.md'), 'utf-8')).toBe('env content');
      expect(result.renamed).toHaveLength(1);
      expect(result.renamed[0]).toMatchObject({ from: 'ENVIRONMENT.md', to: 'TOOLS.md' });
    });

    it('renames both legacy files at once', () => {
      const agentDir = seedAgent(
        { name: 'ceo' },
        { 'RULES.md': 'rules', 'ENVIRONMENT.md': 'env' }
      );

      const result = migrateAgentWorkspaceFilenames(corpRoot);

      expect(existsSync(join(agentDir, 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(agentDir, 'TOOLS.md'))).toBe(true);
      expect(existsSync(join(agentDir, 'RULES.md'))).toBe(false);
      expect(existsSync(join(agentDir, 'ENVIRONMENT.md'))).toBe(false);
      expect(result.renamed).toHaveLength(2);
    });

    it('migrates multiple agents in one pass', () => {
      seedAgent({ name: 'ceo' }, { 'RULES.md': 'ceo rules' });
      seedAgent({ name: 'hr' }, { 'RULES.md': 'hr rules', 'ENVIRONMENT.md': 'hr env' });
      seedAgent({ name: 'adviser' }, { 'ENVIRONMENT.md': 'adviser env' });

      const result = migrateAgentWorkspaceFilenames(corpRoot);

      expect(result.renamed).toHaveLength(4);
      expect(existsSync(join(corpRoot, 'agents', 'ceo', 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(corpRoot, 'agents', 'hr', 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(corpRoot, 'agents', 'hr', 'TOOLS.md'))).toBe(true);
      expect(existsSync(join(corpRoot, 'agents', 'adviser', 'TOOLS.md'))).toBe(true);
    });
  });

  describe('project-scoped agents', () => {
    it('migrates agents under projects/<name>/agents/', () => {
      const agentDir = seedAgent(
        { project: 'alpha', name: 'pm' },
        { 'RULES.md': 'pm rules', 'ENVIRONMENT.md': 'pm env' }
      );

      const result = migrateAgentWorkspaceFilenames(corpRoot);

      expect(existsSync(join(agentDir, 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(agentDir, 'TOOLS.md'))).toBe(true);
      expect(result.renamed).toHaveLength(2);
    });

    it('migrates both corp-scoped AND project-scoped agents in one pass', () => {
      seedAgent({ name: 'ceo' }, { 'RULES.md': 'ceo rules' });
      seedAgent({ project: 'alpha', name: 'pm' }, { 'RULES.md': 'pm rules' });
      seedAgent({ project: 'beta', name: 'lead' }, { 'ENVIRONMENT.md': 'lead env' });

      const result = migrateAgentWorkspaceFilenames(corpRoot);

      expect(result.renamed).toHaveLength(3);
      expect(existsSync(join(corpRoot, 'agents', 'ceo', 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(corpRoot, 'projects', 'alpha', 'agents', 'pm', 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(corpRoot, 'projects', 'beta', 'agents', 'lead', 'TOOLS.md'))).toBe(true);
    });
  });

  describe('idempotency + safety', () => {
    it('running twice is a no-op on the second run', () => {
      seedAgent({ name: 'ceo' }, { 'RULES.md': 'rules' });

      const first = migrateAgentWorkspaceFilenames(corpRoot);
      const second = migrateAgentWorkspaceFilenames(corpRoot);

      expect(first.renamed).toHaveLength(1);
      expect(second.renamed).toHaveLength(0);
      expect(second.conflicts).toHaveLength(0);
      expect(second.errors).toHaveLength(0);
    });

    it('skips agents where only the new file exists (already migrated)', () => {
      seedAgent({ name: 'ceo' }, { 'AGENTS.md': 'already new' });

      const result = migrateAgentWorkspaceFilenames(corpRoot);

      expect(result.renamed).toHaveLength(0);
      expect(result.conflicts).toHaveLength(0);
    });

    it('flags conflict when BOTH legacy and new files exist, leaves both untouched', () => {
      const agentDir = seedAgent(
        { name: 'ceo' },
        { 'RULES.md': 'old content', 'AGENTS.md': 'new content' }
      );

      const result = migrateAgentWorkspaceFilenames(corpRoot);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({ from: 'RULES.md', to: 'AGENTS.md' });
      expect(result.renamed).toHaveLength(0);
      expect(readFileSync(join(agentDir, 'RULES.md'), 'utf-8')).toBe('old content');
      expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8')).toBe('new content');
    });

    it('handles missing corpRoot/agents directory gracefully', () => {
      const result = migrateAgentWorkspaceFilenames(corpRoot);

      expect(result.renamed).toHaveLength(0);
      expect(result.conflicts).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('handles missing corpRoot/projects directory gracefully', () => {
      seedAgent({ name: 'ceo' }, { 'RULES.md': 'rules' });

      const result = migrateAgentWorkspaceFilenames(corpRoot);

      expect(result.renamed).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('ignores non-directory entries under agents/', () => {
      mkdirSync(join(corpRoot, 'agents'), { recursive: true });
      writeFileSync(join(corpRoot, 'agents', 'stray-file.txt'), 'not an agent dir', 'utf-8');
      seedAgent({ name: 'ceo' }, { 'RULES.md': 'rules' });

      const result = migrateAgentWorkspaceFilenames(corpRoot);

      expect(result.renamed).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('preserves file content byte-for-byte across rename', () => {
      const originalContent = '# Rules\n\nThis is a test with 特殊字符 and emojis 🎨 and\nmultiple\nlines.';
      const agentDir = seedAgent({ name: 'ceo' }, { 'RULES.md': originalContent });

      migrateAgentWorkspaceFilenames(corpRoot);

      expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8')).toBe(originalContent);
    });
  });
});
