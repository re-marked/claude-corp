/**
 * cc-cli editor diff — load review context + diff metadata.
 *
 * Bundles task + contract + diff-file-list for Editor's two-pass
 * review (bug + drift). Editor reads this once per task, then uses
 * native Read/Grep on the worktree to follow imports / read sibling
 * tests / check the actual code.
 *
 * Composes `loadReviewContext` (task + contract chits) and, when a
 * worktree is supplied, `computeReviewableDiff` from PR 2 (file
 * list + filtered list + size guard). The agent gets the structural
 * shape; the substance comes from native tool reads.
 */

import { parseArgs } from 'node:util';
import {
  loadReviewContext,
  computeReviewableDiff,
  realGitOps,
} from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  task?: string;
  worktree?: string;
  base?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdEditorDiff(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <editor-slug> required');
  if (!opts.task) fail('--task <chit-id> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const ctxResult = loadReviewContext({ corpRoot, taskId: opts.task! });
  if (!ctxResult.ok) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, failure: ctxResult.failure }, null, 2));
      process.exit(1);
    }
    console.error(`diff: ${ctxResult.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  const ctx = ctxResult.value;

  // Diff metadata is optional — if no worktree supplied, return the
  // chit-only context. Editor would normally pass --worktree from
  // the prior acquire-worktree step's output.
  let diffPayload: unknown = null;
  if (opts.worktree) {
    const dr = await computeReviewableDiff({
      worktreePath: opts.worktree,
      baseRef: opts.base ?? 'origin/main',
      headRef: 'HEAD',
      gitOps: realGitOps,
    });
    if (!dr.ok) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, failure: dr.failure }, null, 2));
        process.exit(1);
      }
      console.error(`diff metadata: ${dr.failure.pedagogicalSummary}`);
      process.exit(1);
    }
    diffPayload = dr.value;
  }

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      review: {
        taskId: ctx.taskId,
        branchUnderReview: ctx.branchUnderReview,
        currentRound: ctx.currentRound,
        contractId: ctx.contractId,
        task: {
          title: ctx.task.title,
          priority: ctx.task.priority,
          assignee: ctx.task.assignee ?? null,
          handedBy: ctx.task.handedBy ?? null,
          acceptanceCriteria: ctx.task.acceptanceCriteria ?? null,
          complexity: ctx.task.complexity ?? null,
          output: ctx.task.output ?? null,
        },
        contract: ctx.contract ? {
          title: ctx.contract.title,
          goal: ctx.contract.goal,
          taskIds: ctx.contract.taskIds,
        } : null,
        diff: diffPayload,
      },
    }, null, 2));
    return;
  }

  console.log(`task ${ctx.taskId}: ${ctx.task.title}`);
  console.log(`  branch:    ${ctx.branchUnderReview}`);
  console.log(`  round:     ${ctx.currentRound + 1} (priors: ${ctx.currentRound})`);
  console.log(`  priority:  ${ctx.task.priority}`);
  if (ctx.task.acceptanceCriteria?.length) {
    console.log(`  criteria:`);
    for (const c of ctx.task.acceptanceCriteria) console.log(`    - ${c}`);
  } else {
    console.log(`  criteria:  (none specified)`);
  }
  if (ctx.contract) {
    console.log(`contract ${ctx.contractId}: ${ctx.contract.title}`);
    console.log(`  goal: ${ctx.contract.goal}`);
  } else {
    console.log(`contract:    (standalone task — drift pass uses task criteria only)`);
  }
  if (diffPayload && typeof diffPayload === 'object') {
    const d = diffPayload as { files?: unknown[]; filteredFiles?: unknown[]; oversized?: boolean; oversizedReason?: string };
    console.log(`diff:`);
    console.log(`  files reviewable: ${(d.files ?? []).length}`);
    console.log(`  files filtered:   ${(d.filteredFiles ?? []).length}`);
    if (d.oversized) console.log(`  oversized:        true (${d.oversizedReason ?? 'unspecified'})`);
  }
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      task: { type: 'string' },
      worktree: { type: 'string' },
      base: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli editor diff: ${msg}`);
  process.exit(1);
}
