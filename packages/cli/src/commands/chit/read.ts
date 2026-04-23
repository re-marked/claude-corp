import { parseArgs } from 'node:util';
import {
  findChitById,
  ChitMalformedError,
  isChitIdFormat,
  type Chit,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

export async function cmdChitRead(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      json: { type: 'boolean', default: false },
      field: { type: 'string' },
      corp: { type: 'string' },
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

  // The chit id is the first positional (rawArgs already had the
  // subcommand stripped by the dispatcher).
  const id = parsed.positionals[0];
  if (!id || typeof id !== 'string') {
    fail('chit id is required (e.g. cc-cli chit read chit-t-abcdef01)');
  }

  if (!isChitIdFormat(id)) {
    fail(`not a valid chit id format: ${id}`);
  }

  const corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);

  try {
    const result = findChitById(corpRoot, id);
    if (!result) {
      console.error(`chit not found: ${id}`);
      process.exit(1);
    }

    // --field extracts a single field from the chit object
    if (typeof v.field === 'string') {
      const value = pickField(result.chit as Chit, v.field);
      if (value === undefined) {
        console.error(`field not found: ${v.field}`);
        process.exit(1);
      }
      if (typeof value === 'string') console.log(value);
      else console.log(JSON.stringify(value));
      return;
    }

    if (v.json) {
      console.log(
        JSON.stringify(
          { chit: result.chit, body: result.body, path: result.path },
          null,
          2,
        ),
      );
    } else {
      // Human-readable: show id, type, status, scope-from-path, key frontmatter, body
      console.log(formatChitReadable(result.chit as Chit, result.body, result.path));
    }
  } catch (err) {
    if (err instanceof ChitMalformedError) {
      console.error(`malformed chit file: ${err.path}`);
      console.error(`  cause: ${err.cause}`);
      console.error(`  logged to: <corp>/chits/_log/malformed.jsonl`);
      process.exit(3);
    }
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

/**
 * Pick a field from a chit by dot-path. Supports common fields at the top
 * level ("status", "tags") and fields.<type>.<key> via dot-notation
 * ("fields.task.priority", "task.priority", or bare "priority" which
 * searches the type-specific block).
 */
function pickField(chit: Chit, path: string): unknown {
  // Direct dot-path
  const parts = path.split('.');
  let current: unknown = chit;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      current = undefined;
      break;
    }
  }
  if (current !== undefined) return current;

  // Bare key: try fields.<type>.<key>
  const typeFieldsObj = (chit as unknown as { fields: Record<string, unknown> }).fields;
  if (typeFieldsObj && typeof typeFieldsObj === 'object') {
    const typeKey = (chit as Chit).type;
    const typeFields = typeFieldsObj[typeKey];
    if (typeFields && typeof typeFields === 'object' && path in (typeFields as Record<string, unknown>)) {
      return (typeFields as Record<string, unknown>)[path];
    }
  }

  return undefined;
}

function formatChitReadable(chit: Chit, body: string, path: string): string {
  const lines: string[] = [];
  lines.push(`id:         ${chit.id}`);
  lines.push(`type:       ${chit.type}`);
  lines.push(`status:     ${chit.status}`);
  lines.push(`ephemeral:  ${chit.ephemeral}${chit.ttl ? ` (ttl: ${chit.ttl})` : ''}`);
  lines.push(`createdBy:  ${chit.createdBy}`);
  lines.push(`updatedAt:  ${chit.updatedAt}`);
  if (chit.tags.length > 0) lines.push(`tags:       ${chit.tags.join(', ')}`);
  if (chit.references.length > 0) lines.push(`references: ${chit.references.join(', ')}`);
  if (chit.dependsOn.length > 0) lines.push(`dependsOn:  ${chit.dependsOn.join(', ')}`);
  lines.push(``);
  lines.push(`path:       ${path}`);
  lines.push(``);
  lines.push(`fields.${chit.type}:`);
  const typeFields = (chit.fields as Record<string, unknown>)[chit.type];
  if (typeFields && typeof typeFields === 'object') {
    for (const [k, val] of Object.entries(typeFields as Record<string, unknown>)) {
      lines.push(`  ${k}: ${typeof val === 'string' ? val : JSON.stringify(val)}`);
    }
  }
  if (body.trim().length > 0) {
    lines.push(``);
    lines.push(`--- body ---`);
    lines.push(body.trim());
  }
  return lines.join('\n');
}

function fail(msg: string): never {
  console.error(`cc-cli chit read: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli chit read — Read a chit by id

Usage:
  cc-cli chit read <id> [options]

The id determines the type (chit-t-xxx → task, casket-<slug> → casket,
etc.). The command searches all scopes and returns the first match.

Options:
  --json              Output as JSON (chit + body + path)
  --field <path>      Extract a single field (e.g. status, tags,
                      fields.task.priority, or bare "priority")
  --corp <name>       Operate on a specific corp (defaults to active)
  --help              Show this help

Examples:
  cc-cli chit read chit-t-abcdef01
  cc-cli chit read chit-t-abcdef01 --json
  cc-cli chit read chit-t-abcdef01 --field priority
  cc-cli chit read casket-toast --field currentStep`);
}
