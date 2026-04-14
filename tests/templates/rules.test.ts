import { describe, it, expect } from 'vitest';
import { defaultRules } from '../../packages/shared/src/templates/rules.js';

describe('defaultRules', () => {
  describe('legacy string signature (backwards compat)', () => {
    it('accepts a rank string and returns non-empty rules', () => {
      const output = defaultRules('worker');
      expect(output).toContain('# Rules');
      expect(output).toContain('non-negotiable');
    });

    it('defaults to openclaw-style tools for string signature', () => {
      const output = defaultRules('worker');
      expect(output).toContain('OpenClaw substrate');
      expect(output).toContain('`exec`');
    });

    it('leader rank adds responsibilities section', () => {
      const leader = defaultRules('leader');
      const worker = defaultRules('worker');
      expect(leader).toContain('Leader Responsibilities');
      expect(worker).not.toContain('Leader Responsibilities');
    });
  });

  describe('options-object signature', () => {
    it('accepts opts with rank + harness', () => {
      const output = defaultRules({ rank: 'worker', harness: 'claude-code' });
      expect(output).toContain('# Rules');
    });

    it('omitted harness defaults to openclaw', () => {
      const output = defaultRules({ rank: 'worker' });
      expect(output).toContain('OpenClaw substrate');
    });
  });

  describe('harness-aware tool sections', () => {
    it('claude-code names Claude Code native tools', () => {
      const output = defaultRules({ rank: 'worker', harness: 'claude-code' });
      expect(output).toContain('Claude Code substrate');
      expect(output).toContain('`Read`');
      expect(output).toContain('`Write`');
      expect(output).toContain('`Edit`');
      expect(output).toContain('`Bash`');
      expect(output).toContain('`Grep`');
      expect(output).toContain('`Glob`');
      expect(output).toContain('`TodoWrite`');
      expect(output).not.toContain('OpenClaw substrate');
      // cc-cli via Bash
      expect(output).toMatch(/Bash.*cc-cli/s);
    });

    it('openclaw names OpenClaw-style tools', () => {
      const output = defaultRules({ rank: 'worker', harness: 'openclaw' });
      expect(output).toContain('OpenClaw substrate');
      expect(output).toContain('`read`');
      expect(output).toContain('`exec`');
      expect(output).toContain('`process`');
      expect(output).toContain('`memory_search`');
      expect(output).toContain('`sessions_send`');
      expect(output).toContain('`subagents`');
      expect(output).not.toContain('Claude Code substrate');
      // cc-cli via exec
      expect(output).toMatch(/exec.*cc-cli/s);
    });
  });

  describe('harness-agnostic content', () => {
    it('Task Workflow section is identical across harnesses', () => {
      const a = defaultRules({ rank: 'worker', harness: 'claude-code' });
      const b = defaultRules({ rank: 'worker', harness: 'openclaw' });
      const extractSection = (s: string, header: string) => {
        const start = s.indexOf(header);
        const nextHeader = s.indexOf('\n## ', start + header.length);
        return s.slice(start, nextHeader === -1 ? undefined : nextHeader);
      };
      expect(extractSection(a, '## Task Workflow')).toBe(extractSection(b, '## Task Workflow'));
    });

    it('Anti-Rationalization section stays the same across harnesses', () => {
      const a = defaultRules({ rank: 'worker', harness: 'claude-code' });
      const b = defaultRules({ rank: 'worker', harness: 'openclaw' });
      expect(a).toContain('## Anti-Rationalization');
      expect(b).toContain('## Anti-Rationalization');
      // The content under both should match literally
      const pattern = /## Anti-Rationalization[\s\S]*?(?=\n## |\n$)/;
      const aMatch = a.match(pattern);
      const bMatch = b.match(pattern);
      expect(aMatch).toBeTruthy();
      expect(bMatch).toBeTruthy();
      expect(aMatch![0]).toBe(bMatch![0]);
    });

    it('Red Lines section stays the same across harnesses', () => {
      const a = defaultRules({ rank: 'worker', harness: 'claude-code' });
      const b = defaultRules({ rank: 'worker', harness: 'openclaw' });
      const pattern = /## Red Lines[\s\S]*?(?=\n## |\n$)/;
      expect(a.match(pattern)![0]).toBe(b.match(pattern)![0]);
    });
  });
});
