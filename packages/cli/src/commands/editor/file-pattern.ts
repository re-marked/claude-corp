/**
 * cc-cli editor file-pattern — call workflow.filePatternObservation.
 *
 * Project 1.12.3 — the writer side of the compounding-judgment loop.
 * Editor calls this at session end when a recurring theme is worth
 * recording. Future loadReviewContext returns matching observations
 * as priors for the drift pass; the corp's review taste tightens
 * monotonically as the substrate grows.
 *
 * Subject discriminator decides which detail flag is required:
 *   --kind role          → --role <id> required
 *   --kind codebase-area → --area <path> required
 *   --kind corp-wide     → neither
 */

import { parseArgs } from 'node:util';
import { filePatternObservation } from '@claudecorp/daemon';
import type { PatternSubject } from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

const VALID_KINDS = new Set<PatternSubject['kind']>(['role', 'codebase-area', 'corp-wide']);

interface Opts {
  from?: string;
  kind?: string;
  role?: string;
  area?: string;
  finding?: string;
  'linked-comments'?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdEditorFilePattern(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <editor-slug> required');
  if (!opts.kind) fail('--kind <role|codebase-area|corp-wide> required');
  if (!VALID_KINDS.has(opts.kind as PatternSubject['kind'])) {
    fail(`--kind must be one of role | codebase-area | corp-wide, got "${opts.kind}"`);
  }
  if (!opts.finding) fail('--finding "..." required');

  let subject: PatternSubject;
  if (opts.kind === 'role') {
    if (!opts.role) fail('--role <id> required when --kind=role');
    subject = { kind: 'role', role: opts.role! };
  } else if (opts.kind === 'codebase-area') {
    if (!opts.area) fail('--area <path> required when --kind=codebase-area');
    subject = { kind: 'codebase-area', codebaseArea: opts.area! };
  } else {
    subject = { kind: 'corp-wide' };
  }

  // Linked comments: comma-separated chit ids. Empty/null/absent
  // means "no specific instances cited" — finding stands on its
  // own. Useful when the pattern is about something the agent
  // observed across many sessions where citations would be
  // arbitrary.
  const linkedComments = opts['linked-comments']
    ? opts['linked-comments'].split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;

  const corpRoot = await getCorpRoot(opts.corp);
  const result = filePatternObservation({
    corpRoot,
    reviewerSlug: opts.from!,
    subject,
    finding: opts.finding!,
    ...(linkedComments && linkedComments.length > 0 ? { linkedComments } : {}),
  });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, observationId: result.value.observationId }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`file-pattern: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  const subjectDesc =
    subject.kind === 'role' ? `role=${subject.role}`
    : subject.kind === 'codebase-area' ? `area=${subject.codebaseArea}`
    : 'corp-wide';
  console.log(`pattern observation ${result.value.observationId} filed (${subjectDesc}).`);
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      kind: { type: 'string' },
      role: { type: 'string' },
      area: { type: 'string' },
      finding: { type: 'string' },
      'linked-comments': { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values as Opts;
}

function fail(msg: string): never {
  console.error(`cc-cli editor file-pattern: ${msg}`);
  process.exit(1);
}
