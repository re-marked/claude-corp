import { describe, it, expect } from 'vitest';
import { defaultEnvironment } from '../../packages/shared/src/templates/environment.js';

const CORP = '/tmp/fake-corp';
const AGENT = '/tmp/fake-corp/agents/ceo';

describe('defaultEnvironment', () => {
  describe('legacy positional signature', () => {
    it('(corpRoot, agentDir) returns non-empty environment', () => {
      const output = defaultEnvironment(CORP, AGENT);
      expect(output).toContain('# Environment');
      expect(output).toContain(CORP);
      expect(output).toContain(AGENT);
    });

    it('(corpRoot, agentDir, projectName) adds project section', () => {
      const output = defaultEnvironment(CORP, AGENT, 'alpha');
      expect(output).toContain('## Project');
      expect(output).toContain('Project: alpha');
    });

    it('defaults to openclaw substrate for positional signature', () => {
      const output = defaultEnvironment(CORP, AGENT);
      expect(output).toContain('OpenClaw substrate');
      expect(output).toContain('`exec`');
    });

    it('(corpRoot, agentDir, projectName, harness) accepts harness positionally', () => {
      const output = defaultEnvironment(CORP, AGENT, undefined, 'claude-code');
      expect(output).toContain('Claude Code substrate');
    });
  });

  describe('options-object signature', () => {
    it('accepts opts with corpRoot + agentDir + harness', () => {
      const output = defaultEnvironment({
        corpRoot: CORP,
        agentDir: AGENT,
        harness: 'claude-code',
      });
      expect(output).toContain('Claude Code substrate');
      expect(output).toContain(CORP);
    });

    it('omitted harness in opts defaults to openclaw', () => {
      const output = defaultEnvironment({ corpRoot: CORP, agentDir: AGENT });
      expect(output).toContain('OpenClaw substrate');
    });
  });

  describe('harness-aware tool sections', () => {
    it('claude-code names Claude Code native tools', () => {
      const output = defaultEnvironment({
        corpRoot: CORP,
        agentDir: AGENT,
        harness: 'claude-code',
      });
      // Section header
      expect(output).toContain('## Tools Available (Claude Code substrate)');
      // Tool vocabulary
      expect(output).toContain('`Read`');
      expect(output).toContain('`Bash`');
      expect(output).toContain('`Grep`');
      expect(output).toContain('`Glob`');
      expect(output).toContain('`Task`');
      expect(output).toContain('`TodoWrite`');
      // Negative: no OpenClaw header
      expect(output).not.toContain('## Tools Available (OpenClaw substrate)');
    });

    it('openclaw names OpenClaw tools', () => {
      const output = defaultEnvironment({
        corpRoot: CORP,
        agentDir: AGENT,
        harness: 'openclaw',
      });
      // Section header
      expect(output).toContain('## Tools Available (OpenClaw substrate)');
      // Tool vocabulary
      expect(output).toContain('`read`');
      expect(output).toContain('`exec`');
      expect(output).toContain('`process`');
      expect(output).toContain('`memory_search`');
      // Negative: no Claude Code header (the text 'Claude Code' still
      // appears in the shared cc-cli reference; we check the section
      // header only, which is the harness-specific content).
      expect(output).not.toContain('## Tools Available (Claude Code substrate)');
    });

    it('cc-cli invocation examples differ by harness', () => {
      const cc = defaultEnvironment({ corpRoot: CORP, agentDir: AGENT, harness: 'claude-code' });
      const oc = defaultEnvironment({ corpRoot: CORP, agentDir: AGENT, harness: 'openclaw' });
      expect(cc).toMatch(/Bash\(\{ command: "cc-cli status" \}\)/);
      expect(oc).toMatch(/exec\(\{ command: "cc-cli status" \}\)/);
    });
  });

  describe('cc-cli reference', () => {
    it('includes hire --harness flag documentation', () => {
      const output = defaultEnvironment({ corpRoot: CORP, agentDir: AGENT });
      expect(output).toContain('--harness claude-code');
    });

    it('includes agent set-harness command documentation', () => {
      const output = defaultEnvironment({ corpRoot: CORP, agentDir: AGENT });
      expect(output).toContain('cc-cli agent set-harness');
    });

    it('includes harness diagnostics commands', () => {
      const output = defaultEnvironment({ corpRoot: CORP, agentDir: AGENT });
      expect(output).toContain('cc-cli harness list');
      expect(output).toContain('cc-cli harness health');
    });
  });
});
