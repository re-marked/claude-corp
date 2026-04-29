/**
 * CLAUDE.md template — the always-on system-prompt anchor for Claude
 * Code agents.
 *
 * Claude Code auto-discovers `CLAUDE.md` in the cwd and inlines its
 * `@path` imports at load time on every dispatch. We use that to route
 * Claude Corp's workspace files (SOUL, IDENTITY, AGENTS, …) into the
 * system prompt without shipping the content as one big blob — imports
 * resolve fresh per turn, so edits to the source files propagate
 * immediately without CLAUDE.md regeneration.
 *
 * Structure:
 *   1. Display-name heading ("# I am <Name>") so the agent's opening
 *      frame is self-referential.
 *   2. Preamble — verbatim SOUL embodiment instruction (borrowed from
 *      OpenClaw's phrasing; it's load-bearing) plus one-liner reminders
 *      about non-negotiable RULES and per-turn state awareness.
 *   3. @imports grouped by purpose: identity, bootstrap, tools+founder,
 *      memory index, heartbeat, current state.
 *   4. Read-on-demand footer listing BRAIN/ chits/observation/ WORKLOG —
 *      large, contextual, fetched reactively with the Read tool.
 *
 * Only generated for agents with harness='claude-code'. OpenClaw
 * agents skip CLAUDE.md entirely — their gateway reads the same files
 * natively via workspace bootstrap.
 */

// ─── Thin CLAUDE.md (Project 0.7 — the survival anchor shape) ─────

import type { CorpMdKind } from './corp-md.js';

/**
 * Options for the thin CLAUDE.md template. Kind/role drive the single
 * critical lifecycle rule; corpName + workspacePath are interpolated
 * into the directory-discipline + identity lines.
 */
export interface ThinClaudeMdOpts {
  kind: CorpMdKind;
  displayName: string;
  role: string;
  corpName: string;
  workspacePath: string;
}

/**
 * Build the thin CLAUDE.md shell for a Claude Code agent under the
 * Project 0.7 architecture — survival anchor only, no reference
 * content. The full corp manual + situational context is injected
 * dynamically at SessionStart / PreCompact by \`cc-cli wtf\`
 * (wired in 0.7.2 part B via .claude/settings.json hooks; this
 * template just establishes the shape agents see).
 *
 * What's @imported here: ONLY agent-authored files (SOUL, IDENTITY,
 * USER, MEMORY) and live operational state (STATUS, TASKS). AGENTS.md
 * and TOOLS.md are intentionally absent — their content moved to
 * CORP.md sections, rendered dynamically by wtf.
 *
 * The single critical rule varies by kind — Employees need to know
 * about hand-complete + the Stop audit hook; Partners need to know
 * about /compact + the PreCompact audit + the never-push-to-main
 * Partner-only red line.
 */
export function buildThinClaudeMd(opts: ThinClaudeMdOpts): string {
  const criticalRule = opts.kind === 'employee'
    ? `Your task ends with \`cc-cli done\`. The Stop hook will audit
your work first — you cannot exit a session until audit passes.`
    : `Your context ends with \`/compact\`. The PreCompact hook audits first
— you cannot compact until audit passes. Never push to main directly,
ever. That's corp-breaking.`;

  // Soul-file @imports are Partner-only. Project 1.1's DNA split says
  // Employees don't have soul at the slot level — no SOUL, no USER, no
  // MEMORY/BRAIN. Their identity is captured by role + displayName in
  // members.json and rendered dynamically into CORP.md's Role section
  // via the role registry. @importing files Employees don't have would
  // log "import not found" warnings every dispatch; kind-conditional
  // rendering keeps the prompt honest.
  const soulFilesSection = opts.kind === 'partner'
    ? `## Your soul files (agent-authored, persist across sessions)

@./SOUL.md
@./IDENTITY.md
@./USER.md
@./MEMORY.md`
    : `## Your identity

You don't have soul files at the slot level — Employees are ephemeral
role-slots; identity lives at the role-registry level, not per-slot.
Your role (\`${opts.role}\`) is rendered into CORP.md dynamically by
\`cc-cli wtf\`, always current. When you earn promotion to Partner
(\`cc-cli tame\`), soul files get created; until then, your role is
your identity.`;

  return `# ${opts.displayName}

You are ${opts.displayName}, a ${opts.role} (${opts.kind}) in the ${opts.corpName} corporation.

## Survival protocol

If your context has been compacted, this is a fresh session, or you're
disoriented at any point: run \`cc-cli wtf\` in a Bash tool call. It
regenerates CORP.md in your workspace and emits a small situational
header as a \`<system-reminder>\`. The corp manual itself reaches you
via \`@./CORP.md\` below — claude-code re-resolves the import every
turn, so a fresh wtf is reflected immediately.

## Workspace discipline

You live at \`${opts.workspacePath}\`. Stay here. Other agents' workspaces
are off-limits — you can read shared corp files (members.json, channels,
chits) but never write outside your own sandbox.

## The single critical rule

${criticalRule}

${soulFilesSection}

## The corp manual

@./CORP.md

This is the corp's full ops reference — chits, casket, audit, hand,
patrols, commands, escalation, the works. Regenerated on every
SessionStart by \`cc-cli wtf\`, so what you see here is current as
of this turn. Re-run \`cc-cli wtf\` mid-session if state changed
materially and you need a fresh snapshot.

## Your live operational state

@./STATUS.md
@./TASKS.md

## Your inbox

Inbox items are chits, not a file. Run \`cc-cli inbox list\` to see open
ones. Your wtf header shows the summary: count per tier, most-recent
peek. Tier 3 items block session completion via the Stop / PreCompact
audit hook — resolve them before trying to end your turn.

## What you'll get dynamically

SessionStart auto-runs \`cc-cli wtf\`. wtf rewrites CORP.md on disk
(picked up by the \`@./CORP.md\` import above) and emits a short
situational header as a \`<system-reminder>\`. Two paths, one source
of truth — wtf decides what's current, you read it via @import.
Don't \`@import\` AGENTS.md or TOOLS.md; those no longer exist as
workspace files (their content moved into CORP.md sections).
`;
}

