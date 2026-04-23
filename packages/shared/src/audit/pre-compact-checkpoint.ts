/**
 * Pre-compact checkpoint builder — Project 1.7 round 2.
 *
 * The pre-compact signal fragment (daemon/fragments/pre-compact-signal.ts)
 * nudges a Partner to run `cc-cli observe --category CHECKPOINT` manually
 * when they enter the 30k-token runway. That's a nudge; it relies on the
 * Partner noticing AND having discipline. Discipline fails; automation
 * doesn't. This builder supplies the content for an auto-written
 * CHECKPOINT observation chit that the PreCompact hook (cc-cli audit)
 * persists for the Partner regardless of whether they noticed the nudge.
 *
 * What the chit captures (soul material that raw-context summarization
 * will smooth over):
 *   - the trigger (auto vs manual /compact)
 *   - founder's `/compact <arg>` if any — their live ask verbatim
 *   - Casket `current_step` chit id + title
 *   - excerpt from the Partner's last assistant turns — "what I was
 *     thinking" at the boundary, in their own words
 *
 * The chit is **non-ephemeral** by design — a Partner's state at the
 * compact boundary is exactly the kind of soul material the 0.6
 * observations-never-destruct policy was written for. These accumulate
 * as witnessed moments across the Partner's life, not noise.
 *
 * Kind gate: builder returns `null` for employee-kind input so the
 * caller skips the write entirely. Employees don't ride Claude Code's
 * compact today; when they do, a separate body shape will be layered in
 * here — same as the summary-shaping template.
 *
 * Pure module. No I/O. Consumer: `cc-cli audit` in PreCompact-event mode.
 */

import type { HookInput } from './types.js';
import type { ChitScope } from '../types/chit.js';
import type { ObservationFields } from '../types/chit.js';

export interface CheckpointCasketRef {
  readonly chitId: string;
  readonly title?: string | null;
}

export interface CheckpointRecentActivity {
  /**
   * Recent assistant-text blocks, chronological. Builder takes the last
   * few, truncates each, and renders them as blockquotes. Tool-call
   * log is intentionally not consumed here — that's Stop-audit
   * territory (what the agent DID); checkpoint is about what the
   * agent was THINKING at the compact boundary.
   */
  readonly assistantText: readonly string[];
}

export interface CheckpointBuilderInput {
  readonly hookInput: HookInput;
  readonly kind: 'partner' | 'employee';
  readonly agentDisplayName: string;
  readonly agentSlug: string;
  readonly casket: CheckpointCasketRef | null;
  readonly recent: CheckpointRecentActivity | null;
  /** Injected for deterministic test output. Defaults to `new Date().toISOString()`. */
  readonly nowIso?: string;
}

/**
 * What the builder returns — a closed bundle of everything `createChit`
 * needs, without actually calling it. Caller composes the final
 * `CreateChitOpts` by forwarding these fields.
 */
export interface CheckpointChitSpec {
  readonly scope: ChitScope;
  readonly createdBy: string;
  readonly tags: readonly string[];
  readonly body: string;
  readonly ephemeral: false;
  readonly fields: {
    readonly observation: ObservationFields;
  };
}

const MAX_ASSISTANT_EXCERPTS = 3;
const MAX_EXCERPT_LENGTH = 600;

/**
 * Compose the auto-checkpoint observation chit for a Partner's pre-compact
 * boundary. Returns `null` for employees (no auto-checkpoint yet) so the
 * caller can skip the write cleanly.
 */
export function buildCheckpointObservation(
  input: CheckpointBuilderInput,
): CheckpointChitSpec | null {
  if (input.kind !== 'partner') return null;

  const now = input.nowIso ?? new Date().toISOString();
  const trigger = input.hookInput.trigger === 'auto' ? 'auto' : 'manual';
  const founderAsk =
    typeof input.hookInput.custom_instructions === 'string' &&
    input.hookInput.custom_instructions.trim().length > 0
      ? input.hookInput.custom_instructions.trim()
      : null;

  const lines: string[] = [];
  lines.push(`# Pre-Compact Checkpoint — ${input.agentDisplayName}`);
  lines.push('');
  lines.push(
    `Claude Code's PreCompact hook fired at \`${now}\`. Context was about to ` +
      `be summarized; this observation captures substrate-state the summary ` +
      `would otherwise flatten.`,
  );
  lines.push('');
  lines.push(`- **Trigger:** \`${trigger}\``);
  if (founderAsk) {
    lines.push('- **Founder ask (/compact argument):**');
    lines.push('  ' + formatBlockquote(founderAsk));
  } else {
    lines.push('- **Founder ask:** _(none)_');
  }

  if (input.casket && input.casket.chitId) {
    const title =
      typeof input.casket.title === 'string' && input.casket.title.trim().length > 0
        ? ` "${input.casket.title.trim()}"`
        : '';
    lines.push(`- **Casket current_step:** \`${input.casket.chitId}\`${title}`);
  } else {
    lines.push('- **Casket current_step:** _(idle — no active task)_');
  }

  const excerpts = collectAssistantExcerpts(input.recent);
  if (excerpts.length > 0) {
    lines.push('');
    lines.push('## Last intent (assistant-text excerpts)');
    for (const ex of excerpts) {
      lines.push('');
      lines.push(formatBlockquote(ex));
    }
  }

  const body = lines.join('\n') + '\n';

  const tags: string[] = [
    'from-log:CHECKPOINT',
    'auto-checkpoint',
    'pre-compact',
    `trigger:${trigger}`,
  ];

  const observation: ObservationFields = {
    category: 'NOTICE',
    subject: input.agentSlug,
    importance: 3,
    title: `[auto] pre-compact checkpoint (${trigger})`,
    context: founderAsk,
  };

  return {
    scope: `agent:${input.agentSlug}` as ChitScope,
    createdBy: input.agentSlug,
    tags,
    body,
    ephemeral: false,
    fields: { observation },
  };
}

function collectAssistantExcerpts(
  recent: CheckpointRecentActivity | null,
): string[] {
  if (!recent || recent.assistantText.length === 0) return [];
  const picked: string[] = [];
  for (let i = recent.assistantText.length - 1; i >= 0 && picked.length < MAX_ASSISTANT_EXCERPTS; i--) {
    const raw = recent.assistantText[i];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    picked.push(truncate(trimmed, MAX_EXCERPT_LENGTH));
  }
  return picked.reverse();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

function formatBlockquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}
