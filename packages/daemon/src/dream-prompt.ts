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

// ── BRAIN State Renderer ────────────────────────────────────────────

function buildOrientSteps(opts: DreamPromptOpts): string {
  const steps: string[] = [];
  let n = 2;

  if (opts.brainState) {
    steps.push(`${n}. Review the BRAIN state above — you already know what's there`);
    n++;
    steps.push(`${n}. Read the 1-2 most relevant existing BRAIN/ files for context`);
    n++;
    if (opts.brainState.staleFiles.length > 0) {
      steps.push(`${n}. **Read the stale files listed above** — are they still accurate? Validate or delete them.`);
      n++;
    }
    if (opts.brainState.orphanFiles.length > 0) {
      steps.push(`${n}. **Review the orphans** — should they be linked from related memories, or pruned?`);
    }
  } else {
    steps.push(`${n}. List existing BRAIN files: ls "${opts.agentDir}/BRAIN/" 2>/dev/null`);
    n++;
    steps.push(`${n}. If any BRAIN/ files exist, read the 1-2 most relevant ones`);
  }

  return steps.join('\n');
}

function renderBrainState(state: NonNullable<DreamPromptOpts['brainState']>): string {
  const lines: string[] = [];
  lines.push('## Your Current B.R.A.I.N. State\n');

  if (state.files.length === 0) {
    lines.push('Your BRAIN/ is empty. This dream is your first consolidation.\n');
    return '\n' + lines.join('\n') + '\n';
  }

  // File count by type
  const byType = new Map<string, typeof state.files>();
  for (const f of state.files) {
    const arr = byType.get(f.type) || [];
    arr.push(f);
    byType.set(f.type, arr);
  }

  lines.push(`**${state.files.length} memor${state.files.length === 1 ? 'y' : 'ies'}:**`);
  for (const [type, files] of byType) {
    const tagSample = [...new Set(files.flatMap(f => f.tags))].slice(0, 5).join(', ');
    lines.push(`- ${files.length} ${type}${tagSample ? ` (tags: ${tagSample})` : ''}`);
  }
  lines.push('');

  // Stale files — founder-preference files get urgent flag
  if (state.staleFiles.length > 0) {
    const founderStale = state.staleFiles.filter(name =>
      state.files.find(f => f.name === name && f.type === 'founder-preference'),
    );
    const otherStale = state.staleFiles.filter(name =>
      !state.files.find(f => f.name === name && f.type === 'founder-preference'),
    );

    if (founderStale.length > 0) {
      lines.push(`**🔴 URGENT stale founder preferences:** ${founderStale.join(', ')}`);
      lines.push('These are your compass for autonomous decisions. Re-read and validate immediately.\n');
    }
    if (otherStale.length > 0) {
      lines.push(`**⚠ Stale (not validated in 30+ days):** ${otherStale.join(', ')}`);
      lines.push('Re-read these during this dream. Validate if still true, delete if not.\n');
    }
  }

  // Orphans
  if (state.orphanFiles.length > 0) {
    lines.push(`**Orphans (no inbound [[wikilinks]]):** ${state.orphanFiles.join(', ')}`);
    lines.push('Consider linking these from related memories, or pruning if stale.\n');
  }

  // Clusters
  if (state.clusters.length > 0) {
    const multiClusters = state.clusters.filter(c => c.length > 1);
    const isolated = state.clusters.filter(c => c.length === 1);
    if (multiClusters.length > 0) {
      lines.push(`**Knowledge clusters:** ${multiClusters.map(c => `{${c.join(', ')}}`).join('  ')}`);
    }
    if (isolated.length > 0) {
      lines.push(`**Isolated:** ${isolated.map(c => c[0]).join(', ')}`);
    }
    lines.push('');
  }

  // Suggested connections — files with overlapping tags but no wikilink between them
  const suggestions = findSuggestedConnections(state);
  if (suggestions.length > 0) {
    lines.push('**Suggested connections** (shared tags, no link yet):');
    for (const { a, b, sharedTags } of suggestions.slice(0, 5)) {
      lines.push(`- [[${a}]] ↔ [[${b}]] (shared: ${sharedTags.join(', ')})`);
    }
    lines.push('Consider adding [[wikilinks]] between related memories to strengthen the graph.\n');
  }

  return '\n' + lines.join('\n') + '\n';
}

/** Find pairs of BRAIN files that share tags but have no wikilink between them. */
function findSuggestedConnections(
  state: NonNullable<DreamPromptOpts['brainState']>,
): Array<{ a: string; b: string; sharedTags: string[] }> {
  // Build a set of existing links for fast lookup
  const linkedPairs = new Set<string>();
  // We don't have link data in brainState.files, so we use clusters as a proxy:
  // files in the same cluster are already connected (directly or transitively)
  const sameCluster = new Map<string, Set<string>>();
  for (const cluster of state.clusters) {
    const members = new Set(cluster);
    for (const member of cluster) {
      sameCluster.set(member, members);
    }
  }

  const suggestions: Array<{ a: string; b: string; sharedTags: string[] }> = [];

  for (let i = 0; i < state.files.length; i++) {
    for (let j = i + 1; j < state.files.length; j++) {
      const a = state.files[i]!;
      const b = state.files[j]!;

      // Skip if already in the same cluster (already connected)
      const aCluster = sameCluster.get(a.name);
      if (aCluster?.has(b.name)) continue;

      // Find shared tags
      const sharedTags = a.tags.filter(t => b.tags.includes(t));
      if (sharedTags.length >= 2) {
        suggestions.push({ a: a.name, b: b.name, sharedTags });
      }
    }
  }

  // Sort by number of shared tags (most overlap first)
  return suggestions.sort((x, y) => y.sharedTags.length - x.sharedTags.length);
}

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
  /** Pre-populated BRAIN state — saves the agent from discovery tool calls */
  brainState?: {
    files: Array<{ name: string; type: string; tags: string[]; lastValidated: string }>;
    staleFiles: string[];
    orphanFiles: string[];
    clusters: string[][];
  };
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
${opts.brainState ? renderBrainState(opts.brainState) : ''}
## Phase 1 — Orient

Execute these commands NOW:
1. Read your MEMORY.md: \`cat "${opts.agentDir}/MEMORY.md"\`
${buildOrientSteps(opts)}

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
