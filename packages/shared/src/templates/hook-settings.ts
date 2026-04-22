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
 * One entry in a hook array — Claude Code's hook config schema.
 * Expanded if we ever need matcher/type filtering; for now every hook
 * we wire runs unconditionally when the event fires.
 */
export interface HookEntry {
  command: string;
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
    SessionStart: [{ command: `cc-cli wtf --agent ${slug} --hook` }],
    Stop: [{ command: `cc-cli audit --agent ${slug}` }],
  };

  // PreCompact + UserPromptSubmit are Partner-only:
  //   - Employees don't compact (per-step handoff via WORKLOG instead)
  //   - Employees don't receive founder DMs mid-session (Partners broker)
  if (opts.kind === 'partner') {
    hooks.PreCompact = [{ command: `cc-cli wtf --agent ${slug} --hook` }];
    hooks.UserPromptSubmit = [{ command: `cc-cli inbox check --agent ${slug} --inject` }];
  }

  return { hooks };
}
