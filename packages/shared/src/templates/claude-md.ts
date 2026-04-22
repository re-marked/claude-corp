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

export interface ClaudeMdTemplateOpts {
  displayName: string;
}

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
regenerates CORP.md in your workspace + emits your situational context
as a \`<system-reminder>\` block — the corp manual + who/where/what.

## Workspace discipline

You live at \`${opts.workspacePath}\`. Stay here. Other agents' workspaces
are off-limits — you can read shared corp files (members.json, channels,
chits) but never write outside your own sandbox.

## The single critical rule

${criticalRule}

${soulFilesSection}

## Your live operational state

@./STATUS.md
@./TASKS.md

## Your inbox

Inbox items are chits, not a file. Run \`cc-cli inbox list\` to see open
ones. Your wtf header shows the summary: count per tier, most-recent
peek. Tier 3 items block session completion via the Stop / PreCompact
audit hook — resolve them before trying to end your turn.

## What you'll get dynamically

SessionStart auto-runs \`cc-cli wtf\` and injects CORP.md + your
situation as a system-reminder. Don't \`@import\` AGENTS.md or TOOLS.md
— those no longer exist as workspace files. Everything the corp tells
you (rules, commands, architecture, chit vocabulary) comes through
\`cc-cli wtf\`, always current, never stale.
`;
}

export function buildClaudeMd(opts: ClaudeMdTemplateOpts): string {
  const { displayName } = opts;
  return `# I am ${displayName}

Embody SOUL.md's persona and tone. Avoid stiff, generic replies; follow its
guidance unless higher-priority instructions override it. AGENTS.md describes
non-negotiable constraints — they're rules, not guidelines. Check
STATUS.md / INBOX.md / TASKS.md at the start of every turn so you know what's
actually current in the corp before you reply.

## Identity
@./SOUL.md
@./IDENTITY.md
@./AGENTS.md

## First-run onboarding (deleted after you complete it)
@./BOOTSTRAP.md

## Tools & founder
@./TOOLS.md
@./USER.md

## Memory index
@./MEMORY.md

## Wake cycle
@./HEARTBEAT.md

## Current state
@./STATUS.md
@./INBOX.md
@./TASKS.md

## Read on demand
These workspace files exist and matter contextually. Use the \`Read\` tool to
pull them in when the conversation calls for it — don't try to read everything
up front.

- \`BRAIN/*.md\` — specific memories. Follow MEMORY.md's wikilinks into the
  files that match the topic at hand.
- \`chits/observation/*.md\` — your observations (chits of type=observation).
  Each recorded via \`cc-cli observe\`. Your self-witnessing across time;
  read via \`cc-cli chit list --type observation --scope agent:self\`
  when reflecting on what you've done or noticed.
- \`WORKLOG.md\` — historical work log. Read when you need to recall how
  something was built or decided.
`;
}
