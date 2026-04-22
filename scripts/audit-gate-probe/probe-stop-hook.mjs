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
 * Each invocation appends to `.probe-log` in this directory with a
 * timestamp and the decision. After the probe, inspect the log to
 * confirm the block → agent-response → approve loop.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const counterFile = join(here, '.probe-counter');
const logFile = join(here, '.probe-log');

let count = 0;
if (existsSync(counterFile)) {
  count = Number.parseInt(readFileSync(counterFile, 'utf-8'), 10) || 0;
}
count += 1;
writeFileSync(counterFile, String(count), 'utf-8');

const decision = count === 1
  ? {
      decision: 'block',
      reason:
        'PROBE AUDIT GATE: Stop hook invocation #1. If you can read this text in your context, the hook-blocking contract works. Please respond with the literal token "PROBE_ACK" so we can see the reason surfaced to you, then attempt to end the session again. The next Stop invocation will approve.',
    }
  : { decision: 'approve' };

appendFileSync(
  logFile,
  `[${new Date().toISOString()}] invocation #${count} → ${decision.decision}\n`,
  'utf-8',
);

process.stdout.write(JSON.stringify(decision) + '\n');
process.exit(0);
