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
 *   4. Read-on-demand footer listing BRAIN/ observations/ WORKLOG —
 *      large, contextual, fetched reactively with the Read tool.
 *
 * Only generated for agents with harness='claude-code'. OpenClaw
 * agents skip CLAUDE.md entirely — their gateway reads the same files
 * natively via workspace bootstrap.
 */

export interface ClaudeMdTemplateOpts {
  displayName: string;
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
- \`observations/*.md\` — your daily journal entries, your self-witnessing
  across time. Read them when reflecting on what you've done or noticed.
- \`WORKLOG.md\` — historical work log. Read when you need to recall how
  something was built or decided.
`;
}
