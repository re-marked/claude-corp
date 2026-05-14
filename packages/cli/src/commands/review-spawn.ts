/**
 * cc-cli review-spawn — Project 2.5 Phase 2 manual review-session
 * dispatcher.
 *
 * Reads the target task + its contract + walk position + prior
 * task outputs, builds the review-mode prompt via buildReviewPrompt,
 * and delivers it to the agent via the daemon's /cc/say endpoint.
 * The agent's session boots, processes the prompt as a user-message,
 * writes a `review` chit with one of three verdicts, and exits.
 * The Stop hook then fires `cc-cli audit`, which routes through the
 * review-mode detection path landed in feat/2.5-phase2-wiring and
 * applies the verdict via applyReviewVerdict.
 *
 * Minimum-viable Phase 2 shape: prompt delivered as a user-message
 * via the existing say infrastructure. Trade-offs vs a proper
 * system-message review-mode fragment:
 *   - The prompt lands in the agent's DM thread (visible in channel
 *     history); a system-message version wouldn't.
 *   - The agent's normal CLAUDE.md / SOUL.md identity is intact —
 *     the user-message asks them to switch lenses for this turn.
 * Both trade-offs are acceptable for substrate; Phase 3 can layer
 * a proper review-mode fragment over the same shared building blocks.
 *
 * Future automatic spawn (Phase 3 watcher): the audit-approve path
 * consults `shouldRunReviewSessionForTask` to decide whether to
 * defer promotion + invoke this dispatch flow automatically. This
 * CLI command is the manual / operator-driven entry point.
 *
 * ### Command surface
 *
 *   cc-cli review-spawn --task <task-id> --from <reviewer-slug>
 *                       [--redo-cap N] [--corp <name>] [--json]
 *
 *   --task    chit id of the just-completed task being reviewed
 *   --from    the reviewer agent's slug (same slot as the task-session
 *             per 2.5 same-self identity)
 *   --redo-cap optional override; surfaced in the prompt's cap-state
 *             section so the reviewer knows the limit
 */

import { parseArgs } from 'node:util';
import {
  type Chit,
  type ContractFields,
  type TaskFields,
  buildReviewPrompt,
  type PriorTaskOutput,
  findChitById,
  queryChits,
  getWalkPosition,
  isChitIdFormat,
  REVIEW_REDO_CAP_DEFAULT,
} from '@claudecorp/shared';
import { getCorpRoot, getClient } from '../client.js';

export interface ReviewSpawnOpts {
  task?: string;
  from?: string;
  redoCap?: number;
  corp?: string;
  json?: boolean;
}

export async function cmdReviewSpawn(rawArgs: string[]): Promise<void>;
export async function cmdReviewSpawn(opts: ReviewSpawnOpts): Promise<void>;
export async function cmdReviewSpawn(input: string[] | ReviewSpawnOpts): Promise<void> {
  const opts = Array.isArray(input) ? parseOpts(input) : input;

  if (!opts.task) fail('--task <chit-id> required');
  if (!isChitIdFormat(opts.task)) fail(`not a valid chit id format: ${opts.task}`);
  if (!opts.from) fail('--from <reviewer-slug> required');

  const corpRoot = await getCorpRoot(opts.corp);

  // ── Resolve the task chit. ─────────────────────────────────────
  const taskHit = findChitById(corpRoot, opts.task);
  if (!taskHit || taskHit.chit.type !== 'task') {
    fail(`task chit not found or wrong type: ${opts.task}`);
  }
  const taskChit = taskHit.chit as Chit<'task'>;
  const taskFields = taskChit.fields.task as TaskFields;

  // ── Find the contract that owns this task. ─────────────────────
  const contractResult = queryChits<'contract'>(corpRoot, {
    types: ['contract'],
    limit: 0,
  });
  const containingHit = contractResult.chits.find((cwb) =>
    (cwb.chit.fields.contract as ContractFields).taskIds.includes(taskChit.id),
  );
  if (!containingHit) {
    fail(`task ${opts.task} is not part of any contract — review-spawn requires a multi-task contract`);
  }
  const contractChit = containingHit.chit as Chit<'contract'>;
  const contractFields = contractChit.fields.contract as ContractFields;

  // ── Walk position from the task (ad-hoc walks return null). ───
  const walkPosition = getWalkPosition(taskChit, corpRoot);

  // ── Prior task outputs in the same contract, in declaration order. ─
  const priorTaskOutputs: PriorTaskOutput[] = [];
  for (const otherTaskId of contractFields.taskIds) {
    if (otherTaskId === taskChit.id) continue;
    const otherHit = findChitById(corpRoot, otherTaskId);
    if (!otherHit || otherHit.chit.type !== 'task') continue;
    const otherFields = otherHit.chit.fields.task as TaskFields;
    // Only show prior steps (workflowStatus completed or further);
    // skip future steps that haven't run yet.
    if (otherFields.workflowStatus !== 'completed') continue;
    priorTaskOutputs.push({
      stepId: extractStepId(otherHit.chit as Chit<'task'>),
      taskId: otherTaskId,
      taskTitle: otherFields.title,
      output: otherFields.output ?? null,
    });
  }

  // ── Resolve display name for the reviewer (best-effort; falls back to slug). ─
  const displayName = await resolveDisplayName(corpRoot, opts.from);

  // ── Build the prompt. ─────────────────────────────────────────
  const redoCap = opts.redoCap ?? REVIEW_REDO_CAP_DEFAULT;
  const prompt = buildReviewPrompt({
    agentDisplayName: displayName,
    reviewerSlug: opts.from,
    task: taskChit,
    contract: contractChit,
    priorTaskOutputs,
    walkPosition,
    redoCap,
    currentRedoCount: taskFields.reviewRedoCount ?? 0,
  });

  // ── Dispatch via daemon.say (delivers as user-message). ───────
  const client = getClient();
  let result: { ok: boolean; from: string; response: string; interrupted?: boolean };
  try {
    result = await client.say(opts.from, prompt);
  } catch (err) {
    fail(
      `dispatch failed via /cc/say: ${err instanceof Error ? err.message : String(err)}. ` +
        `Is the daemon running? Try \`cc-cli status\`.`,
    );
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          taskId: taskChit.id,
          contractId: contractChit.id,
          reviewerSlug: opts.from,
          promptLength: prompt.length,
          response: result.response,
        },
        null,
        2,
      ),
    );
    if (!result.ok) process.exit(2);
    return;
  }

  if (!result.ok) {
    console.error(
      `review-spawn dispatched but the agent's response was not ok: ${(result as { error?: string }).error ?? 'unknown'}`,
    );
    process.exit(2);
  }

  console.log(`review-session dispatched to ${displayName} (${opts.from}) for task ${taskChit.id}.`);
  console.log(`Prompt length: ${prompt.length} chars. Agent's response:`);
  console.log('---');
  console.log(result.response);
  console.log('---');
  console.log(
    `\nNext: when the agent's Stop hook fires \`cc-cli audit\`, the review-mode router will apply the verdict.`,
  );
}

function parseOpts(rawArgs: string[]): ReviewSpawnOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      task: { type: 'string' },
      from: { type: 'string' },
      'redo-cap': { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;
  const redoCapRaw = typeof v['redo-cap'] === 'string' ? Number(v['redo-cap']) : undefined;
  return {
    task: (v.task as string | undefined) ?? undefined,
    from: (v.from as string | undefined) ?? undefined,
    ...(redoCapRaw !== undefined && Number.isFinite(redoCapRaw) ? { redoCap: redoCapRaw } : {}),
    corp: (v.corp as string | undefined) ?? undefined,
    json: Boolean(v.json),
  };
}

/** Extract the blueprint step id from a task chit's tags (returns null for ad-hoc). */
function extractStepId(taskChit: Chit<'task'>): string | null {
  const tag = taskChit.tags.find((t) => t.startsWith('blueprint-step:'));
  return tag ? tag.slice('blueprint-step:'.length) : null;
}

/** Resolve the reviewer's display name from members.json; fall back to slug on any miss. */
async function resolveDisplayName(corpRoot: string, slug: string): Promise<string> {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { MEMBERS_JSON } = await import('@claudecorp/shared');
    const path = join(corpRoot, MEMBERS_JSON);
    if (!existsSync(path)) return slug;
    const members = JSON.parse(readFileSync(path, 'utf-8')) as Array<{
      id: string;
      displayName?: string;
    }>;
    return members.find((m) => m.id === slug)?.displayName ?? slug;
  } catch {
    return slug;
  }
}

function fail(msg: string): never {
  console.error(`cc-cli review-spawn: ${msg}`);
  process.exit(1);
}
