import { describe, it, expect } from 'vitest';
import {
  coerceVarValue,
  mergeBlueprintVars,
  BlueprintVarError,
} from '../packages/shared/src/blueprint-vars.js';
import type { BlueprintVar } from '../packages/shared/src/types/chit.js';

/**
 * Project 1.8 PR 2 — coverage for the vars merge + coercion module.
 *
 * Two pure functions: `coerceVarValue` handles one value × one type;
 * `mergeBlueprintVars` composes that across a declared-vars list and
 * caller overrides. Tests hit every coercion branch + every merge
 * precedence rule + every error path.
 */

// ─── coerceVarValue — string type ───────────────────────────────────

describe('coerceVarValue — string type', () => {
  it('passes string values through', () => {
    expect(coerceVarValue('hello', 'string', 'v')).toBe('hello');
    expect(coerceVarValue('', 'string', 'v')).toBe('');
  });

  it('stringifies numbers for programmatic-caller convenience', () => {
    expect(coerceVarValue(5, 'string', 'v')).toBe('5');
    expect(coerceVarValue(3.14, 'string', 'v')).toBe('3.14');
  });

  it('stringifies booleans', () => {
    expect(coerceVarValue(true, 'string', 'v')).toBe('true');
    expect(coerceVarValue(false, 'string', 'v')).toBe('false');
  });

  it('null and undefined pass through as null', () => {
    expect(coerceVarValue(null, 'string', 'v')).toBeNull();
    expect(coerceVarValue(undefined, 'string', 'v')).toBeNull();
  });
});

// ─── coerceVarValue — int type ──────────────────────────────────────

describe('coerceVarValue — int type', () => {
  it('accepts Number.isInteger values verbatim', () => {
    expect(coerceVarValue(5, 'int', 'v')).toBe(5);
    expect(coerceVarValue(0, 'int', 'v')).toBe(0);
    expect(coerceVarValue(-42, 'int', 'v')).toBe(-42);
  });

  it('rejects non-integer numbers (float)', () => {
    expect(() => coerceVarValue(3.14, 'int', 'v')).toThrow(BlueprintVarError);
    expect(() => coerceVarValue(3.14, 'int', 'v')).toThrow(/non-integer/);
  });

  it('parses base-10 integer strings', () => {
    expect(coerceVarValue('5', 'int', 'v')).toBe(5);
    expect(coerceVarValue('-10', 'int', 'v')).toBe(-10);
    expect(coerceVarValue('0', 'int', 'v')).toBe(0);
  });

  it('trims whitespace then parses', () => {
    expect(coerceVarValue('  5  ', 'int', 'v')).toBe(5);
  });

  it('rejects float strings (no silent truncation)', () => {
    expect(() => coerceVarValue('3.14', 'int', 'v')).toThrow(BlueprintVarError);
    expect(() => coerceVarValue('5.0', 'int', 'v')).toThrow(BlueprintVarError);
  });

  it('rejects hex strings (only base-10)', () => {
    expect(() => coerceVarValue('0x10', 'int', 'v')).toThrow(BlueprintVarError);
  });

  it('rejects non-numeric strings', () => {
    expect(() => coerceVarValue('abc', 'int', 'v')).toThrow(BlueprintVarError);
    expect(() => coerceVarValue('5abc', 'int', 'v')).toThrow(BlueprintVarError);
  });

  it('rejects empty / whitespace-only strings', () => {
    expect(() => coerceVarValue('', 'int', 'v')).toThrow(BlueprintVarError);
    expect(() => coerceVarValue('   ', 'int', 'v')).toThrow(BlueprintVarError);
  });

  it('rejects booleans (no implicit true→1)', () => {
    expect(() => coerceVarValue(true, 'int', 'v')).toThrow(BlueprintVarError);
  });

  it('null passes through', () => {
    expect(coerceVarValue(null, 'int', 'v')).toBeNull();
  });

  it('error carries the varName for CLI surfacing', () => {
    try {
      coerceVarValue('abc', 'int', 'threshold_min');
    } catch (err) {
      expect(err).toBeInstanceOf(BlueprintVarError);
      expect((err as BlueprintVarError).varName).toBe('threshold_min');
      expect((err as Error).message).toContain('threshold_min');
    }
  });
});

// ─── coerceVarValue — bool type ─────────────────────────────────────

describe('coerceVarValue — bool type', () => {
  it('accepts boolean values verbatim', () => {
    expect(coerceVarValue(true, 'bool', 'v')).toBe(true);
    expect(coerceVarValue(false, 'bool', 'v')).toBe(false);
  });

  it('accepts "true"/"false" strings (case-insensitive)', () => {
    expect(coerceVarValue('true', 'bool', 'v')).toBe(true);
    expect(coerceVarValue('FALSE', 'bool', 'v')).toBe(false);
    expect(coerceVarValue('True', 'bool', 'v')).toBe(true);
  });

  it('accepts "1"/"0" strings', () => {
    expect(coerceVarValue('1', 'bool', 'v')).toBe(true);
    expect(coerceVarValue('0', 'bool', 'v')).toBe(false);
  });

  it('accepts 1/0 numbers', () => {
    expect(coerceVarValue(1, 'bool', 'v')).toBe(true);
    expect(coerceVarValue(0, 'bool', 'v')).toBe(false);
  });

  it('trims whitespace in string inputs', () => {
    expect(coerceVarValue('  true  ', 'bool', 'v')).toBe(true);
  });

  it('rejects "yes"/"no" and other truthy-looking strings', () => {
    expect(() => coerceVarValue('yes', 'bool', 'v')).toThrow(BlueprintVarError);
    expect(() => coerceVarValue('no', 'bool', 'v')).toThrow(BlueprintVarError);
    expect(() => coerceVarValue('t', 'bool', 'v')).toThrow(BlueprintVarError);
  });

  it('rejects numbers other than 0/1', () => {
    expect(() => coerceVarValue(2, 'bool', 'v')).toThrow(BlueprintVarError);
    expect(() => coerceVarValue(-1, 'bool', 'v')).toThrow(BlueprintVarError);
  });

  it('null passes through', () => {
    expect(coerceVarValue(null, 'bool', 'v')).toBeNull();
  });
});

// ─── mergeBlueprintVars ─────────────────────────────────────────────

describe('mergeBlueprintVars', () => {
  it('empty declared + empty overrides → empty result', () => {
    expect(mergeBlueprintVars([], {})).toEqual({});
    expect(mergeBlueprintVars(undefined, {})).toEqual({});
  });

  it('declared with defaults, no overrides → defaults win', () => {
    const declared: BlueprintVar[] = [
      { name: 'threshold', type: 'int', default: 5 },
      { name: 'label', type: 'string', default: 'hi' },
    ];
    expect(mergeBlueprintVars(declared, {})).toEqual({ threshold: 5, label: 'hi' });
  });

  it('override wins over default', () => {
    const declared: BlueprintVar[] = [{ name: 'threshold', type: 'int', default: 5 }];
    expect(mergeBlueprintVars(declared, { threshold: 10 })).toEqual({ threshold: 10 });
  });

  it('coerces CLI-shaped string overrides to declared types', () => {
    const declared: BlueprintVar[] = [
      { name: 'n', type: 'int', default: 0 },
      { name: 'enabled', type: 'bool', default: false },
    ];
    const merged = mergeBlueprintVars(declared, { n: '42', enabled: 'true' });
    expect(merged).toEqual({ n: 42, enabled: true });
  });

  it('throws BlueprintVarError on required var with no default and no override', () => {
    const declared: BlueprintVar[] = [{ name: 'required_thing', type: 'string' }];
    try {
      mergeBlueprintVars(declared, {});
    } catch (err) {
      expect(err).toBeInstanceOf(BlueprintVarError);
      expect((err as BlueprintVarError).varName).toBe('required_thing');
      expect((err as Error).message).toContain('required_thing');
      expect((err as Error).message).toContain('--vars');
    }
  });

  it('required var + override works', () => {
    const declared: BlueprintVar[] = [{ name: 'must_set', type: 'string' }];
    expect(mergeBlueprintVars(declared, { must_set: 'hi' })).toEqual({ must_set: 'hi' });
  });

  it('silently ignores extras in overrides (common-vars-file reuse pattern)', () => {
    const declared: BlueprintVar[] = [{ name: 'n', type: 'int', default: 5 }];
    const merged = mergeBlueprintVars(declared, { n: 10, extra: 'ignored' });
    expect(merged).toEqual({ n: 10 });
    expect(merged).not.toHaveProperty('extra');
  });

  it('coercion failure on override propagates as BlueprintVarError', () => {
    const declared: BlueprintVar[] = [{ name: 'n', type: 'int' }];
    expect(() => mergeBlueprintVars(declared, { n: 'abc' })).toThrow(BlueprintVarError);
  });

  it('null default is explicit null in result', () => {
    const declared: BlueprintVar[] = [{ name: 'note', type: 'string', default: null }];
    expect(mergeBlueprintVars(declared, {})).toEqual({ note: null });
  });

  it('caller override with explicit null produces null in result', () => {
    const declared: BlueprintVar[] = [{ name: 'note', type: 'string', default: 'x' }];
    expect(mergeBlueprintVars(declared, { note: null })).toEqual({ note: null });
  });
});
