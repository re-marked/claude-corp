/**
 * Dream Prompt — adapted from Claude Code's consolidationPrompt.ts
 * for Claude Corp's agent workspace structure.
 *
 * Original: services/autoDream/consolidationPrompt.ts
 * Key differences:
 *   - Uses BRAIN/ directory instead of flat memory root
 *   - Uses MEMORY.md as index (their ENTRYPOINT_NAME equivalent)
 *   - Sources from WORKLOG.md session boundaries (not JSONL transcripts)
 *   - Bash is unrestricted (agents have full workspace access)
 *   - Adds corp context (STATUS.md, recent task completions)
 */

export function buildDreamPrompt(opts: {
  agentName: string;
  agentDir: string;
  corpRoot: string;
  sessionsSince: number;
  hoursSinceLast: number;
}): string {
  return `# Dream: Memory Consolidation

You are ${opts.agentName}, performing a dream — a reflective pass over your memory and experience. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Your workspace: \`${opts.agentDir}\`
Corp root: \`${opts.corpRoot}\`

It has been ${opts.hoursSinceLast.toFixed(0)} hours since your last consolidation. ${opts.sessionsSince} work sessions have accumulated.

---

## Phase 1 — Orient

- Read \`MEMORY.md\` to understand your current memory index
- \`ls BRAIN/\` to see what topic files already exist
- Skim existing topic files so you improve them rather than creating duplicates
- Read \`WORKLOG.md\` to see your recent session boundaries and what you worked on

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in priority order:

1. **WORKLOG.md session summaries** — what you worked on, what decisions were made, what shipped
2. **TASKS.md** — completed tasks with acceptance criteria and outcomes
3. **Existing BRAIN/ memories that drifted** — facts that may be outdated given recent work
4. **STATUS.md** — current corp state, recent completions, any patterns worth noting
5. **INBOX.md** — unprocessed signals that contain learnable patterns

Don't exhaustively read everything. Look only for things that matter for future you.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a topic file in \`BRAIN/\`:

**What to save:**
- Project decisions and their reasoning (WHY, not just WHAT)
- Patterns you discovered in the codebase or in agent collaboration
- Mistakes and what you learned from them
- User preferences and working style observations
- Technical knowledge gained (file paths, architecture patterns, build commands)
- Relationships: who does what well, who to escalate to, communication patterns

**How to save:**
- Use markdown files with clear titles: \`BRAIN/auth-system.md\`, \`BRAIN/team-dynamics.md\`
- Each file should be self-contained and useful to a future session with zero context
- Merge new signal into existing topic files rather than creating near-duplicates
- Convert relative dates ("yesterday", "last session") to absolute dates
- Delete contradicted facts — if new work disproves an old memory, fix it at the source
- Keep each topic file under 200 lines — split if growing too large

**What NOT to save:**
- Raw task descriptions (already in task files)
- Code snippets (already in the codebase — just reference file paths)
- Temporary debugging state
- Anything derivable from git history

## Phase 4 — Prune and index

Update \`MEMORY.md\` so it stays under 200 lines:

- It is an **index**, not a dump — each entry should be one line under 150 characters:
  \`- [Title](BRAIN/file.md) — one-line hook\`
- Never write memory content directly into MEMORY.md
- Remove pointers to memories that are stale, wrong, or superseded
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one
- Group entries semantically by topic, not chronologically

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing meaningful changed (memories are already tight), say "DREAM_CLEAN" and nothing else.`;
}
