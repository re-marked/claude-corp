/**
 * cc-cli editor list — review-comment + pattern-observation browser.
 *
 * Project 1.12.3 — forensic browse across the Editor's outputs.
 * Modes:
 *   default          List active review-comments. Filterable by
 *                    task, role, severity, category.
 *   --patterns       List pattern-observation chits instead.
 *                    Filterable by subject kind.
 */

import { parseArgs } from 'node:util';
import {
  queryChits,
  readConfig,
  MEMBERS_JSON,
  type Chit,
  type Member,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

interface Opts {
  patterns?: boolean;
  task?: string;
  role?: string;
  severity?: string;
  category?: string;
  'subject-kind'?: string;
  'include-closed'?: boolean;
  limit?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdEditorList(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  const corpRoot = await getCorpRoot(opts.corp);

  if (opts.patterns) {
    return listPatterns(corpRoot, opts);
  }
  return listComments(corpRoot, opts);
}

async function listComments(corpRoot: string, opts: Opts): Promise<void> {
  let result: ReturnType<typeof queryChits<'review-comment'>>;
  try {
    result = queryChits<'review-comment'>(corpRoot, {
      types: ['review-comment'],
      scopes: ['corp'],
      ...(opts['include-closed'] ? {} : { statuses: ['active'] }),
    });
  } catch (err) {
    console.error(`list: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let comments = result.chits.map((c) => c.chit as Chit<'review-comment'>);

  if (opts.task) {
    comments = comments.filter((c) => c.fields['review-comment'].taskId === opts.task);
  }
  if (opts.severity) {
    comments = comments.filter((c) => c.fields['review-comment'].severity === opts.severity);
  }
  if (opts.category) {
    comments = comments.filter((c) => c.fields['review-comment'].category === opts.category);
  }
  if (opts.role) {
    const slugs = new Set<string>();
    try {
      const members = readConfig<Member[]>(`${corpRoot}/${MEMBERS_JSON}`);
      for (const m of members) if (m.role === opts.role) slugs.add(m.id);
    } catch { /* empty set */ }
    comments = comments.filter((c) => slugs.has(c.fields['review-comment'].reviewerSlug));
  }

  comments.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const limit = opts.limit ? parseInt(opts.limit, 10) : 50;
  if (Number.isFinite(limit) && limit > 0) comments = comments.slice(0, limit);

  if (opts.json) {
    console.log(JSON.stringify({
      comments: comments.map((c) => ({ id: c.id, chitStatus: c.status, createdAt: c.createdAt, ...c.fields['review-comment'] })),
    }, null, 2));
    return;
  }

  if (comments.length === 0) {
    console.log('(no review-comments match)');
    return;
  }

  console.log(`${comments.length} review-comment(s):`);
  console.log('');
  for (const c of comments) {
    const f = c.fields['review-comment'];
    console.log(`  [${f.severity}/${f.category}] ${f.filePath}:${f.lineStart}${f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ''}  task=${f.taskId}  round ${f.reviewRound}`);
    console.log(`    by ${f.reviewerSlug} at ${c.createdAt}`);
    console.log(`    ${f.issue}`);
  }
}

async function listPatterns(corpRoot: string, opts: Opts): Promise<void> {
  let result: ReturnType<typeof queryChits<'pattern-observation'>>;
  try {
    result = queryChits<'pattern-observation'>(corpRoot, {
      types: ['pattern-observation'],
      scopes: ['corp'],
      ...(opts['include-closed'] ? {} : { statuses: ['active'] }),
    });
  } catch (err) {
    console.error(`list --patterns: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let patterns = result.chits.map((c) => c.chit as Chit<'pattern-observation'>);

  if (opts['subject-kind']) {
    patterns = patterns.filter((p) => p.fields['pattern-observation'].subject.kind === opts['subject-kind']);
  }
  if (opts.role) {
    patterns = patterns.filter((p) => {
      const subject = p.fields['pattern-observation'].subject;
      return subject.kind === 'role' && subject.role === opts.role;
    });
  }

  patterns.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const limit = opts.limit ? parseInt(opts.limit, 10) : 50;
  if (Number.isFinite(limit) && limit > 0) patterns = patterns.slice(0, limit);

  if (opts.json) {
    console.log(JSON.stringify({
      patterns: patterns.map((p) => ({ id: p.id, chitStatus: p.status, createdAt: p.createdAt, ...p.fields['pattern-observation'] })),
    }, null, 2));
    return;
  }

  if (patterns.length === 0) {
    console.log('(no pattern-observations match)');
    return;
  }

  console.log(`${patterns.length} pattern-observation(s):`);
  console.log('');
  for (const p of patterns) {
    const f = p.fields['pattern-observation'];
    const subjectDesc =
      f.subject.kind === 'role' ? `role=${f.subject.role}`
      : f.subject.kind === 'codebase-area' ? `area=${f.subject.codebaseArea}`
      : 'corp-wide';
    console.log(`  ${p.id}  (${subjectDesc})  by ${f.reviewerSlug} at ${p.createdAt}`);
    console.log(`    ${f.finding}`);
    if (f.linkedComments && f.linkedComments.length > 0) {
      console.log(`    linked: ${f.linkedComments.length} comment(s)`);
    }
  }
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      patterns: { type: 'boolean' },
      task: { type: 'string' },
      role: { type: 'string' },
      severity: { type: 'string' },
      category: { type: 'string' },
      'subject-kind': { type: 'string' },
      'include-closed': { type: 'boolean' },
      limit: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values as Opts;
}
