/**
 * `cc-cli inbox respond <id>` — mark an inbox item as responded.
 *
 * The agent indicates "I've engaged with this item substantively" —
 * they've already posted the channel reply / sent the DM / started
 * the task. This command doesn't send the response; it closes the
 * inbox item so the audit gate's tier-3 check sees it as resolved
 * and stops blocking.
 *
 * State transitions:
 *   status: active → completed
 *   fields.inbox-item.resolution = 'responded'
 *
 * Requires --from (the responder's slug, audit trail). Optional
 * --response-ref to link the chit that embodies the response (a
 * task chit they started, an observation they wrote, whatever).
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
  type ChitTypeId,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

export async function cmdInboxRespond(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      'response-ref': { type: 'string' },
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
        'Cannot re-respond to a resolved item.',
    );
  }

  const scope = chitScopeFromPath(corpRoot, found.path);
  const type: ChitTypeId = 'inbox-item';

  // Preserve existing fields (from, subject, tier, source, etc.) + flip
  // resolution to 'responded'. updateChit's deep-merge at fields.<type>
  // level handles this without an explicit spread, but explicit is
  // safer here since we want to guarantee the carriedForward flag
  // clears if it was somehow set (a responded item is no longer
  // carried-forward).
  const existing = inboxChit.fields['inbox-item'];
  try {
    const updated = updateChit(corpRoot, scope, type, id, {
      updatedBy,
      status: 'completed',
      fields: {
        'inbox-item': {
          ...existing,
          resolution: 'responded',
          // Clear carry-forward state if present — responded > carried.
          carriedForward: null,
          carryReason: null,
        },
      },
      references: v['response-ref']
        ? mergeRef(inboxChit.references, v['response-ref'] as string)
        : undefined,
    });

    if (v.json) {
      console.log(JSON.stringify(updated, null, 2));
    } else {
      console.log(`responded: ${updated.id}`);
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

function mergeRef(existing: readonly string[], add: string): string[] {
  if (existing.includes(add)) return [...existing];
  return [...existing, add];
}

function fail(msg: string): never {
  console.error(`cc-cli inbox respond: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli inbox respond <id> — mark an inbox item as responded

Usage:
  cc-cli inbox respond <chit-id> --from <slug> [options]

Required:
  <chit-id>               The inbox-item chit to close as responded.
  --from <member-id>      Who's closing it (the agent handling the item).

Options:
  --response-ref <chit-id>  Link the chit that embodies your response
                            (e.g. a task chit you started, an
                            observation you wrote). Appended to the
                            inbox item's references[].
  --corp <name>             Operate on a specific corp.
  --json                    Machine-readable output.

Notes:
  This command doesn't send your response — you've already posted
  the channel reply / DM / started the task. This just closes the
  inbox item so the audit gate stops blocking on it.

Examples:
  cc-cli inbox respond chit-i-abc123 --from ceo
  cc-cli inbox respond chit-i-abc123 --from ceo --response-ref chit-t-xyz`);
}
