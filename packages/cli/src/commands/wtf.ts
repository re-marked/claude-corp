/**
 * cc-cli wtf — the "where tf am I, what tf do I need to do" command.
 *
 * The Claude Code CLI path of Project 0.7. Orchestration + templates
 * live in @claudecorp/shared's `buildWtfOutput` (so the OpenClaw daemon
 * harness can call the exact same code path at dispatch-prepend time
 * without drift). This module is the thin I/O wrapper: argv parsing,
 * member resolution, visible error paths, CORP.md write, system-reminder
 * emission.
 *
 * Failure modes (spec-mandated, all tested):
 *   - Missing --agent → exit 1 with usage.
 *   - Member not found → emit visible error + exit 1.
 *   - Corrupted Casket → emit degraded context + exit 0 so hooks
 *     don't fail catastrophically.
 *   - Daemon not running → fine, wtf reads local files + chit store.
 */

import { atomicWriteSync, buildWtfOutput } from '@claudecorp/shared';
import { getCorpRoot, getMembers } from '../client.js';

// Re-export the pure helpers from shared so existing tests (which
// import them from this module) keep working without reach-through.
export { inferKind, formatAge } from '@claudecorp/shared';

// ─── CLI entry ──────────────────────────────────────────────────────

export interface WtfOpts {
  agent?: string;
  corp?: string;
  hook: boolean;
  json: boolean;
}

export async function cmdWtf(opts: WtfOpts): Promise<void> {
  if (!opts.agent) {
    emitUsageError();
    process.exit(1);
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const corpName = corpRoot.split(/[/\\]/).pop() ?? 'corp';

  const members = getMembers(corpRoot);
  const member = members.find((m) => m.id === opts.agent);
  if (!member) {
    emitMemberNotFoundError(opts.agent, members.map((m) => m.id));
    process.exit(1);
  }

  if (member.type !== 'agent') {
    emitNonAgentError(opts.agent, member.type);
    process.exit(1);
  }

  if (!member.agentDir) {
    emitNoWorkspaceError(opts.agent);
    process.exit(1);
  }

  const { header, corpMd, corpMdPath } = buildWtfOutput({
    corpRoot,
    corpName,
    agentSlug: opts.agent,
    displayName: member.displayName,
    rank: member.rank,
    workspacePath: member.agentDir,
    generatedAt: new Date().toISOString(),
    now: new Date(),
    // Project 1.1 — pass explicit kind + role when the member record
    // carries them. buildWtfOutput prefers these over rank-based
    // inference and the role-is-rank display fallback respectively.
    ...(member.kind ? { kind: member.kind } : {}),
    ...(member.role ? { roleId: member.role } : {}),
  });

  // Write CORP.md for the agent to re-read cheaply without spawning wtf again.
  try {
    atomicWriteSync(corpMdPath, corpMd);
  } catch (err) {
    // Non-fatal: stdout injection still works even if disk write fails.
    process.stderr.write(
      `wtf: could not write ${corpMdPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ header, corpMd, corpMdPath }, null, 2) + '\n',
    );
    return;
  }

  emitSystemReminder(header, corpMd);
}

// ─── Output ─────────────────────────────────────────────────────────

function emitSystemReminder(header: string, corpMd: string): void {
  process.stdout.write('<system-reminder>\n');
  process.stdout.write(header);
  process.stdout.write('\n---\n\n');
  process.stdout.write(corpMd);
  process.stdout.write('</system-reminder>\n');
}

function emitUsageError(): void {
  process.stderr.write(
    [
      'Usage: cc-cli wtf --agent <slug> [--corp <name>] [--hook] [--json]',
      '',
      'Emits the agent\'s orchestration manual + situational header.',
      'Wired to SessionStart / PreCompact hooks for automatic injection.',
      '',
      '  --agent <slug>   Member id to render for (required).',
      '  --corp <name>    Explicit corp (defaults to daemon\'s corp, or only corp).',
      '  --hook           Set when invoked by a Claude Code hook (reserved; same output today).',
      '  --json           Emit {header, corpMd, corpMdPath} JSON instead of system-reminder.',
      '',
    ].join('\n'),
  );
}

function emitMemberNotFoundError(slug: string, available: readonly string[]): void {
  process.stdout.write('<system-reminder>\n');
  process.stdout.write(`cc-cli wtf: no member with id "${slug}".\n`);
  if (available.length > 0) {
    process.stdout.write('\nAvailable members:\n');
    for (const id of available.slice(0, 20)) process.stdout.write(`  ${id}\n`);
    if (available.length > 20) {
      process.stdout.write(`  ... and ${available.length - 20} more\n`);
    }
  } else {
    process.stdout.write('\nThis corp has no members yet. Run `cc-cli init` or hire an agent first.\n');
  }
  process.stdout.write('</system-reminder>\n');
}

function emitNonAgentError(slug: string, memberType: string): void {
  process.stdout.write('<system-reminder>\n');
  process.stdout.write(
    `cc-cli wtf: member "${slug}" is a ${memberType}, not an agent. wtf is for agents.\n`,
  );
  process.stdout.write('</system-reminder>\n');
}

function emitNoWorkspaceError(slug: string): void {
  process.stdout.write('<system-reminder>\n');
  process.stdout.write(
    `cc-cli wtf: agent "${slug}" has no workspace directory (agentDir is null). Re-hire or run 'cc-cli agent repair --agent ${slug}'.\n`,
  );
  process.stdout.write('</system-reminder>\n');
}
