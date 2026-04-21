import { parseArgs } from 'node:util';
import {
  findChitById,
  closeChit,
  chitScopeFromPath,
  isChitIdFormat,
  ChitValidationError,
  ChitMalformedError,
  ChitConcurrentModificationError,
  type ChitStatus,
  type ChitTypeId,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

export async function cmdChitClose(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      status: { type: 'string' },
      from: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;

  if (v.help) {
    printHelp();
    return;
  }

  const id = parsed.positionals[0];
  if (!id || typeof id !== 'string') {
    fail('chit id is required (e.g. cc-cli chit close chit-t-abcdef01 --from ceo)');
  }
  if (!isChitIdFormat(id)) {
    fail(`not a valid chit id format: ${id}`);
  }

  if (!v.from || typeof v.from !== 'string') {
    fail('--from is required (the member id of whoever is closing)');
  }
  const updatedBy = v.from as string;

  // Default status: 'completed' works for task/contract/step-log; library
  // throws a clear error (listing valid terminal statuses) if this type
  // doesn't accept it — users see the right answer immediately.
  const status = (typeof v.status === 'string' ? v.status : 'completed') as ChitStatus;

  const corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);

  try {
    const found = findChitById(corpRoot, id);
    if (!found) {
      console.error(`chit not found: ${id}`);
      process.exit(1);
    }
    const scope = chitScopeFromPath(corpRoot, found.path);
    const type = found.chit.type as ChitTypeId;

    const closed = closeChit(corpRoot, scope, type, id, status, updatedBy);

    if (v.json) {
      console.log(JSON.stringify(closed, null, 2));
    } else {
      console.log(`closed ${closed.id} (status=${closed.status})`);
    }
  } catch (err) {
    if (err instanceof ChitValidationError) {
      console.error(`validation error: ${err.message}`);
      if (err.field) console.error(`  field: ${err.field}`);
      process.exit(2);
    }
    if (err instanceof ChitMalformedError) {
      console.error(`malformed chit: ${err.path}`);
      console.error(`  cause: ${err.cause}`);
      process.exit(3);
    }
    if (err instanceof ChitConcurrentModificationError) {
      console.error(`concurrent modification: ${err.message}`);
      process.exit(4);
    }
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

function fail(msg: string): never {
  console.error(`cc-cli chit close: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli chit close — Transition a chit to a terminal status

Usage:
  cc-cli chit close <id> --from <member> [options]

Required:
  --from <member>         Who's closing (audit trail)

Options:
  --status <status>       Terminal status to transition to (defaults to
                          'completed'). Must be in the type's
                          terminalStatuses. If your type doesn't accept
                          'completed' (observation, handoff, dispatch-
                          context, pre-brain-entry) pass --status closed.
  --corp <name>           Operate on a specific corp
  --json                  Return the closed chit as JSON

Non-ephemeral chits stay on disk after closing (git history + pattern
detection). Ephemeral chits get swept by the lifecycle scanner (0.6).
Use 'cc-cli chit archive <id>' to move a closed chit to _archive/.

Examples:
  cc-cli chit close chit-t-abc123 --from ceo
  cc-cli chit close chit-t-abc123 --status failed --from ceo
  cc-cli chit close chit-o-def456 --status closed --from toast`);
}
