/**
 * Plan Prompt — adapted from Claude Code's ULTRAPLAN (commands/ultraplan.tsx).
 *
 * Their version offloads to a remote CCR session running Opus for up to 30 min.
 * Ours dispatches to the CEO via say() with a long timeout — same Jack session
 * so the CEO has full conversation context.
 *
 * The plan is returned as structured markdown, saved to plans/ at corp root.
 */

/** Random planning verbs — used in status messages for alive feeling */
export const PLAN_VERBS = [
  'brewing', 'devising', 'architecting', 'contemplating',
  'deliberating', 'mapping out', 'charting', 'sketching',
  'formulating', 'crafting', 'distilling', 'composing',
];

export function randomPlanVerb(): string {
  return PLAN_VERBS[Math.floor(Math.random() * PLAN_VERBS.length)]!;
}

export function buildPlanPrompt(opts: {
  goal: string;
  corpRoot: string;
  agentDir: string;
  projectName?: string;
}): string {
  const projectCtx = opts.projectName
    ? `\nProject: \`${opts.projectName}\``
    : '';

  return `# Plan Mode

You are entering deep planning mode. Take your time. Think thoroughly. Research before deciding.

**Goal:** ${opts.goal}${projectCtx}
**Corp root:** \`${opts.corpRoot}\`
**Your workspace:** \`${opts.agentDir}\`

---

## Instructions

This is a PLANNING session, not an implementation session. Your job:

1. **Research first** — read relevant files, understand the codebase, check existing patterns. Use tools to actually read files. Do NOT guess.

2. **Think deeply** — consider multiple approaches. Weigh tradeoffs. Think about what could go wrong. Don't jump to the first idea.

3. **Produce a structured plan** — your output must be a complete, actionable plan in this format:

## Output Format

Your response MUST follow this structure:

\`\`\`markdown
# Plan: [title]

## Goal
[What we're building and why — 2-3 sentences]

## Context
[What exists already, constraints, dependencies — based on what you READ, not assumed]

## Approach
[High-level strategy — why this approach over alternatives]

## Phases

### Phase 1: [name]
- [ ] Task: [specific, actionable task with file paths]
- [ ] Task: [...]
- Assign to: [agent role or "coordinator"]
- Dependencies: none

### Phase 2: [name]
- [ ] Task: [...]
- Assign to: [agent role]
- Dependencies: Phase 1

[... more phases as needed]

## Risks
- [What could go wrong and how to mitigate]

## Acceptance Criteria
- [ ] [How we know the goal is achieved]
- [ ] [Specific, verifiable criteria]

## Estimated Scope
[Small / Medium / Large — and why]
\`\`\`

## Rules

- **Use tools.** Read files. Run commands. Don't plan in the dark.
- **Be specific.** File paths, not "the auth module." Line numbers, not "somewhere in the code."
- **Think about phases.** What can be parallelized? What must be sequential?
- **Include risks.** Every plan has risks. Name them.
- **Don't implement.** Plan only. No code changes. No commits.
- **Don't rush.** This is deep planning mode. Take the time you need.`;
}
