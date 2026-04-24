/**
 * `orphantask` sweeper — detect task chits in limbo.
 *
 * An orphan task is a task chit that's queued to dispatch but
 * can't actually dispatch because nobody owns it. Most often
 * happens when:
 *   - A blueprint cast partially succeeded, creating tasks but
 *     failing to write the Casket pointer.
 *   - An agent created a task via `cc-cli task create` without
 *     setting --assignee.
 *   - A member whose Casket pointed at this task got archived
 *     without the task being reassigned.
 *
 * Left alone, orphan tasks chain-stall downstream tasks that
 * dependsOn them. This sweeper surfaces them so Sexton or the
 * founder can reassign via `cc-cli hand`.
 *
 * Detection per task chit across all active queryable scopes:
 *   - workflowStatus === 'queued' (not in-progress, not blocked,
 *     not already dispatched, not terminal)
 *   - assignee is null / empty / points to a missing or archived
 *     member
 *   - Task has no active blocker (dependsOn array empty OR all
 *     referenced blockers are in terminal-success — i.e. nothing
 *     is actually blocking forward motion)
 *
 * The "no active blocker" check exists because a queued task
 * legitimately sits without dispatch while it waits on a dep
 * (that's 1.4.1 blocker flow, not orphan). Only truly stranded
 * tasks get flagged.
 *
 * Severity: warn. Not data corruption, but a chain stall wants
 * human attention within hours.
 *
 * No auto-action — assignment is judgment. Sexton reads, decides
 * whether the right reassignment is to a specific slot (cc-cli
 * hand --to <slug>) or a role pool (cc-cli hand --to <role>).
 */

import { readConfig, type Member, MEMBERS_JSON, queryChits, findChitById, type TaskFields } from '@claudecorp/shared';
import { join } from 'node:path';
import { log } from '../../logger.js';
import type { SweeperContext, SweeperResult, SweeperFinding } from './types.js';

export async function runOrphantask(ctx: SweeperContext): Promise<SweeperResult> {
  const { daemon } = ctx;
  const findings: SweeperFinding[] = [];
  let orphans = 0;

  // Members.json for assignee-resolution. Anything not in here or
  // archived is an orphan-making pointer.
  let members: Member[];
  try {
    members = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
  } catch (err) {
    return {
      status: 'failed',
      findings: [],
      summary: `orphantask: members.json read failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const activeMemberIds = new Set(members.filter((m) => m.status !== 'archived').map((m) => m.id));

  // Scan active task chits across all scopes (corp + projects +
  // teams). queryChits walks all discoverable scopes when scopes
  // is absent.
  let taskResult;
  try {
    taskResult = queryChits<'task'>(daemon.corpRoot, {
      types: ['task'],
      statuses: ['active'],
    });
  } catch (err) {
    return {
      status: 'failed',
      findings: [],
      summary: `orphantask: task query failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  for (const item of taskResult.chits) {
    const task = item.chit.fields.task as TaskFields;

    // Only queued tasks qualify. in_progress/under_review/blocked
    // all imply someone owns the task or it's legitimately waiting.
    if (task.workflowStatus !== 'queued') continue;

    // Does it have an assignee that resolves to an active Member?
    const assignee = typeof task.assignee === 'string' ? task.assignee : null;
    if (assignee && activeMemberIds.has(assignee)) continue;

    // Does it have an unresolved blocker? If dependsOn is present
    // and at least one referenced chit is NOT in a terminal-success
    // state, the task is blocked (not orphan).
    const dependsOn = Array.isArray(item.chit.dependsOn) ? item.chit.dependsOn : [];
    if (dependsOn.length > 0) {
      let hasActiveBlocker = false;
      for (const depId of dependsOn) {
        const hit = findChitById(daemon.corpRoot, depId);
        if (!hit) {
          // Broken dep pointer — that's chit-hygiene's problem.
          // Treat as "blocker unresolved" conservatively (don't
          // flag as orphan, since the real issue is the broken
          // pointer not the orphan shape).
          hasActiveBlocker = true;
          break;
        }
        const depStatus = hit.chit.status;
        // terminal-success statuses for deps vary by type; tasks
        // use 'completed'. Anything non-terminal = active blocker.
        if (depStatus !== 'completed' && depStatus !== 'closed') {
          hasActiveBlocker = true;
          break;
        }
      }
      if (hasActiveBlocker) continue;
    }

    // Task is queued, unassigned (or assignee archived/missing),
    // and has no active blocker. It's an orphan.
    orphans++;
    const assigneeNote = assignee
      ? `assignee "${assignee}" is missing or archived`
      : `no assignee set`;
    findings.push({
      subject: item.chit.id,
      severity: 'warn',
      title: `Orphan task ${item.chit.id}: ${(task.title ?? '(no title)').slice(0, 60)}`,
      body: `Task chit ${item.chit.id} is workflowStatus='queued' with ${assigneeNote}. No active blocker — forward motion is stalled only because nobody owns the work. Reassign via \`cc-cli hand --to <slot-or-role> --chit ${item.chit.id}\`. Original title: "${task.title ?? '(no title)'}". Priority: ${task.priority ?? 'unset'}. Complexity: ${task.complexity ?? 'unset'}.`,
    });
    log(`[sweeper:orphantask] orphan ${item.chit.id} (${assigneeNote})`);
  }

  if (orphans === 0) {
    return {
      status: 'noop',
      findings: [],
      summary: `orphantask: no orphan tasks (scanned ${taskResult.chits.length} active tasks).`,
    };
  }

  return {
    status: 'completed',
    findings,
    summary: `orphantask: ${orphans} orphan task(s) (scanned ${taskResult.chits.length}).`,
  };
}
