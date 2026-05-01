/**
 * Summary-shaping instructions emitted by cc-cli audit on the PreCompact
 * hook — Project 1.7 commit 4.
 *
 * Claude Code's PreCompact hook merges stdout from every registered hook
 * into the compaction summarization prompt via `mergeHookInstructions`
 * (leaked source, services/compact/autoCompact.ts). The summarization
 * model reads these instructions and shapes its synthetic summary turn
 * accordingly — this is our chance to bias what survives the compact.
 *
 * Our default template for Partners tells the summarization model to
 * preserve: current work pointer (Casket), in-flight reasoning
 * expressed in tool calls + assistant text, open questions, and any
 * references to chit ids / file paths the agent was manipulating. Those
 * are the substrate-specific anchors that make post-compact continuity
 * possible.
 *
 * Employees don't get a kind-aware PreCompact template (yet) — they run
 * on OpenClaw-native heartbeats that pre-date Claude Code's compact,
 * and their HEARTBEAT / WORKLOG files act as the durable substitute for
 * a compact summary. If/when Employees move onto Claude Code,
 * `kind: 'employee'` can grow its own template here.
 *
 * The builder echoes any founder-typed `/compact <extra>` argument
 * (hookInput.custom_instructions) after our template so both survive —
 * the founder's live ask comes FIRST in the rendered text so it wins any
 * conflict with our default shaping.
 *
 * Pure module — no I/O. Consumer: `cc-cli audit` in PreCompact-event mode.
 */

import type { HookInput } from './types.js';

export interface PreCompactInstructionsInput {
  /** Hook payload straight from stdin. trigger + custom_instructions read. */
  readonly hookInput: HookInput;
  /** Partner vs employee — shapes template choice. */
  readonly kind: 'partner' | 'employee';
  /** Agent display name for anchoring the voice ("keep Toast's..."). */
  readonly agentDisplayName: string;
  /** Agent slug for cc-cli-side references embedded in the template. */
  readonly agentSlug: string;
}

/**
 * Compose the PreCompact summary-shaping text Claude Code will merge
 * into its summarization prompt.
 *
 * Returns an empty string when there's nothing to contribute
 * (employee-kind for now) so the caller can skip stdout emission.
 */
export function buildPreCompactInstructions(input: PreCompactInstructionsInput): string {
  const { hookInput, kind, agentDisplayName, agentSlug } = input;

  // Kind-aware gate. Employees don't currently ride Claude Code compact,
  // so we don't emit a template for them — anything we say would risk
  // misleading the summarizer in contexts we haven't validated.
  if (kind !== 'partner') return '';

  const trigger = hookInput.trigger === 'auto' ? 'auto' : 'manual';
  const founderAsk =
    typeof hookInput.custom_instructions === 'string'
      ? hookInput.custom_instructions.trim()
      : '';

  const sections: string[] = [];

  // Founder's /compact argument wins first slot — if they typed an
  // explicit request, the summarizer should satisfy that above our
  // default shape. Omit the header when they didn't type anything.
  if (founderAsk) {
    sections.push(
      `## Founder's compact request\n\n${founderAsk}\n\nHonor this above all else when it conflicts with the defaults below.`,
    );
  }

  sections.push(
    `## Claude Corp compact-summary shape (Partner: ${agentDisplayName})

This compaction was triggered \`${trigger}\`. The summary should let ${agentDisplayName}
resume work without re-reading the pre-compact history. Preserve these
explicitly:

- **Current work pointer** — the task the agent was on at the moment of
  compact. Quote the task chit id + title verbatim if it appears in the
  transcript. Reference: Casket is at \`agents/${agentSlug}/casket.md\`
  (the agent can re-read it after compact, but it needs to know WHICH
  currentStep to expect).
- **In-flight reasoning** — any "thinking out loud" the agent was doing
  across the last 5–10 turns. Do NOT compress this into a single
  sentence; the agent's next move often depends on the specific hypothesis
  they were testing.
- **Open questions** — anything the agent flagged as uncertain, waiting
  on input, or flagged to \`askFounder\`. These must survive verbatim;
  summarizing "they had questions" is not enough.
- **Verbatim references** — chit ids (\`chit-t-*\`, \`chit-o-*\`,
  \`chit-h-*\`, etc.), file paths under the corp tree, and any exact
  command strings. These are the substrate anchors post-compact recovery
  depends on.
- **Active cc-cli sessions / handoffs** — if the agent recently ran
  \`cc-cli hand\`, \`cc-cli done\`, or \`cc-cli observe\`, name the chit
  that resulted.

Do NOT preserve:
- Fully-resolved tool output that's already been acted on.
- Idle/chat turns with no decisions or artifacts.
- The chrome of stream events (lifecycle phase noise).

Voice: neutral third-person narration addressed TO ${agentDisplayName}.
End with one line naming the exact next action the agent should take
when they read the summary.`,
  );

  return sections.join('\n\n');
}
