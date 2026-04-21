import { parseArgs } from 'node:util';
import {
  findChitById,
  archiveChit,
  chitScopeFromPath,
  isChitIdFormat,
  ChitValidationError,
  ChitMalformedError,
  type ChitTypeId,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

export async function cmdChitArchive(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
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
    fail('chit id is required (e.g. cc-cli chit archive chit-t-abcdef01)');
  }
  if (!isChitIdFormat(id)) {
    fail(`not a valid chit id format: ${id}`);
  }

  const corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);

  try {
    const found = findChitById(corpRoot, id);
    if (!found) {
      console.error(`chit not found: ${id}`);
      process.exit(1);
    }
    const scope = chitScopeFromPath(corpRoot, found.path);
    const type = found.chit.type as ChitTypeId;

    const result = archiveChit(corpRoot, scope, type, id);

    if (v.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`archived ${id}`);
      console.log(`  from: ${result.sourcePath}`);
      console.log(`  to:   ${result.archivePath}`);
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
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

function fail(msg: string): never {
  console.error(`cc-cli chit archive: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli chit archive — Move a closed chit to _archive/

Usage:
  cc-cli chit archive <id> [options]

The chit must already be in a terminal status — archiving in-progress
work hides real state. Close it first with:

  cc-cli chit close <id> --from <member>

Then archive:

  cc-cli chit archive <id>

Archived chits are invisible to default queries (keeping working-set
reads fast as history grows) but still accessible via:

  cc-cli chit list --include-archive

Options:
  --corp <name>           Operate on a specific corp
  --json                  Return { sourcePath, archivePath } as JSON

Archive does not need --from because it doesn't modify chit state; it
only relocates the file. Authorship lives on the prior close operation.`);
}
