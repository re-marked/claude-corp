/**
 * Project 2.5 — self-witnessing review-mode session prompt.
 *
 * Constructs the system-message body for a REVIEW dispatch (as
 * distinct from a task dispatch). Same Employee identity (CLAUDE.md /
 * SOUL.md / IDENTITY.md unchanged); the difference is the per-session
 * body the daemon injects — this template.
 *
 * The review-session reads:
 *   - the Contract's goal + acceptance criteria
 *   - the just-completed Task's output
 *   - prior Task outputs in this walk (for coherence-checking)
 *   - the walk position from 2.1
 *
 * And writes ONE `review` chit with one of three verdicts:
 *   accept / redo / flag.
 *
 * The template is a pure string builder — no I/O, no chit reads. The
 * caller (the future daemon spawn for review sessions) gathers the
 * inputs + passes them in.
 */

import type { Chit } from '../types/chit.js';
import type { WalkPosition } from '../walk.js';

export interface PriorTaskOutput {
  /** Step id from the walk's blueprint (or null for ad-hoc walks). */
  readonly stepId: string | null;
  /** Task chit id. */
  readonly taskId: string;
  /** Task title (rendered, no Handlebars). */
  readonly taskTitle: string;
  /** task.output — the agent's prose summary. Null when not yet written or unrecoverable. */
  readonly output: string | null;
}

export interface BuildReviewPromptOpts {
  /** Display name of the reviewing agent (same slot as the task-session per 2.5 same-self). */
  readonly agentDisplayName: string;
  /** Slug of the reviewing agent — surfaces in the cc-cli command examples. */
  readonly reviewerSlug: string;
  /** The just-completed Task being reviewed. */
  readonly task: Chit<'task'>;
  /** The Contract this Task belongs to. */
  readonly contract: Chit<'contract'>;
  /** Prior Task outputs on this walk — in declaration order, excluding the just-completed one. */
  readonly priorTaskOutputs: readonly PriorTaskOutput[];
  /** Walk position from 2.1's getWalkPosition. Null for ad-hoc walks. */
  readonly walkPosition: WalkPosition | null;
  /** Redo cap — surfaced in the prompt so the reviewer knows the limit. Default 1 per 2.5 spec. */
  readonly redoCap: number;
  /** Current redoCount on the Task — if > 0, the reviewer is on second-redo territory and must promote to flag. */
  readonly currentRedoCount: number;
}

/**
 * Build the system-message body for a review-mode session.
 *
 * Sections (in order — the agent reads top-down):
 *   1. Identity + mode declaration
 *   2. The verdicts (what each does, when to pick which)
 *   3. The redo cap (current state — does the agent have a redo
 *      available or is it auto-flag from here)
 *   4. The Contract's goal + acceptance criteria
 *   5. Walk position
 *   6. The just-completed Task
 *   7. Prior Task outputs
 *   8. How to write the review chit (cc-cli command shape)
 */
export function buildReviewPrompt(opts: BuildReviewPromptOpts): string {
  const {
    agentDisplayName,
    reviewerSlug,
    task,
    contract,
    priorTaskOutputs,
    walkPosition,
    redoCap,
    currentRedoCount,
  } = opts;

  const taskFields = task.fields.task;
  const contractFields = contract.fields.contract;

  const sections: string[] = [];

  // ── 1. Identity + mode ────────────────────────────────────────
  sections.push(
    `You are ${agentDisplayName}. This is a REVIEW session, not a task session — ` +
      `you're reading work you just finished and deciding whether it coheres with the Contract's ` +
      `goal and the prior steps in this walk. Same you, different lens: catch incoherence the ` +
      `mechanical gates (audit, sweeper) can't see.`,
  );

  // ── 2. Verdicts ──────────────────────────────────────────────
  sections.push(
    `## Your verdict\n\n` +
      `You write ONE \`review\` chit with one of three verdicts:\n\n` +
      `- **accept** — the work coheres with the Contract goal + prior steps. The system fires audit ` +
      `next, then the walk advances to the next Task. Use \`notesForNextTask\` to carry forward ` +
      `anything the next step's session should know.\n\n` +
      `- **redo** — the work didn't cohere; you want this same Task redone with specific feedback. ` +
      `The Task flips back to in_progress and you (or whoever picks it up) addresses the gap. ` +
      `\`redoFeedback\` is REQUIRED on redo — name the specific gap, not "try again." A redo without ` +
      `concrete improvement guidance is the failure mode the cap below exists to prevent.\n\n` +
      `- **flag** — you can't decide alone. Founder needed. Reasoning becomes a Tier-3 inbox-item; ` +
      `walk pauses until they weigh in. Use this when the gap is real but the right fix isn't ` +
      `obvious from what's in front of you.`,
  );

  // ── 3. Redo cap state ────────────────────────────────────────
  if (currentRedoCount >= redoCap) {
    sections.push(
      `## Redo cap status\n\n` +
        `This Task has already been redone ${currentRedoCount} time(s) (cap: ${redoCap}). ` +
        `A second redo verdict from you will be auto-promoted to **flag** by the verdict-decide ` +
        `flow — the system will not loop the agent on the same Task indefinitely. Your real choice ` +
        `here is accept vs flag; redo is mechanically equivalent to flag at this point.`,
    );
  } else {
    sections.push(
      `## Redo cap status\n\n` +
        `Redo count for this Task: ${currentRedoCount} of ${redoCap}. You can issue one redo; ` +
        `a second one (after the agent retries) auto-promotes to flag. Pointless second redos are ` +
        `cost-blowing loops — the cap is the cost-discipline mechanism.`,
    );
  }

  // ── 4. Contract goal + acceptance criteria ───────────────────
  sections.push(
    `## The Contract\n\n` +
      `**Contract id:** \`${contract.id}\`\n` +
      `**Title:** ${contractFields.title}\n` +
      `**Goal:** ${contractFields.goal}\n` +
      (contractFields.priority ? `**Priority:** ${contractFields.priority}\n` : '') +
      (contractFields.deadline ? `**Deadline:** ${contractFields.deadline}\n` : ''),
  );

  // ── 5. Walk position ─────────────────────────────────────────
  if (walkPosition) {
    sections.push(
      `## Walk position\n\n` +
        `Walk: \`${walkPosition.blueprintName}\`\n` +
        `Step under review: \`${walkPosition.stepId}\` (step ${walkPosition.stepIndex} of ${walkPosition.totalSteps})\n`,
    );
  } else {
    sections.push(
      `## Walk position\n\n` +
        `Ad-hoc walk (no blueprint cast). You're reviewing a single Task; the "prior steps" you'll ` +
        `see below are the agent's history on this Contract, not a blueprint-defined sequence.`,
    );
  }

  // ── 6. The just-completed Task ───────────────────────────────
  const taskOutputBlock = taskFields.output
    ? `**Output (the agent's prose summary):**\n\n${fenced(taskFields.output)}`
    : `**Output:** _(empty — the agent didn't fill in task.output. This itself is signal — incoherence often starts with skipping the externalization step.)_`;
  sections.push(
    `## The Task you're reviewing\n\n` +
      `**Task id:** \`${task.id}\`\n` +
      `**Title:** ${taskFields.title}\n` +
      (taskFields.acceptanceCriteria && taskFields.acceptanceCriteria.length > 0
        ? `**Acceptance criteria:**\n${taskFields.acceptanceCriteria.map((c) => `  - ${c}`).join('\n')}\n\n`
        : '') +
      taskOutputBlock,
  );

  // ── 7. Prior Task outputs ────────────────────────────────────
  if (priorTaskOutputs.length === 0) {
    sections.push(
      `## Prior Task outputs\n\n` +
        `_(None — this is the first Task in the walk. Coherence-check is against the Contract goal alone.)_`,
    );
  } else {
    const renderedPrior = priorTaskOutputs
      .map((p, i) => {
        const header = p.stepId
          ? `### ${i + 1}. Step \`${p.stepId}\` — task \`${p.taskId}\`: ${p.taskTitle}`
          : `### ${i + 1}. Task \`${p.taskId}\`: ${p.taskTitle}`;
        const body = p.output
          ? fenced(p.output)
          : `_(output empty — was this a substantive step?)_`;
        return `${header}\n\n${body}`;
      })
      .join('\n\n');
    sections.push(`## Prior Task outputs in this walk\n\n${renderedPrior}`);
  }

  // ── 8. How to write the review chit ──────────────────────────
  // The exact CLI command — verified against cc-cli chit create's
  // actual flags. Spelled out for each verdict so the reviewer can't
  // get the field-gating wrong (validator rejects misshapes).
  sections.push(
    `## How to write your verdict\n\n` +
      `Write ONE \`review\` chit. Use \`cc-cli chit create\`:\n\n` +
      `**For \`accept\`:**\n` +
      '```\n' +
      `cc-cli chit create --type review --scope agent:${reviewerSlug} --from ${reviewerSlug} \\\n` +
      `  --field verdict=accept \\\n` +
      `  --field reasoning="<why you're accepting — short OK>" \\\n` +
      `  --field taskId=${task.id} \\\n` +
      `  --field contractId=${contract.id} \\\n` +
      `  --field reviewerSlug=${reviewerSlug} \\\n` +
      `  --field notesForNextTask="<optional — what the next step's session should know>"\n` +
      '```\n\n' +
      `**For \`redo\`:**\n` +
      '```\n' +
      `cc-cli chit create --type review --scope agent:${reviewerSlug} --from ${reviewerSlug} \\\n` +
      `  --field verdict=redo \\\n` +
      `  --field reasoning="<why this needs another pass>" \\\n` +
      `  --field taskId=${task.id} \\\n` +
      `  --field contractId=${contract.id} \\\n` +
      `  --field reviewerSlug=${reviewerSlug} \\\n` +
      `  --field redoFeedback="<REQUIRED — specific guidance for the next attempt>"\n` +
      '```\n\n' +
      `**For \`flag\`:**\n` +
      '```\n' +
      `cc-cli chit create --type review --scope agent:${reviewerSlug} --from ${reviewerSlug} \\\n` +
      `  --field verdict=flag \\\n` +
      `  --field reasoning="<what's wrong and why you can't decide alone>" \\\n` +
      `  --field taskId=${task.id} \\\n` +
      `  --field contractId=${contract.id} \\\n` +
      `  --field reviewerSlug=${reviewerSlug}\n` +
      '```\n\n' +
      `Then exit. The verdict-decide flow picks up the chit and routes accordingly — your job is ` +
      `to read, decide, write the verdict, and stop. Don't try to apply the verdict yourself.`,
  );

  return sections.join('\n\n');
}

/**
 * Fence a multi-line string in a code block for the review prompt's
 * inline output rendering. Picks a delimiter long enough to escape
 * any backticks inside the string (rare but worth defending against;
 * the agent's task.output is free-form prose).
 */
function fenced(s: string): string {
  // Find the longest run of backticks in the input; use one more than
  // that as the fence (markdown spec for code-block delimiters).
  const longestRun = (s.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${s}\n${fence}`;
}
