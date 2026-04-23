/**
 * Claude Code `.claude/settings.json` generator for Project 0.7.2.
 *
 * Wires four lifecycle hooks to the corresponding cc-cli commands so
 * Claude Code sessions auto-inject CORP.md + situational context
 * (SessionStart / PreCompact), block completion until audit passes
 * (Stop), and inject new inbox items mid-session (UserPromptSubmit).
 *
 * Kind-aware — Employees get fewer hooks because they don't compact
 * (per-step handoff model) and don't receive founder DMs mid-session
 * (Partners broker all founder↔Employee traffic):
 *
 *   Employee: SessionStart + Stop                   (2 hooks)
 *   Partner:  SessionStart + PreCompact + Stop +    (4 hooks)
 *             UserPromptSubmit
 *
 * Shape note (why the nesting). Claude Code's settings.json schema for
 * hooks is two-level: each event maps to an array of `{matcher, hooks}`
 * groups, where `hooks` is itself an array of `{type, command}`
 * entries. The outer `matcher` filters by tool name for tool-scoped
 * hooks (PreToolUse/PostToolUse); for Stop/SessionStart/PreCompact/
 * UserPromptSubmit the matcher has no semantic effect but must still
 * be present and a string. An earlier version of this file emitted the
 * flat `{command}` shape, which Claude Code rejected at settings-parse
 * time — skipping the entire settings file. The probe at
 * `scripts/audit-gate-probe/` is the regression harness that catches
 * this class of schema drift.
 *
 * The `Stop` hook command shell (`cc-cli audit`) lands in 0.7.3; until
 * then it's a stub that exits 0 (allows stops) so these settings
 * files are safe to ship to fresh hires. Once 0.7.3 ships, existing
 * agents pick up the real audit gate automatically because the same
 * command path is reached.
 *
 * Pure function, no I/O. Agent-setup (a later PR) serializes the
 * returned object + writes to `<workspacePath>/.claude/settings.json`.
 */

import type { CorpMdKind } from './corp-md.js';

export interface HookSettingsOpts {
  kind: CorpMdKind;
  /** Agent slug — baked into each hook command's `--agent <slug>` flag. */
  agentSlug: string;
}

/**
 * Innermost entry — the command Claude Code actually invokes when the
 * hook fires. `type: 'command'` is the only variant we use; Claude
 * Code supports other types (e.g. MCP-server-backed hooks) but they're
 * not in scope for Claude Corp.
 */
export interface HookCommand {
  type: 'command';
  command: string;
}

/**
 * One matcher group for an event. `matcher` is a string filter (tool
 * name, pipe-separated list, or empty-for-match-all). For the four
 * events Claude Corp wires, the matcher has no semantic effect — we
 * pass empty string to match all triggers.
 */
export interface HookEntry {
  matcher: string;
  hooks: HookCommand[];
}

/**
 * Full `.claude/settings.json` shape. Only the `hooks` key is populated
 * by this generator; if the user adds custom claude-code settings
 * (e.g. permissions, env), they do so by hand — regeneration via
 * rewire (0.7.5) preserves unknown keys.
 */
export interface HookSettings {
  hooks: {
    SessionStart?: HookEntry[];
    PreCompact?: HookEntry[];
    Stop?: HookEntry[];
    UserPromptSubmit?: HookEntry[];
  };
}

/**
 * Wrap raw command strings into Claude Code's expected nested shape.
 * All four events Claude Corp wires use a catch-all matcher, so we
 * factor the wrapping into one helper. Multiple commands under the
 * same matcher land in one `hooks` array — Claude Code runs them in
 * order, and a blocking decision from an earlier command short-
 * circuits later ones. We rely on that for PreCompact (audit first,
 * wtf after).
 */
function commandEntry(...commands: string[]): HookEntry {
  return {
    matcher: '',
    hooks: commands.map((command) => ({ type: 'command', command })),
  };
}

/**
 * Build the settings.json contents for an agent workspace.
 *
 * Every hook command bakes in `--agent <slug>` so the CLI knows which
 * member record to resolve — Claude Code hooks don't inherit shell env
 * reliably across platforms, so we pass the slug explicitly.
 *
 * The `--hook` flag on wtf invocations is reserved for future
 * hook-specific output formatting (MVP: identical output with or
 * without the flag). Keeping it in the command line now avoids
 * needing a settings migration when we diverge behaviors later.
 */
export function buildHookSettings(opts: HookSettingsOpts): HookSettings {
  const slug = opts.agentSlug;

  // SessionStart + Stop are universal — both kinds get wtf-on-boot
  // and audit-gated session-end.
  const hooks: HookSettings['hooks'] = {
    SessionStart: [commandEntry(`cc-cli wtf --agent ${slug} --hook`)],
    Stop: [commandEntry(`cc-cli audit --agent ${slug}`)],
  };

  // PreCompact + UserPromptSubmit are Partner-only:
  //   - Employees don't compact (per-step handoff via WORKLOG instead)
  //   - Employees don't receive founder DMs mid-session (Partners broker)
  //
  // PreCompact gets a two-command sequence: audit first (gates
  // compaction — if audit blocks, compact doesn't happen), then wtf
  // (refreshes CORP.md + situational header so the post-compact
  // summary is built against current context, not stale fragments).
  // Order matters: audit must run before wtf so a blocked compact
  // doesn't waste the wtf render. Claude Code executes hook entries
  // sequentially within an event, and a block decision on audit
  // short-circuits — wtf won't run if audit blocked.
  if (opts.kind === 'partner') {
    hooks.PreCompact = [
      commandEntry(
        `cc-cli audit --agent ${slug}`,
        `cc-cli wtf --agent ${slug} --hook`,
      ),
    ];
    hooks.UserPromptSubmit = [commandEntry(`cc-cli inbox check --agent ${slug} --inject`)];
  }

  return { hooks };
}
