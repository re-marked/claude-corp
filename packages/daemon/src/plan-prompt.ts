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

Quick planning pass. Outline the approach, don't over-research.

**Goal:** ${opts.goal}${projectCtx}
**Your workspace:** \`${opts.agentDir}\`

Produce a concise plan. Structure:

\`\`\`markdown
# Sketch: [title]

## Goal
[1-2 sentences]

## Approach
[High-level strategy — why this over alternatives]

## Steps
1. [First thing to do — specific, actionable]
2. [Second thing]
3. [...]

## Risks
- [Main risk and mitigation]

## Done when
- [ ] [Key acceptance criterion]
\`\`\`

Rules:
- Keep it under 50 lines
- Be specific — file paths, not "the module"
- Don't implement — sketch only
- If you need to read a file to answer, read it. But don't over-research.`;
}

function buildDeepPlanPrompt(opts: PlanPromptOpts, projectCtx: string): string {
  return `# Plan Mode — Deep Planning

Take your time. Research thoroughly. Think about tradeoffs.

**Goal:** ${opts.goal}${projectCtx}
**Corp root:** \`${opts.corpRoot}\`
**Your workspace:** \`${opts.agentDir}\`

---

## Instructions

This is a PLANNING session. Your job:

1. **Research first** — read relevant files, understand the codebase, check existing patterns. Use tools. Do NOT guess.
2. **Think deeply** — consider multiple approaches. Weigh tradeoffs. Think about what could go wrong.
3. **Produce a structured plan** in this format:

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

Rules:
- **Use tools.** Read files. Run commands. Don't plan in the dark.
- **Be specific.** File paths, not "the auth module."
- **Think about phases.** What parallelizes? What must be sequential?
- **Include risks.** Every plan has them.
- **Don't implement.** Plan only. No code changes.
- **Don't rush.** You have up to 20 minutes.`;
}
