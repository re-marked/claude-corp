/**
 * cc-cli clearinghouse attribute — call workflow.attributeStep.
 *
 * Pressman calls this AFTER `test` returns consistent-fail to
 * decide blocker routing: pr-introduced (route to author),
 * main-regression (route to engineering-lead — author is innocent),
 * mixed (author plus shared-with-main flagged), inconclusive.
 *
 * Costs an extra test run on `origin/main`. Pressman's blueprint
 * teaches when it's worth running (default: always for consistent-
 * fail; agent may skip for cap-bypassed or low-priority work).
 */

import { parseArgs } from 'node:util';
import { attributeStep } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  submission?: string;
  worktree?: string;
  branch?: string;
  base?: string;
  command?: string;
  narrative?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdClearinghouseAttribute(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <pressman-slug> required');
  if (!opts.submission) fail('--submission <chit-id> required');
  if (!opts.worktree) fail('--worktree <path> required');
  if (!opts.branch) fail('--branch <name> required (the PR branch — restored after main test)');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = await attributeStep({
    corpRoot,
    submissionId: opts.submission!,
    worktreePath: opts.worktree!,
    branch: opts.branch!,
    emittedBy: opts.from!,
    ...(opts.base ? { baseRef: opts.base } : {}),
    ...(opts.command ? { testCommand: opts.command } : {}),
    ...(opts.narrative ? { narrative: opts.narrative } : {}),
  });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, ...result.value }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`attribute: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  const a = result.value.attribution;
  console.log(`attribution: ${a.kind}`);
  switch (a.kind) {
    case 'no-failure':
      console.log('  the PR run passed at attribution time — no blocker needed.');
      break;
    case 'pr-introduced':
      console.log(`  PR introduced ${a.prFailures.length} failure(s). Route to author.`);
      for (const f of a.prFailures.slice(0, 5)) console.log(`    - ${f.name}`);
      if (a.prFailures.length > 5) console.log(`    ...and ${a.prFailures.length - 5} more`);
      break;
    case 'main-regression':
      console.log(`  main is broken — ${a.sharedFailures.length} shared failure(s). Route to engineering-lead.`);
      for (const f of a.sharedFailures.slice(0, 5)) console.log(`    - ${f.name}`);
      break;
    case 'mixed':
      console.log(`  ${a.prOnly.length} PR-introduced + ${a.sharedWithMain.length} shared-with-main.`);
      console.log('  PR-introduced (author):');
      for (const f of a.prOnly.slice(0, 5)) console.log(`    - ${f.name}`);
      console.log('  Shared with main (engineering-lead):');
      for (const f of a.sharedWithMain.slice(0, 5)) console.log(`    - ${f.name}`);
      break;
    case 'inconclusive':
      console.log(`  ${a.reason}`);
      break;
  }
  if (result.value.restoreFailure) {
    console.log(`  WARN: post-attribution restore failed — release the worktree before next acquire.`);
    console.log(`        ${result.value.restoreFailure.pedagogicalSummary}`);
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
      command: { type: 'string' },
      narrative: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli clearinghouse attribute: ${msg}`);
  process.exit(1);
}
