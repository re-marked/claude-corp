import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Regression for v2.1.18: cc-cli used to dangle for ~5 seconds after
 * every command because index.ts had no `process.exit(0)` on the
 * success path. Node's fetch (undici) keeps connection pools alive
 * for that long after the last request, blocking event loop shutdown.
 *
 * Real-world cost: every Bash-tool invocation of cc-cli by an agent
 * burned 5 extra seconds on top of the actual work — Failsafe's
 * `inspect` + `status` chain at 18:27 today cost 10+ seconds of
 * agent thinking time the model wasn't actually using.
 *
 * These tests spawn the built cc-cli as a real subprocess and assert
 * it exits within 2 seconds. If a future change re-introduces the
 * hang (a new fetch call, an unclosed websocket, a leaked timer),
 * this catches it before it ships.
 */

const CLI_DIST = join(__dirname, '..', 'packages', 'cli', 'dist', 'index.js');
const TIMEOUT_MS = 2000;

function runCli(args: string[]): Promise<{ exitCode: number | null; durationMs: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [CLI_DIST, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cc-cli ${args.join(' ')} did not exit within ${TIMEOUT_MS}ms — likely hung on an open handle (undici pool, websocket, etc.)`));
    }, TIMEOUT_MS);

    child.on('exit', (exitCode) => {
      clearTimeout(killer);
      resolve({ exitCode, durationMs: Date.now() - start, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
  });
}

describe('cc-cli exits cleanly', () => {
  it('cc-cli dist binary is built (precondition for these tests)', () => {
    expect(existsSync(CLI_DIST), `cc-cli dist not found at ${CLI_DIST} — run pnpm build first`).toBe(true);
  });

  it('cc-cli --help exits within 2s', async () => {
    const { exitCode, durationMs } = await runCli(['--help']);
    expect(exitCode).toBe(0);
    expect(durationMs).toBeLessThan(TIMEOUT_MS);
  });

  it('cc-cli version exits within 2s — goes through the run() path that the v2.1.18 fix targets', async () => {
    const { exitCode, durationMs } = await runCli(['version']);
    expect(exitCode).toBe(0);
    expect(durationMs).toBeLessThan(TIMEOUT_MS);
  });

  it('cc-cli with unknown command exits within 2s (error path also auto-exits)', async () => {
    const { exitCode, durationMs } = await runCli(['this-command-does-not-exist']);
    expect(exitCode).toBe(1);
    expect(durationMs).toBeLessThan(TIMEOUT_MS);
  });
});
