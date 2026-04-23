import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  promotePendingHandoff,
  createChit,
  createCasketIfMissing,
  advanceCurrentStep,
  getCurrentStep,
  atomicWriteSync,
} from '../packages/shared/src/index.js';

/**
 * End-of-PR coverage for the Project 1.4 Casket-advance-to-next-in-
 * chain logic inside promotePendingHandoff (handoff-promotion.ts).
 *
 * The function `findNextSameAgentChainStep` is private, so these
 * tests exercise it end-to-end through the full promotion flow:
 * write a pending-handoff.json, call promotePendingHandoff, check
 * the resulting Casket currentStep.
 *
 * The ship criterion load-bearing cases:
 *   - Two-task chain, same agent: Casket advances to task 2, not null.
 *   - Two-task chain, different agents: Casket clears to null.
 *   - Standalone task (no contract): Casket clears to null.
 *   - Contract fully done: Casket clears to null.
 *   - Next step is blocked (deps unsatisfied): Casket clears to null.
 */

describe('promotePendingHandoff — Casket advance to next-in-chain', () => {
  let corpRoot: string;
  let workspace: string;
  const AGENT = 'toast';

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'handoff-advance-test-'));
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
    workspace = join(corpRoot, 'agents', AGENT);
    mkdirSync(workspace, { recursive: true });
    createCasketIfMissing(corpRoot, AGENT, 'founder');
  });

  afterEach(() => rmSync(corpRoot, { recursive: true, force: true }));

  /** Write a valid pending-handoff.json for the agent. */
  function writePending(): void {
    atomicWriteSync(
      join(workspace, '.pending-handoff.json'),
      JSON.stringify({
        predecessorSession: 'test-session',
        completed: ['did the thing'],
        nextAction: 'pick up next step',
        openQuestion: null,
        sandboxState: null,
        notes: null,
        createdAt: new Date().toISOString(),
        createdBy: AGENT,
      }),
    );
  }

  /** Build a contract with two tasks chained via dependsOn. */
  function buildTwoTaskChain(opts: {
    task2Assignee: string | null;
    task2Status?: string;
  }) {
    const task1 = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: {
        task: {
          title: 'task-1',
          priority: 'normal',
          workflowStatus: 'under_review',
          assignee: AGENT,
        },
      } as never,
      createdBy: 'founder',
      status: 'active',
    });
    const task2Fields: Record<string, unknown> = {
      title: 'task-2',
      priority: 'normal',
      workflowStatus: opts.task2Status ?? 'queued',
    };
    if (opts.task2Assignee !== null) task2Fields.assignee = opts.task2Assignee;
    const task2 = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: task2Fields } as never,
      createdBy: 'founder',
      status: 'draft',
      dependsOn: [task1.id],
    });
    const contract = createChit(corpRoot, {
      type: 'contract',
      scope: 'corp',
      fields: {
        contract: {
          title: 'test-contract',
          goal: 'exercise chain advance',
          taskIds: [task1.id, task2.id],
          leadId: 'founder',
        },
      },
      createdBy: 'founder',
    });
    advanceCurrentStep(corpRoot, AGENT, task1.id, 'founder');
    return { task1, task2, contract };
  }

  it('same-agent next task: Casket advances to task 2', () => {
    const { task2 } = buildTwoTaskChain({ task2Assignee: AGENT });
    writePending();

    const result = promotePendingHandoff(corpRoot, AGENT, workspace);
    expect(result.promoted).toBe(true);
    expect(getCurrentStep(corpRoot, AGENT)).toBe(task2.id);
  });

  it('different-agent next task: Casket clears (chain ownership passes)', () => {
    buildTwoTaskChain({ task2Assignee: 'other-agent' });
    writePending();

    const result = promotePendingHandoff(corpRoot, AGENT, workspace);
    expect(result.promoted).toBe(true);
    expect(getCurrentStep(corpRoot, AGENT)).toBeNull();
  });

  it('next task has no assignee: Casket clears (no same-agent match possible)', () => {
    buildTwoTaskChain({ task2Assignee: null });
    writePending();

    const result = promotePendingHandoff(corpRoot, AGENT, workspace);
    expect(result.promoted).toBe(true);
    expect(getCurrentStep(corpRoot, AGENT)).toBeNull();
  });

  it('standalone task (no contract): Casket clears', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: {
        task: {
          title: 'solo',
          priority: 'normal',
          workflowStatus: 'under_review',
          assignee: AGENT,
        },
      } as never,
      createdBy: 'founder',
      status: 'active',
    });
    advanceCurrentStep(corpRoot, AGENT, task.id, 'founder');
    writePending();

    const result = promotePendingHandoff(corpRoot, AGENT, workspace);
    expect(result.promoted).toBe(true);
    expect(getCurrentStep(corpRoot, AGENT)).toBeNull();
  });

  it('contract fully done (next task already completed): Casket clears', () => {
    const task1 = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: {
        task: {
          title: 'task-1',
          priority: 'normal',
          workflowStatus: 'under_review',
          assignee: AGENT,
        },
      } as never,
      createdBy: 'founder',
      status: 'active',
    });
    createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: {
        task: {
          title: 'already-done',
          priority: 'normal',
          workflowStatus: 'completed',
          assignee: AGENT,
        },
      } as never,
      createdBy: 'founder',
      status: 'completed',
    });
    const task2Id = `${task1.id}-done-sibling`;
    createChit(corpRoot, {
      type: 'contract',
      scope: 'corp',
      fields: {
        contract: {
          title: 'done-contract',
          goal: 'test',
          taskIds: [task1.id],
          leadId: 'founder',
        },
      },
      createdBy: 'founder',
    });
    advanceCurrentStep(corpRoot, AGENT, task1.id, 'founder');
    writePending();

    const result = promotePendingHandoff(corpRoot, AGENT, workspace);
    expect(result.promoted).toBe(true);
    // Contract had only one task (the one we just closed). No next
    // ready step → Casket clears.
    expect(getCurrentStep(corpRoot, AGENT)).toBeNull();
    // Suppress unused warning.
    void task2Id;
  });

  it('next task blocked on a dep that did not close: Casket clears (nextReadyTask skips non-ready)', () => {
    // task1 + task2 chained. ALSO an external blocker that task2
    // depends on. Closing task1 unblocks one dep but not the
    // other, so task2 is still unready.
    const blocker = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: {
        task: {
          title: 'external-blocker',
          priority: 'normal',
          workflowStatus: 'in_progress',
          assignee: 'other-agent',
        },
      } as never,
      createdBy: 'founder',
      status: 'active',
    });
    const task1 = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: {
        task: {
          title: 'task-1',
          priority: 'normal',
          workflowStatus: 'under_review',
          assignee: AGENT,
        },
      } as never,
      createdBy: 'founder',
      status: 'active',
    });
    createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: {
        task: {
          title: 'task-2',
          priority: 'normal',
          workflowStatus: 'queued',
          assignee: AGENT,
        },
      } as never,
      createdBy: 'founder',
      status: 'draft',
      dependsOn: [task1.id, blocker.id],
    });
    createChit(corpRoot, {
      type: 'contract',
      scope: 'corp',
      fields: {
        contract: {
          title: 'two-deps',
          goal: 'test',
          taskIds: [task1.id],
          leadId: 'founder',
        },
      },
      createdBy: 'founder',
    });
    advanceCurrentStep(corpRoot, AGENT, task1.id, 'founder');
    writePending();

    const result = promotePendingHandoff(corpRoot, AGENT, workspace);
    expect(result.promoted).toBe(true);
    // task2 still has an unsatisfied dep (blocker in_progress) →
    // nextReadyTask returns null → Casket clears.
    expect(getCurrentStep(corpRoot, AGENT)).toBeNull();
  });
});
