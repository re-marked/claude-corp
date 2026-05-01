import { parseArgs } from 'node:util';
import {
  resolveBlueprint,
  parseBlueprint,
  updateChit,
  listBlueprintChits,
  chitScopeFromPath,
  BlueprintVarError,
  BlueprintParseError,
  type BlueprintVar,
  type ChitScope,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

/**
 * `cc-cli blueprint validate <name-or-id> [--json]`
 *
 * Dry-run parseBlueprint against synthesized dummy values to prove the
 * blueprint's structure is sound, then promote draft → active on
 * success. On failure, surface the specific error + don't promote.
 *
 * "Structure is sound" means:
 *   - Every declared var merges cleanly (no missing required refs at
 *     the blueprint-vars layer — caller vs. author discipline)
 *   - Every Handlebars template compiles (syntax check)
 *   - Every {{var}} reference in a template resolves to a declared var
 *     (strict-mode check via Handlebars)
 *
 * ### Why dummy values work
 *
 * validate doesn't care about cast-time values — it cares whether the
 * blueprint's templates are coherent with its declared vars. Passing
 * dummy values for required vars (''/0/false) lets parseBlueprint
 * run its full pipeline without simulating a real cast. Handlebars
 * strict mode catches undeclared refs regardless of WHAT is in the
 * context map — what matters is whether the KEYS exist.
 *
 * Active blueprints can also be validated (useful for
 * "does this still parse after I edited the template?") — re-validating
 * an active blueprint is a no-op on success; on failure it DOES NOT
 * demote (demotion needs author intent, not a failing parse).
 */

const HELP = `Usage: cc-cli blueprint validate <name-or-id> [options]

Parse a blueprint against synthesized dummy vars to prove structure
is sound. On success, promote draft → active. On failure, surface
the specific parse/var error and do not promote.

Options:
  --scope <scope>       Scope hint for name resolution (repeatable).
  --from <member-id>    Audit actor for the promotion write ('founder'
                        by default). Use an agent's slug when an agent
                        is self-promoting its own draft blueprint.
  --json                Machine-readable output.
  --corp <name>         Operate on a specific corp (defaults to active).
  --help                Show this help.

Exit codes:
  0  Validation passed (promoted if previously draft, no-op otherwise).
  1  Blueprint not found.
  2  Validation failed (parse, var, or structural error).

Examples:
  cc-cli blueprint validate patrol/health-check
  cc-cli blueprint validate chit-b-abc12345 --json
`;

interface ValidateSuccess {
  readonly ok: true;
  readonly name: string;
  readonly id: string;
  readonly previousStatus: string;
  readonly newStatus: string;
  readonly promoted: boolean;
}

interface ValidateFailure {
  readonly ok: false;
  readonly name: string | null;
  readonly id: string | null;
  readonly errorKind: 'not-found' | 'var' | 'parse' | 'other';
  readonly message: string;
  readonly stepId?: string;
  readonly field?: string;
}

export async function cmdBlueprintValidate(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      json: { type: 'boolean' },
      scope: { type: 'string', multiple: true },
      from: { type: 'string' },
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

  const nameOrId = parsed.positionals[0];
  if (!nameOrId) {
    console.error('error: <name-or-id> required — see `cc-cli blueprint validate --help`');
    process.exit(1);
  }

  const asJson = !!parsed.values.json;
  const corpOpt = parsed.values.corp as string | undefined;
  const scopeHints = parsed.values.scope as string[] | undefined;
  const updatedBy = (parsed.values.from as string | undefined) ?? 'founder';
  const corpRoot = await getCorpRoot(corpOpt);

  // Validate needs to SEE draft blueprints (it's what promotes them),
  // so activeOnly=false. --scope hints (repeatable) thread through to
  // resolveBlueprint AND the fallback scan so collision-case promotion
  // is deterministic — without this, `validate my-bp --scope project:X`
  // would silently validate+promote the corp-scope chit instead of the
  // project-scope draft the caller meant (reviewer catch, PR #173 P2).
  const hit =
    resolveBlueprint(corpRoot, nameOrId, {
      activeOnly: false,
      ...(scopeHints && scopeHints.length > 0
        ? { scopes: scopeHints as ChitScope[] }
        : {}),
    }) ?? fallbackSearchAll(corpRoot, nameOrId, scopeHints);

  if (!hit) {
    emit(asJson, {
      ok: false,
      name: null,
      id: null,
      errorKind: 'not-found',
      message: `blueprint '${nameOrId}' not found`,
    });
    process.exit(1);
  }

  const fields = hit.chit.fields.blueprint;
  const previousStatus = hit.chit.status;

  // Synthesize dummy values for every required (no-default) var.
  // Vars with defaults don't need dummies — mergeBlueprintVars uses
  // the default. Vars with explicit null defaults also don't need
  // dummies (null is a valid resolved value).
  const dummyVars: Record<string, unknown> = {};
  for (const v of fields.vars ?? []) {
    if (v.default === undefined) {
      dummyVars[v.name] = dummyForType(v.type);
    }
  }

  try {
    parseBlueprint(fields, dummyVars);
  } catch (err) {
    if (err instanceof BlueprintVarError) {
      emit(asJson, {
        ok: false,
        name: fields.name,
        id: hit.chit.id,
        errorKind: 'var',
        message: err.message,
      });
      process.exit(2);
    }
    if (err instanceof BlueprintParseError) {
      emit(asJson, {
        ok: false,
        name: fields.name,
        id: hit.chit.id,
        errorKind: 'parse',
        message: err.message,
        ...(err.stepId ? { stepId: err.stepId } : {}),
        ...(err.field ? { field: err.field } : {}),
      });
      process.exit(2);
    }
    // Unexpected error class — surface the message.
    emit(asJson, {
      ok: false,
      name: fields.name,
      id: hit.chit.id,
      errorKind: 'other',
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(2);
  }

  // Parse succeeded. Promote draft → active if needed; no-op if
  // already active or closed (closed blueprints can still be
  // structurally valid but shouldn't be revived by validate alone —
  // that needs explicit re-open via `cc-cli chit update`).
  let newStatus = previousStatus;
  let promoted = false;

  if (previousStatus === 'draft') {
    const scope = chitScopeFromPath(corpRoot, hit.path);
    updateChit(corpRoot, scope, 'blueprint', hit.chit.id, {
      status: 'active',
      updatedBy,
    });
    newStatus = 'active';
    promoted = true;
  }

  const result: ValidateSuccess = {
    ok: true,
    name: fields.name,
    id: hit.chit.id,
    previousStatus,
    newStatus,
    promoted,
  };

  emit(asJson, result);
}

// ─── Helpers ────────────────────────────────────────────────────────

function dummyForType(type: BlueprintVar['type']): string | number | boolean {
  switch (type) {
    case 'string':
      return '';
    case 'int':
      return 0;
    case 'bool':
      return false;
  }
}

/**
 * Fallback scan when resolveBlueprint's targeted lookup misses. Honors
 * --scope hints (if the caller narrowed the search, don't widen past
 * their request) but defaults to all discoverable scopes.
 */
function fallbackSearchAll(
  corpRoot: string,
  nameOrId: string,
  scopeHints?: string[],
): ReturnType<typeof resolveBlueprint> {
  const all = listBlueprintChits(corpRoot, {
    includeNonActive: true,
    ...(scopeHints && scopeHints.length > 0
      ? { scopes: scopeHints as ChitScope[] }
      : {}),
  });
  const match = all.find((cwb) => {
    const bp = cwb.chit.fields.blueprint;
    return bp.name === nameOrId || cwb.chit.id === nameOrId;
  });
  return match ?? null;
}

function emit(asJson: boolean, payload: ValidateSuccess | ValidateFailure): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (payload.ok) {
    if (payload.promoted) {
      console.log(`✓ ${payload.name} validated — promoted draft → active (${payload.id})`);
    } else {
      console.log(`✓ ${payload.name} validated — already ${payload.newStatus}, no change (${payload.id})`);
    }
    return;
  }

  if (payload.errorKind === 'not-found') {
    console.error(`error: ${payload.message}`);
    return;
  }

  console.error(`✗ validation failed [${payload.errorKind}]`);
  if (payload.name) console.error(`  blueprint: ${payload.name} (${payload.id})`);
  console.error(`  ${payload.message}`);
  if (payload.stepId) console.error(`  step:   ${payload.stepId}`);
  if (payload.field) console.error(`  field:  ${payload.field}`);
}
