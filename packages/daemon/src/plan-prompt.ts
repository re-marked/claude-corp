/**
 * Plan Prompts — two tiers of the Plan primitive.
 *
 * Sketch: 5 min, quick outline, high-level phases
 * Plan: 20 min, deep research with file reading, risk matrix, detailed tasks
 *
 * Both produce structured markdown saved to plans/<word-pair>.md
 */

/** Random verbs for status messages */
export const PLAN_VERBS = [
  'brewing', 'devising', 'architecting', 'contemplating',
  'deliberating', 'mapping out', 'charting', 'sketching',
  'formulating', 'crafting', 'distilling', 'composing',
];

export function randomPlanVerb(): string {
  return PLAN_VERBS[Math.floor(Math.random() * PLAN_VERBS.length)]!;
}

export type PlanType = 'sketch' | 'plan';

export const PLAN_TIMEOUTS: Record<PlanType, number> = {
  sketch: 5 * 60 * 1000,   // 5 min
  plan: 20 * 60 * 1000,    // 20 min
};

interface PlanPromptOpts {
  goal: string;
  type: PlanType;
  agentName: string;
  agentDir: string;
  corpRoot: string;
  projectName?: string;
}

export function buildPlanPrompt(opts: PlanPromptOpts): string {
  const projectCtx = opts.projectName ? `\nProject: \`${opts.projectName}\`` : '';

  if (opts.type === 'sketch') {
    return buildSketchPrompt(opts, projectCtx);
  }
  return buildDeepPlanPrompt(opts, projectCtx);
}

function buildSketchPrompt(opts: PlanPromptOpts, projectCtx: string): string {
  return `# Sketch Mode

Planning pass. Read relevant code first, then outline the approach.

**Goal:** ${opts.goal}${projectCtx}
**Corp root:** \`${opts.corpRoot}\`
**Your workspace:** \`${opts.agentDir}\`

---

## Process

1. **Quick exploration** — read 2-5 relevant files to understand what exists. Use tools. Don't guess about the codebase.
2. **Consider alternatives** — briefly think about 2 approaches. Pick the better one and say why.
3. **Write the sketch** — structured, specific, actionable.

## Output Format

\`\`\`markdown
# Sketch: [title]

## Goal
[What and why — 2-3 sentences]

## Context
[What you found when reading the code — existing patterns, reusable functions, constraints]

## Approach
[Strategy and why this over the alternative you considered]

## Steps
1. [Specific step with file paths — e.g., "Create src/middleware/auth.ts with JWT verify"]
2. [...]
3. [...]

## Files to modify/create
- \`path/to/file.ts\` — [what changes]
- \`path/to/new-file.ts\` — [what it does]

## Risks
- [Main risk + mitigation]
- [Second risk if applicable]

## Done when
- [ ] [Specific, verifiable criterion]
- [ ] [Second criterion]
\`\`\`

Rules:
- **Read code first.** Even a sketch should be grounded in reality.
- Keep it under 80 lines — concise but complete.
- Be specific — file paths, function names, not "the auth module."
- List files you'll modify — agents need to know the blast radius.
- Don't implement — sketch only. No code changes.`;
}

function buildDeepPlanPrompt(opts: PlanPromptOpts, projectCtx: string): string {
  return `# Ultra Plan Mode — Deep Planning (5-Phase Workflow)

You are the Planner running on Opus. You have up to 20 minutes. This is NOT a sketch — this is a thorough, production-grade plan. A plan that takes less than 5 minutes is NOT deep enough.

**Goal:** ${opts.goal}${projectCtx}
**Corp root:** \`${opts.corpRoot}\`
**Your workspace:** \`${opts.agentDir}\`

---

## The 5 Phases — Execute ALL of them. Do NOT skip or rush any phase.

### Phase 1: Audit the Codebase
Do NOT just read a few files. Understand the WHOLE system.
- \`find ${opts.corpRoot} -name "*.ts" -o -name "*.tsx" -o -name "*.js" | head -50\` — map the codebase structure
- Read package.json, tsconfig, key configs — understand the stack
- Read the main entry points and core modules
- Identify existing patterns: how is auth done? how are routes structured? what conventions exist?
- List what you found: "The codebase has X files, uses Y framework, follows Z pattern"
- Check what functions/modules already exist that you can reuse
- Identify constraints, dependencies, potential conflicts
- If there's no codebase yet, research the ecosystem (frameworks, libraries, best practices)

### Phase 2: Design & Compare
Think about HOW to build it. Compare to real-world production apps.
- List at least 3 different approaches. For EACH:
  - How do production apps solve this? (e.g., "Stripe uses X, GitHub uses Y")
  - What are the tradeoffs? (complexity vs performance vs maintainability vs developer experience)
  - What breaks at 10x scale? 100x?
- Pick the best approach and explain WHY with explicit reasoning
- What existing code can be reused? (reference specific file:line)
- What new patterns does this introduce? Are they consistent with the existing codebase?

### Phase 3: Review & Stress-Test
Challenge your own design before writing it down.
- Re-read the critical files you'll be modifying — do they actually work how you assumed?
- Trace the data flow end-to-end: request → middleware → handler → database → response
- Think about failure modes: what happens when the DB is down? when auth fails? when input is malformed?
- Think about security: SQL injection? XSS? auth bypass? rate limiting?
- Think about testing: how will QA verify this works? what are the edge cases?
- Identify anything you're unsure about — every uncertainty goes in Risks

### Phase 4: Write the Structured Plan
Now — and ONLY now — write the plan. Use this format:

\`\`\`markdown
# Plan: [title]

## Goal
[What we're building and why — 2-3 sentences]

## Context
[What exists already, constraints, dependencies — based on what you READ]

## Approach
[High-level strategy — why this approach over alternatives]

## Phases

### Phase 1: [name]
- [ ] Task: [specific, actionable with file paths]
- [ ] Task: [...]
- Assign to: [agent role]
- Dependencies: none

### Phase 2: [name]
- [ ] Task: [...]
- Assign to: [agent role]
- Dependencies: Phase 1

## Risks
- [What could go wrong and mitigation]

## Acceptance Criteria
- [ ] [How we know the goal is achieved]

## Estimated Scope
[Small / Medium / Large — and why]
\`\`\`

### Phase 5: Self-Review
Before finalizing, check your own plan:
- Is every task specific enough that an agent with zero context could execute it?
- Are file paths real (you verified they exist) or assumed?
- Did you consider what could go wrong?
- Is the scope realistic for the timeline?
- Would YOU approve this plan if someone else wrote it?

If any answer is "no" — go back and fix it before responding.

---

Rules:
- **Use tools in every phase.** Read files. Run commands. Don't plan in the dark.
- **Be specific.** File paths with line numbers, not "the auth module."
- **Think about parallelism.** What can workers do simultaneously?
- **Include risks.** Every plan has them. Name the mitigation.
- **Don't implement.** Plan only. No code changes. No commits.
- **Don't rush.** If your plan took less than 5 minutes, it's not deep enough. Go back to Phase 1.`;
}
