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

function setupTempCorpWithObservationLogs(
  entries: Array<{ agent: string; date: string; bullets: string[] }>,
): { corpRoot: string; homeEnv: Record<string, string>; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'cli-migrate-obs-'));
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

  // Seed daily observation log files
  for (const { agent, date, bullets } of entries) {
    const [year, month] = date.split('-');
    const dir = join(corpRoot, 'agents', agent, 'observations', year!, month!);
    mkdirSync(dir, { recursive: true });
    const content = `# Observations — ${date}\n\n${bullets.join('\n')}\n`;
    writeFileSync(join(dir, `${date}.md`), content, 'utf-8');
  }

  const homeEnv: Record<string, string> = { HOME: home, USERPROFILE: home };
  return {
    corpRoot,
    homeEnv,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('cc-cli migrate observations', () => {
  let env: { corpRoot: string; homeEnv: Record<string, string>; cleanup: () => void };

  afterEach(() => {
    if (env) env.cleanup();
  });

  it('migrates all bullets from a single daily log', async () => {
    env = setupTempCorpWithObservationLogs([
      {
        agent: 'toast',
        date: '2026-04-20',
        bullets: [
          '- 09:00 [TASK] picked up work',
          '- 14:30 [DECISION] chose approach A',
          '- 16:00 [CREATED] wrote tests',
        ],
      },
    ]);

    const { exitCode, stdout, stderr } = await runCli(
      ['migrate', 'observations'],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('migrated 3 observations');

    // Source deleted
    expect(existsSync(join(env.corpRoot, 'agents', 'toast', 'observations', '2026', '04', '2026-04-20.md'))).toBe(false);
    // 3 chits at agent:toast scope
    const chitDir = join(env.corpRoot, 'agents', 'toast', 'chits', 'observation');
    expect(readdirSync(chitDir).filter((f) => f.endsWith('.md'))).toHaveLength(3);
  });

  it('walks multi-agent, multi-date corpus in one call', async () => {
    env = setupTempCorpWithObservationLogs([
      { agent: 'toast', date: '2026-04-20', bullets: ['- 10:00 [TASK] a'] },
      { agent: 'toast', date: '2026-03-15', bullets: ['- 11:00 [LEARNED] b', '- 11:30 [DECISION] c'] },
      { agent: 'copper', date: '2026-04-20', bullets: ['- 12:00 [CREATED] d'] },
    ]);

    const { exitCode, stdout } = await runCli(
      ['migrate', 'observations'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('migrated 4 observations');
    expect(stdout).toContain('from 3 daily logs');
  });

  it('dry-run reports planned counts without writing', async () => {
    env = setupTempCorpWithObservationLogs([
      {
        agent: 'toast',
        date: '2026-04-20',
        bullets: ['- 10:00 [TASK] a', '- 11:00 [LEARNED] b'],
      },
    ]);

    const { exitCode, stdout } = await runCli(
      ['migrate', 'observations', '--dry-run'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('DRY RUN');
    expect(stdout).toContain('would migrate 2 observations from 1 file');

    // Nothing written
    expect(existsSync(join(env.corpRoot, 'agents', 'toast', 'chits'))).toBe(false);
    // Source preserved
    expect(existsSync(join(env.corpRoot, 'agents', 'toast', 'observations', '2026', '04', '2026-04-20.md'))).toBe(true);
  });

  it('returns structured JSON with --json', async () => {
    env = setupTempCorpWithObservationLogs([
      { agent: 'toast', date: '2026-04-20', bullets: ['- 10:00 [TASK] a'] },
    ]);

    const { exitCode, stdout } = await runCli(
      ['migrate', 'observations', '--json'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.migrated).toBe(1);
    expect(result.filesProcessed).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('reports skipped count when bullets are malformed', async () => {
    env = setupTempCorpWithObservationLogs([
      {
        agent: 'toast',
        date: '2026-04-20',
        bullets: [
          '- not a valid bullet',
          '- 10:00 [TASK] valid',
          '- garbage line',
        ],
      },
    ]);

    const { exitCode, stdout } = await runCli(
      ['migrate', 'observations'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('migrated 1');
    expect(stdout).toContain('skipped 2 malformed bullet lines');
  });

  it('reports empty-corp friendly message when no observations exist', async () => {
    env = setupTempCorpWithObservationLogs([]);

    const { exitCode, stdout } = await runCli(
      ['migrate', 'observations'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('no observations found');
  });
});
