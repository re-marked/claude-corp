/**
 * Audit prompt template — the `<audit-check>` block injected into the
 * agent's context when the audit engine blocks. Pure function, no I/O.
 *
 * Kind-aware + event-aware so the "exit primitive" line names the right
 * next action:
 *
 *   Stop + Employee     → `cc-cli done`
 *   Stop + Partner      → `/compact` (Partners hand off via compaction)
 *   PreCompact + Partner → `/compact` (re-try compaction once audit passes)
 *
 * Structure matches REFACTOR.md 0.7.3's audit-prompt spec: acceptance-
 * criteria checklist, files-to-re-read, build/test/git-status prompts,
 * tier-3 inbox unresolved list. Rendered as an XML-tagged system-reminder
 * block so Claude Code surfaces it as discrete injected context the
 * agent can parse and respond to line-by-line.
 */

import type { AuditInput, HookEventName } from './types.js';
import type { Chit } from '../types/chit.js';

/**
 * What we're asking the agent to re-verify. Constructed by the engine
 * from the task chit's acceptance criteria + any evidence-scanner
 * findings. Distinguishing "criterion unverified" (benign: agent just
 * hasn't shown evidence yet) from "criterion contradicts evidence"
 * (dishonest claim) is a v2 refinement; v1 just asks for evidence.
 */
export interface AuditPromptInput {
  /** The input that produced the block decision — same shape as engine's. */
  audit: AuditInput;
  /**
   * Human-readable list of acceptance criteria that haven't shown
   * evidence in recent activity. Engine's evidence scanner produces
   * these. Empty array means criteria aren't the reason for blocking
   * (the block might be on tier-3 inbox alone).
   */
  unverifiedCriteria: string[];
  /**
   * Files the agent's task references that weren't read-back-verified.
   * Empty array means no file-readback gate fired.
   */
  filesNeedingReadback: string[];
  /**
   * Tool-use evidence the scanner couldn't find. "build", "tests",
   * "git-status" each render as a human-readable line in the prompt.
   * Missing from the list = evidence found = no prompt line.
   */
  missingEvidence: Array<'build' | 'tests' | 'git-status'>;
}

/**
 * Build the full <audit-check> block for an agent-facing block reason.
 * Returns the same text the engine packs into AuditDecision.reason —
 * the separation is testability: you can snapshot-test the prompt
 * rendering independently of the decision tree that produces it.
 */
export function buildAuditPrompt(input: AuditPromptInput): string {
  const { audit, unverifiedCriteria, filesNeedingReadback, missingEvidence } = input;
  const { currentTask, openTier3Inbox, event, kind, agentDisplayName } = audit;

  const lines: string[] = [];

  lines.push('<audit-check>');
  lines.push(
    `You tried to ${endOfSessionVerb(event, kind)}. Before I let you go, audit your work.`,
  );
  lines.push('');

  // Task + criteria section — skipped when there's no current task.
  if (currentTask) {
    const taskTitle =
      currentTask.fields.task?.title ?? `(title missing — chit id: ${currentTask.id})`;
    lines.push(`For the task ${currentTask.id} "${taskTitle}":`);
    lines.push('');

    const criteria = currentTask.fields.task?.acceptanceCriteria ?? [];
    if (criteria.length > 0) {
      lines.push('  Acceptance criteria (cite evidence for each in your next turn):');
      for (const criterion of criteria) {
        const unverified = unverifiedCriteria.includes(criterion);
        const box = unverified ? '[ ]' : '[x]';
        const hint = unverified ? ' — evidence not found in recent activity' : '';
        lines.push(`    ${box} ${criterion}${hint}`);
      }
      lines.push('');
    }

    if (filesNeedingReadback.length > 0) {
      lines.push('  Files you claimed to write/edit — re-Read each to confirm content:');
      for (const path of filesNeedingReadback) lines.push(`    - ${path}`);
      lines.push('');
    }

    if (missingEvidence.includes('build')) {
      lines.push('  Build: run `pnpm build` and show the output.');
    }
    if (missingEvidence.includes('tests')) {
      lines.push('  Tests: run the relevant vitest tests and show the output.');
    }
    if (missingEvidence.includes('git-status')) {
      lines.push('  Git status: run `git status` and report.');
    }
    if (missingEvidence.length > 0) lines.push('');
  }

  // Tier 3 inbox — hard gate. Listed even when there's no current task,
  // because unresolved critical inbox items block regardless.
  if (openTier3Inbox.length > 0) {
    lines.push(`Unresolved Tier 3 inbox items (${openTier3Inbox.length}):`);
    for (const item of openTier3Inbox) {
      lines.push(`  - ${item.id} (from ${inboxFrom(item)}): ${inboxSubject(item)}`);
    }
    lines.push('');
    lines.push(
      '  For each: respond with `cc-cli inbox respond <id>`, dismiss with a specific',
    );
    lines.push(
      '  `--reason "..."`, or explicitly carry-forward with a reason.',
    );
    lines.push('');
  }

  lines.push(
    `Once every checkbox is verifiably complete and every Tier 3 item is resolved, ${tryAgainVerb(
      event,
      kind,
    )}. The audit will re-run. If it passes, ${exitActionVerb(event, kind)}.`,
  );
  lines.push('');
  lines.push(
    `— audit gate, on behalf of ${agentDisplayName}'s substrate`,
  );
  lines.push('</audit-check>');

  return lines.join('\n');
}

/**
 * "end your session" / "compact your context" — what the agent was
 * trying to do when the hook fired. Drives the first line of the
 * audit prompt so it sounds natural instead of generic.
 */
function endOfSessionVerb(event: HookEventName, kind: 'partner' | 'employee'): string {
  if (event === 'PreCompact') return 'compact your context';
  if (kind === 'employee') return 'hand off this session';
  return 'end this session';
}

/**
 * "run hand-complete again" / "run /compact again" — the "try to exit
 * again" call-to-action at the end of the audit prompt.
 */
function tryAgainVerb(event: HookEventName, kind: 'partner' | 'employee'): string {
  if (event === 'PreCompact') return 'try `/compact` again';
  if (kind === 'employee') return 'run `cc-cli done` again';
  return 'try to end the session again';
}

/**
 * "your session will end" / "compaction will proceed" — what happens
 * on next audit approval. Closes the loop for the agent.
 */
function exitActionVerb(event: HookEventName, kind: 'partner' | 'employee'): string {
  if (event === 'PreCompact') return 'compaction will proceed';
  if (kind === 'employee') return 'your handoff will be committed and the session will end';
  return 'your session will end';
}

function inboxFrom(item: Chit<'inbox-item'>): string {
  return item.fields['inbox-item']?.from ?? '(unknown)';
}

function inboxSubject(item: Chit<'inbox-item'>): string {
  return item.fields['inbox-item']?.subject ?? '(no subject)';
}
