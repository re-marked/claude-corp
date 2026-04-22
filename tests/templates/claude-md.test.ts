import { describe, it, expect } from 'vitest';
import { buildClaudeMd } from '../../packages/shared/src/templates/claude-md.js';

describe('buildClaudeMd', () => {
  describe('heading', () => {
    it('places display name in the "I am <Name>" frontispiece', () => {
      expect(buildClaudeMd({ displayName: 'CEO' })).toContain('# I am CEO');
      expect(buildClaudeMd({ displayName: 'Herald' })).toContain('# I am Herald');
      expect(buildClaudeMd({ displayName: 'Lead Coder' })).toContain('# I am Lead Coder');
    });
  });

  describe('SOUL embodiment preamble', () => {
    it('includes the verbatim OpenClaw phrasing so the agent embodies SOUL', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).toContain(
        "Embody SOUL.md's persona and tone. Avoid stiff, generic replies; follow its\nguidance unless higher-priority instructions override it."
      );
    });

    it('reminds the agent AGENTS.md constraints are non-negotiable', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).toContain('non-negotiable constraints');
    });

    it('tells the agent to check STATUS/INBOX/TASKS at the start of every turn', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).toMatch(/STATUS\.md.*INBOX\.md.*TASKS\.md/);
      expect(output).toMatch(/start of every turn/);
    });
  });

  describe('@imports', () => {
    it('imports all always-on identity files', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).toContain('@./SOUL.md');
      expect(output).toContain('@./IDENTITY.md');
      expect(output).toContain('@./AGENTS.md');
    });

    it('imports the first-run BOOTSTRAP file', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).toContain('@./BOOTSTRAP.md');
    });

    it('imports tools + founder', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).toContain('@./TOOLS.md');
      expect(output).toContain('@./USER.md');
    });

    it('imports MEMORY index + HEARTBEAT', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).toContain('@./MEMORY.md');
      expect(output).toContain('@./HEARTBEAT.md');
    });

    it('imports live operational state', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).toContain('@./STATUS.md');
      expect(output).toContain('@./INBOX.md');
      expect(output).toContain('@./TASKS.md');
    });

    it('does NOT @import BRAIN, observations, or WORKLOG (they stay reactive)', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).not.toMatch(/@\.\/BRAIN/);
      expect(output).not.toMatch(/@\.\/observations/);
      expect(output).not.toMatch(/@\.\/WORKLOG\.md/);
    });
  });

  describe('read-on-demand footer', () => {
    it('lists BRAIN, observations (chit-backed), and WORKLOG with one-liner descriptions', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).toContain('## Read on demand');
      expect(output).toContain('BRAIN/*.md');
      // Post-0.5: observations live as chits under chits/observation/.
      expect(output).toContain('chits/observation');
      expect(output).toContain('WORKLOG.md');
    });

    it('explains to use the Read tool reactively', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).toContain('Read` tool');
    });

    it('teaches the MEMORY.md wikilinks pattern for BRAIN access', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      expect(output).toMatch(/MEMORY\.md.*wikilinks/);
    });
  });

  describe('section ordering', () => {
    it('heading → preamble → identity → bootstrap → tools+founder → memory index → wake cycle → current state → read-on-demand', () => {
      const output = buildClaudeMd({ displayName: 'CEO' });
      const idxHeading = output.indexOf('# I am');
      const idxIdentity = output.indexOf('## Identity');
      const idxBootstrap = output.indexOf('## First-run');
      const idxTools = output.indexOf('## Tools & founder');
      const idxMemory = output.indexOf('## Memory index');
      const idxWake = output.indexOf('## Wake cycle');
      const idxCurrent = output.indexOf('## Current state');
      const idxReactive = output.indexOf('## Read on demand');

      // Every section present
      expect(idxHeading).toBeGreaterThan(-1);
      expect(idxIdentity).toBeGreaterThan(-1);
      expect(idxBootstrap).toBeGreaterThan(-1);
      expect(idxTools).toBeGreaterThan(-1);
      expect(idxMemory).toBeGreaterThan(-1);
      expect(idxWake).toBeGreaterThan(-1);
      expect(idxCurrent).toBeGreaterThan(-1);
      expect(idxReactive).toBeGreaterThan(-1);

      // Ordered
      expect(idxHeading).toBeLessThan(idxIdentity);
      expect(idxIdentity).toBeLessThan(idxBootstrap);
      expect(idxBootstrap).toBeLessThan(idxTools);
      expect(idxTools).toBeLessThan(idxMemory);
      expect(idxMemory).toBeLessThan(idxWake);
      expect(idxWake).toBeLessThan(idxCurrent);
      expect(idxCurrent).toBeLessThan(idxReactive);
    });
  });
});
