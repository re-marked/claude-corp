/**
 * cc-cli clearinghouse rebase — call workflow.rebaseStep.
 *
 * Fetches the base branch + runs attemptRebase. Returns the typed
 * five-outcome RebaseAttemptResult: clean / auto-resolved / needs-author
 * / sanity-failed / fatal. Agent branches on outcome via the JSON
 * shape and decides next-step (proceed to test, file-blocker,
 * mark-failed).
 */

import { parseArgs } from 'node:util';
import { rebaseStep } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  submission?: string;
  worktree?: string;
  branch?: string;
  base?: string;
  narrative?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdClearinghouseRebase(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <pressman-slug> required');
  if (!opts.submission) fail('--submission <chit-id> required');
  if (!opts.worktree) fail('--worktree <path> required');
  if (!opts.branch) fail('--branch <name> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = await rebaseStep({
    corpRoot,
    submissionId: opts.submission!,
    worktreePath: opts.worktree!,
    branch: opts.branch!,
    emittedBy: opts.from!,
    ...(opts.base ? { baseBranch: opts.base } : {}),
    ...(opts.narrative ? { narrative: opts.narrative } : {}),
  });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, rebase: result.value }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`rebase failed: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  const r = result.value;
  console.log(`rebase outcome: ${r.outcome}`);
  if (r.outcome === 'auto-resolved' && r.autoResolvedFiles?.length) {
    console.log(`  auto-resolved: ${r.autoResolvedFiles.join(', ')}`);
    if (r.autoResolutionRounds) console.log(`  rounds:        ${r.autoResolutionRounds}`);
  }
  if (r.outcome === 'needs-author' && r.conflictedFiles?.length) {
    console.log(`  conflicted files (substantive):`);
    for (const f of r.conflictedFiles) console.log(`    - ${f}`);
  }
  if (r.outcome === 'sanity-failed' || r.outcome === 'fatal') {
    if (r.failureRecord) {
      console.log(`  reason: ${r.failureRecord.pedagogicalSummary}`);
      console.log(`  route:  ${r.failureRecord.route}`);
    }
  }
  if (r.preStats && r.postStats) {
    console.log(`  diff: ${r.preStats.filesChanged}f → ${r.postStats.filesChanged}f`);
  }
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      submission: { type: 'string' },
      worktree: { type: 'string' },
      branch: { type: 'string' },
      base: { type: 'string' },
      narrative: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli clearinghouse rebase: ${msg}`);
  process.exit(1);
}
