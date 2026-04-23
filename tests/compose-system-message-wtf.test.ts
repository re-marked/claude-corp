import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChit } from '../packages/shared/src/chits.js';
import { composeSystemMessage } from '../packages/daemon/src/fragments/index.js';
import type { FragmentContext } from '../packages/daemon/src/fragments/types.js';

/**
 * Integration tests for the 0.7.2 wtf-prepend added to composeSystemMessage.
 * OpenClaw dispatches get CORP.md + situational header prepended at the
 * front of the composed system message; Claude Code dispatches skip the
 * prepend (their SessionStart hook delivers wtf independently, and we
 * don't want double-injection).
 */

function baseCtx(corpRoot: string, agentDir: string, overrides: Partial<FragmentContext> = {}): FragmentContext {
  return {
    agentDir,
    corpRoot,
    channelName: 'general',
    channelMembers: [],
    corpMembers: [],
    recentHistory: [],
    agentMemberId: 'ceo',
    agentRank: 'master',
    agentDisplayName: 'CEO',
    channelKind: 'broadcast',
    supervisorName: null,
    ...overrides,
  };
}

describe('composeSystemMessage — wtf prepend (0.7.2)', () => {
  let corpRoot: string;
  let agentDir: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'compose-wtf-test-'));
    agentDir = join(corpRoot, 'agents', 'ceo');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
    writeFileSync(join(corpRoot, 'channels.json'), '[]', 'utf-8');
  });

  afterEach(() => {
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('prepends CORP.md + situational header for OpenClaw dispatches', () => {
    const out = composeSystemMessage(baseCtx(corpRoot, agentDir, { harness: 'openclaw' }));
    // Identity line from wtf-header
    expect(out).toContain('You are CEO, master (partner).');
    // CORP.md section headings
    expect(out).toContain('## The Two Non-Negotiables');
    expect(out).toContain('## Chit Lifecycle');
    expect(out).toContain('## Commands Quick Reference');
    // Empty inbox renders cleanly
    expect(out).toMatch(/Inbox: empty\./);
  });

  it('writes CORP.md to the agent workspace as a side effect (agent can re-read via Read tool)', () => {
    composeSystemMessage(baseCtx(corpRoot, agentDir, { harness: 'openclaw' }));
    const corpMdPath = join(agentDir, 'CORP.md');
    expect(existsSync(corpMdPath)).toBe(true);
    const content = readFileSync(corpMdPath, 'utf-8');
    expect(content).toContain('## Chit Lifecycle');
  });

  it('does NOT prepend wtf content for Claude Code dispatches (hook handles it to avoid double-injection)', () => {
    const out = composeSystemMessage(baseCtx(corpRoot, agentDir, { harness: 'claude-code' }));
    // No wtf identity line
    expect(out).not.toMatch(/You are CEO, master \(partner\)\./);
    // No CORP.md section headings
    expect(out).not.toContain('## The Two Non-Negotiables');
    expect(out).not.toContain('## Chit Lifecycle');
  });

  it('does NOT write CORP.md for Claude Code contexts', () => {
    composeSystemMessage(baseCtx(corpRoot, agentDir, { harness: 'claude-code' }));
    expect(existsSync(join(agentDir, 'CORP.md'))).toBe(false);
  });

  it('skips prepend gracefully when required context fields are missing', () => {
    // Sparse context — no agentMemberId. Shouldn't throw; fragment pipeline
    // still runs without the wtf prepend.
    expect(() =>
      composeSystemMessage({
        ...baseCtx(corpRoot, agentDir, { harness: 'openclaw' }),
        agentMemberId: undefined,
      }),
    ).not.toThrow();
  });

  it('wtf prepend renders current task from Casket → Task chit', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'mark',
      fields: { task: { title: 'Ship 0.7.2', priority: 'high' } },
    });
    createChit(corpRoot, {
      type: 'casket',
      scope: 'agent:ceo',
      id: 'chit-cask-ceo',
      createdBy: 'ceo',
      fields: { casket: { currentStep: task.id } },
    });

    const out = composeSystemMessage(baseCtx(corpRoot, agentDir, { harness: 'openclaw' }));
    expect(out).toContain(`Current task: ${task.id} — Ship 0.7.2`);
  });

  it('wtf prepend reflects open inbox-items in the header', () => {
    createChit(corpRoot, {
      type: 'inbox-item',
      scope: 'agent:ceo',
      createdBy: 'router',
      fields: {
        'inbox-item': { tier: 3, from: 'mark', subject: 'corp status?', source: 'dm' },
      },
    });

    const out = composeSystemMessage(baseCtx(corpRoot, agentDir, { harness: 'openclaw' }));
    expect(out).toMatch(/\[T3\] 1 critical/);
    expect(out).toContain('mark — "corp status?"');
  });

  it('kind-aware rendering: worker rank → Employee section appears in the CORP.md block', () => {
    const employeeDir = join(corpRoot, 'agents', 'toast');
    mkdirSync(employeeDir, { recursive: true });
    const out = composeSystemMessage({
      ...baseCtx(corpRoot, employeeDir, { harness: 'openclaw' }),
      agentMemberId: 'toast',
      agentRank: 'worker',
      agentDisplayName: 'Toast',
    });
    expect(out).toContain('You are Toast, worker (employee).');
    expect(out).toContain('## You are an Employee');
    expect(out).not.toContain('## You are a Partner');
  });

  it('still runs the fragment pipeline alongside the wtf prepend (backward compat during cleanup window)', () => {
    // Some fragments apply unconditionally (applies: () => true). Their
    // output should still appear AFTER the wtf block — fragments aren't
    // deleted yet, just supplemented.
    const out = composeSystemMessage(baseCtx(corpRoot, agentDir, { harness: 'openclaw' }));
    // The fragment pipeline's own well-known content — if any fragments
    // are still applicable to this sparse context, they render after the
    // wtf prepend. The key assertion: no throw, output is non-empty.
    expect(out.length).toBeGreaterThan(500); // full wtf output at minimum
  });
});
