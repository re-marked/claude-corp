/**
 * Alarum dispatcher — invokes the ephemeral triage agent subprocess.
 *
 * ### What this is
 *
 * The thing Pulse's tick callback calls. Takes the daemon, produces
 * an AlarumDecision. Implements Option B from the 1.9.3 design: no
 * corp-member registration, no persistent workspace — a scratch
 * tmpdir per invocation, a claude CLI subprocess in that tmpdir,
 * captured stdout, parsed decision, tmpdir cleaned up. Matches Gas
 * Town's "Boot" pattern: ephemeral triage is *infrastructure*, not
 * a corp citizen.
 *
 * ### Flow per invocation
 *
 *   1. Build AlarumContext via buildAlarumContext (state primitives).
 *   2. Create a scratch tmpdir for this invocation (unique per tick).
 *   3. Write CLAUDE.md in the tmpdir containing ALARUM_SYSTEM_PROMPT —
 *      claude CLI auto-discovers CLAUDE.md in cwd at startup, which
 *      is how the corp's system-prompt-equivalent normally gets into
 *      any agent's session.
 *   4. Compose user prompt via composeAlarumUserPrompt(ctx).
 *   5. Spawn `claude -p` in the tmpdir with Haiku model, Bash tools
 *      pre-approved (--dangerously-skip-permissions), fresh session-id.
 *   6. Pipe user prompt to subprocess stdin.
 *   7. Await subprocess exit, capture stdout.
 *   8. parseAlarumDecision(stdout) — null on any failure.
 *   9. Clean up tmpdir.
 *  10. Return decision, falling back to `{ action: 'nothing',
 *      reason: '<error context>' }` on any exec/parse failure.
 *
 * ### Why fail-safe to `nothing`
 *
 * A broken Alarum must not cascade into Sexton wakes. Accidentally
 * waking Sexton on garbage output costs Partner-tier tokens (Opus /
 * Sonnet) on every failed tick — at 288 ticks/day the bill adds up
 * fast. Missing a wake, by contrast, recovers cheaply on the next
 * tick 5 min later. So every error path returns `nothing`.
 *
 * ### Cost observability
 *
 * Logs duration + decision per invocation. Haiku token counts aren't
 * available from the plain `-p` output (would need `--output-format
 * stream-json`); adding token-level observability is a follow-up if
 * the budget bite warrants it. Duration alone catches the worst cost
 * class (runaway subprocesses eating timeout budget).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Daemon } from '../daemon.js';
import { log, logError } from '../logger.js';
import { buildAlarumContext } from './alarum-state.js';
import {
  ALARUM_SYSTEM_PROMPT,
  composeAlarumUserPrompt,
  parseAlarumDecision,
  type AlarumDecision,
} from './alarum-prompt.js';

// ─── Configuration ──────────────────────────────────────────────────

/**
 * Model id for Alarum. Haiku is cheap + fast enough for a per-tick
 * triage decision. The precise ID tracks the current Claude Code
 * CLAUDE.md guidance (Haiku 4.5 at time of writing). Future model
 * rolls require editing exactly this constant.
 */
const ALARUM_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Subprocess timeout. 60s is generous for a one-shot Haiku decision
 * — typical successful invocations complete in 5-15s. A stuck
 * subprocess past this threshold gets killed + fallback-to-nothing.
 */
const ALARUM_TIMEOUT_MS = 60_000;

/**
 * Binary name. 'claude' resolves via PATH on all supported platforms.
 * Matches ClaudeCodeHarness's default.
 */
const CLAUDE_BINARY = 'claude';

// ─── Public entrypoint ──────────────────────────────────────────────

/**
 * Invoke Alarum for one Pulse tick. Always returns a decision — null
 * is never a legal return; every failure path produces
 * `{ action: 'nothing', reason: <context> }` so Pulse's tick is
 * deterministic.
 *
 * Side effects: writes a scratch tmpdir (cleaned up on return),
 * spawns a claude subprocess (exits with the subprocess), writes
 * log lines for observability.
 */
export async function invokeAlarum(daemon: Daemon): Promise<AlarumDecision> {
  const start = Date.now();
  const tickId = randomUUID();
  const ctx = buildAlarumContext(daemon);
  const userPrompt = composeAlarumUserPrompt(ctx);

  let scratchDir: string | null = null;
  try {
    scratchDir = mkdtempSync(join(tmpdir(), `alarum-${tickId.slice(0, 8)}-`));

    // System-prompt-equivalent: claude CLI auto-discovers CLAUDE.md in
    // cwd at startup. Writing ALARUM_SYSTEM_PROMPT as CLAUDE.md gives
    // her her role frame without needing --append-system-prompt or
    // similar flag mechanics.
    writeFileSync(join(scratchDir, 'CLAUDE.md'), ALARUM_SYSTEM_PROMPT, 'utf-8');

    const output = await runClaudeSubprocess(scratchDir, userPrompt);
    const parsed = parseAlarumDecision(output);

    const duration = Date.now() - start;

    if (!parsed) {
      log(`[alarum] invocation ${tickId.slice(0, 8)} parse-failed in ${duration}ms — falling back to 'nothing'`);
      return {
        action: 'nothing',
        reason: `parse-failure: output did not contain a valid JSON decision block (${truncate(output, 120)})`,
      };
    }

    log(`[alarum] invocation ${tickId.slice(0, 8)} → ${parsed.action} in ${duration}ms — ${parsed.reason}`);
    return parsed;
  } catch (err) {
    const duration = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    logError(`[alarum] invocation ${tickId.slice(0, 8)} exec-failed in ${duration}ms: ${message}`);
    return {
      action: 'nothing',
      reason: `exec-failure: ${truncate(message, 160)}`,
    };
  } finally {
    if (scratchDir) {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // Windows fs-handle race — best effort, orphan tmpdirs are
        // cleaned up by OS tmpdir eviction. Not worth failing a
        // decision over.
      }
    }
  }
}

// ─── Subprocess plumbing ────────────────────────────────────────────

/**
 * Spawn `claude -p` in the given cwd with the given user prompt.
 * Resolves with captured stdout on clean exit; rejects on non-zero
 * exit code, spawn failure, or timeout (timeout → kills the
 * subprocess first).
 */
function runClaudeSubprocess(cwd: string, userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--session-id', randomUUID(),
      '--model', ALARUM_MODEL,
      // Alarum may run cc-cli via Bash to dig deeper into corp state.
      // --dangerously-skip-permissions lets her do that non-
      // interactively; per the harness's precedent, the "dangerously"
      // framing assumes a human at the terminal, not an autonomous
      // agent where tool use IS the design.
      '--dangerously-skip-permissions',
      '--add-dir', cwd,
    ];

    const child = nodeSpawn(CLAUDE_BINARY, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead — fine.
      }
    }, ALARUM_TIMEOUT_MS);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on('error', (err) => {
      settle(() => reject(err));
    });

    child.on('close', (code) => {
      settle(() => {
        if (timedOut) {
          reject(new Error(`subprocess timed out after ${ALARUM_TIMEOUT_MS}ms`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`subprocess exited ${code}: ${truncate(stderrBuf, 200)}`));
          return;
        }
        resolve(stdoutBuf);
      });
    });

    // Deliver user prompt via stdin + close to signal end-of-input.
    try {
      child.stdin?.end(userPrompt + '\n');
    } catch (err) {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

// ─── Internals ──────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
