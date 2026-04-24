import { parseArgs } from 'node:util';
import {
  resolveBlueprint,
  chitScopeFromPath,
  listBlueprintChits,
  type BlueprintStep,
  type BlueprintVar,
  type ChitScope,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

/**
 * `cc-cli blueprint show <name-or-id> [--include-draft] [--json]`
 *
 * Render a blueprint human-readable. Accepts either the blueprint's
 * `name` field or a raw chit id (resolveBlueprint discriminates).
 * Default: active only; `--include-draft` lets the caller see drafts
 * (useful when editing one and wanting to preview before validate).
 *
 * Output sections:
 *   1. Identity header (name, scope, status, origin, id, path)
 *   2. Title + summary metadata
 *   3. Variables table (name, type, default, description)
 *   4. Steps listing (ordered; each step shows its deps, acceptance
 *      criteria, and expanded assignee)
 *   5. Body (the markdown content — the authoring guide + author notes)
 *
 * JSON output dumps the full chit + derived scope field.
 */

const HELP = `Usage: cc-cli blueprint show <name-or-id> [options]

Render a blueprint human-readable. Accepts name OR chit id.

Options:
  --include-draft       Allow drafts (default: active only).
  --json                Machine-readable JSON output.
  --scope <scope>       Preferred scope for name resolution (default:
                        walks all scopes; most-specific wins).
  --corp <name>         Operate on a specific corp (defaults to active).
  --help                Show this help.

Examples:
  cc-cli blueprint show patrol/health-check
  cc-cli blueprint show chit-b-abc12345 --json
  cc-cli blueprint show my-draft --include-draft
`;

export async function cmdBlueprintShow(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      'include-draft': { type: 'boolean' },
      json: { type: 'boolean' },
      scope: { type: 'string', multiple: true },
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
    console.error('error: <name-or-id> required — see `cc-cli blueprint show --help`');
    process.exit(1);
  }

  const includeDraft = !!parsed.values['include-draft'];
  const asJson = !!parsed.values.json;
  const corpOpt = parsed.values.corp as string | undefined;
  const scopeHints = parsed.values.scope as string[] | undefined;

  const corpRoot = await getCorpRoot(corpOpt);

  // Scope resolution: if --scope hints were passed, use those in
  // precedence; otherwise walk every discoverable scope. The lookup
  // doesn't yet support "walk all scopes" as a single call — we mimic
  // by probing corp first, then by listing to find the match. Simpler
  // path for now: let findBlueprintByName default to ['corp']; if it
  // returns null, fall back to a full listBlueprintChits scan.
  const hit = resolveBlueprint(corpRoot, nameOrId, {
    activeOnly: !includeDraft,
    ...(scopeHints && scopeHints.length > 0
      ? { scopes: scopeHints as ChitScope[] }
      : {}),
  }) ?? fallbackSearchAllScopes(corpRoot, nameOrId, includeDraft);

  if (!hit) {
    console.error(`error: blueprint '${nameOrId}' not found`);
    if (!includeDraft) {
      console.error('       (pass --include-draft to search drafts too)');
    }
    process.exit(1);
  }

  const bp = hit.chit.fields.blueprint;
  const scope = chitScopeFromPath(corpRoot, hit.path);

  if (asJson) {
    console.log(
      JSON.stringify(
        { ...hit.chit, scope, path: hit.path, body: hit.body },
        null,
        2,
      ),
    );
    return;
  }

  // ── Header ────────────────────────────────────────────────────────
  console.log(`Blueprint: ${bp.name}`);
  console.log(`  scope:   ${scope}`);
  console.log(`  status:  ${hit.chit.status}`);
  console.log(`  origin:  ${bp.origin}`);
  console.log(`  id:      ${hit.chit.id}`);
  console.log(`  file:    ${hit.path}`);
  if (bp.title) console.log(`  title:   ${bp.title}`);
  if (bp.summary) console.log(`  summary: ${bp.summary}`);

  // ── Variables ────────────────────────────────────────────────────
  if (bp.vars && bp.vars.length > 0) {
    console.log('');
    console.log(`Variables (${bp.vars.length}):`);
    for (const v of bp.vars) {
      console.log('  ' + formatVar(v));
      if (v.description) console.log(`    ${v.description}`);
    }
  }

  // ── Steps ────────────────────────────────────────────────────────
  console.log('');
  console.log(`Steps (${bp.steps.length}):`);
  bp.steps.forEach((step, i) => {
    renderStep(step, i + 1);
  });

  // ── Body (the markdown content) ──────────────────────────────────
  if (hit.body.trim()) {
    console.log('');
    console.log('─'.repeat(60));
    console.log(hit.body.trimEnd());
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * When the caller doesn't specify --scope, we start with the default
 * (['corp']) — if that misses, scan every discoverable scope before
 * giving up. Costs one extra queryChits pass; only runs on miss.
 */
function fallbackSearchAllScopes(
  corpRoot: string,
  nameOrId: string,
  includeDraft: boolean,
): ReturnType<typeof resolveBlueprint> {
  const all = listBlueprintChits(corpRoot, { includeNonActive: includeDraft });
  const match = all.find((cwb) => {
    const bp = cwb.chit.fields.blueprint;
    if (bp.name === nameOrId) return true;
    if (cwb.chit.id === nameOrId) return true;
    return false;
  });
  return match ?? null;
}

function formatVar(v: BlueprintVar): string {
  const parts: string[] = [`${v.name} (${v.type})`];
  if (v.default !== undefined) {
    parts.push(`default: ${JSON.stringify(v.default)}`);
  } else {
    parts.push('required');
  }
  return parts.join('  ');
}

function renderStep(step: BlueprintStep, index: number): void {
  console.log(`  ${index}. ${step.id}`);
  console.log(`     title:    ${step.title}`);
  if (step.assigneeRole !== undefined && step.assigneeRole !== null) {
    console.log(`     role:     ${step.assigneeRole}`);
  } else if (step.assigneeRole === null) {
    console.log(`     role:     (deferred — cast-time --stepRoleOverrides.${step.id})`);
  }
  if (step.dependsOn && step.dependsOn.length > 0) {
    console.log(`     depends:  ${step.dependsOn.join(', ')}`);
  }
  if (step.description) {
    console.log(`     ${step.description}`);
  }
  if (step.acceptanceCriteria && step.acceptanceCriteria.length > 0) {
    console.log(`     accept:`);
    for (const ac of step.acceptanceCriteria) {
      console.log(`       - ${ac}`);
    }
  }
}
