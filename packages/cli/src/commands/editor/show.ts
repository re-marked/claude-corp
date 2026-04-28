/**
 * cc-cli editor show <task-id> — forensic per-task review view.
 *
 * Project 1.12.3 — drills into one task's review thread:
 *   - Task summary (title, branch, current round, capHit, claim).
 *   - All review-comments grouped by round + category + severity.
 *   - All escalations originating from this task.
 *   - Editor-side lane-events (claim/approve/reject/bypass/release).
 */

import { parseArgs } from 'node:util';
import {
  findChitById,
  queryChits,
  type Chit,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

interface Opts {
  corp?: string;
  json?: boolean;
}

const EDITOR_KINDS = new Set([
  'editor-claimed',
  'editor-approved',
  'editor-rejected',
  'editor-bypassed',
  'editor-released',
]);

export async function cmdEditorShow(rawArgs: string[]): Promise<void> {
  const positionals = parseArgs({
    args: rawArgs,
    options: { corp: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
  });
  const taskId = positionals.positionals[0];
  if (!taskId) {
    console.error('cc-cli editor show: <task-id> required');
    process.exit(1);
  }
  const opts = positionals.values as Opts;
  const corpRoot = await getCorpRoot(opts.corp);

  const taskHit = findChitById(corpRoot, taskId);
  if (!taskHit || taskHit.chit.type !== 'task') {
    console.error(`show: task ${taskId} not found`);
    process.exit(1);
  }
  const task = taskHit.chit as Chit<'task'>;
  const tf = task.fields.task;

  let comments: Chit<'review-comment'>[] = [];
  try {
    const result = queryChits<'review-comment'>(corpRoot, { types: ['review-comment'], scopes: ['corp'] });
    comments = result.chits
      .map((c) => c.chit as Chit<'review-comment'>)
      .filter((c) => c.fields['review-comment'].taskId === taskId);
  } catch { /* empty */ }

  let escalations: Chit<'escalation'>[] = [];
  try {
    const result = queryChits<'escalation'>(corpRoot, { types: ['escalation'], scopes: ['corp'] });
    escalations = result.chits
      .map((c) => c.chit as Chit<'escalation'>)
      .filter((e) => e.fields.escalation.originatingChit === taskId);
  } catch { /* empty */ }

  let editorEvents: Chit<'lane-event'>[] = [];
  try {
    const result = queryChits<'lane-event'>(corpRoot, { types: ['lane-event'], scopes: ['corp'] });
    editorEvents = result.chits
      .map((c) => c.chit as Chit<'lane-event'>)
      .filter((e) => e.fields['lane-event'].taskId === taskId && EDITOR_KINDS.has(e.fields['lane-event'].kind))
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  } catch { /* empty */ }

  if (opts.json) {
    console.log(JSON.stringify({
      task: { id: task.id, ...tf, chitStatus: task.status },
      comments: comments.map((c) => ({ id: c.id, ...c.fields['review-comment'] })),
      escalations: escalations.map((e) => ({ id: e.id, ...e.fields.escalation })),
      editorEvents: editorEvents.map((e) => ({
        id: e.id,
        createdAt: e.createdAt,
        kind: e.fields['lane-event'].kind,
        emittedBy: e.fields['lane-event'].emittedBy,
        narrative: e.fields['lane-event'].narrative ?? null,
      })),
    }, null, 2));
    return;
  }

  console.log(`task ${task.id}: ${tf.title}`);
  console.log(`  priority:           ${tf.priority}`);
  console.log(`  workflowStatus:     ${tf.workflowStatus ?? '?'}`);
  console.log(`  assignee:           ${tf.assignee ?? '(none)'}`);
  if (tf.branchUnderReview) console.log(`  branchUnderReview:  ${tf.branchUnderReview}`);
  console.log(`  editorReviewRound:  ${tf.editorReviewRound ?? 0}`);
  console.log(`  editorReviewCapHit: ${tf.editorReviewCapHit ?? false}`);
  console.log(`  reviewerClaim:      ${tf.reviewerClaim ? `${tf.reviewerClaim.slug} since ${tf.reviewerClaim.claimedAt}` : '(none)'}`);
  console.log('');

  if (editorEvents.length > 0) {
    console.log(`Editor events (${editorEvents.length}):`);
    for (const e of editorEvents) {
      const ef = e.fields['lane-event'];
      const t = (e.createdAt ?? '').slice(11, 19);
      const narrative = ef.narrative ? ` — "${ef.narrative}"` : '';
      console.log(`  ${t}  ${ef.kind} by ${ef.emittedBy ?? 'daemon'}${narrative}`);
    }
    console.log('');
  }

  if (comments.length > 0) {
    // Group by reviewRound, then severity, then category.
    const byRound = new Map<number, Chit<'review-comment'>[]>();
    for (const c of comments) {
      const r = c.fields['review-comment'].reviewRound;
      const list = byRound.get(r) ?? [];
      list.push(c);
      byRound.set(r, list);
    }
    const rounds = [...byRound.keys()].sort((a, b) => a - b);
    console.log(`Review comments (${comments.length} total across ${rounds.length} round(s)):`);
    for (const r of rounds) {
      const roundComments = byRound.get(r)!;
      const blockers = roundComments.filter((c) => c.fields['review-comment'].severity === 'blocker').length;
      console.log(`  Round ${r} (${roundComments.length} comments, ${blockers} blocker(s)):`);
      for (const c of roundComments) {
        const cf = c.fields['review-comment'];
        console.log(`    [${cf.severity}/${cf.category}] ${cf.filePath}:${cf.lineStart}${cf.lineEnd !== cf.lineStart ? `-${cf.lineEnd}` : ''}`);
        console.log(`      ${cf.issue}`);
      }
    }
    console.log('');
  }

  if (escalations.length > 0) {
    console.log(`Escalations (${escalations.length}):`);
    for (const e of escalations) {
      const ef = e.fields.escalation;
      console.log(`  ${e.id}  severity=${ef.severity}  to=${ef.to}`);
      console.log(`    ${ef.reason}`);
    }
    console.log('');
  }
}
