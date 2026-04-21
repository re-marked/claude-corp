import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_DIST = join(__dirname, '..', 'packages', 'cli', 'dist', 'index.js');
const TIMEOUT_MS = 10_000;

function runCli(
  args: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cc-cli ${args.join(' ')} timed out`));
    }, TIMEOUT_MS);
    child.on('exit', (exitCode) => {
      clearTimeout(killer);
      resolve({ exitCode, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
  });
}

function setupTempCorpWithContracts(contracts: Array<{ projectName: string; id: string }>): {
  corpRoot: string;
  homeEnv: Record<string, string>;
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), 'cli-migrate-contracts-'));
  const corpRoot = join(home, '.claudecorp', 'test-corp');
  mkdirSync(corpRoot, { recursive: true });

  writeFileSync(
    join(corpRoot, 'corp.json'),
    JSON.stringify({ name: 'test-corp', theme: 'corporate', founder: 'founder' }, null, 2),
    'utf-8',
  );
  writeFileSync(
    join(corpRoot, 'members.json'),
    JSON.stringify({ members: [{ id: 'founder', name: 'founder', rank: 'owner' }] }, null, 2),
    'utf-8',
  );
  writeFileSync(
    join(corpRoot, 'channels.json'),
    JSON.stringify({ channels: [] }, null, 2),
    'utf-8',
  );

  const corpsIndexDir = join(home, '.claudecorp', 'corps');
  mkdirSync(corpsIndexDir, { recursive: true });
  writeFileSync(
    join(corpsIndexDir, 'index.json'),
    JSON.stringify({ corps: [{ name: 'test-corp', path: corpRoot }] }, null, 2),
    'utf-8',
  );

  writeFileSync(
    join(home, '.claudecorp', 'global-config.json'),
    JSON.stringify({ apiKey: 'test', defaultModel: 'haiku' }, null, 2),
    'utf-8',
  );

  // Seed each contract at the pre-chits path
  for (const { projectName, id } of contracts) {
    const contractsDir = join(corpRoot, 'projects', projectName, 'contracts');
    mkdirSync(contractsDir, { recursive: true });
    const content = `---
id: ${id}
title: Seeded contract ${id}
goal: Ship ${id}
projectId: proj-${projectName}
leadId: null
status: draft
priority: normal
taskIds: []
blueprintId: null
deadline: null
createdBy: mark
completedAt: null
reviewedBy: null
reviewNotes: null
rejectionCount: 0
createdAt: '2026-04-20T10:00:00.000Z'
updatedAt: '2026-04-20T10:00:00.000Z'
---

## Progress
(seeded)
`;
    writeFileSync(join(contractsDir, `${id}.md`), content, 'utf-8');
  }

  const homeEnv: Record<string, string> = { HOME: home, USERPROFILE: home };
  return {
    corpRoot,
    homeEnv,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('cc-cli migrate contracts', () => {
  let env: { corpRoot: string; homeEnv: Record<string, string>; cleanup: () => void };

  afterEach(() => {
    if (env) env.cleanup();
  });

  it('migrates contracts across multiple projects', async () => {
    env = setupTempCorpWithContracts([
      { projectName: 'alpha', id: 'contract-a' },
      { projectName: 'beta', id: 'contract-b' },
    ]);

    const { exitCode, stdout, stderr } = await runCli(
      ['migrate', 'contracts'],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('migrated 2 contracts');

    // Sources gone
    expect(readdirSync(join(env.corpRoot, 'projects', 'alpha', 'contracts')).filter((f) => f.endsWith('.md'))).toHaveLength(0);
    // Chits present at project-scoped location
    expect(existsSync(join(env.corpRoot, 'projects', 'alpha', 'chits', 'contract', 'contract-a.md'))).toBe(true);
    expect(existsSync(join(env.corpRoot, 'projects', 'beta', 'chits', 'contract', 'contract-b.md'))).toBe(true);
  });

  it('migrated chit carries the expected frontmatter shape', async () => {
    env = setupTempCorpWithContracts([{ projectName: 'fire', id: 'ship-feature' }]);

    await runCli(['migrate', 'contracts'], { env: env.homeEnv });

    const chitFile = join(env.corpRoot, 'projects', 'fire', 'chits', 'contract', 'ship-feature.md');
    const raw = readFileSync(chitFile, 'utf-8');
    expect(raw).toContain('id: ship-feature');
    expect(raw).toContain('type: contract');
    expect(raw).toContain('status: draft'); // direct enum mapping
    expect(raw).toContain('projectId: proj-fire');
  });

  it('dry-run reports planned paths without writing or deleting', async () => {
    env = setupTempCorpWithContracts([
      { projectName: 'alpha', id: 'c1' },
      { projectName: 'beta', id: 'c2' },
    ]);

    const { exitCode, stdout } = await runCli(
      ['migrate', 'contracts', '--dry-run'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('DRY RUN');
    expect(stdout).toContain('would migrate 2 contracts');

    // Sources still there; no chits written
    expect(readdirSync(join(env.corpRoot, 'projects', 'alpha', 'contracts')).filter((f) => f.endsWith('.md'))).toHaveLength(1);
    expect(existsSync(join(env.corpRoot, 'projects', 'alpha', 'chits'))).toBe(false);
  });

  it('idempotent — re-running skips already-migrated contracts', async () => {
    env = setupTempCorpWithContracts([{ projectName: 'fire', id: 'c1' }]);

    await runCli(['migrate', 'contracts'], { env: env.homeEnv });

    // Re-seed the source with the ORIGINAL Contract shape (simulating a
    // partial-state where source + target coexist). Use the same content
    // the setup helper wrote so the parse succeeds the same way the first
    // run did — the migration should skip because the target chit exists.
    const srcDir = join(env.corpRoot, 'projects', 'fire', 'contracts');
    mkdirSync(srcDir, { recursive: true });
    const contractSource = `---
id: c1
title: Seeded contract c1
goal: Ship c1
projectId: proj-fire
leadId: null
status: draft
priority: normal
taskIds: []
blueprintId: null
deadline: null
createdBy: mark
completedAt: null
reviewedBy: null
reviewNotes: null
rejectionCount: 0
createdAt: '2026-04-20T10:00:00.000Z'
updatedAt: '2026-04-20T10:00:00.000Z'
---

## Progress
(seeded)
`;
    writeFileSync(join(srcDir, 'c1.md'), contractSource, 'utf-8');

    const { exitCode, stdout } = await runCli(
      ['migrate', 'contracts'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('skipped 1');
  });

  it('returns structured JSON with --json', async () => {
    env = setupTempCorpWithContracts([{ projectName: 'fire', id: 'c1' }]);

    const { exitCode, stdout } = await runCli(
      ['migrate', 'contracts', '--json'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.migrated).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('reports friendly message when no contracts exist', async () => {
    env = setupTempCorpWithContracts([]);

    const { exitCode, stdout } = await runCli(
      ['migrate', 'contracts'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('no contracts found');
  });
});
