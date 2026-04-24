import { parseArgs } from 'node:util';
import {
  createChit,
  findBlueprintByName,
  chitPath,
  ChitValidationError,
  type BlueprintFields,
  type ChitScope,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

/**
 * `cc-cli blueprint new <name> [--scope <scope>] [--from <slug>]
 *                              [--title "..."]`
 *
 * Scaffold a draft blueprint chit. Creates a minimal `steps: [...]`
 * placeholder the author edits directly on disk (file path is printed
 * in the success output). The resulting chit lands in `draft` status;
 * `cc-cli blueprint validate` promotes to `active` once the author has
 * filled in real steps.
 *
 * ### Uniqueness
 *
 * Before creating, checks findBlueprintByName(name, scopes=[scope],
 * activeOnly=false). If a blueprint with that name already exists in
 * this scope (active OR draft OR closed), reject. Enforcement at the
 * CLI boundary because the validator is pure on fields — it can't see
 * scope state.
 *
 * ### Default scaffold body
 *
 * The chit body (markdown after frontmatter) gets a short authoring
 * guide explaining how to edit steps + vars + use Handlebars. Author
 * deletes this once they've replaced it with real description.
 */

const HELP = `Usage: cc-cli blueprint new <name> [options]

Scaffold a draft blueprint chit at <scope>. The chit lands in 'draft'
status; edit it directly on disk, then 'cc-cli blueprint validate' to
promote to 'active' (cast-able).

Required positional:
  <name>                Blueprint name (kebab-case, optional / for
                        category prefix: 'patrol/health-check').

Options:
  --scope <scope>       Scope: 'corp' (default) | 'project:<name>' |
                        'agent:<slug>'.
  --from <member-id>    Author (required for agent scope; 'founder' by default).
  --title "<text>"      Optional display label shown in 'blueprint list'.
  --summary "<text>"    Optional one-line summary for list rendering.
  --corp <name>         Operate on a specific corp (defaults to active).
  --help                Show this help.

Example:
  cc-cli blueprint new patrol/health-check --scope corp \\
    --title "Corp health patrol" \\
    --summary "Sweep caskets, detect stalls, respawn silent exits"
`;

export async function cmdBlueprintNew(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      scope: { type: 'string' },
      from: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      corp: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (parsed.values.help) {
    console.log(HELP);
    return;
  }

  const name = parsed.positionals[0];
  if (!name) {
    console.error('error: <name> required — see `cc-cli blueprint new --help`');
    process.exit(1);
  }

  const scope: ChitScope = (parsed.values.scope as ChitScope | undefined) ?? 'corp';
  const createdBy = (parsed.values.from as string | undefined) ?? 'founder';
  const titleOpt = parsed.values.title as string | undefined;
  const summaryOpt = parsed.values.summary as string | undefined;
  const corpOpt = parsed.values.corp as string | undefined;

  const corpRoot = await getCorpRoot(corpOpt);

  // Uniqueness check: reject if a blueprint with this name already
  // exists in the target scope (active OR draft OR closed — any).
  const existing = findBlueprintByName(corpRoot, name, {
    scopes: [scope],
    activeOnly: false,
  });
  if (existing) {
    console.error(
      `error: blueprint '${name}' already exists at scope '${scope}' ` +
        `(status '${existing.chit.status}', id ${existing.chit.id})`,
    );
    console.error('');
    console.error(`To edit: open ${existing.path}`);
    console.error(`To replace: close the existing one, then create a new one.`);
    process.exit(1);
  }

  // Scaffold fields. One placeholder step so the author has something
  // to edit; null assigneeRole so the scaffold doesn't encode a wrong
  // default. Empty vars array (authors add as needed).
  const scaffoldFields: BlueprintFields = {
    name,
    origin: 'authored',
    steps: [
      {
        id: 'step-1',
        title: 'First step (edit me)',
        description: 'Describe what this step does.',
        assigneeRole: null,
      },
    ],
    vars: [],
    title: titleOpt ?? null,
    summary: summaryOpt ?? null,
  };

  const scaffoldBody = `# ${name}

_Edit this description: what does this blueprint do, when should
someone cast it?_

## Authoring notes

- Each entry in the frontmatter's \`steps\` array becomes a Task chit
  when this blueprint is cast. Step ids are local (referenced by
  \`dependsOn\`); cast rewrites them to real chit ids at cast time.
- Declare typed variables in \`vars\` (\`string\` | \`int\` | \`bool\`).
  Reference them in step strings via Handlebars: \`{{var_name}}\`.
  Conditionals supported: \`{{#if touches_tui}}...{{/if}}\`.
- Set \`assigneeRole\` to a role id from the role registry (e.g.
  \`backend-engineer\`, \`ceo\`, \`sexton\`) or leave \`null\` to require
  a \`--stepRoleOverrides\` entry at cast time.
- \`cc-cli blueprint validate <name>\` parses this blueprint with
  dummy vars + promotes to \`active\` if the structure is sound.

Delete this section once you've filled in real content.
`;

  try {
    const chit = createChit(corpRoot, {
      type: 'blueprint',
      scope,
      createdBy,
      body: scaffoldBody,
      fields: { blueprint: scaffoldFields },
    });

    const path = chitPath(corpRoot, scope, 'blueprint', chit.id);
    console.log(`Blueprint draft created:`);
    console.log(`  name:   ${name}`);
    console.log(`  id:     ${chit.id}`);
    console.log(`  scope:  ${scope}`);
    console.log(`  status: ${chit.status} (edit + validate to promote)`);
    console.log(`  file:   ${path}`);
    console.log('');
    console.log(`Next steps:`);
    console.log(`  1. Open ${path} in your editor and flesh out steps + vars.`);
    console.log(`  2. cc-cli blueprint validate ${name}`);
    console.log(`  3. cc-cli blueprint cast ${name} --project <id> [--vars k=v]`);
  } catch (err) {
    if (err instanceof ChitValidationError) {
      console.error(`error: ${err.message}`);
      if (err.field) console.error(`       (field: ${err.field})`);
      process.exit(1);
    }
    throw err;
  }
}
