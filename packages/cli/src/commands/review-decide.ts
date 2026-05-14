/**
 * cc-cli review-decide — Project 2.5 verdict-application wrapper.
 *
 * Reads a `review` chit and applies its verdict via
 * applyReviewVerdict. Returns a structured result; on failure, prints
 * the errors + exits non-zero.
 *
 * The future Stop-hook re-wire (follow-up PR) will call this for
 * review-mode session ends instead of `cc-cli audit`. Right now it
 * exists primarily so the substrate is independently testable from
 * the shell — Mark or an operator can:
 *
 *   1. Cast a walk, get to under_review on Task 1
 *   2. Manually write a review chit via `cc-cli chit create --type review ...`
 *   3. Run `cc-cli review-decide --review-id <id> --founder mark`
 *   4. Observe: task transitions / inbox-item / review closed
 *
 * Without this command, the same flow requires writing a TS script.
 *
 * ### Founder resolution
 *
 * --founder names the recipient of Tier-3 inbox-items on flag verdicts
 * (and on cap-downgraded redos). When omitted, the command falls back
 * to the rank=owner member from members.json. Pass --founder explicitly
 * to override or when running against a corp without an owner-rank
 * member registered.
 */

import { parseArgs } from 'node:util';
import {
  applyReviewVerdict,
  type Member,
  isChitIdFormat,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers } from '../client.js';

export interface ReviewDecideOpts {
  reviewId?: string;
  founder?: string;
  redoCap?: number;
  corp?: string;
  json?: boolean;
}

export async function cmdReviewDecide(rawArgs: string[]): Promise<void>;
export async function cmdReviewDecide(opts: ReviewDecideOpts): Promise<void>;
export async function cmdReviewDecide(
  input: string[] | ReviewDecideOpts,
): Promise<void> {
  const opts = Array.isArray(input) ? parseOpts(input) : input;

  if (!opts.reviewId) fail('--review-id <chit-id> required');
  if (!isChitIdFormat(opts.reviewId)) {
    fail(`not a valid chit id format: ${opts.reviewId}`);
  }

  const corpRoot = await getCorpRoot(opts.corp);

  // Founder resolution — explicit --founder beats the registry lookup.
  let founderId = opts.founder;
  if (!founderId) {
    const members = safeGetMembers(corpRoot);
    const owner = members.find((m) => m.rank === 'owner');
    if (!owner) {
      fail(
        '--founder <member-id> required (no rank=owner member found in members.json to fall back to)',
      );
    }
    founderId = owner.id;
  }

  const result = applyReviewVerdict(corpRoot, {
    reviewChitId: opts.reviewId,
    founderMemberId: founderId,
    ...(opts.redoCap !== undefined ? { redoCap: opts.redoCap } : {}),
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.applied) {
      console.error(`review-decide refused to apply verdict on ${opts.reviewId}:`);
      for (const e of result.errors) console.error(`  - ${e}`);
      process.exit(2);
    }
    const tail = [
      `applied verdict on review ${result.reviewChitId} (task ${result.taskId})`,
      `  input verdict:    ${result.inputVerdict}`,
      `  outcome verdict:  ${result.outcomeVerdict}${result.capDowngrade ? ' (cap-downgrade from redo)' : ''}`,
      result.appliedTaskTransition
        ? `  task transition:  ${result.appliedTaskTransition.from} → ${result.appliedTaskTransition.to}`
        : `  task transition:  (none)`,
      result.inboxItemId
        ? `  inbox-item:       ${result.inboxItemId} → founder`
        : `  inbox-item:       (none)`,
    ];
    console.log(tail.join('\n'));
  }
}

function parseOpts(rawArgs: string[]): ReviewDecideOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      'review-id': { type: 'string' },
      founder: { type: 'string' },
      'redo-cap': { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;
  const redoCapRaw = typeof v['redo-cap'] === 'string' ? Number(v['redo-cap']) : undefined;
  return {
    reviewId: (v['review-id'] as string | undefined) ?? undefined,
    founder: (v.founder as string | undefined) ?? undefined,
    ...(redoCapRaw !== undefined && Number.isFinite(redoCapRaw) ? { redoCap: redoCapRaw } : {}),
    corp: (v.corp as string | undefined) ?? undefined,
    json: Boolean(v.json),
  };
}

function safeGetMembers(corpRoot: string): Member[] {
  try {
    return getMembers(corpRoot);
  } catch {
    return [];
  }
}

function fail(msg: string): never {
  console.error(`cc-cli review-decide: ${msg}`);
  process.exit(1);
}
