/**
 * `phantom-cleanup` sweeper — reconcile members.json with on-disk
 * workspace directories.
 *
 * Two complementary detection directions:
 *
 *   1. Phantom member — a Member record with agentDir that doesn't
 *      exist on disk. Dispatch fails silently for these (the
 *      harness can't cd into their workspace). Severity=warn
 *      because dispatching to them is broken until fixed.
 *
 *   2. Phantom workspace — a directory at a known agent-workspace
 *      path (`agents/<slug>`, `projects/<name>/agents/<slug>`,
 *      `projects/<name>/teams/<team>/agents/<slug>`) with no
 *      matching Member entry. Usually leftover from imperfect
 *      cleanup after `cc-cli fire` or a failed hire. Severity=info
 *      because disk clutter doesn't actively break anything; it
 *      just accumulates.
 *
 * How phantom members happen:
 *   - Hire partially succeeded: Member written, workspace creation
 *     failed or got partially rolled back.
 *   - External filesystem edit: someone rm -rf'd an agent directory
 *     directly rather than going through cc-cli fire.
 *   - Corp move / restore from backup lost workspace files.
 *
 * How phantom workspaces happen:
 *   - `cc-cli fire` marked the Member archived but left the
 *     workspace on disk (by design — git-track the state; founder
 *     decides when to cleanup).
 *   - Member was deleted from members.json directly, or a hire-
 *     script created a workspace without writing the Member.
 *
 * ### What this does NOT do
 *
 * No auto-cleanup. Both deletion paths are destructive:
 *   - Removing a Member record loses audit history.
 *   - rm -rf'ing a workspace loses the agent's SOUL, BRAIN,
 *     observations, WORKLOG — all soul material.
 *
 * Founder/Sexton reads the findings and decides. Sexton might
 * escalate the phantom-member cases (blocking dispatch); founder
 * does the destructive cleanup manually after review.
 */

import { readConfig, type Member, MEMBERS_JSON } from '@claudecorp/shared';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { log } from '../../logger.js';
import type { SweeperContext, SweeperResult, SweeperFinding } from './types.js';

/**
 * The agent-workspace roots phantom-cleanup knows how to walk.
 * Anything outside these paths isn't scanned — keeps the
 * scope bounded, matches the corp's actual folder conventions.
 */
function agentContainerPaths(corpRoot: string): string[] {
  const paths: string[] = [];

  // Corp-level agents/
  const corpAgents = join(corpRoot, 'agents');
  if (existsSync(corpAgents)) paths.push(corpAgents);

  // projects/<name>/agents and projects/<name>/teams/<team>/agents
  const projectsRoot = join(corpRoot, 'projects');
  if (!existsSync(projectsRoot)) return paths;

  for (const projectName of safeReaddir(projectsRoot)) {
    const projectDir = join(projectsRoot, projectName);
    if (!isDirectory(projectDir)) continue;

    const projectAgents = join(projectDir, 'agents');
    if (existsSync(projectAgents)) paths.push(projectAgents);

    const teamsDir = join(projectDir, 'teams');
    if (!existsSync(teamsDir)) continue;

    for (const teamName of safeReaddir(teamsDir)) {
      const teamDir = join(teamsDir, teamName);
      if (!isDirectory(teamDir)) continue;
      const teamAgents = join(teamDir, 'agents');
      if (existsSync(teamAgents)) paths.push(teamAgents);
    }
  }

  return paths;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveMemberWorkspace(corpRoot: string, agentDir: string): string {
  return isAbsolute(agentDir) ? agentDir : join(corpRoot, agentDir);
}

export async function runPhantomCleanup(ctx: SweeperContext): Promise<SweeperResult> {
  const { daemon } = ctx;
  const findings: SweeperFinding[] = [];
  let phantomMembers = 0;
  let phantomWorkspaces = 0;
  let scannedMembers = 0;
  let scannedWorkspaces = 0;

  let members: Member[];
  try {
    members = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
  } catch (err) {
    return {
      status: 'failed',
      findings: [],
      summary: `phantom-cleanup: members.json read failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Direction 1: Phantom members. For each agent Member with
  // agentDir set, verify the directory exists.
  //
  // Skip archived Members — `cc-cli fire` deliberately leaves the
  // Member record but may or may not leave the workspace; either
  // state is legitimate for an archived slot.
  for (const member of members) {
    if (member.type !== 'agent') continue;
    if (member.status === 'archived') continue;
    if (!member.agentDir) continue; // no workspace declared — nothing to check

    scannedMembers++;

    const resolved = resolveMemberWorkspace(daemon.corpRoot, member.agentDir);
    if (existsSync(resolved)) continue;

    phantomMembers++;
    findings.push({
      subject: member.id,
      severity: 'warn',
      title: `Phantom member ${member.displayName}: agentDir missing`,
      body: `Member ${member.displayName} (${member.id}) has agentDir="${member.agentDir}" but the directory doesn't exist at ${resolved}. Dispatch to this slot will fail silently (harness can't cd into a missing workspace). Likely causes: partial hire failure, external rm -rf, corp restore lost files. Fix via re-hire + migrate data, or \`cc-cli remove --agent ${member.id}\` to clean up the Member record if the slot is truly gone.`,
    });
    log(`[sweeper:phantom-cleanup] phantom member ${member.id} (agentDir=${member.agentDir})`);
  }

  // Direction 2: Phantom workspaces. For each dir at a known
  // agent-container path, check whether any Member (including
  // archived) claims it. Archived members legitimately hold
  // workspaces — we only flag dirs with NO Member at all.
  const knownAgentDirs = new Set<string>();
  for (const member of members) {
    if (member.type !== 'agent' || !member.agentDir) continue;
    knownAgentDirs.add(resolveMemberWorkspace(daemon.corpRoot, member.agentDir));
  }

  for (const containerPath of agentContainerPaths(daemon.corpRoot)) {
    for (const slug of safeReaddir(containerPath)) {
      const slotDir = join(containerPath, slug);
      if (!isDirectory(slotDir)) continue;
      scannedWorkspaces++;

      if (knownAgentDirs.has(slotDir)) continue;

      phantomWorkspaces++;
      findings.push({
        subject: slotDir,
        severity: 'info',
        title: `Phantom workspace: ${slotDir.replace(daemon.corpRoot, '').replace(/^[/\\]/, '')}`,
        body: `Directory ${slotDir} looks like an agent workspace (located under an agents/ container) but no Member in members.json claims it. Usually leftover from a fire that didn't clean up disk state, or a manual members.json edit. No active impact — dispatch isn't affected — but the directory will stay on disk indefinitely. Review + remove manually if the slot is truly gone.`,
      });
      log(`[sweeper:phantom-cleanup] phantom workspace ${slotDir}`);
    }
  }

  if (phantomMembers === 0 && phantomWorkspaces === 0) {
    return {
      status: 'noop',
      findings: [],
      summary: `phantom-cleanup: no phantoms (scanned ${scannedMembers} member dirs + ${scannedWorkspaces} workspace dirs).`,
    };
  }

  return {
    status: 'completed',
    findings,
    summary: `phantom-cleanup: ${phantomMembers} phantom member(s), ${phantomWorkspaces} phantom workspace(s). Scanned ${scannedMembers} + ${scannedWorkspaces}.`,
  };
}
