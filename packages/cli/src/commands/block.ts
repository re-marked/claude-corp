/**
 * cc-cli block — dynamic blocker injection (Project 1.4.1).
 *
 * The missing primitive for mid-work dependency discovery: an agent
 * working a task realizes "I can't finish this until someone builds X."
 * Pre-1.4.1, the agent had three bad options — interrupt a supervisor,
 * work around the gap, or rationalize the problem away. All three are
 * failure modes REFACTOR.md's autonomy dream rejects.
 *
 * With block, the agent stays honest: files a sub-task with clear
 * acceptance criteria, marks their own task `blocked`, exits cleanly.
 * Chain walker auto-resumes when the blocker closes (wiring lands in
 * task-events integration).
 *
 * ### Command surface
 *
 *   cc-cli block --assignee <who-unblocks> --title "..." --description "..."
 *                [--priority critical|high|normal|low]
 *                [--acceptance "..."]* [--from <my-slug>]
 *                [--chit <blocked-task-id>]
 *                [--corp <name>] [--json]
 *
 *   --assignee   who will do the unblocking work (slug OR role)
 *   --title      short blocker title (max ~60 chars suggested)
 *   --description detailed "what I hit and what needs to happen" (min 20 chars)
 *   --priority   inherited default 'high' — blockers block chains, they're urgent
 *   --acceptance repeatable; each arg is one checkbox criterion on the blocker
 *   --from       required — the caller's slug (who's being blocked)
 *   --chit       optional; defaults to caller's Casket.currentStep
 *
 * ### What block does
 *
 *   1. Resolve caller's current task via --chit or Casket.currentStep.
 *      Reject if caller has no current work (nothing to block).
 *   2. Circular check — reject --assignee matching --from (direct or
 *      via role resolver; "blocked on yourself" is nonsense).
 *   3. Create blocker task chit at corp scope (draft + dependsOn empty
 *      — blocker itself isn't blocked on anything; it IS the blocker).
 *   4. Add blocker.id to caller's task's dependsOn (creates the dep
 *      edge chain-walker will read).
 *   5. Transition caller's task via state machine: block trigger.
 *      Usually in_progress → blocked, but also legal from dispatched
 *      (pre-work discovery of a dep).
 *   6. Hand the blocker chit to the assignee via handChitToSlot.
 *   7. Fire Tier 2 inbox-item on CALLER's inbox so the wtf header +
 *      founder visibility surfaces "blocked on chit-X" until resolved.
 *   8. Return cleanly — caller can exit; next session dispatch will
 *      see the Casket task is blocked and either wait or pick up
 *      something else from the role's pool.
 */

import { parseArgs } from 'node:util';
import {
  type Member,
  createChit,
  findChitById,
  updateChit,
  chitScopeFromPath,
  resolveRoleToEmployee,
  validateTransition,
  TaskTransitionError,
  getCurrentStep,
  getRole,
  handChitToSlot,
  HandNotAllowedError,
  createInboxItem,
  type TaskFields,
  type TaskWorkflowStatus,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers } from '../client.js';

const MIN_DESCRIPTION_CHARS = 20;

export interface BlockOpts {
  assignee?: string;
  title?: string;
  description?: string;
  priority?: TaskFields['priority'];
  acceptance?: string[];
  from?: string;
  chit?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdBlock(rawArgs: string[]): Promise<void>;
export async function cmdBlock(opts: BlockOpts): Promise<void>;
export async function cmdBlock(input: string[] | BlockOpts): Promise<void> {
  const opts = Array.isArray(input) ? parseOpts(input) : input;

  // Required-field validation at the boundary.
  if (!opts.from) fail('--from <your-slug> required — who is being blocked');
  if (!opts.assignee) fail('--assignee <who-unblocks> required');
  if (!opts.title || opts.title.trim().length === 0) fail('--title "..." required');
  if (!opts.description || opts.description.trim().length < MIN_DESCRIPTION_CHARS) {
    fail(
      `--description "..." required (>=${MIN_DESCRIPTION_CHARS} chars). A blocker ` +
        `must be specific enough that the assignee can act without asking back. ` +
        `Example: "migration uses utc coercion but legacy rows carry local tz; ` +
        `need a policy decision recorded as a chit before I coerce".`,
    );
  }
  const priority = opts.priority ?? 'high';
  if (!isValidPriority(priority)) {
    fail(`--priority must be one of: critical | high | normal | low (got "${priority}")`);
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const members = safeGetMembers(corpRoot);
  const fromId = opts.from;

  // 1. Resolve caller's current task.
  let callerTaskId = opts.chit;
  if (!callerTaskId) {
    try {
      const cs = getCurrentStep(corpRoot, fromId);
      callerTaskId = typeof cs === 'string' ? cs : undefined;
    } catch {
      // fall through to error
    }
  }
  if (!callerTaskId) {
    fail(
      `--chit <task-id> required (or run with a Casket currentStep set). ` +
        `A block must name the task being blocked.`,
    );
  }

  const callerTaskHit = findChitById(corpRoot, callerTaskId);
  if (!callerTaskHit) fail(`task "${callerTaskId}" not found`);
  if (callerTaskHit.chit.type !== 'task') {
    fail(`chit "${callerTaskId}" is type "${callerTaskHit.chit.type}", not a task — block only chains off tasks`);
  }

  // 2. Circular check. Literal self-block first.
  if (opts.assignee === fromId) {
    fail(`circular blocker: --assignee cannot equal --from ("${fromId}"). An agent blocked on themselves goes nowhere.`);
  }
  // Role-resolver circular: if --assignee is a role and the resolver
  // returns caller's own slug, also reject. Evaluates before any
  // chit writes so the corp state never sees a self-blocker.
  const resolvedAssignee = resolveAssignee(corpRoot, members, opts.assignee);
  if (resolvedAssignee.kind === 'error') fail(resolvedAssignee.message);
  if (resolvedAssignee.slug === fromId) {
    fail(
      `circular blocker: role "${opts.assignee}" resolved to caller "${fromId}". ` +
        `Role-pool resolution circled back to you — expand the pool or pick a different assignee.`,
    );
  }

  // 3. Pre-validate the caller's block transition BEFORE any writes.
  // If caller is in a state where `block` isn't legal (draft, terminal),
  // we want to reject before creating a blocker chit or mutating the
  // caller's task. Validation is pure — throws without side effect.
  const callerFields = callerTaskHit.chit.fields as { task: TaskFields };
  const callerCurrentWs: TaskWorkflowStatus = callerFields.task.workflowStatus ?? 'in_progress';
  let callerNextWs: TaskWorkflowStatus;
  try {
    callerNextWs = validateTransition(callerCurrentWs, 'block', callerTaskId);
  } catch (err) {
    if (err instanceof TaskTransitionError) {
      fail(
        `caller's task ${callerTaskId} is in state "${callerCurrentWs}"; ` +
          `block trigger not legal from there. ${err.message}`,
      );
    }
    throw err;
  }

  // 4. Create the blocker task chit. If subsequent steps (hand) fail,
  // the blocker is orphaned — that's recoverable (founder can close
  // it or re-hand manually). The wedged-caller alternative (create
  // blocker + mutate caller, then fail on hand) is not.
  const acceptanceList = opts.acceptance?.filter((s) => s.trim().length > 0) ?? [];
  const blocker = createChit(corpRoot, {
    type: 'task',
    scope: 'corp',
    fields: {
      task: {
        title: opts.title.trim(),
        priority,
        assignee: resolvedAssignee.slug,
        acceptanceCriteria: acceptanceList.length > 0 ? acceptanceList : null,
        // workflowStatus starts at 'queued' — the assignee is set and
        // a hand is about to fire, state machine takes it forward from
        // there. handChitToSlot will transition queued → dispatched.
        workflowStatus: 'queued',
        // Audit trail — who filed the blocker and when.
        handedBy: fromId,
        handedAt: new Date().toISOString(),
      },
    } as never,
    createdBy: fromId,
    status: 'draft',
    ephemeral: false,
    references: [callerTaskId],
    body:
      `Blocker filed by \`${fromId}\` for task \`${callerTaskId}\`.\n\n` +
      `## What's blocking\n\n${opts.description.trim()}\n` +
      (acceptanceList.length > 0
        ? `\n## Acceptance Criteria\n${acceptanceList.map((c) => `- [ ] ${c}`).join('\n')}\n`
        : ''),
  });

  // 5. Hand the blocker chit FIRST — before mutating caller. If hand
  // fails (assignee stale, state machine reject), the blocker is
  // orphaned but the caller's task is still clean / still running.
  // The previous order (caller-mutate THEN hand) left the caller
  // blocked on a blocker nobody was working on, with no rollback.
  //
  // Priority-to-tier mapping: critical blockers escalate to Tier 3 on
  // the assignee so they don't sit in a Tier 2 queue while a chain
  // stalls. high/normal/low stay at the default Tier 2 — visible in
  // wtf but not founder-paged.
  const blockerTier = priority === 'critical' ? 3 : 2;
  let handResult;
  try {
    handResult = handChitToSlot({
      corpRoot,
      targetSlug: resolvedAssignee.slug,
      chitId: blocker.id,
      handerId: fromId,
      reason: `blocker for ${callerTaskId}`,
      announce: true,
      announceTier: blockerTier,
    });
  } catch (err) {
    if (err instanceof HandNotAllowedError || err instanceof TaskTransitionError) {
      fail(
        `hand of blocker chit failed: ${err.message}\n\n` +
          `Caller's task ${callerTaskId} was NOT mutated — it remains ` +
          `in state "${callerCurrentWs}". The orphaned blocker chit ` +
          `${blocker.id} can be closed manually if unwanted.`,
      );
    }
    throw err;
  }

  // 6. Hand succeeded. Now mutate the caller — inject dep + transition
  // to blocked. If these fail for some reason, the blocker has an
  // assignee working it, but caller's task isn't yet marked blocked;
  // agent just works the pre-block state (worst case: duplicate work).
  // This is strictly better than the pre-fix order.
  const callerScope = chitScopeFromPath(corpRoot, callerTaskHit.path);
  const existingDeps = callerTaskHit.chit.dependsOn;
  const newDeps = existingDeps.includes(blocker.id) ? existingDeps : [...existingDeps, blocker.id];
  updateChit(corpRoot, callerScope, 'task', callerTaskId, {
    dependsOn: newDeps,
    updatedBy: fromId,
  });

  updateChit(corpRoot, callerScope, 'task', callerTaskId, {
    fields: { task: { workflowStatus: callerNextWs } } as never,
    updatedBy: fromId,
  });

  // 7. Tier 2 inbox-item on CALLER'S inbox — "you are blocked on X,"
  // so the agent's wtf header + founder visibility shows the state.
  let callerNotified = false;
  try {
    createInboxItem({
      corpRoot,
      recipient: fromId,
      tier: 2,
      from: fromId,
      subject: `BLOCKED: task ${callerTaskId} waiting on ${blocker.id} (${resolvedAssignee.displayName})`,
      source: 'system',
      sourceRef: blocker.id,
    });
    callerNotified = true;
  } catch {
    // non-fatal
  }

  // 8. Output.
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          blocker: blocker.id,
          callerTask: callerTaskId,
          callerWorkflowStatus: callerNextWs,
          assignee: resolvedAssignee.slug,
          assigneeMode: resolvedAssignee.mode,
          handWorkflowStatus: handResult.finalWorkflowStatus,
          callerNotified,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`blocker filed: ${blocker.id}`);
    console.log(`  your task: ${callerTaskId} → ${callerNextWs}`);
    console.log(
      `  assignee: ${resolvedAssignee.displayName} (${resolvedAssignee.slug})` +
        (resolvedAssignee.mode === 'role' ? ` [role: ${opts.assignee}]` : ''),
    );
    if (acceptanceList.length > 0) {
      console.log(`  acceptance: ${acceptanceList.length} criteri${acceptanceList.length === 1 ? 'on' : 'a'}`);
    }
    console.log(
      '\nyour session can exit; chain walker will re-dispatch when the ' +
        'blocker closes. founder will see your BLOCKED state in wtf.',
    );
  }
}

// ─── Assignee resolution (slug OR role, like hand) ───────────────────

type AssigneeResolution =
  | { kind: 'resolved'; slug: string; displayName: string; mode: 'slot' | 'role' }
  | { kind: 'error'; message: string };

function resolveAssignee(
  corpRoot: string,
  members: Member[],
  to: string,
): AssigneeResolution {
  const slotTarget = members.find(
    (m) => m.type === 'agent' && m.status === 'active' && m.id === to,
  );
  if (slotTarget) {
    return {
      kind: 'resolved',
      slug: slotTarget.id,
      displayName: slotTarget.displayName,
      mode: 'slot',
    };
  }

  if (getRole(to)) {
    const pick = resolveRoleToEmployee(corpRoot, to);
    switch (pick.kind) {
      case 'resolved': {
        const m = members.find((x) => x.id === pick.slug);
        return {
          kind: 'resolved',
          slug: pick.slug,
          displayName: m?.displayName ?? pick.slug,
          mode: 'role',
        };
      }
      case 'role-is-partner-only': {
        const list = pick.partnerCandidates.length
          ? pick.partnerCandidates.map((p) => p.slug).join(', ')
          : '<none hired>';
        return {
          kind: 'error',
          message:
            `role "${to}" is a Partner role — Partners are slot targets. ` +
            `Blockers go to workers; for Partner-level decisions use ` +
            `\`cc-cli escalate\`. If you truly need a Partner to unblock, ` +
            `name them. Candidates: ${list}.`,
        };
      }
      case 'no-candidates':
        return {
          kind: 'error',
          message:
            `no Employees of role "${to}" exist yet. Hire one with ` +
            `\`cc-cli hire --role ${to} --kind employee\` before filing this blocker.`,
        };
      case 'unknown-role':
        return { kind: 'error', message: `unknown role "${to}"` };
    }
  }

  return {
    kind: 'error',
    message:
      `no agent or role matches "${to}". Use the member id (e.g. \`toast\`) ` +
      `or a registered role id (e.g. \`qa-engineer\`).`,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function isValidPriority(p: unknown): p is TaskFields['priority'] {
  return p === 'critical' || p === 'high' || p === 'normal' || p === 'low';
}

function safeGetMembers(corpRoot: string): Member[] {
  try {
    return getMembers(corpRoot);
  } catch {
    return [];
  }
}

function parseOpts(rawArgs: string[]): BlockOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      assignee: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string' },
      acceptance: { type: 'string', multiple: true },
      from: { type: 'string' },
      chit: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;
  return {
    assignee: v.assignee as string | undefined,
    title: v.title as string | undefined,
    description: v.description as string | undefined,
    priority: v.priority as TaskFields['priority'] | undefined,
    acceptance: Array.isArray(v.acceptance) ? (v.acceptance as string[]) : undefined,
    from: v.from as string | undefined,
    chit: v.chit as string | undefined,
    corp: v.corp as string | undefined,
    json: v.json === true,
  };
}

function fail(msg: string): never {
  console.error(`cc-cli block: ${msg}`);
  process.exit(1);
}
