/**
 * cc-cli editor acquire-worktree — call workflow.acquireEditorWorktree.
 *
 * Ensures isolated worktree for the task's branch at the
 * deterministic editor-wt-<taskId-prefix> path. Idempotent on the
 * path; the branch checkout is recreated fresh on every call.
 */

import { parseArgs } from 'node:util';
import { acquireEditorWorktree } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  task?: string;
  branch?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdEditorAcquireWorktree(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <editor-slug> required');
  if (!opts.task) fail('--task <chit-id> required');
  if (!opts.branch) fail('--branch <name> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = await acquireEditorWorktree({
    corpRoot,
    taskId: opts.task!,
    branch: opts.branch!,
  });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, worktree: result.value }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`acquire-worktree failed: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  console.log(`worktree ready: ${result.value.path}`);
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      task: { type: 'string' },
      branch: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli editor acquire-worktree: ${msg}`);
  process.exit(1);
}
