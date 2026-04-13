/**
 * Dream Prompt — adapted from Claude Code's consolidationPrompt.ts
 * for Claude Corp's agent workspace structure.
 *
 * Original: services/autoDream/consolidationPrompt.ts
 * Key differences:
 *   - Uses BRAIN/ directory instead of flat memory root
 *   - Uses MEMORY.md as index
 *   - Sources from REAL conversations: DMs, #general, #tasks, activity
 *   - Agents have full workspace access
 *   - Corp-specific context: STATUS.md, task completions, Herald narration
 */

export interface DreamPromptOpts {
  agentName: string;
  agentDir: string;
  corpRoot: string;
  sessionsSince: number;
  hoursSinceLast: number;
  /** Path to the agent's DM channel with the founder (highest signal) */
  dmChannelPath: string | null;
  /** Path to #general channel (corp-wide context) */
  generalChannelPath: string | null;
  /** Path to #tasks channel (task events, completions) */
  tasksChannelPath: string | null;
  /** Recent agent names + what they're working on */
  agentSummaries: string[];
}

export function buildDreamPrompt(opts: DreamPromptOpts): string {
  // Build the signal sources section based on what channels exist
  const sources: string[] = [];
  let sourceNum = 1;

  // DM with founder is the highest-signal source
  if (opts.dmChannelPath) {
    sources.push(`${sourceNum}. **Your DM with the Founder** — \`${opts.dmChannelPath}/messages.jsonl\`
   This is your most important signal source. Grep the last ~50 lines for recent conversations:
   \`tail -100 "${opts.dmChannelPath}/messages.jsonl" | grep -o '"content":"[^"]*"' | tail -30\`
   Look for: direct instructions, feedback on your work, preferences, decisions, corrections`);
    sourceNum++;
  }

  // WORKLOG.md for session summaries
  sources.push(`${sourceNum}. **WORKLOG.md** — your recent session log
   Read the last few session summaries. What did you work on? What shipped? What failed?`);
  sourceNum++;

  // Observation logs — structured daily activity records (highest-structure source)
  sources.push(`${sourceNum}. **Observation logs** — \`${opts.agentDir}/observations/\`
   These are your daily activity journals — timestamped, categorized entries of what you did.
   List the observations directory, read today's log and yesterday's if they exist.
   Each entry has a category tag: [TASK], [RESEARCH], [DECISION], [BLOCKED], [LEARNED], [CREATED], etc.
   This is your most STRUCTURED signal source — use it to identify patterns:
   - What tasks consumed the most time?
   - What decisions were made and why?
   - What got blocked repeatedly?
   - What did you learn that should be in BRAIN/?`);
  sourceNum++;

  // #general for corp-wide context
  if (opts.generalChannelPath) {
    sources.push(`${sourceNum}. **#general channel** — \`${opts.generalChannelPath}/messages.jsonl\`
   Scan the last ~30 messages for corp-wide context:
   \`tail -60 "${opts.generalChannelPath}/messages.jsonl" | grep -o '"content":"[^"]*"' | tail -20\`
   Look for: announcements, decisions, strategy changes, new hires`);
    sourceNum++;
  }

  // #tasks for task events
  if (opts.tasksChannelPath) {
    sources.push(`${sourceNum}. **#tasks channel** — \`${opts.tasksChannelPath}/messages.jsonl\`
   Scan for recent task completions and events:
   \`tail -40 "${opts.tasksChannelPath}/messages.jsonl" | grep -o '"content":"[^"]*"' | tail -15\`
   Look for: completed tasks, blocked tasks, contract updates, Warden reviews`);
    sourceNum++;
  }

  // TASKS.md + STATUS.md + INBOX.md for workspace state
  sources.push(`${sourceNum}. **Your workspace state files** — TASKS.md, STATUS.md, INBOX.md
   Skim for: completed tasks with outcomes, current corp vitals, pending signals`);
  sourceNum++;

  // Existing memories that may have drifted
  sources.push(`${sourceNum}. **Existing BRAIN/ memories** — check if any facts are now outdated
   Compare what you knew with what the recent conversations reveal`);

  const sourcesText = sources.join('\n\n');

  // Agent context
  const agentContext = opts.agentSummaries.length > 0
    ? `\n\n**Current corp agents:**\n${opts.agentSummaries.map(s => `- ${s}`).join('\n')}`
    : '';

  return `# Dream: Memory Consolidation

You are ${opts.agentName}, performing a dream — a reflective pass over your recent experience. Synthesize what you've learned into durable, well-organized memories so that future sessions can orient quickly.

Your workspace: \`${opts.agentDir}\`
Corp root: \`${opts.corpRoot}\`

It has been ${opts.hoursSinceLast.toFixed(0)} hours since your last consolidation. ${opts.sessionsSince} work sessions have accumulated.${agentContext}

**CRITICAL: You MUST use tools.** Read actual files. Write actual BRAIN/ topic files. Run actual commands. Do NOT just describe what you would do or reply with a summary. Execute every phase below using tools. If there is nothing to consolidate, say DREAM_CLEAN.

---

## Phase 1 — Orient

Execute these commands NOW:
1. \`cat "${opts.agentDir}/MEMORY.md"\` — read your current memory index
2. \`ls "${opts.agentDir}/BRAIN/" 2>/dev/null\` — list existing topic files
3. If any BRAIN/ files exist, read the 1-2 most relevant ones

## Phase 2 — Gather recent signal

Scan these sources for new information worth persisting. **Be selective** — don't read entire files. Grep narrowly, tail recent lines, and look for what matters.

${sourcesText}

**Important:** Don't exhaustively read every channel. Grep for recent messages, scan the tail, look for things that surprised you or changed your understanding. If a source has nothing new, move on.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a topic file in \`BRAIN/\`.

**Every BRAIN/ file MUST have YAML frontmatter:**

\`\`\`yaml
---
type: founder-preference | technical | decision | self-knowledge | correction | relationship
tags: [freeform, tags, for, search]
source: dream
confidence: high | medium | low
created: YYYY-MM-DD
updated: YYYY-MM-DD
last_validated: YYYY-MM-DD
---
\`\`\`

For **new files**: set \`source: dream\`, set all three dates to today, and choose confidence:
- \`high\` — directly stated by founder or confirmed by correction
- \`medium\` — inferred from patterns across multiple observations
- \`low\` — speculative, based on limited data

For **updates to existing files**: preserve \`created\`, update \`updated\` and \`last_validated\` to today.

**Memory types — choose the right one:**
- \`founder-preference\` — what the founder likes, hates, values
- \`technical\` — file paths, build commands, architecture decisions
- \`decision\` — what was decided and WHY (the why matters more)
- \`self-knowledge\` — your own patterns, preferences, style
- \`correction\` — something you got wrong and what you learned
- \`relationship\` — who does what, who to ask for what

**Cross-reference with [[wikilinks]]:**
When a BRAIN/ file relates to another topic, link it: "See [[auth-architecture]] for the related decision." This builds a knowledge graph — the more connections, the richer the memory.

**What to save:**
- Founder preferences, communication style, and working patterns
- Project decisions and their reasoning (WHY, not just WHAT)
- Patterns in agent collaboration — who does what well, who to escalate to
- Mistakes made and lessons learned (yours and others')
- Technical knowledge: file paths, build commands, architecture decisions
- Corp dynamics: recent hires, team changes, strategy shifts
- Recurring tasks and how to handle them efficiently
- **Your own emerging patterns** — what kind of worker you're becoming, what you gravitate toward, what you've gotten better at

**How to save:**
- Use descriptive filenames: \`BRAIN/founder-code-style.md\`, \`BRAIN/auth-architecture.md\`, \`BRAIN/my-working-patterns.md\`
- Each file is self-contained — useful to future you with zero prior context
- Tag generously — tags are how you find memories later
- Merge new signal into existing topics. Never create near-duplicates.
- Convert relative dates to absolute: "yesterday" → "2026-03-31"
- Delete contradicted facts at the source — don't leave wrong memories
- Keep each topic file under 200 lines. Split if growing.

**What NOT to save:**
- Raw task descriptions (already in task files)
- Full conversation transcripts (stay in JSONL)
- Code snippets (reference file paths instead)
- Anything derivable from git log

## Phase 4 — Prune and index

Update \`MEMORY.md\` so it stays under 200 lines:

- It is an **index**, not a dump — each entry: \`- [[filename]] — one-line description\`
- Use \`[[wikilink]]\` format, not markdown links
- Never write content directly into MEMORY.md
- Remove stale, wrong, or superseded pointers
- Add pointers to newly important memories
- Resolve contradictions between files
- Group by type: Founder, Technical, Decisions, Self, Corrections, Relationships

---

Return a brief summary of what you consolidated, updated, or pruned. Format:
- X new topics created
- Y topics updated
- Z stale entries pruned

If nothing meaningful changed, say "DREAM_CLEAN" and nothing else.`;
}
