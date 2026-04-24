import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Integration tests for `cc-cli blueprint` subcommands (Project 1.8
 * PR 3). Spawns the built cc-cli binary as a subprocess so every test
 * exercises the REAL cli path founders + agents hit — arg parsing,
 * shared-library integration, exit codes, stdout/stderr, filesystem
 * effects, chit writes.
 *
 * Modeled on tests/cli-chit.test.ts's subprocess-plus-tmpdir-HOME
 * pattern: we shadow ~/.claudecorp via HOME+USERPROFILE env overrides
 * pointing at a per-test tmpdir, create the minimal corp files
 * required for listCorps() to accept the corp, then run the cli
 * against that isolated environment.
 *
 * Every path covered: happy path for all 5 subcommands (new, list,
 * show, validate, cast), error paths (missing positional / scope,
 * unknown blueprint, draft-cast rejection, bad flag values), + the
 * dispatcher's help + unknown-subcommand branches.
 */

const CLI_DIST = join(__dirname, '..', 'packages', 'cli', 'dist', 'index.js');
const TIMEOUT_MS = 15_000;

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

function setupTempCorp(): {
  corpRoot: string;
  homeEnv: Record<string, string>;
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), 'cli-bp-home-'));
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

  return {
    corpRoot,
    homeEnv: { HOME: home, USERPROFILE: home },
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // Windows fs-handle race — best effort.
      }
    },
  };
}

// ─── Preconditions ──────────────────────────────────────────────────

describe('cc-cli blueprint — preconditions', () => {
  it('cli dist is built', () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });
});

// ─── Dispatcher ─────────────────────────────────────────────────────

describe('cc-cli blueprint (no subcommand)', () => {
  it('prints help text listing all five subcommands', async () => {
    const { exitCode, stdout } = await runCli(['blueprint']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('cc-cli blueprint');
    expect(stdout).toContain('Subcommands');
    for (const sub of ['new', 'list', 'show', 'validate', 'cast']) {
      expect(stdout).toContain(sub);
    }
  });

  it('"blueprint help" (positional) prints the same help text — note that `--help` at this position is consumed by the top-level CLI and routes to global help, consistent with every other subcommand group', async () => {
    const { exitCode, stdout } = await runCli(['blueprint', 'help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Subcommands');
  });

  it('rejects unknown subcommands with non-zero exit', async () => {
    const { exitCode, stderr } = await runCli(['blueprint', 'floop']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Unknown blueprint subcommand/);
  });
});

// ─── new ────────────────────────────────────────────────────────────

describe('cc-cli blueprint new', () => {
  let env: ReturnType<typeof setupTempCorp>;

  beforeEach(() => {
    env = setupTempCorp();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('scaffolds a draft blueprint chit at corp scope by default', async () => {
    const { exitCode, stdout } = await runCli(
      ['blueprint', 'new', 'my-workflow', '--title', 'My Workflow'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Blueprint draft created');
    expect(stdout).toContain('my-workflow');
    expect(stdout).toContain('draft');
    expect(stdout).toContain('file:');

    // File persisted on disk.
    const blueprintDir = join(env.corpRoot, 'chits', 'blueprint');
    expect(existsSync(blueprintDir)).toBe(true);
    expect(readdirSync(blueprintDir).length).toBe(1);
  });

  it('rejects missing <name> positional', async () => {
    const { exitCode, stderr } = await runCli(['blueprint', 'new'], { env: env.homeEnv });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('<name> required');
  });

  it('rejects a duplicate name at the same scope', async () => {
    await runCli(['blueprint', 'new', 'dup-test'], { env: env.homeEnv });
    const second = await runCli(['blueprint', 'new', 'dup-test'], { env: env.homeEnv });
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain('already exists');
    expect(second.stderr).toContain('dup-test');
  });

  it('rejects an invalid kebab-case name (uppercase)', async () => {
    const { exitCode, stderr } = await runCli(['blueprint', 'new', 'BAD-NAME'], {
      env: env.homeEnv,
    });
    expect(exitCode).not.toBe(0);
    // Passes through the chit-type validator error message.
    expect(stderr).toContain('kebab-case');
  });

  it('accepts a name with `/` category separator', async () => {
    const { exitCode, stdout } = await runCli(
      ['blueprint', 'new', 'patrol/my-check'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('patrol/my-check');
  });
});

// ─── list ───────────────────────────────────────────────────────────

describe('cc-cli blueprint list', () => {
  let env: ReturnType<typeof setupTempCorp>;

  beforeEach(() => {
    env = setupTempCorp();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('reports empty state on a corp with no blueprints', async () => {
    const { exitCode, stdout } = await runCli(['blueprint', 'list'], { env: env.homeEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/No active blueprints/);
  });

  it('lists drafts when --all passed', async () => {
    await runCli(['blueprint', 'new', 'first'], { env: env.homeEnv });
    await runCli(['blueprint', 'new', 'second'], { env: env.homeEnv });

    const { exitCode, stdout } = await runCli(['blueprint', 'list', '--all'], {
      env: env.homeEnv,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('first');
    expect(stdout).toContain('second');
    expect(stdout).toContain('draft');
    expect(stdout).toContain('2 blueprint');
  });

  it('hides drafts by default (active-only)', async () => {
    await runCli(['blueprint', 'new', 'hidden-draft'], { env: env.homeEnv });
    const { stdout } = await runCli(['blueprint', 'list'], { env: env.homeEnv });
    expect(stdout).toMatch(/No active blueprints/);
    expect(stdout).not.toContain('hidden-draft');
  });

  it('--json emits a parseable array', async () => {
    await runCli(['blueprint', 'new', 'json-test'], { env: env.homeEnv });
    const { exitCode, stdout } = await runCli(
      ['blueprint', 'list', '--all', '--json'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe('json-test');
    expect(parsed[0].status).toBe('draft');
  });
});

// ─── show ───────────────────────────────────────────────────────────

describe('cc-cli blueprint show', () => {
  let env: ReturnType<typeof setupTempCorp>;

  beforeEach(() => {
    env = setupTempCorp();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('rejects missing <name-or-id>', async () => {
    const { exitCode, stderr } = await runCli(['blueprint', 'show'], {
      env: env.homeEnv,
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('<name-or-id> required');
  });

  it('errors on unknown name (active-only default)', async () => {
    await runCli(['blueprint', 'new', 'just-a-draft'], { env: env.homeEnv });
    // Draft exists but show defaults to active-only.
    const { exitCode, stderr } = await runCli(
      ['blueprint', 'show', 'just-a-draft'],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/not found/);
    expect(stderr).toMatch(/--include-draft/);
  });

  it('renders a draft when --include-draft passed', async () => {
    await runCli(
      ['blueprint', 'new', 'drafty', '--title', 'Drafty', '--summary', 'does stuff'],
      { env: env.homeEnv },
    );
    const { exitCode, stdout } = await runCli(
      ['blueprint', 'show', 'drafty', '--include-draft'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Blueprint: drafty');
    expect(stdout).toContain('draft');
    expect(stdout).toContain('Drafty');
    expect(stdout).toContain('does stuff');
    expect(stdout).toContain('Steps');
  });

  it('--json dumps the full chit + derived scope + path', async () => {
    await runCli(['blueprint', 'new', 'json-show'], { env: env.homeEnv });
    const { exitCode, stdout } = await runCli(
      ['blueprint', 'show', 'json-show', '--include-draft', '--json'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.type).toBe('blueprint');
    expect(parsed.fields.blueprint.name).toBe('json-show');
    expect(parsed.scope).toBe('corp');
    expect(parsed.path).toBeTruthy();
  });
});

// ─── validate ───────────────────────────────────────────────────────

describe('cc-cli blueprint validate', () => {
  let env: ReturnType<typeof setupTempCorp>;

  beforeEach(() => {
    env = setupTempCorp();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('promotes a structurally-sound draft to active', async () => {
    // new.ts scaffolds a minimal 1-step blueprint — parses fine.
    await runCli(['blueprint', 'new', 'promo-test'], { env: env.homeEnv });

    const { exitCode, stdout } = await runCli(
      ['blueprint', 'validate', 'promo-test'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('validated');
    expect(stdout).toContain('draft → active');

    // Now show should find it active.
    const show = await runCli(['blueprint', 'show', 'promo-test'], { env: env.homeEnv });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('status:  active');
  });

  it('is a no-op on an already-active blueprint', async () => {
    await runCli(['blueprint', 'new', 'already'], { env: env.homeEnv });
    await runCli(['blueprint', 'validate', 'already'], { env: env.homeEnv });

    const { exitCode, stdout } = await runCli(
      ['blueprint', 'validate', 'already'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/already active/);
  });

  it('errors with exit 1 when blueprint not found', async () => {
    const { exitCode, stderr } = await runCli(
      ['blueprint', 'validate', 'nope'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not found');
  });

  it('--json emits a structured success payload', async () => {
    await runCli(['blueprint', 'new', 'json-val'], { env: env.homeEnv });
    const { exitCode, stdout } = await runCli(
      ['blueprint', 'validate', 'json-val', '--json'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.promoted).toBe(true);
    expect(parsed.name).toBe('json-val');
  });
});

// ─── cast ──────────────────────────────────────────────────────────

describe('cc-cli blueprint cast', () => {
  let env: ReturnType<typeof setupTempCorp>;

  beforeEach(() => {
    env = setupTempCorp();
  });

  afterEach(() => {
    env.cleanup();
  });

  async function prepareActiveBlueprint(name: string): Promise<void> {
    // Scaffold a blueprint, edit its steps[0].assigneeRole to an
    // existing registry role (scaffold defaults to null), then validate
    // it to promote to active. We edit the chit file directly because
    // there's no CLI command for mid-step editing yet.
    await runCli(['blueprint', 'new', name], { env: env.homeEnv });
    const blueprintDir = join(env.corpRoot, 'chits', 'blueprint');
    const file = readdirSync(blueprintDir)[0]!;
    const path = join(blueprintDir, file);

    const { readFileSync } = await import('node:fs');
    const content = readFileSync(path, 'utf-8');
    // Replace the null assigneeRole with a real registry role.
    const patched = content.replace(/assigneeRole: null/, 'assigneeRole: ceo');
    writeFileSync(path, patched, 'utf-8');

    const val = await runCli(['blueprint', 'validate', name], { env: env.homeEnv });
    if (val.exitCode !== 0) {
      throw new Error(
        `validate failed during test prep: exit ${val.exitCode}\n` +
          `stdout: ${val.stdout}\nstderr: ${val.stderr}`,
      );
    }
  }

  it('rejects missing --scope flag', async () => {
    await prepareActiveBlueprint('cast-needs-scope');
    const { exitCode, stderr } = await runCli(
      ['blueprint', 'cast', 'cast-needs-scope'],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--scope');
  });

  it('rejects missing <name-or-id> positional', async () => {
    const { exitCode, stderr } = await runCli(
      ['blueprint', 'cast', '--scope', 'corp'],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('<name-or-id> required');
  });

  it('rejects casting a draft blueprint (active-only)', async () => {
    await runCli(['blueprint', 'new', 'still-draft'], { env: env.homeEnv });
    // Not promoting; draft stays.
    const { exitCode, stderr } = await runCli(
      ['blueprint', 'cast', 'still-draft', '--scope', 'corp'],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/active blueprint.+not found/);
    expect(stderr).toMatch(/validate/);
  });

  it('casts an active blueprint into Contract + Task chits', async () => {
    await prepareActiveBlueprint('ship-thing');

    const { exitCode, stdout } = await runCli(
      ['blueprint', 'cast', 'ship-thing', '--scope', 'corp'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Cast ship-thing');
    expect(stdout).toContain('Contract:');
    expect(stdout).toContain('Tasks:');

    // Contract + Task chits written.
    const contractDir = join(env.corpRoot, 'chits', 'contract');
    const taskDir = join(env.corpRoot, 'chits', 'task');
    expect(existsSync(contractDir)).toBe(true);
    expect(existsSync(taskDir)).toBe(true);
    expect(readdirSync(contractDir).length).toBe(1);
    expect(readdirSync(taskDir).length).toBeGreaterThanOrEqual(1);
  });

  it('--json emits Contract + Tasks shape', async () => {
    await prepareActiveBlueprint('json-cast');

    const { exitCode, stdout } = await runCli(
      ['blueprint', 'cast', 'json-cast', '--scope', 'corp', '--json'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.blueprint.name).toBe('json-cast');
    expect(parsed.contract.id).toMatch(/^chit-c-/);
    expect(Array.isArray(parsed.tasks)).toBe(true);
  });

  it('rejects an invalid --priority value', async () => {
    await prepareActiveBlueprint('bad-prio');
    const { exitCode, stderr } = await runCli(
      ['blueprint', 'cast', 'bad-prio', '--scope', 'corp', '--priority', 'yelling'],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--priority');
  });

  it('rejects malformed --vars pair (missing =)', async () => {
    await prepareActiveBlueprint('bad-vars');
    const { exitCode, stderr } = await runCli(
      ['blueprint', 'cast', 'bad-vars', '--scope', 'corp', '--vars', 'nokvp'],
      { env: env.homeEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--vars');
    expect(stderr).toMatch(/key=value/);
  });

  it('--vars k=v flows through to cast-time Handlebars expansion', async () => {
    // Seed an active blueprint with a declared var + a Handlebars-ref
    // step title. Then cast with --vars and verify the resulting Task
    // title has the caller's value substituted in. Proves the CLI's
    // key=value parsing reaches castFromBlueprint intact AND that
    // Handlebars expansion happens end-to-end through the cc-cli path.
    await runCli(['blueprint', 'new', 'vars-flow'], { env: env.homeEnv });
    const blueprintDir = join(env.corpRoot, 'chits', 'blueprint');
    const file = readdirSync(blueprintDir)[0]!;
    const path = join(blueprintDir, file);

    const { readFileSync } = await import('node:fs');
    const original = readFileSync(path, 'utf-8');
    // Splice in a var declaration + reference it from the step title.
    // The YAML frontmatter order matters less than structural
    // correctness; we're injecting into the one-step scaffold.
    const patched = original
      .replace(/assigneeRole: null/, 'assigneeRole: ceo')
      .replace(/vars: \[\]/, "vars:\n    - { name: feature, type: string }")
      .replace(
        /title: First step \(edit me\)/,
        "title: Ship {{feature}}",
      );
    writeFileSync(path, patched, 'utf-8');

    const val = await runCli(['blueprint', 'validate', 'vars-flow'], {
      env: env.homeEnv,
    });
    if (val.exitCode !== 0) {
      throw new Error(
        `validate failed in --vars test: ${val.stdout}\n${val.stderr}`,
      );
    }

    const { exitCode, stdout } = await runCli(
      [
        'blueprint',
        'cast',
        'vars-flow',
        '--scope',
        'corp',
        '--vars',
        'feature=fire',
        '--json',
      ],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].title).toBe('Ship fire');
  });

  it('--step-role stepId=roleId fills null assigneeRole on the resolved Task', async () => {
    // Seed a blueprint with assigneeRole: null + use --step-role to
    // resolve at cast time. Proves the CLI's parseKeyValuePairs for
    // --step-role threads through to castFromBlueprint's
    // stepRoleOverrides param.
    await runCli(['blueprint', 'new', 'role-fill'], { env: env.homeEnv });
    const blueprintDir = join(env.corpRoot, 'chits', 'blueprint');
    const file = readdirSync(blueprintDir)[0]!;
    const path = join(blueprintDir, file);
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(path, 'utf-8');
    // Don't replace the null — that's the whole point; --step-role
    // fills it at cast time. Just need step id to be deterministic
    // (scaffold uses 'step-1').
    writeFileSync(path, content, 'utf-8');

    const val = await runCli(['blueprint', 'validate', 'role-fill'], {
      env: env.homeEnv,
    });
    if (val.exitCode !== 0) {
      throw new Error(`validate failed: ${val.stdout}\n${val.stderr}`);
    }

    const { exitCode, stdout } = await runCli(
      [
        'blueprint',
        'cast',
        'role-fill',
        '--scope',
        'corp',
        '--step-role',
        'step-1=ceo',
        '--json',
      ],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.tasks[0].assignee).toBe('ceo');
  });

  it('--lead + --deadline contract overrides land on the Contract chit', async () => {
    await prepareActiveBlueprint('lead-deadline');

    const { exitCode, stdout } = await runCli(
      [
        'blueprint',
        'cast',
        'lead-deadline',
        '--scope',
        'corp',
        '--lead',
        'herald',
        '--deadline',
        '2026-12-31T00:00:00Z',
        '--json',
      ],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.contract.id).toMatch(/^chit-c-/);
    // --json output shape carries blueprint + contract + tasks; to
    // verify lead + deadline landed on the Contract we read it back
    // via blueprint show's JSON-surface equivalent. Simpler: re-read
    // the contract chit directly from disk.
    const contractDir = join(env.corpRoot, 'chits', 'contract');
    const contractFile = readdirSync(contractDir)[0]!;
    const contractContent = readFileSync(
      join(contractDir, contractFile),
      'utf-8',
    );
    // Match frontmatter shape loosely — YAML may quote ISO timestamps,
    // and leadId may or may not be quoted depending on serializer.
    expect(contractContent).toMatch(/leadId:\s*['"]?herald['"]?/);
    expect(contractContent).toMatch(/deadline:\s*['"]?2026-12-31T00:00:00Z['"]?/);
  });
});

// ─── --scope collision (PR #173 P2 regression) ─────────────────────

describe('cc-cli blueprint validate --scope — collision handling', () => {
  let env: ReturnType<typeof setupTempCorp>;

  beforeEach(() => {
    env = setupTempCorp();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('validate --scope targets the correct scope when the name exists in multiple scopes', async () => {
    // Reviewer catch (PR #173 P2): `validate --scope X` ignored the
    // hint and resolved via default, so in collision cases it would
    // promote the wrong chit. This test:
    //   1. Seeds two drafts with the same name, one at corp, one
    //      at project:demo, via direct createChit (the CLI's `new`
    //      would reject a same-scope duplicate but cross-scope is
    //      legitimate per the scope-precedence design).
    //   2. Validates with `--scope project:demo`.
    //   3. Confirms ONLY the project-scope draft became active;
    //      the corp-scope one remains draft.
    //
    // Because `cc-cli blueprint new` can't easily seed a draft at
    // project scope without a project directory existing, we mkdir
    // the path manually; createChit handles the scope tagging.
    mkdirSync(join(env.corpRoot, 'projects', 'demo'), { recursive: true });

    // Seed corp-scope draft via CLI new.
    await runCli(['blueprint', 'new', 'collide'], { env: env.homeEnv });

    // Seed project-scope draft via the CLI too, using --scope.
    // cc-cli blueprint new does support --scope.
    await runCli(
      ['blueprint', 'new', 'collide', '--scope', 'project:demo'],
      { env: env.homeEnv },
    );

    // Sanity — both drafts exist.
    const list = await runCli(['blueprint', 'list', '--all', '--json'], {
      env: env.homeEnv,
    });
    const beforeRows = JSON.parse(list.stdout);
    expect(beforeRows.filter((r: { name: string }) => r.name === 'collide')).toHaveLength(2);

    // Validate with --scope project:demo — should promote ONLY the
    // project-scope chit.
    const val = await runCli(
      ['blueprint', 'validate', 'collide', '--scope', 'project:demo'],
      { env: env.homeEnv },
    );
    expect(val.exitCode).toBe(0);
    expect(val.stdout).toContain('promoted');

    // Verify: project-scope row is active, corp-scope row is still draft.
    const list2 = await runCli(['blueprint', 'list', '--all', '--json'], {
      env: env.homeEnv,
    });
    const afterRows = JSON.parse(list2.stdout);
    const projectRow = afterRows.find(
      (r: { name: string; scope: string }) =>
        r.name === 'collide' && r.scope === 'project:demo',
    );
    const corpRow = afterRows.find(
      (r: { name: string; scope: string }) =>
        r.name === 'collide' && r.scope === 'corp',
    );
    expect(projectRow.status).toBe('active');
    expect(corpRow.status).toBe('draft');
  });
});

// ─── list --scope filter (test gap) ─────────────────────────────────

describe('cc-cli blueprint list --scope', () => {
  let env: ReturnType<typeof setupTempCorp>;

  beforeEach(() => {
    env = setupTempCorp();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('--scope filters the listing to exactly that scope', async () => {
    mkdirSync(join(env.corpRoot, 'projects', 'demo'), { recursive: true });

    await runCli(['blueprint', 'new', 'only-corp'], { env: env.homeEnv });
    await runCli(
      ['blueprint', 'new', 'only-project', '--scope', 'project:demo'],
      { env: env.homeEnv },
    );

    const { exitCode, stdout } = await runCli(
      ['blueprint', 'list', '--scope', 'project:demo', '--all', '--json'],
      { env: env.homeEnv },
    );
    expect(exitCode).toBe(0);
    const rows = JSON.parse(stdout);
    // Only one row, the project-scope blueprint.
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('only-project');
    expect(rows[0].scope).toBe('project:demo');
  });
});
