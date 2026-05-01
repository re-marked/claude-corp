/**
 * cc-cli editor status — admin/debug snapshot of the review lane.
 *
 * Shows in-flight claims (tasks held by which Editor), pending
 * review-eligible tasks (editorReviewRequested + no claim), and a
 * recent-window of review-comment chits. Composes queryChits — no
 * daemon round-trip needed.
 *
 * Forensic per-task views (full comment thread, escalation chain)
 * land in 1.12.3 as `cc-cli editor show <task-id>`.
 */

import { parseArgs } from 'node:util';
import { queryChits, type Chit } from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

interface Opts {
  corp?: string;
  json?: boolean;
}

const RECENT_COMMENTS = 10;

export async function cmdEditorStatus(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  const corpRoot = await getCorpRoot(opts.corp);

  let tasks: ReturnType<typeof queryChits<'task'>>;
  try {
    tasks = queryChits<'task'>(corpRoot, { types: ['task'], statuses: ['active'] });
  } catch {
    tasks = { chits: [] } as unknown as ReturnType<typeof queryChits<'task'>>;
  }

  const inFlight: Array<{ taskId: string; reviewer: string; claimedAt: string; branch: string | null; round: number }> = [];
  const pending: Array<{ taskId: string; branch: string | null; priority: string; round: number }> = [];
  for (const c of tasks.chits) {
    const t = c.chit as Chit<'task'>;
    const f = t.fields.task;
    if ((f.reviewerClaim ?? null) !== null) {
      inFlight.push({
        taskId: t.id,
        reviewer: f.reviewerClaim!.slug,
        claimedAt: f.reviewerClaim!.claimedAt,
        branch: f.branchUnderReview ?? null,
        round: f.editorReviewRound ?? 0,
      });
    } else if (
      f.editorReviewRequested === true
      && f.editorReviewCapHit !== true
      && f.workflowStatus === 'under_review'
      && f.branchUnderReview
    ) {
      pending.push({
        taskId: t.id,
        branch: f.branchUnderReview,
        priority: f.priority,
        round: f.editorReviewRound ?? 0,
      });
    }
  }

  let comments: ReturnType<typeof queryChits<'review-comment'>>;
  try {
    comments = queryChits<'review-comment'>(corpRoot, { types: ['review-comment'], scopes: ['corp'] });
  } catch {
    comments = { chits: [] } as unknown as ReturnType<typeof queryChits<'review-comment'>>;
  }
  const recent = comments.chits
    .map((c) => c.chit as Chit<'review-comment'>)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, RECENT_COMMENTS);

  if (opts.json) {
    console.log(JSON.stringify({
      inFlight,
      pending,
      recent: recent.map((c) => ({
        commentId: c.id,
        taskId: c.fields['review-comment'].taskId,
        reviewer: c.fields['review-comment'].reviewerSlug,
        severity: c.fields['review-comment'].severity,
        category: c.fields['review-comment'].category,
        filePath: c.fields['review-comment'].filePath,
        lineStart: c.fields['review-comment'].lineStart,
        issue: c.fields['review-comment'].issue,
        createdAt: c.createdAt,
      })),
    }, null, 2));
    return;
  }

  console.log('editor status');
  console.log('');
  console.log(`In-flight reviews: ${inFlight.length}`);
  for (const i of inFlight) {
    console.log(`  ${i.taskId}  reviewer=${i.reviewer}  branch=${i.branch ?? '?'}  round=${i.round}`);
    console.log(`    since ${i.claimedAt}`);
  }
  console.log('');
  console.log(`Pending (requested, unclaimed): ${pending.length}`);
  for (const p of pending) {
    console.log(`  ${p.taskId}  branch=${p.branch ?? '?'}  priority=${p.priority}  prior-rejections=${p.round}`);
  }
  console.log('');
  console.log(`Recent comments (top ${RECENT_COMMENTS}):`);
  if (recent.length === 0) {
    console.log('  (none)');
  } else {
    for (const c of recent) {
      const f = c.fields['review-comment'];
      console.log(`  ${c.id}  ${f.severity}/${f.category}  task=${f.taskId}  ${f.filePath}:${f.lineStart}`);
      console.log(`    ${f.issue}`);
    }
  }
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}
