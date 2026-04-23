/**
 * `cc-cli inbox dismiss <id>` — close an item without engaging.
 *
 * State transitions:
 *   status: active → rejected
 *   fields.inbox-item.resolution = 'dismissed'
 *   fields.inbox-item.dismissalReason = <reason> (when provided)
 *
 * Tier-aware discipline enforcement (the teeth of the tiered-inbox
 * design):
 *
 *   Tier 1 (ambient):  `--not-important` OR a reason, both accepted.
 *   Tier 2 (direct):   reason required, any non-empty string accepted.
 *   Tier 3 (critical): `--not-important` REJECTED; reason required +
 *                      must be at least TIER_3_MIN_REASON_CHARS long.
 *                      The agent must articulate WHY a founder DM
 *                      doesn't deserve engagement. If they can't, the
 *                      correct paths are `respond` or `carry-forward`.
 *
 * The `--not-important` flag is sugar — it sets a fixed "not-
 * important" dismissal reason for Tier 1 and 2. On Tier 3 it's a
 * trap to stop the "I'll just mark it dismissed and move on" pattern.
 */

import { parseArgs } from 'node:util';
import {
  findChitById,
  updateChit,
  chitScopeFromPath,
  isChitIdFormat,
  ChitConcurrentModificationError,
  ChitValidationError,
  type Chit,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

/**
 * Minimum character count for Tier 3 dismissal reasons. Picked to
 * rule out "nope" / "N/A" / "ok" / single-word dismissals without
 * being so strict it forces essays. Three words usually takes 15+
 * characters.
 */
const TIER_3_MIN_REASON_CHARS = 15;

const NOT_IMPORTANT_CANNED_REASON = 'not important / ambient noise';

export async function cmdInboxDismiss(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      reason: { type: 'string' },
      'not-important': { type: 'boolean', default: false },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;
  const id = parsed.positionals[0];

  if (v.help) {
    printHelp();
    return;
  }
  if (!id || typeof id !== 'string') fail('inbox-item chit id required');
  if (!isChitIdFormat(id)) fail(`not a valid chit id format: ${id}`);
  if (!v.from || typeof v.from !== 'string') fail('--from <member-id> required');

  const updatedBy = v.from as string;
  const corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);

  const found = findChitById(corpRoot, id);
  if (!found) fail(`chit not found: ${id}`);
  if (found.chit.type !== 'inbox-item') {
    fail(`chit ${id} is type '${found.chit.type}', not 'inbox-item'`);
  }

  const inboxChit = found.chit as Chit<'inbox-item'>;
  if (inboxChit.status !== 'active') {
    fail(
      `chit ${id} is already in terminal state '${inboxChit.status}'. ` +
        'Cannot re-dismiss a resolved item.',
    );
  }

  const tier = inboxChit.fields['inbox-item']?.tier;
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    fail(`chit ${id} has malformed tier '${tier}' — cannot dismiss safely`);
  }

  // Resolve the effective reason. --not-important produces the canned
  // string; --reason "..." passes through verbatim. Both or neither
  // are boundary conditions we check below.
  const notImportant = v['not-important'] === true;
  const rawReason = typeof v.reason === 'string' ? v.reason.trim() : '';

  if (notImportant && rawReason) {
    fail('--not-important and --reason are mutually exclusive');
  }

  // Tier 3 discipline: refuse shortcut dismissals. Force articulation.
  if (tier === 3 && notImportant) {
    fail(
      'Tier 3 items cannot be dismissed as --not-important. Respond, ' +
        'dismiss with a specific --reason (explaining why this critical ' +
        'item doesn\'t deserve engagement), or carry-forward with a reason.',
    );
  }

  let effectiveReason: string;
  if (notImportant) {
    effectiveReason = NOT_IMPORTANT_CANNED_REASON;
  } else if (rawReason.length === 0) {
    // Tier 1 ambient can technically be dismissed silently, but
    // requiring a reason on all tiers keeps the audit trail legible
    // post-hoc. The bar is low — Tier 1 accepts any non-empty string.
    fail(
      '--reason "..." required (or --not-important on Tier 1/2). Document why ' +
        'you\'re skipping this item so the audit trail stays legible.',
    );
  } else {
    effectiveReason = rawReason;
  }

  // Tier 3 reason-length floor — after the not-important guard because
  // --not-important has already been rejected on Tier 3 by this point.
  if (tier === 3 && effectiveReason.length < TIER_3_MIN_REASON_CHARS) {
    fail(
      `Tier 3 dismissal reason must be at least ${TIER_3_MIN_REASON_CHARS} characters ` +
        `(got ${effectiveReason.length}). Articulate why this critical item ` +
        'doesn\'t deserve engagement.',
    );
  }

  const scope = chitScopeFromPath(corpRoot, found.path);
  const existing = inboxChit.fields['inbox-item'];

  try {
    const updated = updateChit(corpRoot, scope, 'inbox-item', id, {
      updatedBy,
      status: 'rejected',
      fields: {
        'inbox-item': {
          ...existing,
          resolution: 'dismissed',
          dismissalReason: effectiveReason,
          // Clear any carry-forward state if somehow set (dismiss > carried).
          carriedForward: null,
          carryReason: null,
        },
      },
    });

    if (v.json) {
      console.log(JSON.stringify(updated, null, 2));
    } else {
      console.log(`dismissed: ${updated.id} (tier ${tier}) — ${effectiveReason}`);
    }
  } catch (err) {
    if (err instanceof ChitConcurrentModificationError) {
      console.error(`concurrent modification on ${id} — re-read and retry.`);
      process.exit(4);
    }
    if (err instanceof ChitValidationError) {
      console.error(`validation error: ${err.message}`);
      if (err.field) console.error(`  field: ${err.field}`);
      process.exit(2);
    }
    throw err;
  }
}

function fail(msg: string): never {
  console.error(`cc-cli inbox dismiss: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli inbox dismiss <id> — close an item without engaging

Usage:
  cc-cli inbox dismiss <chit-id> --from <slug> [options]

Required:
  <chit-id>               The inbox-item chit to dismiss.
  --from <member-id>      Who's dismissing.

Resolution (one of):
  --reason "..."          Explain why you're skipping. Required on
                          Tier 2+. Must be >= ${TIER_3_MIN_REASON_CHARS} chars on Tier 3.
  --not-important         Shortcut for Tier 1/2 ambient noise.
                          REJECTED on Tier 3.

Tier discipline:
  Tier 1 (ambient)  — any non-empty reason OR --not-important accepted.
  Tier 2 (direct)   — reason required, any non-empty string accepted.
  Tier 3 (critical) — reason required, >= ${TIER_3_MIN_REASON_CHARS} chars; --not-important
                      forbidden. Respond or carry-forward are usually
                      the right moves on Tier 3.

Options:
  --corp <name>           Operate on a specific corp.
  --json                  Machine-readable output.

Examples:
  cc-cli inbox dismiss chit-i-abc --not-important --from ceo
  cc-cli inbox dismiss chit-i-xyz --reason "duplicate of chit-i-qrs" --from ceo`);
}
