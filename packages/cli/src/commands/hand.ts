/**
 * cc-cli hand — durable chit forwarding on the Casket substrate.
 *
 * Project 1.4, full rewrite. Hand is the mechanism the founder + CEO +
 * Partners use to give work to a target; post-1.4, it's a Casket-pointer
 * write routed through an optional role-resolver, not a chat @mention
 * with channel dispatch. The old daemon-round-trip path via
 * `/tasks/:id/hand` is retained one version for back-compat but is no
 * longer invoked by this CLI — this command writes chits directly per
 * CLAUDE.md's file-first principle (daemon only owns process management).
 *
 * ### Target modes
 *
 *   Slot:   `--to toast`              → named Employee or Partner.
 *   Role:   `--to backend-engineer`   → role-resolver picks an Employee.
 *                                        Partner-by-role targets error with
 *                                        "address by name" + candidate list.
 *
 * ### What hand does, in order
 *
 *   1. Resolve target (slot direct, role via resolveRoleToEmployee).
 *   2. Validate chit exists + is non-terminal + is hand-eligible state.
 *   3. Write target's Casket.currentStep = chitId (via advanceCurrentStep).
 *   4. Transition chit workflowStatus via state machine:
 *        - `draft`      → assign   → `queued`
 *        - `queued`     → dispatch → `dispatched`
 *        - `dispatched` → (no-op — already delivered; idempotent re-hand)
 *        - other        → reject (can't re-hand in-progress/blocked/
 *                                 under-review/terminal tasks)
 *      Two-step (draft → queued → dispatched) happens in one call —
 *      the caller thinks of hand as "deliver," not "two-phase enqueue."
 *   5. Stamp fields.task.assignee + handedBy + handedAt on task chits.
 *   6. Fire Tier 2 inbox-item on target's inbox (unless --no-announce).
 *      Inbox-item is the "you have work" signal; Casket is the work itself.
 *
 * ### What hand doesn't do
 *
 *   - No chat channel broadcast. The pre-1.4 #tasks event message path
 *     is skipped. Founder wanting corp-wide visibility can consume the
 *     audit log or inbox events directly.
 *   - No daemon heartbeat refresh. Heartbeat ticks pick up Casket
 *     changes on their next cycle (a few seconds). Not load-bearing.
 *   - No autoemon wake. Future 1.9/1.10 work.
 */

import { parseArgs } from 'node:util';
import {
  type Member,
  resolveSlotOrRole,
  handChitToSlot,
  HandNotAllowedError,
  TaskTransitionError,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers, getFounder } from '../client.js';

export interface HandOpts {
  to?: string;
  chit?: string;
  reason?: string;
  from?: string;
  noAnnounce?: boolean;
  corp?: string;
  json?: boolean;
}

export async function cmdHand(rawArgs: string[]): Promise<void>;
export async function cmdHand(opts: HandOpts): Promise<void>;
export async function cmdHand(input: string[] | HandOpts): Promise<void> {
  const opts = Array.isArray(input) ? parseOpts(input) : input;

  if (!opts.to) fail('--to <slug-or-role> required');
  if (!opts.chit) fail('--chit <chit-id> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const members = safeGetMembers(corpRoot);
  const founder = getFounder(corpRoot);
  const handerId = opts.from ?? founder.id;

  // 1. Resolve target.
  const resolution = resolveTarget(corpRoot, members, opts.to);
  if (resolution.kind === 'error') fail(resolution.message);
  const target = resolution.target;
  const targetMode = resolution.mode;

  // 2. Delegate the mechanics to handChitToSlot — the shared helper
  // owns: chit-type eligibility check, Casket write, state machine
  // transition, assignee stamp, inbox-item notification. Error paths
  // come back as HandNotAllowedError (type/state) or TaskTransitionError
  // (state machine rejection with legal-triggers list); the CLI
  // surfaces both with actionable messages here.
  let result;
  try {
    result = handChitToSlot({
      corpRoot,
      targetSlug: target.id,
      chitId: opts.chit,
      handerId,
      reason: opts.reason,
      announce: !opts.noAnnounce,
    });
  } catch (err) {
    if (err instanceof HandNotAllowedError) fail(err.message);
    if (err instanceof TaskTransitionError) {
      fail(`task ${opts.chit} can't be handed from state "${err.from}". ${err.message}`);
    }
    throw err;
  }
  const finalState = result.finalWorkflowStatus;
  const announced = result.announced;

  // Output.
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          chit: opts.chit,
          target: target.id,
          targetDisplayName: target.displayName,
          targetMode,
          finalWorkflowStatus: finalState,
          announced,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `handed ${opts.chit} → ${target.displayName} (${target.id})` +
        (targetMode === 'role' ? ` [role: ${opts.to}]` : ''),
    );
    if (finalState) console.log(`  workflowStatus: ${finalState}`);
    if (announced) console.log(`  announced: Tier 2 inbox-item`);
    if (opts.reason) console.log(`  reason: ${opts.reason}`);
  }
}

// ─── Target resolution ──────────────────────────────────────────────

type TargetResolution =
  | { kind: 'resolved'; target: Member; mode: 'slot' | 'role' }
  | { kind: 'error'; message: string };

/**
 * Thin CLI-layer wrapper around the shared resolveSlotOrRole helper.
 * Keeps command-specific error wording (bacteria hint, Partner-role
 * Address-by-name hint) without reimplementing the resolution logic.
 */
function resolveTarget(
  corpRoot: string,
  members: Member[],
  to: string,
): TargetResolution {
  const res = resolveSlotOrRole(corpRoot, members, to);
  switch (res.kind) {
    case 'slot':
    case 'role':
      return { kind: 'resolved', target: res.member, mode: res.mode };
    case 'role-is-partner-only': {
      const list = res.partnerCandidates.length
        ? res.partnerCandidates.map((p) => p.slug).join(', ')
        : '<none hired>';
      return {
        kind: 'error',
        message:
          `role "${to}" is a Partner role — Partners are slot targets, ` +
          `not pool-resolvable. Address by name. Candidates: ${list}.`,
      };
    }
    case 'role-no-candidates':
      return {
        kind: 'error',
        message:
          `no Employees of role "${to}" exist yet. Hire one with ` +
          `\`cc-cli hire --role ${to} --kind employee\` or wait for bacteria (Project 1.9).`,
      };
    case 'unknown':
      return {
        kind: 'error',
        message:
          `no agent or role matches "${to}". Use the member id (e.g. \`ceo\`, \`toast\`) ` +
          `or a registered role id (e.g. \`backend-engineer\`).`,
      };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function safeGetMembers(corpRoot: string): Member[] {
  try {
    return getMembers(corpRoot);
  } catch {
    return [];
  }
}

function parseOpts(rawArgs: string[]): HandOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      to: { type: 'string' },
      chit: { type: 'string' },
      // Back-compat: --task was the legacy flag name; alias it to --chit
      // so existing scripts don't break on the name change. Agents should
      // migrate to --chit in new writing.
      task: { type: 'string' },
      reason: { type: 'string' },
      from: { type: 'string' },
      'no-announce': { type: 'boolean', default: false },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;
  return {
    to: (v.to as string | undefined) ?? undefined,
    chit: (v.chit as string | undefined) ?? (v.task as string | undefined),
    reason: v.reason as string | undefined,
    from: v.from as string | undefined,
    noAnnounce: v['no-announce'] === true,
    corp: v.corp as string | undefined,
    json: v.json === true,
  };
}

function fail(msg: string): never {
  console.error(`cc-cli hand: ${msg}`);
  process.exit(1);
}
