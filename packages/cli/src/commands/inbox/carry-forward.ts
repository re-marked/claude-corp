/**
 * `cc-cli inbox carry-forward <id>` — defer an item with justification.
 *
 * The audit-gate escape valve for legitimate "I looked at this and
 * decided to punt it explicitly, not ignore it" cases. Canonical
 * scenario: Tier 3 founder DM asking for input the agent can't act on
 * without more context. Responding prematurely is wrong; dismissing
 * is dishonest; carry-forward is the middle path.
 *
 * State:
 *   status: stays 'active' — the item is NOT resolved, it's deferred.
 *   fields.inbox-item.carriedForward = true
 *   fields.inbox-item.carryReason = <reason>
 *
 * The 0.7.3 audit gate treats carriedForward items as non-blocking
 * even though they're status=active. This is the one place the hard
 * tier-3 gate relaxes — explicit acknowledgment + documented reason
 * counts as resolution for the session-end check, without implying
 * the item itself is closed. Next session's wtf header still surfaces
 * the carried item so it stays visible until real resolution lands.
 *
 * Deliberately minimal surface: no tier filtering (carry-forward
 * works on any tier; tier 1 is pointless but harmless), no JSON-
 * structured reason. The reason is prose the founder eyeballs later.
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
 * Minimum characters for the carry-forward reason. Same floor as Tier 3
 * dismissal — "waiting" or "later" aren't reasons, they're evasions.
 * The reason needs to actually communicate WHAT the agent is waiting
 * on so the founder can supply it.
 */
const MIN_REASON_CHARS = 15;

export async function cmdInboxCarryForward(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      reason: { type: 'string' },
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

  const reason = typeof v.reason === 'string' ? v.reason.trim() : '';
  if (reason.length === 0) {
    fail(
      '--reason "..." required. Document what you\'re waiting for so the ' +
        'founder can supply it — "waiting" isn\'t a reason, it\'s an evasion.',
    );
  }
  if (reason.length < MIN_REASON_CHARS) {
    fail(
      `--reason must be at least ${MIN_REASON_CHARS} characters (got ${reason.length}). ` +
        'Explain what context you need so the founder can resolve it.',
    );
  }

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
        'Carry-forward is only valid on active items.',
    );
  }

  const scope = chitScopeFromPath(corpRoot, found.path);
  const existing = inboxChit.fields['inbox-item'];

  try {
    const updated = updateChit(corpRoot, scope, 'inbox-item', id, {
      updatedBy,
      // status stays 'active' — carry-forward is a deferral, not a close.
      fields: {
        'inbox-item': {
          ...existing,
          carriedForward: true,
          carryReason: reason,
        },
      },
    });

    if (v.json) {
      console.log(JSON.stringify(updated, null, 2));
    } else {
      console.log(`carried forward: ${updated.id} — ${reason}`);
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
  console.error(`cc-cli inbox carry-forward: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli inbox carry-forward <id> — defer an item with justification

Usage:
  cc-cli inbox carry-forward <chit-id> --from <slug> --reason "..."

Required:
  <chit-id>               The inbox-item chit to carry forward.
  --from <member-id>      Who's deferring (audit trail).
  --reason "..."          >= ${MIN_REASON_CHARS} chars. Explain what you're waiting on.

Behavior:
  Item stays status='active' but gets carriedForward=true + carryReason.
  The audit gate treats carried-forward items as non-blocking for
  session-end purposes while preserving their visibility in the next
  wtf header. Real resolution (respond or dismiss) still needed before
  the item truly closes.

When to use:
  Tier 3 founder DM you can't act on without more context. Work
  assignment that depends on something the founder hasn't landed yet.
  "I looked at this, I have a thought, I'm blocked" rather than "I
  don't care about this."

Options:
  --corp <name>           Operate on a specific corp.
  --json                  Machine-readable output.

Example:
  cc-cli inbox carry-forward chit-i-abc --reason "waiting on founder to confirm budget cap before I can scope this" --from ceo`);
}
