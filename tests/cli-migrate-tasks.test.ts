import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Integration tests for `cc-cli migrate tasks`. Spawns the built cli as
 * a real subprocess with an overridden HOME so the corp isolation is
 * identical to production usage — validates the migration path end-to-end.
 */

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

function setupTempCorpWithTasks(taskCount: number): {
  corpRoot: string;
  homeEnv: Record<string, string>;
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), 'cli-migrate-'));
  const corpRoot = join(home, '.claudecorp', 'test-corp');
  mkdirSync(corpRoot, { recursive: true });

  // Corp scaffolding (listCorps requires members.json)
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

  // Corps index
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

  // Seed pre-chits Task files
  const tasksDir = join(corpRoot, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  for (let i = 0; i < taskCount; i++) {
    const id = `seed-task${i}`;
    const content = `---
id: ${id}
title: Seeded task ${i}
status: ${i % 2 === 0 ? 'pending' : 'in_progress'}
priority: normal
assignedTo: null
createdBy: mark
projectId: null
parentTaskId: null
blockedBy: null
handedBy: null
handedAt: null
teamId: null
acceptanceCriteria: null
dueAt: null
loopId: null
createdAt: '2026-04-20T10:00:00.000Z'
updatedAt: '2026-04-20T10:00:00.000Z'
---

## Progress Notes
`;
    writeFileSync(join(tasksDir, `${id}.md`), content, 'utf-8');
  }

  const homeEnv: Record<string, string> = { HOME: home, USERPROFILE: home };
  return {
    corpRoot,
    homeEnv,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('cc-cli migrate — preconditions', () => {
  it('cli dist is built', () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });
});

describe('cc-cli migrate (no subcommand)', () => {
  it('prints help listing available migration targets', async () => {
    const { exitCode, stdout } = await runCli(['migrate']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('cc-cli migrate');
    expect(stdout).toContain('tasks');
  });

  it('rejects unknown subcommand', async () => {
    const { exitCode, stderr } = await runCli(['migrate', 'notreal']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Unknown migrate subcommand/);
  });
});

describe('cc-cli migrate tasks', () => {
  let env: { corpRoot: string; homeEnv: Record<string, string>; cleanup: () => void };

  afterEach(() => {
    if (env) env.cleanup();
  });

  it('migrates 3 seeded tasks, deletes sources, writes chits', async () => {
    env = setupTempCorpWithTasks(3);

    const { exitCode, stdout, stderr } = await runCli(
      ['migrate', 'tasks'],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('migrated 3 tasks');

    // Sources gone
    expect(readdirSync(join(env.corpRoot, 'tasks')).filter((f) => f.endsWith('.md'))).toHaveLength(0);
    // Chits present
    const chitsTaskDir = join(env.corpRoot, 'chits', 'task');
    expect(existsSync(chitsTaskDir)).toBe(true);
    expect(readdirSync(chitsTaskDir).filter((f) => f.endsWith('.md'))).toHaveLength(3);
  });

  it('migrated chits carry the expected frontmatter shape', async () => {
    env = setupTempCorpWithTasks(1);

    await runCli(['migrate', 'tasks'], { env: env.homeEnv });

    const chitPath = join(env.corpRoot, 'chits', 'task', 'seed-task0.md');
    const raw = readFileSync(chitPath, 'utf-8');
    // The source task had status=pending (legacy TaskStatus).
    // Post-1.3: legacy `pending` → chit.status=`draft` +
    // fields.task.workflowStatus=`draft` (the 1.3 rename).
    expect(raw).toContain('id: seed-task0');
    expect(raw).toContain('type: task');
    expect(raw).toContain('status: draft');
    expect(raw).toContain('workflowStatus: draft');
  });

  it('dry-run reports planned paths without writing or deleting', async () => {
    env = setupTempCorpWithTasks(2);

    const { exitCode, stdout } = await runCli(
      ['migrate', 'tasks', '--dry-run'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('DRY RUN');
    expect(stdout).toContain('would migrate 2 tasks');

    // Sources still there; no chits written
    expect(readdirSync(join(env.corpRoot, 'tasks')).filter((f) => f.endsWith('.md'))).toHaveLength(2);
    const chitsTaskDir = join(env.corpRoot, 'chits', 'task');
    expect(existsSync(chitsTaskDir)).toBe(false);
  });

  it('idempotent — re-running skips already-migrated tasks', async () => {
    env = setupTempCorpWithTasks(2);

    await runCli(['migrate', 'tasks'], { env: env.homeEnv });

    // Re-seed one source (simulates split state)
    writeFileSync(
      join(env.corpRoot, 'tasks', 'seed-task0.md'),
      readFileSync(join(env.corpRoot, 'chits', 'task', 'seed-task0.md'), 'utf-8'),
      'utf-8',
    );

    const { exitCode, stdout } = await runCli(
      ['migrate', 'tasks'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('skipped 1');
  });

  it('returns structured JSON with --json', async () => {
    env = setupTempCorpWithTasks(2);

    const { exitCode, stdout } = await runCli(
      ['migrate', 'tasks', '--json'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.migrated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('reports empty friendly message when no tasks exist', async () => {
    // Setup corp with 0 tasks — still create the .claudecorp structure
    env = setupTempCorpWithTasks(0);

    const { exitCode, stdout } = await runCli(
      ['migrate', 'tasks'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('no tasks found');
  });
});
