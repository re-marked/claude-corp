import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Integration tests for `cc-cli chit` subcommands. Spawns the built
 * cc-cli binary as a subprocess to verify end-to-end behavior — arg
 * parsing, library integration, exit codes, stdout/stderr, filesystem
 * effects all exercised through the real cli path the founder and
 * agents use.
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
      reject(new Error(`cc-cli ${args.join(' ')} timed out after ${TIMEOUT_MS}ms`));
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

/**
 * Create a minimal corp at a tempdir + configure the corps index so
 * cc-cli can find it. Returns the corp path + the overridden HOME env
 * that points the cli at our temp ~/.claudecorp.
 */
function setupTempCorp(): { corpRoot: string; homeEnv: Record<string, string>; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'cli-chit-home-'));
  const corpRoot = join(home, '.claudecorp', 'test-corp');
  mkdirSync(corpRoot, { recursive: true });

  // Minimal corp.json so the corp is recognized
  writeFileSync(
    join(corpRoot, 'corp.json'),
    JSON.stringify({ name: 'test-corp', theme: 'corporate', founder: 'founder' }, null, 2),
    'utf-8',
  );

  // members.json — required for listCorps() to accept the corp
  // (checks existsSync(join(corpPath, 'members.json')) before listing)
  writeFileSync(
    join(corpRoot, 'members.json'),
    JSON.stringify({ members: [{ id: 'founder', name: 'founder', rank: 'owner' }] }, null, 2),
    'utf-8',
  );

  // channels.json — some code paths reach for it
  writeFileSync(
    join(corpRoot, 'channels.json'),
    JSON.stringify({ channels: [] }, null, 2),
    'utf-8',
  );

  // Corps index so listCorps() also finds it via the index path
  const corpsIndexDir = join(home, '.claudecorp', 'corps');
  mkdirSync(corpsIndexDir, { recursive: true });
  writeFileSync(
    join(corpsIndexDir, 'index.json'),
    JSON.stringify({ corps: [{ name: 'test-corp', path: corpRoot }] }, null, 2),
    'utf-8',
  );

  // Global config so ensureClaudeCorpHome() is satisfied
  writeFileSync(
    join(home, '.claudecorp', 'global-config.json'),
    JSON.stringify({ apiKey: 'test', defaultModel: 'haiku' }, null, 2),
    'utf-8',
  );

  // HOME for unix; USERPROFILE for windows (os.homedir() consults these).
  // Both set so the spawned process sees our temp dir regardless of platform.
  const homeEnv: Record<string, string> = { HOME: home, USERPROFILE: home };

  return {
    corpRoot,
    homeEnv,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('cc-cli chit — preconditions', () => {
  it('cli dist is built', () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });
});

describe('cc-cli chit (no subcommand)', () => {
  it('prints help text listing the subcommands', async () => {
    const { exitCode, stdout } = await runCli(['chit']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('cc-cli chit');
    expect(stdout).toContain('Subcommands');
    expect(stdout).toContain('create');
    expect(stdout).toContain('read');
  });

  it('rejects unknown subcommands with non-zero exit', async () => {
    const { exitCode, stderr } = await runCli(['chit', 'floop']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Unknown chit subcommand/);
  });
});

describe('cc-cli chit create', () => {
  let env: { corpRoot: string; homeEnv: Record<string, string>; cleanup: () => void };

  beforeEach(() => {
    env = setupTempCorp();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('creates a minimal task and prints the new id', async () => {
    const { exitCode, stdout, stderr } = await runCli(
      [
        'chit',
        'create',
        '--type',
        'task',
        '--scope',
        'corp',
        '--title',
        'ship it',
        '--field',
        'priority=normal',
      ],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    const id = stdout.trim();
    expect(id).toMatch(/^chit-t-[0-9a-f]{8}$/);

    // Verify file on disk
    const filePath = join(env.corpRoot, 'chits', 'task', `${id}.md`);
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).toContain('title: ship it');
    expect(raw).toContain('priority: normal');
  });

  it('creates an observation with tags and --json output', async () => {
    const { exitCode, stdout, stderr } = await runCli(
      [
        'chit',
        'create',
        '--type',
        'observation',
        '--scope',
        'agent:toast',
        '--field',
        'category=FEEDBACK',
        '--field',
        'subject=mark',
        '--field',
        'importance=4',
        '--tag',
        'mark-preference',
        '--tag',
        'actionable-errors',
        '--content',
        'Mark prefers actionable errors.',
        '--json',
      ],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    const chit = JSON.parse(stdout);
    expect(chit.type).toBe('observation');
    expect(chit.fields.observation.category).toBe('FEEDBACK');
    expect(chit.fields.observation.importance).toBe(4);
    expect(chit.tags).toContain('mark-preference');
    expect(chit.ephemeral).toBe(true);
  });

  it('rejects unknown --type with non-zero exit', async () => {
    const { exitCode, stderr } = await runCli(
      ['chit', 'create', '--type', 'notreal', '--scope', 'corp'],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/unknown chit type/);
  });

  it('rejects missing --scope', async () => {
    const { exitCode, stderr } = await runCli(
      ['chit', 'create', '--type', 'task'],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--scope is required/);
  });

  it('rejects invalid field values via validator (exit 2)', async () => {
    const { exitCode, stderr } = await runCli(
      [
        'chit',
        'create',
        '--type',
        'task',
        '--scope',
        'corp',
        '--title',
        'x',
        '--field',
        'priority=nonsense',
      ],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/priority/);
  });

  it('rejects --content and --content-file together', async () => {
    const fakeFile = join(env.corpRoot, 'fake.md');
    writeFileSync(fakeFile, 'fake content', 'utf-8');
    const { exitCode, stderr } = await runCli(
      [
        'chit',
        'create',
        '--type',
        'task',
        '--scope',
        'corp',
        '--title',
        'x',
        '--field',
        'priority=normal',
        '--content',
        'inline',
        '--content-file',
        fakeFile,
      ],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/mutually exclusive/);
  });
});

describe('cc-cli chit update', () => {
  let env: { corpRoot: string; homeEnv: Record<string, string>; cleanup: () => void };
  let taskId: string;

  beforeEach(async () => {
    env = setupTempCorp();
    const { stdout } = await runCli(
      [
        'chit',
        'create',
        '--type',
        'task',
        '--scope',
        'corp',
        '--title',
        'update me',
        '--field',
        'priority=normal',
      ],
      { env: env.homeEnv },
    );
    taskId = stdout.trim();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('updates status and records updatedBy', async () => {
    const { exitCode, stdout, stderr } = await runCli(
      ['chit', 'update', taskId, '--status', 'active', '--from', 'ceo'],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toMatch(/updated chit-t-/);

    // Verify persistence via read
    const read = await runCli(['chit', 'read', taskId, '--json'], { env: env.homeEnv });
    const chit = JSON.parse(read.stdout).chit;
    expect(chit.status).toBe('active');
    expect(chit.updatedBy).toBe('ceo');
  });

  it('partially updates fields, preserving the rest', async () => {
    const { exitCode, stderr } = await runCli(
      [
        'chit',
        'update',
        taskId,
        '--set-field',
        'priority=high',
        '--set-field',
        'assignee=backend',
        '--from',
        'ceo',
      ],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);

    const read = await runCli(['chit', 'read', taskId, '--json'], { env: env.homeEnv });
    const chit = JSON.parse(read.stdout).chit;
    expect(chit.fields.task.priority).toBe('high');
    expect(chit.fields.task.assignee).toBe('backend');
    expect(chit.fields.task.title).toBe('update me'); // preserved
  });

  it('adds and removes tags', async () => {
    // First add two tags
    await runCli(
      ['chit', 'update', taskId, '--add-tag', 'alpha', '--add-tag', 'beta', '--from', 'ceo'],
      { env: env.homeEnv },
    );
    // Then remove one, add another
    await runCli(
      ['chit', 'update', taskId, '--add-tag', 'gamma', '--remove-tag', 'alpha', '--from', 'ceo'],
      { env: env.homeEnv },
    );
    const read = await runCli(['chit', 'read', taskId, '--json'], { env: env.homeEnv });
    const chit = JSON.parse(read.stdout).chit;
    expect(chit.tags).toContain('beta');
    expect(chit.tags).toContain('gamma');
    expect(chit.tags).not.toContain('alpha');
  });

  it('appends body content with a separator', async () => {
    // First set an initial body via replace-content
    await runCli(
      ['chit', 'update', taskId, '--replace-content', 'line one', '--from', 'ceo'],
      { env: env.homeEnv },
    );
    // Then append
    await runCli(
      ['chit', 'update', taskId, '--append-content', 'line two', '--from', 'ceo'],
      { env: env.homeEnv },
    );
    const read = await runCli(['chit', 'read', taskId, '--json'], { env: env.homeEnv });
    const payload = JSON.parse(read.stdout);
    expect(payload.body).toContain('line one');
    expect(payload.body).toContain('line two');
  });

  it('rejects missing --from with non-zero exit', async () => {
    const { exitCode, stderr } = await runCli(
      ['chit', 'update', taskId, '--status', 'active'],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--from is required/);
  });

  it('surfaces concurrent modification with exit 4', async () => {
    // Get current updatedAt, then call update with a stale expected value
    const read = await runCli(['chit', 'read', taskId, '--json'], { env: env.homeEnv });
    const chit = JSON.parse(read.stdout).chit;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void chit.updatedAt; // sanity: it exists

    const { exitCode, stderr } = await runCli(
      [
        'chit',
        'update',
        taskId,
        '--status',
        'active',
        '--from',
        'ceo',
        '--expected-updated-at',
        '2020-01-01T00:00:00.000Z',
      ],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(4);
    expect(stderr).toMatch(/concurrent modification/);
  });

  it('rejects --replace-content and --append-content together', async () => {
    const { exitCode, stderr } = await runCli(
      [
        'chit',
        'update',
        taskId,
        '--replace-content',
        'x',
        '--append-content',
        'y',
        '--from',
        'ceo',
      ],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/mutually exclusive/);
  });
});

describe('cc-cli chit close', () => {
  let env: { corpRoot: string; homeEnv: Record<string, string>; cleanup: () => void };
  let taskId: string;

  beforeEach(async () => {
    env = setupTempCorp();
    const { stdout } = await runCli(
      [
        'chit',
        'create',
        '--type',
        'task',
        '--scope',
        'corp',
        '--title',
        'close me',
        '--field',
        'priority=normal',
      ],
      { env: env.homeEnv },
    );
    taskId = stdout.trim();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('closes a task with default status=completed', async () => {
    const { exitCode, stdout, stderr } = await runCli(
      ['chit', 'close', taskId, '--from', 'ceo'],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain(`closed ${taskId}`);
    expect(stdout).toContain('status=completed');
  });

  it('closes with a custom terminal status', async () => {
    const { exitCode, stdout, stderr } = await runCli(
      ['chit', 'close', taskId, '--status', 'failed', '--from', 'ceo'],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('status=failed');
  });

  it('rejects non-terminal status (exit 2 from validator)', async () => {
    const { exitCode, stderr } = await runCli(
      ['chit', 'close', taskId, '--status', 'active', '--from', 'ceo'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/terminal/);
  });

  it('rejects missing --from', async () => {
    const { exitCode, stderr } = await runCli(
      ['chit', 'close', taskId],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--from is required/);
  });
});

describe('cc-cli chit read', () => {
  let env: { corpRoot: string; homeEnv: Record<string, string>; cleanup: () => void };
  let taskId: string;

  beforeEach(async () => {
    env = setupTempCorp();
    // Seed a task via create
    const { stdout } = await runCli(
      [
        'chit',
        'create',
        '--type',
        'task',
        '--scope',
        'corp',
        '--title',
        'readable',
        '--field',
        'priority=high',
        '--tag',
        'seeded',
      ],
      { env: env.homeEnv },
    );
    taskId = stdout.trim();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('reads a task by id and prints human-readable frontmatter', async () => {
    const { exitCode, stdout, stderr } = await runCli(
      ['chit', 'read', taskId],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain(`id:         ${taskId}`);
    expect(stdout).toContain('type:       task');
    expect(stdout).toContain('status:     draft');
    expect(stdout).toContain('tags:       seeded');
    expect(stdout).toContain('priority: high');
    expect(stdout).toContain('title: readable');
  });

  it('returns JSON when --json is set', async () => {
    const { exitCode, stdout, stderr } = await runCli(
      ['chit', 'read', taskId, '--json'],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.chit.id).toBe(taskId);
    expect(payload.chit.fields.task.title).toBe('readable');
    expect(payload.path).toBeDefined();
  });

  it('extracts a single field with --field', async () => {
    const { exitCode, stdout, stderr } = await runCli(
      ['chit', 'read', taskId, '--field', 'priority'],
      { env: env.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);
    expect(stdout.trim()).toBe('high');
  });

  it('rejects invalid chit id format with non-zero exit', async () => {
    const { exitCode, stderr } = await runCli(
      ['chit', 'read', 'not-a-chit'],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/valid chit id format/);
  });

  it('exits non-zero when the chit does not exist', async () => {
    const { exitCode, stderr } = await runCli(
      ['chit', 'read', 'chit-t-00000000'],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/not found/);
  });

  it('surfaces malformed chits with exit code 3', async () => {
    // Write a garbage chit file at a predictable path
    const badId = 'chit-t-deadbeef';
    const badPath = join(env.corpRoot, 'chits', 'task', `${badId}.md`);
    mkdirSync(join(env.corpRoot, 'chits', 'task'), { recursive: true });
    writeFileSync(badPath, 'not a valid chit', 'utf-8');

    const { exitCode, stderr } = await runCli(
      ['chit', 'read', badId],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/malformed/);

    // Audit log should have an entry too
    const logPath = join(env.corpRoot, 'chits', '_log', 'malformed.jsonl');
    expect(existsSync(logPath)).toBe(true);
  });
});
