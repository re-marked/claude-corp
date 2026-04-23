import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Regression tests for the two Codex catches on `cc-cli tame`:
 *
 *   - Fix 2: tame must validate the target's workspace BEFORE mutating
 *     members.json. Persisting the kind flip first left partial
 *     promotions — Partner by flag, Employee by substrate.
 *
 *   - Fix 3: tame must regenerate .claude/settings.json alongside
 *     CLAUDE.md. Without this, newly-tamed Partners ran with Employee
 *     hooks — no PreCompact (compaction audit), no UserPromptSubmit
 *     (inbox check-in). Soul files there, lifecycle plumbing missing.
 *
 * Spawns the built cc-cli binary against a tempdir corp so every
 * filesystem effect is observable end-to-end, matching the cli-chit /
 * cli-wtf test style.
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
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cc-cli ${args.join(' ')} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.on('exit', (exitCode) => {
      clearTimeout(killer);
      resolve({ exitCode, stdout, stderr });
    });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
  });
}

interface CorpFixture {
  corpRoot: string;
  homeEnv: Record<string, string>;
  cleanup: () => void;
}

/**
 * Minimal corp with one Employee agent that has a real workspace +
 * Employee-shaped CLAUDE.md + Employee-shaped .claude/settings.json.
 * Optional `employeeAgentDir` control — pass null to deliberately
 * orphan the agent's agentDir (Fix 2 regression).
 */
function setupCorpWithEmployee(opts: { orphanEmployee?: boolean } = {}): CorpFixture {
  const home = mkdtempSync(join(tmpdir(), 'cli-tame-home-'));
  const corpRoot = join(home, '.claudecorp', 'tame-corp');
  mkdirSync(corpRoot, { recursive: true });

  writeFileSync(
    join(corpRoot, 'corp.json'),
    JSON.stringify({ name: 'tame-corp', theme: 'corporate', founder: 'founder' }, null, 2),
  );

  // Employee workspace. Agent slug = 'toast'. agentDir is relative
  // to corpRoot per the agent-setup convention.
  const employeeDir = 'agents/toast/';
  const employeeAbs = join(corpRoot, employeeDir);
  if (!opts.orphanEmployee) {
    mkdirSync(employeeAbs, { recursive: true });
    mkdirSync(join(employeeAbs, '.claude'), { recursive: true });
    // Employee-shaped CLAUDE.md — presence is the claude-code marker
    // tame uses to decide whether to regenerate harness files.
    writeFileSync(
      join(employeeAbs, 'CLAUDE.md'),
      '# Toast\n\nYou are Toast, a Backend Engineer (employee) in the tame-corp corporation.\n',
    );
    // Employee-shaped settings.json — no PreCompact, no UserPromptSubmit.
    // We'll assert these show up after tame regenerates.
    writeFileSync(
      join(employeeAbs, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'cc-cli wtf --agent toast' }] }],
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'cc-cli audit --agent toast' }] }],
        },
      }, null, 2),
    );
  }

  writeFileSync(
    join(corpRoot, 'members.json'),
    JSON.stringify([
      {
        id: 'founder',
        displayName: 'Mark',
        rank: 'owner',
        status: 'active',
        type: 'human',
        scope: 'corp',
        scopeId: '',
      },
      {
        id: 'toast',
        displayName: 'Toast',
        rank: 'worker',
        status: 'active',
        type: 'agent',
        scope: 'corp',
        scopeId: '',
        agentDir: employeeDir,
        kind: 'employee',
        role: 'backend-engineer',
        harness: 'claude-code',
        createdAt: new Date().toISOString(),
      },
    ], null, 2),
  );

  writeFileSync(join(corpRoot, 'channels.json'), JSON.stringify([]));

  // Corps index + global config (same pattern as cli-chit tests).
  const corpsIndexDir = join(home, '.claudecorp', 'corps');
  mkdirSync(corpsIndexDir, { recursive: true });
  writeFileSync(
    join(corpsIndexDir, 'index.json'),
    JSON.stringify({ corps: [{ name: 'tame-corp', path: corpRoot }] }, null, 2),
  );
  writeFileSync(
    join(home, '.claudecorp', 'global-config.json'),
    JSON.stringify({ apiKey: 'test', defaultModel: 'haiku' }, null, 2),
  );

  return {
    corpRoot,
    homeEnv: { HOME: home, USERPROFILE: home },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('cc-cli tame — preconditions', () => {
  it('cli dist is built', () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });
});

describe('cc-cli tame — Fix 2: validates workspace before persisting kind flip', () => {
  let fixture: CorpFixture;

  beforeEach(() => { fixture = setupCorpWithEmployee({ orphanEmployee: true }); });
  afterEach(() => fixture.cleanup());

  it('exits non-zero without mutating members.json when the target workspace does not exist', async () => {
    const membersBefore = readFileSync(join(fixture.corpRoot, 'members.json'), 'utf-8');

    const { exitCode, stderr } = await runCli(
      ['tame', '--slug', 'toast', '--reason', 'shipped the chit migrations solo', '--corp', 'tame-corp'],
      { env: fixture.homeEnv },
    );

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/workspace does not exist/i);

    // Critical invariant: no persistence happened. members.json byte-
    // identical to pre-run. toast remains an Employee.
    const membersAfter = readFileSync(join(fixture.corpRoot, 'members.json'), 'utf-8');
    expect(membersAfter).toBe(membersBefore);

    const members = JSON.parse(membersAfter);
    const toast = members.find((m: { id: string }) => m.id === 'toast');
    expect(toast.kind).toBe('employee');
  });
});

describe('cc-cli tame — Fix 3: regenerates .claude/settings.json for Partner shape', () => {
  let fixture: CorpFixture;

  beforeEach(() => { fixture = setupCorpWithEmployee(); });
  afterEach(() => fixture.cleanup());

  it('rewrites .claude/settings.json with Partner hooks (PreCompact + UserPromptSubmit) alongside CLAUDE.md', async () => {
    const settingsPath = join(fixture.corpRoot, 'agents/toast/.claude/settings.json');

    // Baseline: Employee shape — no PreCompact, no UserPromptSubmit.
    const before = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(before.hooks.PreCompact).toBeUndefined();
    expect(before.hooks.UserPromptSubmit).toBeUndefined();

    const { exitCode, stderr } = await runCli(
      ['tame', '--slug', 'toast', '--reason', 'shipped the chit migrations solo plus acceptance criteria', '--from', 'founder', '--corp', 'tame-corp'],
      { env: fixture.homeEnv },
    );
    expect(exitCode, `stderr: ${stderr}`).toBe(0);

    // Post-tame: Partner hook set landed.
    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.hooks.SessionStart).toBeDefined();
    expect(after.hooks.Stop).toBeDefined();
    expect(after.hooks.PreCompact).toBeDefined();
    expect(after.hooks.UserPromptSubmit).toBeDefined();

    // And CLAUDE.md re-rendered to Partner shape (paired rewrite —
    // the two files travel together, the point of Fix 3).
    const claudeMd = readFileSync(join(fixture.corpRoot, 'agents/toast/CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('(partner)');
    expect(claudeMd).not.toContain('(employee)');
  });
});
