/**
 * cc-cli editor file-comment — call workflow.fileReviewComment.
 *
 * Cuts a review-comment chit at a specific line range. Editor calls
 * this once per finding during the bug + drift passes. Severity
 * 'blocker' means the round will reject; 'suggestion' / 'nit'
 * advisory only.
 */

import { parseArgs } from 'node:util';
import { fileReviewComment } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

const VALID_SEVERITY = new Set(['blocker', 'suggestion', 'nit']);
const VALID_CATEGORY = new Set(['bug', 'drift']);

interface Opts {
  from?: string;
  task?: string;
  file?: string;
  'line-start'?: string;
  'line-end'?: string;
  severity?: string;
  category?: string;
  issue?: string;
  why?: string;
  'suggested-patch'?: string;
  'review-round'?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdEditorFileComment(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <editor-slug> required');
  if (!opts.task) fail('--task <chit-id> required');
  if (!opts.file) fail('--file <path> required');
  if (!opts['line-start']) fail('--line-start <n> required');
  if (!opts.severity) fail('--severity <blocker|suggestion|nit> required');
  if (!VALID_SEVERITY.has(opts.severity!)) {
    fail(`--severity must be one of blocker | suggestion | nit, got "${opts.severity}"`);
  }
  if (!opts.category) fail('--category <bug|drift> required');
  if (!VALID_CATEGORY.has(opts.category!)) {
    fail(`--category must be one of bug | drift, got "${opts.category}"`);
  }
  if (!opts.issue) fail('--issue "..." required');
  if (!opts.why) fail('--why "..." required');
  if (!opts['review-round']) fail('--review-round <n> required (typically pick.currentRound + 1)');

  const lineStart = parseInt(opts['line-start']!, 10);
  if (!Number.isFinite(lineStart) || lineStart < 1) fail(`--line-start must be a positive integer, got "${opts['line-start']}"`);
  const lineEnd = opts['line-end'] !== undefined ? parseInt(opts['line-end'], 10) : lineStart;
  if (!Number.isFinite(lineEnd) || lineEnd < lineStart) fail(`--line-end must be >= line-start (${lineStart}), got "${opts['line-end']}"`);
  const reviewRound = parseInt(opts['review-round']!, 10);
  if (!Number.isFinite(reviewRound) || reviewRound < 1) fail(`--review-round must be a positive integer, got "${opts['review-round']}"`);

  const corpRoot = await getCorpRoot(opts.corp);
  const result = fileReviewComment({
    corpRoot,
    taskId: opts.task!,
    reviewerSlug: opts.from!,
    filePath: opts.file!,
    lineStart,
    lineEnd,
    severity: opts.severity as 'blocker' | 'suggestion' | 'nit',
    category: opts.category as 'bug' | 'drift',
    issue: opts.issue!,
    why: opts.why!,
    ...(opts['suggested-patch'] ? { suggestedPatch: opts['suggested-patch'] } : {}),
    reviewRound,
  });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, commentId: result.value.commentId }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`file-comment: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  console.log(`comment ${result.value.commentId} (${opts.severity}/${opts.category}) on ${opts.file}:${lineStart}${lineEnd !== lineStart ? `-${lineEnd}` : ''}`);
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      task: { type: 'string' },
      file: { type: 'string' },
      'line-start': { type: 'string' },
      'line-end': { type: 'string' },
      severity: { type: 'string' },
      category: { type: 'string' },
      issue: { type: 'string' },
      why: { type: 'string' },
      'suggested-patch': { type: 'string' },
      'review-round': { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values as Opts;
}

function fail(msg: string): never {
  console.error(`cc-cli editor file-comment: ${msg}`);
  process.exit(1);
}
