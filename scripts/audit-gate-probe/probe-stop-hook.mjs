#!/usr/bin/env node
/**
 * Audit Gate probe for Project 0.7.3.
 *
 * A stand-in for `cc-cli audit` that exercises Claude Code's Stop-hook
 * blocking contract without touching production code. On the first
 * invocation in a session it returns a block decision; on subsequent
 * invocations it approves. A counter file is kept next to this script
 * so we can observe whether Claude Code actually re-invokes the hook
 * after the agent acknowledges the block.
 *
 * Run from the workspace that has this directory as its root (see
 * .claude/settings.json — the Stop hook wires to this file).
 *
 * Side-effects (all written to this script's directory, all gitignored):
 *   .probe-counter  — per-session invocation count, drives the block-once
 *                     behavior. Delete to reset between runs.
 *   .probe-log      — human-readable log of each invocation's decision.
 *   .probe-stdin.jsonl   — every hook-input JSON Claude Code passed us,
 *                     one line per invocation. Load-bearing for 0.7.3:
 *                     cc-cli audit will parse the same input shape, and
 *                     seeing real data beats guessing at the schema.
 *   .probe-env.jsonl  — Claude Code env vars present at each invocation.
 *                     Captures which CLAUDE_* env vars are available so
 *                     the real audit command knows what it can rely on
 *                     (cwd, project dir, session id, etc.).
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const counterFile = join(here, '.probe-counter');
const logFile = join(here, '.probe-log');
const stdinDumpFile = join(here, '.probe-stdin.jsonl');
const envDumpFile = join(here, '.probe-env.jsonl');

// ─── Read the entire hook-input from stdin before we do anything else.
//
// Claude Code writes the hook input (JSON) to stdin and closes it.
// We read synchronously via fs on /dev/stdin (fd 0) to avoid the async
// dance + timeout complexity a 50-line probe doesn't need. If stdin is
// empty (e.g., manual test-run), `rawStdin` is "" and we just carry on.
let rawStdin = '';
try {
  rawStdin = readFileSync(0, 'utf-8');
} catch {
  /* no stdin or fd-0 read failed — not fatal for probe purposes */
}

const invokedAt = new Date().toISOString();

let count = 0;
if (existsSync(counterFile)) {
  count = Number.parseInt(readFileSync(counterFile, 'utf-8'), 10) || 0;
}
count += 1;
writeFileSync(counterFile, String(count), 'utf-8');

// Dump stdin verbatim (as a JSON-wrapped line so jq-style tooling works
// over multiple invocations). One JSON object per line in the .jsonl.
// If stdin was empty, we still write a marker line so the invocation
// count in this file matches the counter.
appendFileSync(
  stdinDumpFile,
  JSON.stringify({
    invokedAt,
    invocation: count,
    rawStdin,
    parsedStdin: tryParseJson(rawStdin),
  }) + '\n',
  'utf-8',
);

// Dump every CLAUDE_* environment variable + a few load-bearing ones
// from the broader environment the hook inherits. Gives us an
// authoritative snapshot of what a production audit command can read.
const envSnapshot = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('CLAUDE_') || key === 'PWD' || key === 'HOME' || key === 'USERPROFILE') {
    envSnapshot[key] = value;
  }
}
appendFileSync(
  envDumpFile,
  JSON.stringify({ invokedAt, invocation: count, env: envSnapshot }) + '\n',
  'utf-8',
);

const decision = count === 1
  ? {
      decision: 'block',
      reason:
        'PROBE AUDIT GATE: Stop hook invocation #1. If you can read this text in your context, the hook-blocking contract works. Please respond with the literal token "PROBE_ACK" so we can see the reason surfaced to you, then attempt to end the session again. The next Stop invocation will approve.',
    }
  : { decision: 'approve' };

appendFileSync(
  logFile,
  `[${invokedAt}] invocation #${count} → ${decision.decision}\n`,
  'utf-8',
);

process.stdout.write(JSON.stringify(decision) + '\n');
process.exit(0);

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Best-effort JSON parse. Returns the parsed object on success, or
 * `{ parseError: "..." }` on failure. Keeps the .probe-stdin.jsonl
 * entries self-describing when Claude Code passes malformed input —
 * diagnostic value beats strictness for a probe.
 */
function tryParseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return { parseError: String(err) };
  }
}
