/**
 * Blueprint parser — Project 1.8 PR 2.
 *
 * Expands a validated blueprint chit against a caller vars context,
 * producing a ParsedBlueprint where every {{handlebars}} reference
 * has been resolved to concrete text. The cast primitive consumes
 * ParsedBlueprint directly — it doesn't know about Handlebars.
 *
 * Pipeline:
 *
 *   BlueprintFields (from chit) + caller vars
 *         │
 *         │  mergeBlueprintVars (defaults + overrides, coerced)
 *         ▼
 *   Record<varName, value>           ← Handlebars context
 *         │
 *         │  Handlebars.compile(template, strict: true)(context)
 *         ▼
 *   ParsedBlueprint                  ← ready for cast
 *
 * Strict mode is load-bearing: undeclared var references throw at
 * render time rather than silently rendering as empty string. We
 * translate the opaque Handlebars error into a BlueprintParseError
 * that names the step id + field so the author sees exactly where
 * the reference is.
 *
 * Pure: no I/O.
 *
 * ### What gets templated
 *
 * `title`, `description`, each `acceptanceCriteria` item, `assigneeRole`
 *  — author-facing prose that benefits from variable substitution.
 *
 * `id`, `dependsOn` — NOT templated. Step ids are static structural
 * identifiers; templating them would break the DAG integrity guaranteed
 * at write time by the chit-type validator. Dependencies are static
 * refs; templating them would produce dynamic step counts which our
 * var schema (string/int/bool only) can't coherently express anyway.
 */

import Handlebars from 'handlebars';
import type { BlueprintFields, BlueprintStep } from './types/chit.js';
import { mergeBlueprintVars, type BlueprintVarValue } from './blueprint-vars.js';

// ─── Error class ────────────────────────────────────────────────────

/**
 * Raised on blueprint parse failures — Handlebars syntax errors, strict-
 * mode undeclared references, anything that couldn't be resolved.
 * Carries step id + field name so CLI / UI can point at the exact
 * location without requiring the caller to re-walk the blueprint.
 *
 * Distinct from BlueprintVarError (which is about caller-vars coercion
 * or missing required declarations) — that one is raised before we
 * reach Handlebars at all.
 */
export class BlueprintParseError extends Error {
  constructor(
    message: string,
    public readonly stepId?: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'BlueprintParseError';
  }
}

// ─── Parsed shape ────────────────────────────────────────────────────

/**
 * A single step after Handlebars expansion. Readonly — ParsedBlueprint
 * is a snapshot tied to one specific vars context. Re-parsing with a
 * different context produces a different ParsedBlueprint.
 *
 * Shape mirrors BlueprintStep minus the optional markers and with
 * non-optional defaults — `dependsOn` and `acceptanceCriteria` both
 * coalesce to `[]` when absent, `description` and `assigneeRole` to
 * `null` — so the cast primitive doesn't have to re-pattern-match
 * optionality on every step.
 */
export interface ParsedBlueprintStep {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly dependsOn: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly assigneeRole: string | null;
}

/**
 * A blueprint fully resolved against a specific vars context. Cast
 * consumes this directly — no Handlebars awareness needed downstream.
 *
 * `varsContext` is echoed for observability (cast-logs / audit trails
 * can show exactly what vars were bound). Frozen so consumers can't
 * mutate and corrupt the snapshot.
 */
export interface ParsedBlueprint {
  readonly name: string;
  readonly origin: 'authored' | 'builtin';
  readonly title: string | null;
  readonly summary: string | null;
  readonly steps: readonly ParsedBlueprintStep[];
  readonly varsContext: Readonly<Record<string, BlueprintVarValue>>;
}

// ─── Parser ──────────────────────────────────────────────────────────

/**
 * Parse a blueprint's fields against caller-provided vars. Returns a
 * fully-expanded ParsedBlueprint ready for cast, or throws on any
 * failure (missing var, coercion mismatch, template syntax, undeclared
 * reference).
 *
 * Callers:
 *   - blueprint-cast (wraps parseBlueprint + chit creation)
 *   - cc-cli blueprint validate (PR 3) — runs parseBlueprint in a
 *     dry-run mode to surface every author error before any chit writes
 *
 * The blueprint fields must already satisfy the chit-type validator
 * from PR 1 (structural invariants — step id uniqueness, DAG acyclic,
 * format constraints, etc.). This parser adds the template-resolution
 * layer on top.
 */
export function parseBlueprint(
  fields: BlueprintFields,
  callerVars: Record<string, unknown>,
): ParsedBlueprint {
  // 1. Resolve vars context. May throw BlueprintVarError.
  const context = mergeBlueprintVars(fields.vars, callerVars);

  // 2. Expand every templated string in every step. Collects all
  //    failures at the first occurrence — stop-on-first is fine
  //    because most author errors cascade (one bad var means most
  //    refs to it fail) and the first error is the one they'll fix.
  const expandedSteps: ParsedBlueprintStep[] = fields.steps.map((step) =>
    expandStep(step, context),
  );

  return {
    name: fields.name,
    origin: fields.origin,
    title: fields.title ?? null,
    summary: fields.summary ?? null,
    steps: expandedSteps,
    varsContext: Object.freeze({ ...context }),
  };
}

// ─── Internals ───────────────────────────────────────────────────────

function expandStep(
  step: BlueprintStep,
  context: Record<string, BlueprintVarValue>,
): ParsedBlueprintStep {
  return {
    id: step.id,
    title: expand(step.title, context, step.id, 'title'),
    description:
      step.description == null
        ? null
        : expand(step.description, context, step.id, 'description'),
    // dependsOn is NOT templated — see module docstring. Array coerced
    // to readonly empty when absent so downstream consumers don't
    // pattern-match on undefined.
    dependsOn: step.dependsOn ?? [],
    acceptanceCriteria: (step.acceptanceCriteria ?? []).map((ac, i) =>
      expand(ac, context, step.id, `acceptanceCriteria[${i}]`),
    ),
    assigneeRole:
      step.assigneeRole == null
        ? null
        : expand(step.assigneeRole, context, step.id, 'assigneeRole'),
  };
}

/**
 * Handlebars expansion for a single templated string. Strict mode
 * ensures undeclared references throw. noEscape=true prevents the
 * default HTML-oriented escaping of `<`, `>`, `&`, `"`, `'` — our
 * templates produce prose (Task chit strings), not HTML.
 *
 * Two distinct error classes we translate:
 *   - compile-time: Handlebars syntax errors (unbalanced `{{`, unknown
 *     block-helper, etc.) surface from `Handlebars.compile`.
 *   - render-time: strict-mode undeclared references surface from the
 *     compiled function's invocation.
 *
 * Both become BlueprintParseError with the step + field location.
 */
function expand(
  template: string,
  context: Record<string, BlueprintVarValue>,
  stepId: string,
  field: string,
): string {
  let compiled: HandlebarsTemplateDelegate;
  try {
    compiled = Handlebars.compile(template, { strict: true, noEscape: true });
  } catch (err) {
    throw new BlueprintParseError(
      `Handlebars syntax error in step '${stepId}' field '${field}': ${(err as Error).message}`,
      stepId,
      field,
    );
  }
  try {
    return compiled(context);
  } catch (err) {
    throw new BlueprintParseError(
      `Handlebars render error in step '${stepId}' field '${field}': ${(err as Error).message}`,
      stepId,
      field,
    );
  }
}
