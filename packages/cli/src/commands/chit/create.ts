import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import {
  createChit,
  casketChitId,
  isKnownChitType,
  ChitValidationError,
  type ChitTypeId,
  type ChitScope,
  type CreateChitOpts,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

/**
 * Parse a single --field value. Try JSON first (numbers, booleans, arrays,
 * objects) so `--field importance=4` yields 4 not "4"; fall back to the raw
 * string for unquoted identifiers like `--field category=FEEDBACK`.
 */
function parseFieldValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Assemble the fields.<type> object from --field key=value pairs plus the
 * --title convenience shortcut. Keys may use dot-notation (e.g.
 * `--field task.priority=high` or bare `--field priority=high`); bare keys
 * are placed under fields.<type>.<key>.
 */
function buildFields(
  type: ChitTypeId,
  title: string | undefined,
  fieldPairs: string[],
): Record<string, unknown> {
  const typeFields: Record<string, unknown> = {};

  if (title !== undefined) {
    typeFields.title = title;
  }

  for (const pair of fieldPairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) {
      throw new ChitValidationError(`--field expects key=value, got: ${pair}`, 'field');
    }
    let key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    // Allow either bare key or `<type>.<key>` for clarity
    if (key.startsWith(`${type}.`)) key = key.slice(type.length + 1);
    typeFields[key] = parseFieldValue(value);
  }

  return { [type]: typeFields };
}

export async function cmdChitCreate(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      type: { type: 'string' },
      scope: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string' },
      'content-file': { type: 'string' },
      tag: { type: 'string', multiple: true },
      ref: { type: 'string', multiple: true },
      'depends-on': { type: 'string', multiple: true },
      field: { type: 'string', multiple: true },
      ephemeral: { type: 'boolean' },
      'no-ephemeral': { type: 'boolean' },
      ttl: { type: 'string' },
      id: { type: 'string' },
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

  // Required: type + scope
  if (!v.type || typeof v.type !== 'string') {
    fail(`--type is required (one of: task, contract, observation, casket, handoff, dispatch-context, pre-brain-entry, step-log)`);
  }
  if (!isKnownChitType(v.type as string)) {
    fail(`unknown chit type: ${v.type}`);
  }
  const type = v.type as ChitTypeId;

  if (!v.scope || typeof v.scope !== 'string') {
    fail(`--scope is required (corp | agent:<slug> | project:<name> | team:<project>/<team>)`);
  }
  const scope = v.scope as ChitScope;

  // Body: --content or --content-file (mutually exclusive); defaults to empty
  let body: string | undefined;
  if (v.content && v['content-file']) {
    fail('--content and --content-file are mutually exclusive');
  }
  if (v.content) body = v.content as string;
  else if (v['content-file']) {
    try {
      body = readFileSync(v['content-file'] as string, 'utf-8');
    } catch (err) {
      fail(`could not read --content-file: ${(err as Error).message}`);
    }
  }

  // Ephemeral override: --ephemeral or --no-ephemeral; neither = registry default
  let ephemeral: boolean | undefined;
  if (v['no-ephemeral']) ephemeral = false;
  else if (v.ephemeral) ephemeral = true;

  // Casket ids are deterministic — accept --id explicitly OR synthesize
  // from agent:<slug> scope if type=casket and no --id was passed.
  let explicitId: string | undefined = typeof v.id === 'string' ? v.id : undefined;
  if (type === 'casket' && !explicitId && scope.startsWith('agent:')) {
    explicitId = casketChitId(scope.slice('agent:'.length));
  }

  // Fields assembly
  const fieldPairs = Array.isArray(v.field) ? (v.field as string[]) : [];
  const title = typeof v.title === 'string' ? v.title : undefined;

  const fields = buildFields(type, title, fieldPairs);

  // Author — --from required for agents, founder implied otherwise.
  // This command can be run by founder or agent; we take --from as-is
  // and default to 'founder' when unset. The daemon boundary enforces
  // stricter auth when agents invoke via the harness.
  const createdBy = (typeof v.from === 'string' ? v.from : 'founder').trim();

  const corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);

  try {
    const opts: CreateChitOpts<typeof type> = {
      type,
      scope,
      fields: fields as CreateChitOpts<typeof type>['fields'],
      createdBy,
      ...(explicitId !== undefined && { id: explicitId }),
      ...(ephemeral !== undefined && { ephemeral }),
      ...(typeof v.ttl === 'string' && { ttl: v.ttl as string }),
      ...(Array.isArray(v.tag) && { tags: v.tag as string[] }),
      ...(Array.isArray(v.ref) && { references: v.ref as string[] }),
      ...(Array.isArray(v['depends-on']) && { dependsOn: v['depends-on'] as string[] }),
      ...(body !== undefined && { body }),
    };

    const chit = createChit(corpRoot, opts);

    if (v.json) {
      console.log(JSON.stringify(chit, null, 2));
    } else {
      console.log(chit.id);
    }
  } catch (err) {
    if (err instanceof ChitValidationError) {
      console.error(`validation error: ${err.message}`);
      if (err.field) console.error(`  field: ${err.field}`);
      process.exit(2);
    }
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

function fail(msg: string): never {
  console.error(`cc-cli chit create: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli chit create — Create a new chit

Usage:
  cc-cli chit create --type <type> --scope <scope> [options]

Required:
  --type <type>          Chit type (task, contract, observation, casket,
                         handoff, dispatch-context, pre-brain-entry, step-log)
  --scope <scope>        Where to store it: corp | agent:<slug> |
                         project:<name> | team:<project>/<team>

Content:
  --title <text>         Shortcut for --field title="<text>" where applicable
  --content <text>       Markdown body
  --content-file <path>  Read body from file (alternative to --content)
  --field key=value      Set fields.<type>.<key> (repeatable). Values parse
                         as JSON when possible (numbers, booleans), else
                         treated as strings.

Links:
  --tag <tag>            Attach a tag (repeatable)
  --ref <chit-id>        Loose reference (repeatable)
  --depends-on <id>      Hard dependency (repeatable)

Lifecycle:
  --ephemeral            Force ephemeral=true
  --no-ephemeral         Force ephemeral=false
  --ttl <iso-timestamp>  Override default TTL (ephemeral only)
  --id <id>              Override auto-generated id (required for casket when
                         the scope's agent slug can't be inferred)

Authorship:
  --from <member-id>     Author member id (founder implied if absent)
  --corp <name>          Operate on a specific corp (defaults to active)

Output:
  --json                 Output the created chit as JSON
  (default)              Output just the new chit id

Examples:
  cc-cli chit create --type task --scope corp \\
    --title "Ship feature X" --field priority=high

  cc-cli chit create --type observation --scope agent:toast \\
    --field category=FEEDBACK --field subject=mark --field importance=4 \\
    --tag mark-preference --tag actionable-errors \\
    --content "Mark prefers actionable error messages"`);
}
