/**
 * cc-cli done — Employee-side "I'm done with this task" signal.
 *
 * Renamed from the REFACTOR.md's original `hand-complete` — the new
 * name is instantly legible (agents naturally say "done") and doesn't
 * rely on knowing the symmetry with 1.4's `hand`. Internally this is
 * the same command the spec describes.
 *
 * Employees don't compact; they hand off per-step. `cc-cli done` is
 * how that handoff happens:
 *
 *   1. Writes a structured handoff payload to
 *      <workspace>/.pending-handoff.json. Contents match the `handoff`
 *      chit type's frontmatter schema (predecessorSession, currentStep,
 *      completed, nextAction, openQuestion, sandboxState, notes).
 *
 *   2. Prints confirmation + reminds the agent that the Stop hook's
 *      audit gate will now run.
 *
 *   3. Exits 0. The agent's current turn ends, Claude Code fires the
 *      Stop hook → `cc-cli audit` → either:
 *
 *        approve  — audit reads .pending-handoff.json, promotes it to
 *                   WORKLOG.md (with <handoff>...</handoff> XML wrapping
 *                   so the current Dredge fragment can parse it), writes
 *                   a handoff chit for 1.6-forward Dredge, closes the
 *                   task chit, clears the Casket currentStep. Session
 *                   exits cleanly with state persisted.
 *
 *        block    — audit leaves the pending file alone. The agent sees
 *                   the audit reason in their context, keeps working,
 *                   can update WORKLOG.md and the pending file via
 *                   another `cc-cli done` call, and retries the exit.
 *
 * The pending-file design means `cc-cli done` itself does no commit
 * work — promotion to WORKLOG + chit + Casket advance is the audit
 * command's responsibility. This keeps the "blocked done leaves no
 * half-written state" invariant: either the pending file gets claimed
 * by a later approve, or it gets overwritten by a later `done` call.
 * No explicit rollback logic needed.
 */

import { mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { getCorpRoot, getMembers } from '../client.js';
import { atomicWriteSync, type Member } from '@claudecorp/shared';

export interface DoneOpts {
  from?: string;
  completed?: string[];
  nextAction?: string;
  openQuestion?: string;
  sandboxState?: string;
  notes?: string;
  json?: boolean;
}

export async function cmdDone(opts: DoneOpts): Promise<void> {
  if (!opts.from) {
    fail('--from <agent-slug> required — who\'s signaling done');
  }
  if (!opts.nextAction || opts.nextAction.trim().length < 3) {
    fail(
      '--next-action "..." required — what happens next. Be specific; a future session reads this as their first input.',
    );
  }

  const corpRoot = await getCorpRoot();
  const workspace = resolveAgentWorkspace(corpRoot, opts.from);
  if (!workspace) {
    fail(
      `agent "${opts.from}" not found in members.json, or member has no agentDir. Check the slug.`,
    );
  }

  mkdirSync(workspace, { recursive: true });

  // Compose the handoff payload. Fields mirror the `handoff` chit
  // type's validated shape in chit-types.ts so when audit promotes the
  // pending file to a chit, the frontmatter passes validation without
  // reshaping. createdAt + predecessorSession come from the agent; the
  // currentStep comes from the Casket the audit reads.
  const payload = {
    predecessorSession: deriveSessionLabel(),
    completed: opts.completed ?? [],
    nextAction: opts.nextAction.trim(),
    openQuestion: opts.openQuestion?.trim() ?? null,
    sandboxState: opts.sandboxState?.trim() ?? null,
    notes: opts.notes?.trim() ?? null,
    // Audit fills currentStep from the Casket at promotion time — agent
    // doesn't supply it. Keeps the pending file honest: "this is what
    // the agent said," Casket is "what the substrate says the agent
    // was on." They should agree; audit is the consistency check.
    createdAt: new Date().toISOString(),
    createdBy: opts.from,
  };

  const pendingPath = join(workspace, '.pending-handoff.json');
  atomicWriteSync(pendingPath, JSON.stringify(payload, null, 2) + '\n');

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, pendingPath, payload }, null, 2));
  } else {
    console.log(`cc-cli done: pending handoff written to ${pendingPath}`);
    console.log(
      'The Stop hook will now fire `cc-cli audit`. If the gate approves, your',
    );
    console.log(
      'handoff is committed and the session ends. If it blocks, you\'ll see',
    );
    console.log(
      'the audit reason — address it and run `cc-cli done` again to retry.',
    );
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function resolveAgentWorkspace(corpRoot: string, slug: string): string | null {
  const member = findMember(corpRoot, slug);
  if (!member?.agentDir) return null;
  return isAbsolute(member.agentDir) ? member.agentDir : join(corpRoot, member.agentDir);
}

function findMember(corpRoot: string, slug: string): Member | null {
  try {
    const members = getMembers(corpRoot);
    return members.find((m) => m.id === slug) ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort session label from env. Claude Code hooks inherit a
 * CLAUDE_SESSION_ID env var (we verified via the probe); when that's
 * absent (manual test, non-claude-code harness), fall back to a
 * timestamp-derived label so the handoff always names SOMETHING.
 *
 * Not load-bearing for 0.7.3 — it's observability only.
 */
function deriveSessionLabel(): string {
  const envId = process.env.CLAUDE_SESSION_ID;
  if (envId && envId.length > 0) return envId;
  return `local-${Date.now()}`;
}

function fail(msg: string): never {
  console.error(`cc-cli done: ${msg}`);
  process.exit(1);
}
