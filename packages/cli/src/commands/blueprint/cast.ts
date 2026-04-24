import { parseArgs } from 'node:util';
import {
  resolveBlueprint,
  castFromBlueprint,
  listBlueprintChits,
  BlueprintVarError,
  BlueprintParseError,
  BlueprintCastError,
  type ChitScope,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

/**
 * `cc-cli blueprint cast <name-or-id> --scope <scope> [options]`
 *
 * Cast a Contract + Task chain from a blueprint. CLI wrapper over
 * `castFromBlueprint` — parses --vars key=value pairs into the caller
 * vars map, resolves the blueprint via resolveBlueprint (name or id),
 * and forwards to the primitive. Errors are teachable: BlueprintVarError
 * points at the bad var, BlueprintParseError at the step + field,
 * BlueprintCastError at the specific failure (status / role / etc).
 *
 * ### Scope is required
 *
 * Unlike `new` (which defaults to corp), cast requires explicit --scope
 * because the Contract + Tasks it produces become part of the corp's
 * working set — making the target scope a default-invisible choice
 * would be too easy to get wrong ("I cast patrol/health-check into
 * project:fire by accident when I meant corp"). Explicit > implicit.
 */

const HELP = `Usage: cc-cli blueprint cast <name-or-id> --scope <scope> [options]

Cast a Contract + Task chain from a blueprint.

Required:
  <name-or-id>                Blueprint name or chit id.
  --scope <scope>             Scope for the Contract + Tasks
                              (corp / project:<name> / agent:<slug>).

Options:
  --from <member-id>          Author of the cast Contract (founder default).
  --vars key=value            Repeatable. Caller values for the blueprint's
                              declared vars. Strings from CLI are coerced
                              per the declared var type (int parses,
                              bool accepts true/false/1/0).
  --step-role stepId=roleId   Repeatable. Fill assigneeRole for steps
                              where the blueprint left it null.
  --title "<text>"            Contract title override.
  --goal "<text>"             Contract goal override.
  --priority <p>              Contract priority (critical|high|normal|low).
  --lead <member-id>          Contract leadId.
  --deadline <iso>            Contract deadline ISO timestamp.
  --corp <name>               Operate on a specific corp (defaults to active).
  --json                      Machine-readable output.
  --help                      Show this help.

Exit codes:
  0  Cast succeeded; Contract + Tasks written.
  1  Argument / lookup error (blueprint not found, --scope missing).
  2  Cast failed (var, parse, or cast-specific error).

Examples:
  cc-cli blueprint cast patrol/health-check --scope corp
  cc-cli blueprint cast ship-feature --scope project:fire \\
    --vars feature=fire --vars touches_tui=true \\
    --step-role qa=qa-engineer
`;

type PriorityOverride = 'critical' | 'high' | 'normal' | 'low';

export async function cmdBlueprintCast(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      scope: { type: 'string' },
      from: { type: 'string' },
      vars: { type: 'string', multiple: true },
      'step-role': { type: 'string', multiple: true },
      title: { type: 'string' },
      goal: { type: 'string' },
      priority: { type: 'string' },
      lead: { type: 'string' },
      deadline: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (parsed.values.help) {
    console.log(HELP);
    return;
  }

  const nameOrId = parsed.positionals[0];
  if (!nameOrId) {
    console.error('error: <name-or-id> required — see `cc-cli blueprint cast --help`');
    process.exit(1);
  }

  const scopeFlag = parsed.values.scope as string | undefined;
  if (!scopeFlag) {
    console.error(
      'error: --scope <scope> required (cast writes into the corp; explicit target is mandatory)',
    );
    console.error(`       example: cc-cli blueprint cast ${nameOrId} --scope corp`);
    process.exit(1);
  }
  const scope = scopeFlag as ChitScope;

  const asJson = !!parsed.values.json;
  const corpOpt = parsed.values.corp as string | undefined;
  const createdBy = (parsed.values.from as string | undefined) ?? 'founder';
  const corpRoot = await getCorpRoot(corpOpt);

  // Resolve the blueprint (active only — cast requires active). Fall
  // back to a full-scope scan on miss for name lookups.
  const hit = resolveBlueprint(corpRoot, nameOrId, { activeOnly: true }) ?? fallbackSearchActive(corpRoot, nameOrId);

  if (!hit) {
    console.error(`error: active blueprint '${nameOrId}' not found`);
    console.error('       (did you forget `cc-cli blueprint validate` to promote a draft?)');
    process.exit(1);
  }

  // Parse --vars key=value repeated flags into a caller-vars record.
  const callerVars = parseKeyValuePairs(
    (parsed.values.vars as string[] | undefined) ?? [],
    '--vars',
  );

  // --step-role stepId=roleId similarly.
  const stepRoleOverrides = parseKeyValuePairs(
    (parsed.values['step-role'] as string[] | undefined) ?? [],
    '--step-role',
  ) as Record<string, string>;

  // Contract-level overrides. Only forward fields the caller set —
  // castFromBlueprint treats undefined as "use the default."
  const contractOverrides: NonNullable<
    Parameters<typeof castFromBlueprint>[3]['contractOverrides']
  > = {};
  if (parsed.values.title !== undefined) contractOverrides.title = parsed.values.title as string;
  if (parsed.values.goal !== undefined) contractOverrides.goal = parsed.values.goal as string;
  if (parsed.values.priority !== undefined) {
    const p = parsed.values.priority as string;
    if (!['critical', 'high', 'normal', 'low'].includes(p)) {
      console.error(`error: --priority must be critical|high|normal|low (got ${JSON.stringify(p)})`);
      process.exit(1);
    }
    contractOverrides.priority = p as PriorityOverride;
  }
  if (parsed.values.lead !== undefined) contractOverrides.leadId = parsed.values.lead as string;
  if (parsed.values.deadline !== undefined) contractOverrides.deadline = parsed.values.deadline as string;

  try {
    const result = castFromBlueprint(corpRoot, hit.chit, callerVars, {
      scope,
      createdBy,
      ...(Object.keys(stepRoleOverrides).length > 0 ? { stepRoleOverrides } : {}),
      ...(Object.keys(contractOverrides).length > 0 ? { contractOverrides } : {}),
    });

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            blueprint: { name: hit.chit.fields.blueprint.name, id: hit.chit.id },
            contract: { id: result.contract.id, title: result.contract.fields.contract.title },
            tasks: result.tasks.map((t) => ({
              id: t.id,
              title: t.fields.task.title,
              assignee: t.fields.task.assignee,
              dependsOn: t.dependsOn,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      `✓ Cast ${hit.chit.fields.blueprint.name} → ${result.tasks.length} task` +
        `${result.tasks.length === 1 ? '' : 's'} at scope '${scope}'`,
    );
    console.log('');
    console.log(`  Contract: ${result.contract.id}`);
    console.log(`    title:   ${result.contract.fields.contract.title}`);
    console.log(`    goal:    ${result.contract.fields.contract.goal}`);
    console.log('');
    console.log(`  Tasks:`);
    for (const t of result.tasks) {
      const deps = t.dependsOn.length > 0 ? `  (deps: ${t.dependsOn.length})` : '';
      console.log(`    ${t.id}  →  ${t.fields.task.assignee}${deps}`);
      console.log(`      ${t.fields.task.title}`);
    }
    console.log('');
    console.log(`  All tasks created in 'queued' workflow state. Dispatch the`);
    console.log(`  head task with 'cc-cli hand --chit <id> --to <assignee>';`);
    console.log(`  the chain walker transitions downstream tasks as deps close.`);
  } catch (err) {
    emitError(asJson, err);
    process.exit(2);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Parse `key=value` pairs from a multi-valued CLI flag. Splits on the
 * FIRST `=` only so values can legitimately contain `=` themselves.
 * Empty keys or malformed pairs (no `=`) reject with the caller-supplied
 * flag label in the error message so users can find the typo.
 */
function parseKeyValuePairs(pairs: string[], flagLabel: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of pairs) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      console.error(
        `error: ${flagLabel} expects key=value (got ${JSON.stringify(raw)}) — keys must be non-empty`,
      );
      process.exit(1);
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    if (!key) {
      console.error(`error: ${flagLabel} expects key=value — got empty key in ${JSON.stringify(raw)}`);
      process.exit(1);
    }
    out[key] = value;
  }
  return out;
}

function fallbackSearchActive(
  corpRoot: string,
  nameOrId: string,
): ReturnType<typeof resolveBlueprint> {
  const all = listBlueprintChits(corpRoot, { includeNonActive: false });
  const match = all.find((cwb) => {
    const bp = cwb.chit.fields.blueprint;
    return bp.name === nameOrId || cwb.chit.id === nameOrId;
  });
  return match ?? null;
}

function emitError(asJson: boolean, err: unknown): void {
  let kind: 'var' | 'parse' | 'cast' | 'other' = 'other';
  let stepId: string | undefined;
  let field: string | undefined;
  const msg = err instanceof Error ? err.message : String(err);

  if (err instanceof BlueprintVarError) {
    kind = 'var';
  } else if (err instanceof BlueprintParseError) {
    kind = 'parse';
    stepId = err.stepId;
    field = err.field;
  } else if (err instanceof BlueprintCastError) {
    kind = 'cast';
    stepId = err.stepId;
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          errorKind: kind,
          message: msg,
          ...(stepId ? { stepId } : {}),
          ...(field ? { field } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.error(`✗ cast failed [${kind}]`);
  console.error(`  ${msg}`);
  if (stepId) console.error(`  step:  ${stepId}`);
  if (field) console.error(`  field: ${field}`);
}
