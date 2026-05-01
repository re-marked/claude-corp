/**
 * Blueprint variable merging + coercion — Project 1.8 PR 2.
 *
 * CLI argument parsing produces `Record<string, string>` (every value
 * arrives as a string because shells are string-typed). But blueprint
 * vars are `'string' | 'int' | 'bool'`. Cast can't just pass raw
 * strings to Handlebars — a blueprint step template like
 * `"Flag stalls > {{threshold_min}} min"` where `threshold_min` is an
 * int var needs numeric context so downstream math helpers don't
 * concatenate "5" instead of adding 5.
 *
 * This module lives in the gap between CLI-shaped input and
 * Handlebars-shaped output:
 *
 *   CLI → { threshold_min: "5", dry_run: "true" }
 *              ↓  mergeBlueprintVars + declared vars with types
 *   Handlebars ← { threshold_min: 5, dry_run: true }
 *
 * Pure module — no I/O, no Handlebars dependency. Tests cover every
 * coercion branch and the merge precedence.
 */

import type { BlueprintVar } from './types/chit.js';

// ─── Error class ────────────────────────────────────────────────────

/**
 * Thrown on var-merge + coercion failures. Carries `varName` so
 * callers can surface the offending variable precisely (CLI can
 * point at `--vars <name>=...` in its error message).
 */
export class BlueprintVarError extends Error {
  constructor(message: string, public readonly varName: string) {
    super(message);
    this.name = 'BlueprintVarError';
  }
}

// ─── Coercion ───────────────────────────────────────────────────────

/**
 * The fully-resolved value shape a var can hold after coercion. Null
 * is reached only when the caller explicitly passed null (signaling
 * "no value") — coercion never produces null on its own.
 */
export type BlueprintVarValue = string | number | boolean | null;

/**
 * Coerce one input value to the declared var type. Strings from the
 * CLI are the common case; we also handle bool/number inputs for
 * direct programmatic callers that don't stringify.
 *
 * Null and undefined pass through as null — signals "explicit no
 * value." (Distinct from "variable absent from overrides," which
 * mergeBlueprintVars catches before calling this.)
 *
 * Coercion is STRICT — we reject anything ambiguous rather than
 * guessing. `"yes"` for a bool var throws; `"5.0"` for an int var
 * throws; `"0x10"` for an int var throws. The principle: if the
 * author wrote the wrong thing, tell them at cast time, loudly.
 */
export function coerceVarValue(
  value: unknown,
  type: BlueprintVar['type'],
  varName: string,
): BlueprintVarValue {
  if (value === null || value === undefined) return null;

  switch (type) {
    case 'string':
      // CLI strings pass-through. Non-strings get String() so programmatic
      // callers can pass numbers/bools directly; conversion is
      // unambiguous (5 → "5", true → "true").
      return String(value);

    case 'int':
      if (typeof value === 'number') {
        if (!Number.isInteger(value)) {
          throw new BlueprintVarError(
            `var '${varName}' expects int but got non-integer number ${value}`,
            varName,
          );
        }
        return value;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        // Base-10 integer only. Reject hex ('0x10'), floats ('5.0'),
        // empty strings, leading zeros are harmless, whitespace-only,
        // and anything else weird. The parseInt-forgiveness-problem
        // ("5abc" → 5) is exactly the silent data-corruption we want
        // to avoid.
        if (!/^-?\d+$/.test(trimmed)) {
          throw new BlueprintVarError(
            `var '${varName}' expects int but got string ${JSON.stringify(value)} (not a base-10 integer)`,
            varName,
          );
        }
        return Number.parseInt(trimmed, 10);
      }
      throw new BlueprintVarError(
        `var '${varName}' expects int but got ${typeof value}: ${JSON.stringify(value)}`,
        varName,
      );

    case 'bool':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === 'true' || s === '1') return true;
        if (s === 'false' || s === '0') return false;
        throw new BlueprintVarError(
          `var '${varName}' expects bool but got string ${JSON.stringify(value)} (expected "true"|"false"|"1"|"0")`,
          varName,
        );
      }
      if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
        throw new BlueprintVarError(
          `var '${varName}' expects bool but got number ${value} (expected 0 or 1)`,
          varName,
        );
      }
      throw new BlueprintVarError(
        `var '${varName}' expects bool but got ${typeof value}: ${JSON.stringify(value)}`,
        varName,
      );
  }
}

// ─── Merge ──────────────────────────────────────────────────────────

/**
 * Merge declared defaults with caller overrides into a fully-resolved
 * vars map. Caller overrides win; missing values fall back to the
 * declared default; a declared var with no default AND no override
 * throws BlueprintVarError with a message that tells the caller how
 * to fix it.
 *
 * Extras in `callerOverrides` (keys that aren't in `declared`) are
 * silently ignored. Rationale: a caller reusing a common vars map
 * across multiple blueprints shouldn't be forced to prune every
 * blueprint's unused keys. If a CLI-layer caller wants stricter
 * behavior, they can diff keys themselves before calling this — the
 * Handlebars strict-mode pass in blueprint-parser will catch
 * references to undeclared vars independently.
 *
 * Every value flows through `coerceVarValue` regardless of whether
 * it came from a default or an override — ensures the returned map
 * is uniformly type-coherent and ready for Handlebars context.
 */
export function mergeBlueprintVars(
  declared: readonly BlueprintVar[] | undefined,
  callerOverrides: Record<string, unknown>,
): Record<string, BlueprintVarValue> {
  const out: Record<string, BlueprintVarValue> = {};
  const varList = declared ?? [];

  for (const decl of varList) {
    const hasOverride = Object.prototype.hasOwnProperty.call(callerOverrides, decl.name);

    if (hasOverride) {
      out[decl.name] = coerceVarValue(callerOverrides[decl.name], decl.type, decl.name);
    } else if (decl.default !== undefined) {
      // PR 1 validator already ensured `decl.default` matches `decl.type`
      // (or is null). Coerce for uniformity — noop for matching types,
      // null passes through.
      out[decl.name] = coerceVarValue(decl.default, decl.type, decl.name);
    } else {
      throw new BlueprintVarError(
        `var '${decl.name}' is required (no default declared) — pass via --vars ${decl.name}=value`,
        decl.name,
      );
    }
  }

  return out;
}
