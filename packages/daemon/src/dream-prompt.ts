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

import { join } from 'node:path';
import type { CultureCandidate } from '@claudecorp/shared';

// ── BRAIN State Renderer ────────────────────────────────────────────

function renderCultureContext(culture: NonNullable<DreamPromptOpts['cultureContext']>): string {
  const lines: string[] = [];
  lines.push('## Your Cultural Context\n');

  if (culture.sharedTags.length > 0) {
    lines.push(`**Corp's shared vocabulary:** ${culture.sharedTags.slice(0, 15).join(', ')}`);
    lines.push('When writing new BRAIN files, prefer these tags where they apply — they\'re how the corp speaks.\n');
  }

  if (culture.agentUniqueTags.length > 0) {
    lines.push(`**Your unique tags:** ${culture.agentUniqueTags.slice(0, 10).join(', ')}`);
    lines.push('These are yours alone — your idiosyncrasy. Keep them if they reflect real preferences.\n');
  }

  lines.push(`**Cultural alignment:** ${culture.alignmentScore}%`);
  if (culture.alignmentScore < 20) {
    lines.push('Your vocabulary is diverging from the corp. Consider whether your tags should align more, or if your unique perspective is valuable as-is.\n');
  } else if (culture.alignmentScore >= 60) {
    lines.push('You speak the corp\'s language well. Your unique tags add individuality without losing coherence.\n');
  }

  return '\n' + lines.join('\n') + '\n';
}

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

// ── Pending Feedback Phase (Phase 0 — runs before Orient) ──────────
//
// Rendered only when `.pending-feedback.md` exists. The router stamped
// it with raw quotes + matched-pattern hints. Dreams author the
// interpreted observation + BRAIN entry, then delete the file.
function renderPendingFeedbackPhase(opts: DreamPromptOpts): string {
  const lines: string[] = [];
  lines.push('## Phase 0 — Pending Feedback (READ THIS FIRST)\n');
  lines.push('The founder corrected or confirmed you while you were working. The router captured the raw quotes for you. **You are the interpreter** — the file holds signals, not conclusions. Read the quotes, weigh them against what you were actually doing, then write memory that will help future-you.\n');

  lines.push('### The captured feedback (`.pending-feedback.md`)\n');
  lines.push('```markdown');
  // Truncate very long files to avoid blowing the prompt; agent can still
  // cat the file if they need the rest.
  const truncated = opts.pendingFeedback!.length > 8000
    ? opts.pendingFeedback!.slice(0, 8000) + '\n\n[... truncated. cat the file for full contents ...]'
    : opts.pendingFeedback!;
  lines.push(truncated);
  lines.push('```\n');

  lines.push('### What to do with it\n');
  lines.push('For **each entry** in the file above:\n');
  lines.push('1. **Read the quote** carefully. The `Signal:` line is only a hint — patterns can false-positive (e.g., "not bad" has the word "not" but is praise). Trust the quote over the tags.');
  lines.push('2. **Judge severity and tone** from the full quote + prior context:');
  lines.push('   - Is this a firm correction, a gentle nudge, a joke, a casual affirmation, or mixed?');
  lines.push('   - Was your prior message actually wrong, or did the founder change their mind?');
  lines.push('   - Is it specific (one decision) or thematic (how you work in general)?');
  lines.push('3. **Append a `[FEEDBACK]` observation** to today\'s observation log documenting what you heard — in your own voice, not the router\'s. Include: what the founder said, what you had done, and your interpretation.');
  lines.push('4. **Check for a matching existing BRAIN entry FIRST.** Before creating anything new, list `BRAIN/` and read any file whose tags or title could be the same theme. Semantic match beats exact title — "don\'t summarize" and "stop recapping" are the same rule. If you find a match:');
  lines.push('   - **Do NOT create a duplicate.** Open the existing file.');
  lines.push('   - Increment `times_heard:` in the frontmatter (default 1 if missing → 2). This counter is load-bearing: corp-level culture synthesis uses it to decide what becomes law.');
  lines.push('   - If `times_heard` just hit 2+, bump `confidence` one level (`low → medium → high`). Repetition is proof.');
  lines.push('   - Append a dated instance under a "## Heard again" section with the new quote. Don\'t rewrite history — add to it.');
  lines.push('   - Update `updated` and `last_validated` to today.');
  lines.push('5. **Otherwise, create a new BRAIN file** with:');
  lines.push('   - `type: correction` for corrections, `type: founder-preference` for confirmations of taste/style');
  lines.push('   - `source: correction` or `source: confirmation` (NOT `source: dream` — the founder spoke, be honest about it)');
  lines.push('   - `confidence`: `high` if the founder was explicit and specific, `medium` if inferred across the pattern+quote, `low` if ambiguous');
  lines.push('   - `times_heard: 1` (the counter starts here)');
  lines.push('   - Lead with the rule/preference itself, then a **Why:** line (the reasoning you can infer from the quote) and a **How to apply:** line (when this kicks in).');
  lines.push('6. **Skip if it\'s noise.** A "lol" or "thanks" on its own doesn\'t need a BRAIN file. Capture only what future-you would want to know.\n');

  lines.push('### After you\'ve consumed every entry\n');
  lines.push('Delete the file so next cycle starts clean:\n');
  lines.push('```bash');
  lines.push(`rm "${opts.agentDir}/.pending-feedback.md"`);
  lines.push('```\n');
  lines.push('If you skipped entries (deemed them noise), still delete the file — the observations/BRAIN are the durable record. The pending file is an inbox, not an archive.\n');
  lines.push('---\n');

  return '\n' + lines.join('\n') + '\n';
}

// ── Culture Synthesis Phase (CEO only — runs after consolidation) ──
//
// Rendered when `isCeo: true` and `cultureCandidates` are non-empty.
// CEO reviews feedback BRAIN entries that compounded across agents or
// repeated for one agent, and promotes the ones worth making corp-wide
// law to CULTURE.md at the corp root.
function renderCultureSynthesisPhase(opts: DreamPromptOpts): string {
  const candidates = opts.cultureCandidates ?? [];
  if (candidates.length === 0) return '';

  const lines: string[] = [];
  lines.push('## Phase 5 — Culture Synthesis (CEO only)\n');
  lines.push('You are the CEO. Feedback that compounds into the founder\'s repeated voice should become **corp culture** — rules every agent inherits, not lessons every agent has to relearn. That\'s your job this phase.\n');
  lines.push(`Candidates below come from scanning every agent's BRAIN/ for entries sourced from founder corrections or confirmations. They are clustered by shared tags — not exact-title matches — so related themes group together. **You make the final call** on whether each cluster is corp-worthy.\n`);

  lines.push('### The candidates\n');
  const MAX_CANDIDATES = 10;
  const shown = candidates.slice(0, MAX_CANDIDATES);
  for (const c of shown) {
    lines.push(`**Cluster** — tags: \`${c.sharedTags.slice(0, 6).join(', ')}\` · agents: ${c.agents.join(', ')} · strength: **${c.strength}** · heard ${c.totalTimesHeard}× across ${c.entries.length} entr${c.entries.length === 1 ? 'y' : 'ies'} (max ${c.maxTimesHeard} for one agent)`);
    for (const e of c.entries.slice(0, 4)) {
      const excerpt = e.excerpt.replace(/\n+/g, ' ').slice(0, 160);
      lines.push(`  - \`${e.agent}\` → [[${e.file}]] (${e.type} · ${e.source} · conf=${e.confidence} · ×${e.timesHeard}): ${excerpt}${e.excerpt.length > 160 ? '…' : ''}`);
    }
    lines.push('');
  }
  if (candidates.length > MAX_CANDIDATES) {
    lines.push(`_(${candidates.length - MAX_CANDIDATES} weaker cluster(s) hidden — scan BRAIN/ directly if you want them)_\n`);
  }

  const culturePath = join(opts.corpRoot, 'CULTURE.md').replace(/\\/g, '/');
  lines.push('### What to do\n');
  lines.push(`1. **Read \`${culturePath}\` if it exists.** Existing rules are sacred — don't reword them, don't reorder them, don't lose them. You append; you don't rewrite.`);
  lines.push('2. **For each candidate above:**');
  lines.push('   - If the cluster is \`strong\` (3+ agents or max times_heard ≥ 3) → **promote** it: write a rule in your own voice, cite the source ("Observed from corrections to: agentA, agentB, agentC"), tag it with the shared tags.');
  lines.push('   - If \`moderate\` (2 agents or times_heard ≥ 2) → **judge**. If the theme is clearly the founder\'s voice (not situational), promote. If it might be a fluke, leave it for next dream.');
  lines.push('   - If you\'re not sure, read 1-2 of the linked BRAIN files directly (`cat "$AGENT_DIR/BRAIN/<file>.md"`) before deciding.');
  lines.push('3. **CULTURE.md structure:** YAML frontmatter + append-only entries. Each entry:');
  lines.push('```markdown');
  lines.push('## <short title>');
  lines.push('');
  lines.push('<rule — one or two sentences, founder\'s voice>');
  lines.push('');
  lines.push('- **Why:** <reason, from the corrections>');
  lines.push('- **When:** <when this rule applies>');
  lines.push('- **Sources:** <agents where this showed up> (heard Nx total)');
  lines.push('- **Promoted:** <YYYY-MM-DD>');
  lines.push('```');
  lines.push(`4. **Write** to \`${culturePath}\` (append if the file exists, create with a header if not). Header template for first-ever write:`);
  lines.push('```markdown');
  lines.push('# Corp Culture');
  lines.push('');
  lines.push('> Rules the founder taught us through repetition. Every agent reads this. Every new hire inherits it. Promoted by the CEO during dreams when feedback compounds across agents.');
  lines.push('');
  lines.push('---');
  lines.push('```');
  lines.push('5. **Don\'t delete agent-level BRAIN entries.** The per-agent memory stays — CULTURE.md is a corp-wide layer ON TOP of it, not a replacement.');
  lines.push('6. **Keep CULTURE.md tight.** It is read by every agent on every dispatch — bloat here costs every token in every session. If you see contradicted, outdated, or duplicate rules in existing CULTURE.md, prune them. New entries should be one-screen max, no filler. Treat it like a constitution, not a changelog.');
  lines.push('7. **If nothing is worth promoting this cycle**, that\'s fine. Leave CULTURE.md alone. Say so in the summary.\n');
  lines.push('---\n');

  return '\n' + lines.join('\n') + '\n';
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
  /** Corp-wide culture context — helps agents align vocabulary during dreams */
  cultureContext?: {
    sharedTags: string[];
    agentUniqueTags: string[];
    alignmentScore: number;
  };
  /**
   * Raw contents of `.pending-feedback.md` if present in the agent's
   * workspace. The router stamped this file every time the founder's
   * message tripped a correction/confirmation pattern. Dreams are where
   * interpretation happens: read the quotes, judge severity + tone in
   * context, author [FEEDBACK] observations, promote to BRAIN, and then
   * delete the file so the same signals don't double-count next cycle.
   */
  pendingFeedback?: string;

  /**
   * True when the dreaming agent is the CEO. CEO gets an extra Phase 5
   * that synthesizes cross-agent feedback into corp-wide CULTURE.md.
   */
  isCeo?: boolean;

  /**
   * Pre-computed culture-promotion candidates from `getCultureCandidates`.
   * Rendered during Phase 5 when isCeo is true. CEO makes the final
   * semantic call on which clusters become corp law.
   */
  cultureCandidates?: CultureCandidate[];
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
${opts.brainState ? renderBrainState(opts.brainState) : ''}${opts.cultureContext ? renderCultureContext(opts.cultureContext) : ''}${opts.pendingFeedback ? renderPendingFeedbackPhase(opts) : ''}
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
${opts.isCeo ? renderCultureSynthesisPhase(opts) : ''}
Return a brief summary of what you consolidated, updated, or pruned. Format:
- X new topics created
- Y topics updated
- Z stale entries pruned

If nothing meaningful changed, say "DREAM_CLEAN" and nothing else.`;
}
