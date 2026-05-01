import { describe, it, expect } from 'vitest';
import {
  parseBlueprint,
  BlueprintParseError,
  type ParsedBlueprint,
} from '../packages/shared/src/blueprint-parser.js';
import { BlueprintVarError } from '../packages/shared/src/blueprint-vars.js';
import type { BlueprintFields } from '../packages/shared/src/types/chit.js';

/**
 * Project 1.8 PR 2 — coverage for the parser (Handlebars expansion
 * over a validated blueprint + caller vars).
 *
 * The parser composes blueprint-vars (merge + coerce) with
 * Handlebars strict-mode expansion. Tests hit:
 *   - happy paths for substitution, conditionals, descriptions,
 *     acceptanceCriteria, assigneeRole
 *   - strict-mode errors (undeclared references throw)
 *   - noEscape: true behavior (HTML-ish chars pass through raw)
 *   - error-propagation from the vars layer
 *   - the frozen varsContext guarantee
 */

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Minimal valid blueprint fields. Accepting Partial overrides so
 * tests pivot one field at a time.
 */
function bp(overrides: Partial<BlueprintFields> = {}): BlueprintFields {
  return {
    name: 'test-bp',
    origin: 'authored',
    steps: [{ id: 's1', title: 'Step One' }],
    ...overrides,
  };
}

// ─── Happy paths ─────────────────────────────────────────────────────

describe('parseBlueprint — happy paths', () => {
  it('parses a blueprint with no vars and no templates', () => {
    const out = parseBlueprint(bp(), {});
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]!.title).toBe('Step One');
    expect(out.varsContext).toEqual({});
  });

  it('expands simple {{var}} substitution in title', () => {
    const out = parseBlueprint(
      bp({
        vars: [{ name: 'who', type: 'string' }],
        steps: [{ id: 's', title: 'Greet {{who}}' }],
      }),
      { who: 'world' },
    );
    expect(out.steps[0]!.title).toBe('Greet world');
  });

  it('expands {{var}} in description, acceptanceCriteria, and assigneeRole', () => {
    const out = parseBlueprint(
      bp({
        vars: [{ name: 'who', type: 'string' }, { name: 'role', type: 'string' }],
        steps: [
          {
            id: 's',
            title: 'T',
            description: 'Hello {{who}}',
            acceptanceCriteria: ['{{who}} responds', '{{who}} confirms'],
            assigneeRole: '{{role}}',
          },
        ],
      }),
      { who: 'toast', role: 'backend-engineer' },
    );
    expect(out.steps[0]!.description).toBe('Hello toast');
    expect(out.steps[0]!.acceptanceCriteria).toEqual(['toast responds', 'toast confirms']);
    expect(out.steps[0]!.assigneeRole).toBe('backend-engineer');
  });

  it('expands {{#if var}} conditional blocks', () => {
    const template = '{{#if urgent}}URGENT: {{/if}}{{title}}';
    const out = parseBlueprint(
      bp({
        vars: [{ name: 'urgent', type: 'bool' }, { name: 'title', type: 'string' }],
        steps: [{ id: 's', title: template }],
      }),
      { urgent: true, title: 'ship it' },
    );
    expect(out.steps[0]!.title).toBe('URGENT: ship it');
  });

  it('omits {{#if}} block when condition is false', () => {
    const template = '{{#if urgent}}URGENT: {{/if}}{{title}}';
    const out = parseBlueprint(
      bp({
        vars: [{ name: 'urgent', type: 'bool', default: false }, { name: 'title', type: 'string' }],
        steps: [{ id: 's', title: template }],
      }),
      { title: 'ship it' },
    );
    expect(out.steps[0]!.title).toBe('ship it');
  });

  it('supports {{#unless var}} for inverse conditionals', () => {
    const out = parseBlueprint(
      bp({
        vars: [{ name: 'silent', type: 'bool' }],
        steps: [{ id: 's', title: '{{#unless silent}}announce{{/unless}}' }],
      }),
      { silent: false },
    );
    expect(out.steps[0]!.title).toBe('announce');
  });

  it('fills in int vars in templates', () => {
    const out = parseBlueprint(
      bp({
        vars: [{ name: 'threshold', type: 'int', default: 5 }],
        steps: [{ id: 's', title: 'Flag stalls > {{threshold}} min' }],
      }),
      {},
    );
    expect(out.steps[0]!.title).toBe('Flag stalls > 5 min');
  });

  it('uses caller overrides over defaults', () => {
    const out = parseBlueprint(
      bp({
        vars: [{ name: 'threshold', type: 'int', default: 5 }],
        steps: [{ id: 's', title: '{{threshold}}' }],
      }),
      { threshold: '10' }, // CLI-shaped string, coerced to int
    );
    expect(out.steps[0]!.title).toBe('10');
  });

  it('preserves top-level blueprint metadata in the parsed output', () => {
    const out = parseBlueprint(
      bp({
        name: 'my-bp',
        title: 'Title',
        summary: 'Summary',
        origin: 'builtin',
        steps: [{ id: 's', title: 'T' }],
      }),
      {},
    );
    expect(out.name).toBe('my-bp');
    expect(out.title).toBe('Title');
    expect(out.summary).toBe('Summary');
    expect(out.origin).toBe('builtin');
  });

  it('preserves step structure (id, dependsOn) verbatim — not templated', () => {
    const out = parseBlueprint(
      bp({
        vars: [{ name: 'x', type: 'string', default: 'should-not-appear' }],
        steps: [
          { id: 's1', title: 'One' },
          { id: 's2', title: 'Two', dependsOn: ['s1'] },
        ],
      }),
      {},
    );
    expect(out.steps[0]!.id).toBe('s1');
    expect(out.steps[1]!.dependsOn).toEqual(['s1']);
  });
});

// ─── noEscape: true ─────────────────────────────────────────────────

describe('parseBlueprint — noEscape behavior (prose, not HTML)', () => {
  it('does NOT escape HTML-ish characters in var values', () => {
    const out = parseBlueprint(
      bp({
        vars: [{ name: 'raw', type: 'string' }],
        steps: [{ id: 's', title: '{{raw}}' }],
      }),
      { raw: 'he said "<hi>" & smiled' },
    );
    expect(out.steps[0]!.title).toBe('he said "<hi>" & smiled');
    // Specifically NOT '&lt;hi&gt;' etc.
    expect(out.steps[0]!.title).not.toContain('&amp;');
    expect(out.steps[0]!.title).not.toContain('&lt;');
  });
});

// ─── Strict-mode error paths ────────────────────────────────────────

describe('parseBlueprint — strict-mode undeclared references', () => {
  it('throws BlueprintParseError when a var is referenced but not declared', () => {
    expect(() =>
      parseBlueprint(
        bp({
          steps: [{ id: 's', title: 'Hello {{undeclared}}' }],
        }),
        {},
      ),
    ).toThrow(BlueprintParseError);
  });

  it('error names the step id and field for fast author debug', () => {
    try {
      parseBlueprint(
        bp({
          steps: [{ id: 'greet-step', title: 'Hello {{nope}}' }],
        }),
        {},
      );
    } catch (err) {
      expect(err).toBeInstanceOf(BlueprintParseError);
      expect((err as BlueprintParseError).stepId).toBe('greet-step');
      expect((err as BlueprintParseError).field).toBe('title');
      expect((err as Error).message).toContain('greet-step');
      expect((err as Error).message).toContain('title');
    }
  });

  it('points at the right field when the error is in acceptanceCriteria', () => {
    try {
      parseBlueprint(
        bp({
          steps: [{ id: 's', title: 'x', acceptanceCriteria: ['fine', '{{missing}}'] }],
        }),
        {},
      );
    } catch (err) {
      expect(err).toBeInstanceOf(BlueprintParseError);
      expect((err as BlueprintParseError).field).toBe('acceptanceCriteria[1]');
    }
  });

  it('points at description when the error is in description', () => {
    try {
      parseBlueprint(
        bp({
          steps: [{ id: 's', title: 'x', description: '{{missing}}' }],
        }),
        {},
      );
    } catch (err) {
      expect((err as BlueprintParseError).field).toBe('description');
    }
  });
});

// ─── Handlebars syntax errors ───────────────────────────────────────

describe('parseBlueprint — Handlebars syntax errors', () => {
  it('throws BlueprintParseError on malformed template', () => {
    expect(() =>
      parseBlueprint(
        bp({
          steps: [{ id: 's', title: '{{#if unclosed' }],
        }),
        {},
      ),
    ).toThrow(BlueprintParseError);
  });
});

// ─── Propagation from blueprint-vars ────────────────────────────────

describe('parseBlueprint — propagates BlueprintVarError from the vars layer', () => {
  it('missing required var throws BlueprintVarError (not ParseError)', () => {
    expect(() =>
      parseBlueprint(
        bp({
          vars: [{ name: 'required', type: 'string' }],
          steps: [{ id: 's', title: 'x' }],
        }),
        {},
      ),
    ).toThrow(BlueprintVarError);
  });

  it('bad coercion in override throws BlueprintVarError (not ParseError)', () => {
    expect(() =>
      parseBlueprint(
        bp({
          vars: [{ name: 'n', type: 'int' }],
          steps: [{ id: 's', title: 'x' }],
        }),
        { n: 'not-a-number' },
      ),
    ).toThrow(BlueprintVarError);
  });
});

// ─── varsContext invariants ─────────────────────────────────────────

describe('parseBlueprint — varsContext', () => {
  it('echoes the resolved vars for audit', () => {
    const out = parseBlueprint(
      bp({
        vars: [
          { name: 'a', type: 'int', default: 1 },
          { name: 'b', type: 'string' },
        ],
        steps: [{ id: 's', title: '{{a}} {{b}}' }],
      }),
      { b: 'hi' },
    );
    expect(out.varsContext).toEqual({ a: 1, b: 'hi' });
  });

  it('varsContext is frozen (Object.freeze)', () => {
    const out: ParsedBlueprint = parseBlueprint(
      bp({
        vars: [{ name: 'x', type: 'string', default: 'y' }],
        steps: [{ id: 's', title: '{{x}}' }],
      }),
      {},
    );
    expect(Object.isFrozen(out.varsContext)).toBe(true);
  });
});
