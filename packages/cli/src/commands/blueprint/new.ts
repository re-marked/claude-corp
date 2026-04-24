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
  //
  // The scaffold is deliberately minimal at the FIELDS level — the
  // authoring guide lives in the BODY where the author will see it
  // when they open the file. Keeping the scaffolded steps single-entry
  // avoids tempting authors to leave multiple placeholder-named steps
  // in their "real" blueprint.
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
someone cast it? Keep it scannable — this is what the founder + CEO
read when they pick a blueprint off \`cc-cli blueprint list\`._

## Authoring guide

A blueprint is a chit whose \`fields.blueprint\` defines a repeatable
DAG of Tasks. When you \`cc-cli blueprint cast\` it (or
\`cc-cli contract start --blueprint ...\`), the DAG is instantiated
into a Contract + Task chits with step ids rewritten to real chit ids.

### Field reference (in the frontmatter)

- **\`name\`** — kebab-case id used as the human reference. Categories
  allowed via \`/\` (\`patrol/health-check\`, \`ship/feature\`).
- **\`origin\`** — \`authored\` (you wrote it) or \`builtin\` (shipped
  with Claude Corp). Keep \`authored\` unless this blueprint ships
  with the repo.
- **\`steps\`** — non-empty array. Each entry becomes ONE Task chit
  at cast time. Ordering within the array is cosmetic; cast walks
  \`dependsOn\` to derive the actual DAG.
- **\`vars\`** — typed variables the caller supplies at cast via
  \`--vars name=value\`. Each entry: \`{ name, type, default? }\` where
  \`type\` is \`string\` | \`int\` | \`bool\`. A default makes the var
  optional at cast time; otherwise the caller must supply it.
- **\`title\`**, **\`summary\`** — human-readable labels surfaced by
  \`cc-cli blueprint list\` and \`cc-cli blueprint show\`.

### Step shape

Each step is:

  { id, title, description?, dependsOn?, acceptanceCriteria?, assigneeRole? }

- **\`id\`** — kebab-case local identifier. Used by other steps'
  \`dependsOn\` to reference this step. Cast rewrites to a real chit
  id when instantiating.
- **\`title\`** — short Task chit title. Templated (Handlebars refs
  allowed, e.g. \`"Ship {{feature}}"\`).
- **\`description\`** — optional prose body of the Task chit. Templated.
- **\`dependsOn\`** — optional array of other step ids this step waits
  on. Empty / absent = head step (no predecessors). The chit-type
  validator checks every reference, and rejects blueprints with
  cycles or references to non-existent step ids before the blueprint
  can be promoted to \`active\`.
- **\`acceptanceCriteria\`** — optional string array the Task must
  satisfy. Each entry is templated. Carries through to
  \`task.fields.acceptanceCriteria\` — the audit gate reads these
  when the Task hits \`cc-cli done\`.
- **\`assigneeRole\`** — role id from the registry (\`ceo\`, \`sexton\`,
  \`backend-engineer\`, etc.) OR \`null\` to defer to cast time. Null
  requires the caster to supply \`--step-role <step-id>=<role>\` at
  cast. Never use a scope-qualified slug (\`agent:toast\`) — blueprints
  assign to ROLES; role-resolver picks an Employee at cast.

### Handlebars templating

Every templated field (\`title\`, \`description\`, \`acceptanceCriteria\`,
\`assigneeRole\`) is run through Handlebars with strict mode + noEscape:

- \`{{var_name}}\` — substitutes the var's cast-time value.
- \`{{#if flag}}A{{else}}B{{/if}}\` — conditionals on bool vars.
- Strict mode means referencing an undeclared var throws at validate
  or cast time with \`blueprint.vars[].name\` field-path context.
- Step ids and \`dependsOn\` are NOT templated — they're structural,
  not prose, and must be stable across casts.

### Typical authoring flow

1. Scaffold: \`cc-cli blueprint new <name> --title "..."\`
2. Open the \`file:\` printed by \`new\`, flesh out steps + vars.
3. Validate: \`cc-cli blueprint validate <name>\` — parses against
   synthesized dummy vars; on success, promotes \`draft\` → \`active\`.
4. Cast: \`cc-cli contract start --blueprint <name> --project <p>
   --vars <k>=<v>...\` — creates the Contract + Tasks at project
   scope, ready for \`cc-cli hand\` to dispatch the head task.

Delete this section once you've filled in real content — it lands in
the chit's body and isn't load-bearing for cast.
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
