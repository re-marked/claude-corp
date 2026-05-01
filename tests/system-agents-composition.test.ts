import { describe, it, expect } from 'vitest';
import { defaultRules } from '../packages/shared/src/templates/rules.js';
import { buildHeraldRules } from '../packages/daemon/src/herald.js';
import { buildJanitorRules } from '../packages/daemon/src/janitor.js';
import { buildWardenRules } from '../packages/daemon/src/warden.js';
import { buildPlannerRules } from '../packages/daemon/src/planner.js';

/**
 * Regression for v2.1.17: system agents (Failsafe, Herald, Janitor,
 * Warden, Planner) used to ship hand-written agentsContent that
 * REPLACED defaultRules entirely. Net effect: every corp-wide rule
 * landed in defaultRules (Speaking-in-channels, Anti-Rationalization,
 * Red Lines, Task Workflow) was invisible to system agents. The
 * Failsafe loop Mark hit at 14:38 today is the lived consequence —
 * Failsafe didn't know its reply IS the channel post because no rule
 * told it.
 *
 * Each system agent now exports buildXxxRules(harness) that composes
 * defaultRules + role bullets. These tests pin three properties per
 * agent so a future refactor can't silently regress to replacement-
 * mode:
 *
 *   1. Output is a strict superset of defaultRules (every line of
 *      the base template appears in the agent's AGENTS.md)
 *   2. The role-specific section is present (so we didn't accidentally
 *      ship bare defaultRules either)
 *   3. The base content appears BEFORE the role section, matching the
 *      composition order (rules come first, role bullets append after)
 */

interface AgentSpec {
  name: string;
  rank: 'worker' | 'leader';
  build: (h: 'openclaw' | 'claude-code') => string;
  /** A distinctive snippet that proves the role section is present. */
  rolePhrase: string;
  /** The H2 heading marking the start of the role section. */
  roleHeading: string;
}

const SYSTEM_AGENTS: AgentSpec[] = [
  { name: 'Herald',   rank: 'worker', build: buildHeraldRules,   rolePhrase: 'corp\'s narrator', roleHeading: '## Herald Narrator Role' },
  { name: 'Janitor',  rank: 'worker', build: buildJanitorRules,  rolePhrase: 'corp\'s git specialist', roleHeading: '## Janitor Git-Merge Role' },
  { name: 'Warden',   rank: 'worker', build: buildWardenRules,   rolePhrase: 'corp\'s quality gate', roleHeading: '## Warden Quality-Gate Role' },
  { name: 'Planner',  rank: 'leader', build: buildPlannerRules,  rolePhrase: 'corp\'s deep thinker', roleHeading: '## Planner Deep-Thinker Role' },
];

describe('system agents — AGENTS.md composition', () => {
  for (const agent of SYSTEM_AGENTS) {
    describe(agent.name, () => {
      const openclaw = agent.build('openclaw');
      const claudeCode = agent.build('claude-code');

      it('starts with the rules.ts base template', () => {
        expect(openclaw).toMatch(/^# Rules\b/);
        expect(claudeCode).toMatch(/^# Rules\b/);
      });

      it('contains the corp-wide voice rule (the v2.1.15 addition)', () => {
        expect(openclaw).toContain('## Speaking with tool calls');
      });

      it('contains the v2.1.17 channels rule — the bug Mark caught', () => {
        expect(openclaw).toContain('## Speaking in channels');
        expect(openclaw).toContain('Your reply text IS the post');
      });

      it('appends role section AFTER the base rules', () => {
        const rulesIdx = openclaw.indexOf('## Task Workflow');
        const roleIdx = openclaw.indexOf(agent.roleHeading);
        expect(rulesIdx).toBeGreaterThan(-1);
        expect(roleIdx).toBeGreaterThan(rulesIdx);
        expect(openclaw).toContain(agent.rolePhrase);
      });

      it('reflects harness in tools section (openclaw vs claude-code differ)', () => {
        expect(openclaw).toContain('(OpenClaw substrate)');
        expect(claudeCode).toContain('(Claude Code substrate)');
        expect(openclaw).not.toContain('(Claude Code substrate)');
        expect(claudeCode).not.toContain('(OpenClaw substrate)');
      });

      it('is a strict superset of defaultRules — agent never loses the base', () => {
        const base = defaultRules({ rank: agent.rank, harness: 'openclaw' });
        const baseLines = base.split('\n').filter((l) => l.trim() !== '');
        for (const line of baseLines) {
          expect(openclaw).toContain(line);
        }
      });
    });
  }

  it('Janitor role section no longer instructs cc-cli send (contradicts the channels rule)', () => {
    // Specific guard against the contradiction Mark almost hit:
    // Janitor's old role told it to "post to #logs via cc-cli send"
    // while the new rule says agents must NOT use cc-cli send.
    // The base rules section legitimately mentions cc-cli send (in
    // the prohibition), so check ONLY the role-specific suffix.
    const janitor = buildJanitorRules('openclaw');
    const roleStart = janitor.indexOf('## Janitor Git-Merge Role');
    expect(roleStart).toBeGreaterThan(-1);
    const roleSection = janitor.slice(roleStart);
    expect(roleSection).not.toMatch(/cc-cli send/);
  });
});
