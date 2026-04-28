/**
 * cc-cli clearinghouse file-blocker — call workflow.fileBlocker.
 *
 * Cuts an escalation chit (severity=blocker) for the submission's
 * author, marks the submission failed, releases the lock + worktree.
 * Used at the three Pressman judgment-failure branch points:
 * substantive rebase conflict, consistent test failure, push-hook
 * rejection. The body the agent supplies should be pedagogical —
 * a substitute Employee may pick up the blocker cold.
 */

import { parseArgs } from 'node:util';
import { fileBlocker, type BlockerKind } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

const VALID_KINDS = new Set<BlockerKind>(['rebase-conflict', 'test-fail', 'hook-reject']);

interface Opts {
  from?: string;
  submission?: string;
  kind?: string;
  summary?: string;
  detail?: string;
  worktree?: string;
  'route-to'?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdClearinghouseFileBlocker(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <pressman-slug> required');
  if (!opts.submission) fail('--submission <chit-id> required');
  if (!opts.kind) fail('--kind <rebase-conflict|test-fail|hook-reject> required');
  if (!VALID_KINDS.has(opts.kind as BlockerKind)) {
    fail(`--kind must be one of rebase-conflict | test-fail | hook-reject, got "${opts.kind}"`);
  }
  if (!opts.summary) fail('--summary "..." required');
  if (!opts.detail) fail('--detail "..." required');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = await fileBlocker({
    corpRoot,
    submissionId: opts.submission!,
    kind: opts.kind as BlockerKind,
    summary: opts.summary!,
    detail: opts.detail!,
    slug: opts.from!,
    ...(opts.worktree ? { worktreePath: opts.worktree } : {}),
    ...(opts['route-to'] ? { routeTo: opts['route-to'] } : {}),
  });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, escalationId: result.value.escalationId }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`file-blocker: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  console.log(`escalation chit created: ${result.value.escalationId}`);
  console.log(`(submission ${opts.submission} marked failed; lock released; worktree cleaned.)`);
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      submission: { type: 'string' },
      kind: { type: 'string' },
      summary: { type: 'string' },
      detail: { type: 'string' },
      worktree: { type: 'string' },
      'route-to': { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli clearinghouse file-blocker: ${msg}`);
  process.exit(1);
}
