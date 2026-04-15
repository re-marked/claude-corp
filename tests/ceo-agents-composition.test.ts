import { describe, it, expect } from 'vitest';
import { buildCeoAgents } from '../packages/shared/src/ceo.js';
import { defaultRules } from '../packages/shared/src/templates/rules.js';

/**
 * Regression for v2.1.15: the CEO's AGENTS.md used to be a 7-bullet
 * hand-written string in ceo.ts, completely disconnected from
 * rules.ts. That meant the CEO never got Task Workflow, Red Lines,
 * Anti-Rationalization, or new rules like "Speaking with tool calls"
 * — and the cc-cli refresh command would have silently clobbered
 * the CEO's unique authority content.
 *
 * buildCeoAgents now composes the shared rules template + CEO-
 * specific authority bullets. These tests pin the composition so a
 * future refactor can't silently drop one side.
 */

describe('buildCeoAgents — CEO AGENTS.md composition', () => {
  const openclaw = buildCeoAgents('openclaw');
  const claudeCode = buildCeoAgents('claude-code');

  it('starts with the rules.ts base template', () => {
    expect(openclaw).toMatch(/^# Rules\b/);
    expect(claudeCode).toMatch(/^# Rules\b/);
  });

  it('includes the Task Workflow section', () => {
    expect(openclaw).toContain('## Task Workflow');
    expect(openclaw).toContain('Read TASKS.md');
  });

  it('includes the "Speaking with tool calls" voice rule (the v2.1.15 addition)', () => {
    expect(openclaw).toContain('## Speaking with tool calls');
    expect(openclaw).toContain('reflection happens ONCE');
    expect(claudeCode).toContain('## Speaking with tool calls');
  });

  it('appends CEO Authority bullets AFTER the base rules', () => {
    expect(openclaw).toContain('## CEO Authority');
    // Authority bullets from the legacy ceo.ts content preserved verbatim
    expect(openclaw).toContain('You have full read/write access to all files in the corporation.');
    expect(openclaw).toContain('You can create agents at leader rank or below.');
    expect(openclaw).toContain('Never act against an explicit Founder directive.');
    // CEO Authority appears AFTER the rules content, not before
    const rulesIdx = openclaw.indexOf('## Task Workflow');
    const authIdx = openclaw.indexOf('## CEO Authority');
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(rulesIdx);
  });

  it('reflects the harness in the tools section (openclaw vs claude-code differ)', () => {
    expect(openclaw).toContain('(OpenClaw substrate)');
    expect(claudeCode).toContain('(Claude Code substrate)');
    // Cross-contamination check
    expect(openclaw).not.toContain('(Claude Code substrate)');
    expect(claudeCode).not.toContain('(OpenClaw substrate)');
  });

  it('is a strict superset of defaultRules for rank=master — CEO never loses the base template', () => {
    const base = defaultRules({ rank: 'master', harness: 'openclaw' });
    // Every non-empty line of the base rules appears somewhere in the CEO variant
    const baseLines = base.split('\n').filter((l) => l.trim() !== '');
    for (const line of baseLines) {
      expect(openclaw).toContain(line);
    }
  });
});
