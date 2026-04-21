import { parseArgs } from 'node:util';
import {
  findChitById,
  promoteChit,
  chitScopeFromPath,
  isChitIdFormat,
  ChitValidationError,
  ChitMalformedError,
  type ChitTypeId,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

export async function cmdChitPromote(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      reason: { type: 'string' },
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
    fail('chit id is required (e.g. cc-cli chit promote chit-o-abc --reason "..." --from ceo)');
  }
  if (!isChitIdFormat(id)) {
    fail(`not a valid chit id format: ${id}`);
  }

  if (!v.reason || typeof v.reason !== 'string') {
    fail('--reason is required (why this ephemeral chit should become permanent)');
  }
  if (!v.from || typeof v.from !== 'string') {
    fail('--from is required (the member id of whoever is promoting)');
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

    const promoted = promoteChit(corpRoot, scope, type, id, {
      reason: v.reason as string,
      updatedBy: v.from as string,
    });

    if (v.json) {
      console.log(JSON.stringify(promoted, null, 2));
    } else {
      console.log(`promoted ${promoted.id} (ephemeral → permanent)`);
      const promotionTag = promoted.tags.find((t) => t.startsWith('promoted:'));
      if (promotionTag) console.log(`tag: ${promotionTag}`);
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
  console.error(`cc-cli chit promote: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli chit promote — Flip an ephemeral chit to permanent

Usage:
  cc-cli chit promote <id> --reason "..." --from <member>

Required:
  --reason <text>         Why this chit should become permanent. The
                          reason slugs into a 'promoted:<reason-slug>'
                          tag on the chit so the provenance is queryable.
  --from <member>         Who is promoting (audit trail)

Optional:
  --corp <name>           Operate on a specific corp
  --json                  Return the promoted chit as JSON

This is the manual promotion path. Automatic promotion via 4-signal
scanner (Project 0.6) will call the same library function when signals
fire.

Examples:
  cc-cli chit promote chit-o-abc123 --reason "mark reaffirmed twice" --from ceo
  cc-cli chit promote chit-pbe-def456 --reason "pattern confirmed" --from herald`);
}
