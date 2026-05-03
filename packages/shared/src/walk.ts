/**
 * walk.ts — Project 2.1 read API for walks.
 *
 * A "walk" is a Contract chit cast from a blueprint, plus its Task
 * chits, plus the originating Blueprint chit. The walk concept is
 * derivable from existing chit data — there's no new chit type — but
 * the navigation logic was scattered across callers before this module.
 * This file centralizes it.
 *
 * The module is the consumer of:
 *   - BlueprintFields.steps[].expectedOutput (Project 2.1 schema PR)
 *   - TaskFields.expectedOutput (this PR's schema commit)
 *   - The `blueprint:<name>` + `blueprint-step:<id>` tags on Task chits
 *     written by castFromBlueprint
 *
 * And the read API for:
 *   - 2.2 visibility surfaces (dispatch fragment, cc-cli wtf header,
 *     handoff chits) — call getWalkPosition + getWalkProgress
 *   - 2.3 walk-aware audit — calls checkExpectedOutput
 *   - 2.4 Sexton stalled-walk patrol — calls getWalkProgress
 *   - 2.7 cc-cli walk show — calls getWalkProgress
 *
 * Pure read API: no chit writes, no state mutation. The shell-out
 * checkers (branch-exists / commit-on-branch / file-exists) DO touch
 * the filesystem and may shell out to git, but only as reads — they
 * never mutate the working tree or the chit store.
 *
 * ### Three-state outcome contract
 *
 * `checkExpectedOutput` returns `{ status: 'met' | 'unmet' |
 * 'unable-to-check' }`. The third state covers environmental flakes
 * (git not in PATH, gh CLI missing, network down, missing cwd) so
 * transient infra never locks agents out of `cc-cli done`. 2.3's
 * audit treats `unable-to-check` as approved-with-warning + logs to
 * `chits/_log/audit-checks.jsonl`; repeated unable-to-check on the
 * same step surfaces as a kink via Sexton's patrol.
 *
 * ### Vacuous-truth on null spec
 *
 * `checkExpectedOutput` called with a step whose expectedOutput is
 * null returns `{ status: 'met', evidence: { reason: 'no
 * expectedOutput specified' } }`. Caller may choose to skip the call
 * entirely if it knows the spec is null; the vacuous-truth path
 * exists so callers don't HAVE to gate every call on null-checking.
 */

import type { Chit, BlueprintStep, BlueprintFields, ContractFields, TaskFields, TaskWorkflowStatus } from './types/chit.js';
import type { ExpectedOutputSpec } from './types/expected-output.js';
import { queryChits, findChitById } from './chits.js';

// ─── Tag conventions ────────────────────────────────────────────────

/**
 * Tag prefix castFromBlueprint writes on every Task chit it produces.
 * Uniqueness within a Task's tag list is guaranteed by the cast
 * pipeline (one tag per blueprint name). Format: `blueprint:<name>`.
 */
const BLUEPRINT_TAG_PREFIX = 'blueprint:';

/**
 * Tag prefix castFromBlueprint writes on every Task chit it produces.
 * One tag per task; the suffix is the step's local kebab-case id from
 * the source blueprint. Format: `blueprint-step:<step-id>`.
 */
const BLUEPRINT_STEP_TAG_PREFIX = 'blueprint-step:';

// ─── Pure helpers ────────────────────────────────────────────────────

/**
 * True when the given Task chit was cast from a blueprint and carries
 * the canonical walk tags. Both the `blueprint:<name>` AND
 * `blueprint-step:<id>` tags must be present — castFromBlueprint always
 * writes both, so a task missing either is either ad-hoc (not from a
 * cast) or has had its tags hand-mutated (out of scope to handle).
 *
 * Pure data inspection — no chit store reads. Cheap to call in hot
 * paths (dispatch fragment will call this on every dispatch).
 */
export function isWalkTask(taskChit: Chit<'task'>): boolean {
  return (
    taskChit.tags.some((t) => t.startsWith(BLUEPRINT_TAG_PREFIX)) &&
    taskChit.tags.some((t) => t.startsWith(BLUEPRINT_STEP_TAG_PREFIX))
  );
}

/**
 * Inverse of isWalkTask. A task is "ad-hoc" when it doesn't carry the
 * walk-defining tags — typically `cc-cli task new` or `cc-cli task
 * create` style standalone tasks not associated with a Contract walk.
 *
 * Walk-aware audit (2.3) treats ad-hoc tasks as no-walk-check (the
 * existing AC checks still run). 2.2's visibility surface renders
 * "Walk: ad-hoc" for these so the agent isn't ambiguously oriented.
 */
export function isAdHocTask(taskChit: Chit<'task'>): boolean {
  return !isWalkTask(taskChit);
}

/**
 * Extract the blueprint name from a walk task's tags. Returns null if
 * the task is ad-hoc (no blueprint tag). When multiple `blueprint:`
 * tags somehow exist (defensive — shouldn't happen with cast), returns
 * the first one to keep behavior deterministic.
 */
export function getWalkBlueprintName(taskChit: Chit<'task'>): string | null {
  const tag = taskChit.tags.find((t) => t.startsWith(BLUEPRINT_TAG_PREFIX));
  if (!tag) return null;
  return tag.slice(BLUEPRINT_TAG_PREFIX.length) || null;
}

/**
 * Extract the blueprint step id from a walk task's tags. Returns null
 * if the task is ad-hoc. Same first-match semantics as
 * getWalkBlueprintName for the defensive duplicate case.
 */
export function getWalkStepId(taskChit: Chit<'task'>): string | null {
  const tag = taskChit.tags.find((t) => t.startsWith(BLUEPRINT_STEP_TAG_PREFIX));
  if (!tag) return null;
  return tag.slice(BLUEPRINT_STEP_TAG_PREFIX.length) || null;
}

// ─── Walk position lookup ───────────────────────────────────────────

/**
 * The "where am I in the walk?" answer for a Task chit. All references
 * are eagerly resolved — callers don't need to do a second hop to read
 * the contract / blueprint / step. Pre-expanded data (taskOutput,
 * expectedOutput, claimedAt) lives on the task and is surfaced here so
 * audit / visibility don't have to dual-read.
 *
 * `stepIndex` is 1-based for human-facing display ("step 4 of 7"); a
 * 0-based index would leak as "step 0 of 7" if a renderer forgot to
 * add 1. Programmers consuming this for arithmetic should subtract 1
 * if they want the array offset.
 *
 * `step` is the original (unexpanded) BlueprintStep so callers needing
 * the DAG structure (`dependsOn`) get it. For rendering, prefer the
 * task chit's already-expanded title / description instead — the
 * blueprint step's strings still contain `{{handlebars}}` references
 * which are fine for type purposes but useless for display.
 */
export interface WalkPosition {
  /** Blueprint name (e.g. `ship-feature`). Same value as the `blueprint:` tag suffix. */
  readonly blueprintName: string;
  /** Step id within the blueprint (e.g. `acquire-worktree`). Same as the `blueprint-step:` tag suffix. */
  readonly stepId: string;
  /** 1-based index in the blueprint's steps array. UI-friendly; subtract 1 for array math. */
  readonly stepIndex: number;
  /** Total number of steps in the blueprint. */
  readonly totalSteps: number;
  /** The original (unexpanded) BlueprintStep — useful for dependsOn navigation. */
  readonly step: BlueprintStep;
  /** Full Contract chit containing this task's id. */
  readonly contract: Chit<'contract'>;
  /** Full Blueprint chit (also unexpanded; raw templates). */
  readonly blueprint: Chit<'blueprint'>;
  /** Pre-expanded ExpectedOutputSpec from the task chit (or null when no walk-aware enforcement on this step). */
  readonly expectedOutput: ExpectedOutputSpec | null;
  /** Agent's prose summary so far from `task.output` — null when not written yet. */
  readonly taskOutput: string | null;
  /** ISO timestamp of when the agent transitioned dispatched → in_progress, or null when unwired/pre-2.1. */
  readonly claimedAt: string | null;
}

/**
 * Resolve the full walk position for a Task chit. Returns null on any
 * missing-data case along the lookup chain — callers should treat null
 * as "this task isn't part of a walk we can navigate" and fall through
 * to ad-hoc behavior. Specific null causes:
 *
 *   - Task is ad-hoc (no `blueprint:*` or `blueprint-step:*` tag)
 *   - No Contract chit contains this task's id in `taskIds[]` (orphan
 *     task — possible if the contract was hand-deleted or the task was
 *     hand-created with the tags but no containing contract)
 *   - Contract has null `blueprintId` (corruption — castFromBlueprint
 *     always sets it, but defensive)
 *   - Blueprint chit can't be resolved by id (deleted)
 *   - Step id from the task tag isn't in the blueprint's steps array
 *     (blueprint edited after cast — this task references a step that
 *     no longer exists)
 *
 * Reverse lookup task → contract is O(N) over contracts. At realistic
 * corp scale (dozens to hundreds of contracts) this is microseconds.
 * Not denormalizing `contractId` onto TaskFields for this — premature
 * optimization, and the existing taskIds-on-contract relationship is
 * the canonical edge.
 */
export function getWalkPosition(
  taskChit: Chit<'task'>,
  corpRoot: string,
): WalkPosition | null {
  // 1. Tag-based identity. Both required — a task with only one of the
  //    walk tags is malformed; treat as ad-hoc rather than picking
  //    apart partial state.
  const blueprintName = getWalkBlueprintName(taskChit);
  const stepId = getWalkStepId(taskChit);
  if (blueprintName === null || stepId === null) return null;

  // 2. Reverse lookup: find the contract containing this task. Scan
  //    contracts via queryChits — limit 0 = unlimited so we don't miss
  //    a hit at the tail of a large corp's contract list. Contracts
  //    are non-ephemeral + small in count vs tasks, so this is cheap.
  //    queryChits returns { chits, malformed }; we ignore malformed
  //    here (the surface is callers concerned with corp health, not
  //    walk navigation — a malformed contract is invisible to walks
  //    until repaired).
  const contractQuery = queryChits<'contract'>(corpRoot, {
    types: ['contract'] as const,
    limit: 0,
  });
  const containing = contractQuery.chits.filter((cwb) =>
    (cwb.chit.fields as { contract: ContractFields }).contract.taskIds.includes(taskChit.id),
  );
  // Defensive duplicate handling: a task SHOULDN'T appear in multiple
  // contracts' taskIds, but file corruption or manual edits could
  // produce that state. Return the first match deterministically rather
  // than throwing — callers see the same answer across calls.
  const containingHit = containing[0];
  if (!containingHit) return null;
  const contract = containingHit.chit as Chit<'contract'>;

  // 3. Contract → blueprint id. blueprintId can technically be null on
  //    contracts created without a blueprint (`cc-cli contract create`
  //    direct path). Treat as ad-hoc-ish — the contract exists but no
  //    walk to navigate.
  const contractFields = contract.fields.contract as ContractFields;
  if (contractFields.blueprintId == null) return null;

  // 4. Blueprint chit lookup by id. Defensive: blueprint may have been
  //    deleted (closed + archived, manually removed) since cast. Tasks
  //    persist; their references can dangle.
  const blueprintHit = findChitById(corpRoot, contractFields.blueprintId);
  if (!blueprintHit || blueprintHit.chit.type !== 'blueprint') return null;
  const blueprint = blueprintHit.chit as Chit<'blueprint'>;

  // 5. Locate the step within the blueprint. The cast pipeline tagged
  //    this task with the step id; if the blueprint has since been
  //    edited and this step id removed, treat as null (the walk shape
  //    has drifted from the cast). The task's pre-expanded
  //    expectedOutput remains valid because it's stored on the task,
  //    not derived from the current blueprint — so audit can still
  //    fire even when getWalkPosition returns null. But the navigation
  //    surface (visibility) honestly says "this task is in a walk that
  //    has changed since cast — no clean position to render."
  const blueprintFields = blueprint.fields.blueprint as BlueprintFields;
  const stepIdx0 = blueprintFields.steps.findIndex((s) => s.id === stepId);
  if (stepIdx0 < 0) return null;
  const step = blueprintFields.steps[stepIdx0]!;

  // 6. Compose. Reads from the TASK for pre-expanded fields (output /
  //    expectedOutput / claimedAt) — these reflect the cast moment and
  //    the agent's work since, NOT the current blueprint state.
  const taskFields = taskChit.fields.task as TaskFields;
  return {
    blueprintName,
    stepId,
    stepIndex: stepIdx0 + 1, // 1-based for human display
    totalSteps: blueprintFields.steps.length,
    step,
    contract,
    blueprint,
    expectedOutput: taskFields.expectedOutput ?? null,
    taskOutput: taskFields.output ?? null,
    claimedAt: taskFields.claimedAt ?? null,
  };
}

// ─── Walk progress (contract → full step picture) ──────────────────

/**
 * Per-step entry in WalkProgress. Combines blueprint structural info
 * (id, raw step) with the corresponding Task chit's runtime state
 * (id, status, latest activity timestamp). When a step has no task
 * chit (data drift — task referenced in contract.taskIds doesn't
 * resolve, or step exists in blueprint but no matching task was cast),
 * `taskId` and `taskStatus` are null. Renderers use these to show
 * "[step exists but no task]" gaps so corp-health surfaces flag the
 * inconsistency.
 */
export interface WalkStep {
  /** Step id (kebab-case) from blueprint.steps[].id. */
  readonly stepId: string;
  /** 1-based index in the blueprint's steps array. */
  readonly stepIndex: number;
  /** The original (unexpanded) BlueprintStep — title still has `{{vars}}` if templated. */
  readonly step: BlueprintStep;
  /** Task chit id matching this step (via `blueprint-step:` tag), or null when no task found. */
  readonly taskId: string | null;
  /** Task's current workflowStatus, or null when no task. */
  readonly taskStatus: TaskWorkflowStatus | null;
  /** Task's pre-expanded title (the rendered version, no `{{vars}}`), null when no task. */
  readonly taskTitle: string | null;
  /** ISO timestamp of the task chit's last update, null when no task. Useful for "recent activity" surfaces. */
  readonly taskUpdatedAt: string | null;
}

/**
 * Walk progress as seen from the Contract. Every step in the
 * blueprint gets an entry, in declaration order. Caller filters /
 * groups by status as needed (active vs completed vs blocked vs
 * remaining). No "current step" concept here — DAG walks may have
 * multiple in-progress steps simultaneously, so renderers compute
 * "what's current" from the per-step taskStatus rather than us
 * picking one.
 */
export interface WalkProgress {
  /** Blueprint name (for display + cross-reference). */
  readonly blueprintName: string;
  /** Total number of steps in the blueprint. */
  readonly totalSteps: number;
  /** Per-step entry, blueprint-declaration order. */
  readonly steps: readonly WalkStep[];
  /** Full Contract chit echoed for callers that need it. */
  readonly contract: Chit<'contract'>;
  /** Full Blueprint chit echoed for callers that need it. */
  readonly blueprint: Chit<'blueprint'>;
}

/**
 * Resolve the full walk picture for a Contract chit. Returns null when
 * the contract isn't a walk (no blueprintId) or its blueprint chit is
 * missing. Tasks listed in contract.taskIds that don't resolve are
 * rendered as `taskId/taskStatus = null` entries — visible to callers
 * but not a hard fail (the alternative would be returning null for the
 * whole walk on one missing task, which masks the actual data shape).
 *
 * For each blueprint step, finds the task chit by matching the
 * `blueprint-step:<stepId>` tag against the contract's taskIds. If
 * multiple tasks match (defensive — shouldn't happen with cast),
 * returns the first deterministically.
 */
export function getWalkProgress(
  contractChit: Chit<'contract'>,
  corpRoot: string,
): WalkProgress | null {
  const contractFields = contractChit.fields.contract as ContractFields;
  if (contractFields.blueprintId == null) return null;

  const blueprintHit = findChitById(corpRoot, contractFields.blueprintId);
  if (!blueprintHit || blueprintHit.chit.type !== 'blueprint') return null;
  const blueprint = blueprintHit.chit as Chit<'blueprint'>;
  const blueprintFields = blueprint.fields.blueprint as BlueprintFields;

  // Eager-resolve every task chit listed in the contract. Tasks are
  // stored under `chits/task/<id>.md` so findChitById is O(1) per
  // task (with type prefix routing). Total: O(taskCount) per call.
  const tasksById = new Map<string, Chit<'task'>>();
  for (const taskId of contractFields.taskIds) {
    const hit = findChitById(corpRoot, taskId);
    if (hit && hit.chit.type === 'task') {
      tasksById.set(taskId, hit.chit as Chit<'task'>);
    }
  }

  // Walk blueprint steps in declaration order. For each, find the
  // matching task by `blueprint-step:` tag among the contract's tasks.
  const steps: WalkStep[] = blueprintFields.steps.map((step, idx) => {
    let matchedTask: Chit<'task'> | null = null;
    for (const task of tasksById.values()) {
      if (task.tags.includes(`${BLUEPRINT_STEP_TAG_PREFIX}${step.id}`)) {
        matchedTask = task;
        break; // First match wins; cast guarantees uniqueness.
      }
    }
    const taskFields = matchedTask?.fields.task as TaskFields | undefined;
    return {
      stepId: step.id,
      stepIndex: idx + 1,
      step,
      taskId: matchedTask?.id ?? null,
      taskStatus: taskFields?.workflowStatus ?? null,
      taskTitle: taskFields?.title ?? null,
      taskUpdatedAt: matchedTask?.updatedAt ?? null,
    };
  });

  return {
    blueprintName: blueprintFields.name,
    totalSteps: blueprintFields.steps.length,
    steps,
    contract: contractChit,
    blueprint,
  };
}

// ─── DAG navigation (pure helpers on blueprint structure) ──────────

/**
 * Steps that depend ON the given step (forward edges in the DAG).
 * Returns plural even though many walks are linear — DAGs can fan out.
 * Pure: operates on blueprint structure, no chit store reads.
 *
 * Returns empty array when no step depends on this one (terminal step,
 * or unknown stepId — both cases produce no successors).
 */
export function nextSteps(
  blueprint: BlueprintFields,
  currentStepId: string,
): BlueprintStep[] {
  return blueprint.steps.filter((s) => (s.dependsOn ?? []).includes(currentStepId));
}

/**
 * Steps that the given step depends ON (backward edges). Reads
 * directly from `currentStep.dependsOn` — same semantics as the
 * cast-time DAG validator. Returns empty array when the step has no
 * dependencies (top of chain) or when `currentStepId` doesn't match
 * any blueprint step (defensive — shouldn't happen with valid input).
 */
export function previousSteps(
  blueprint: BlueprintFields,
  currentStepId: string,
): BlueprintStep[] {
  const current = blueprint.steps.find((s) => s.id === currentStepId);
  if (!current) return [];
  const depIds = current.dependsOn ?? [];
  return blueprint.steps.filter((s) => depIds.includes(s.id));
}

// ─── Expected-output checking — dispatcher + pure checkers ─────────

/**
 * Three-state outcome of `checkExpectedOutput`:
 *
 *   - `met` — the check fired AND the expected output is present.
 *     Audit (2.3) treats as approved.
 *   - `unmet` — the check fired AND the expected output is absent.
 *     Audit blocks `cc-cli done` with a teaching message that names
 *     the missed step + the expected shape.
 *   - `unable-to-check` — the check couldn't fire (git not in PATH,
 *     gh missing, network down, missing cwd). Audit treats as
 *     approved-with-warning + logs to chits/_log/audit-checks.jsonl;
 *     repeated unable on the same step surfaces as a kink via
 *     Sexton's patrol so degraded infra is operationally visible
 *     without blocking the agent on transient flakes.
 *
 * `missing` populated on `unmet` for kinds that can name what's
 * missing (e.g. specific tags absent). `evidence` is free-form per
 * checker — chit ids found, git output, file paths checked. `reason`
 * is the human-readable explainer for `unable-to-check`.
 */
export interface CheckResult {
  readonly status: 'met' | 'unmet' | 'unable-to-check';
  readonly missing?: readonly string[];
  readonly evidence?: unknown;
  readonly reason?: string;
}

/**
 * Caller-facing options for `checkExpectedOutput`. All optional;
 * defaults preserve safe behavior.
 *
 * `cwd` controls where shell-out checkers run (`branch-exists`,
 * `commit-on-branch`, `file-exists`). 2.3's audit caller is
 * responsible for resolving this — when a task has a Clearinghouse
 * worktree allocated, audit passes the worktree path so checks fire
 * against the correct git tree. Defaults to corpRoot (the corp's
 * primary checkout) when absent.
 *
 * `timeoutMs` caps every shell-out at this duration. Default 10s —
 * enough for git operations on typical repos, short enough that
 * repeated unable-to-check from a hung command becomes visible to
 * Sexton's patrol within a couple of cycles. Pure-data checkers
 * (tag-on-task / task-output-nonempty / multi-of-pure) ignore this.
 */
export interface CheckExpectedOutputOpts {
  /** Working directory for git / fs shell-outs. Default: corpRoot. */
  readonly cwd?: string;
  /** Per-shell-out timeout in milliseconds. Default: 10_000. */
  readonly timeoutMs?: number;
}

/**
 * Check whether a Task chit satisfies its expectedOutput spec.
 * Vacuous-truth on null spec — callers that pass `task.fields.task
 * .expectedOutput` directly don't need to gate on the null case.
 *
 * Per-kind dispatch routes to a checker function below. The
 * dispatcher itself is exhaustive (TypeScript narrowing on the
 * discriminant) so adding a new kind requires updating this switch
 * + adding a checker function — the build catches missed kinds.
 *
 * Pure on data; checkers may shell out (git) or read fs but never
 * mutate the working tree or the chit store. Three-state outcome
 * propagates per the CheckResult contract above.
 */
export function checkExpectedOutput(
  spec: ExpectedOutputSpec | null,
  taskChit: Chit<'task'>,
  corpRoot: string,
  opts: CheckExpectedOutputOpts = {},
): CheckResult {
  // Vacuous truth: a null spec is "no walk-aware enforcement on this
  // step." Returning `met` lets audit treat it as approved without
  // having to gate every call site on null. Evidence names the
  // reason so audit logs can distinguish vacuous from real-met.
  if (spec === null) {
    return { status: 'met', evidence: { reason: 'no expectedOutput specified' } };
  }

  switch (spec.kind) {
    case 'tag-on-task':
      return checkTagOnTask(spec, taskChit);
    case 'task-output-nonempty':
      return checkTaskOutputNonempty(spec, taskChit);
    case 'multi':
      return checkMulti(spec, taskChit, corpRoot, opts);
    case 'chit-of-type':
      return checkChitOfType(spec, taskChit, corpRoot, opts);
    case 'branch-exists':
      return checkBranchExists(spec, taskChit, corpRoot, opts);
    case 'commit-on-branch':
      return checkCommitOnBranch(spec, taskChit, corpRoot, opts);
    case 'file-exists':
      return checkFileExists(spec, taskChit, corpRoot, opts);
  }
}

// ─── Pure-data checkers (real implementations) ─────────────────────

/**
 * `tag-on-task` — pure tag inspection on the task chit. The cast
 * pipeline strips withTags Handlebars-rendered, so this checker
 * doesn't see `{{vars}}` here. Trivially `met` or `unmet`; never
 * `unable-to-check`.
 */
function checkTagOnTask(
  spec: { kind: 'tag-on-task'; tag: string },
  taskChit: Chit<'task'>,
): CheckResult {
  if (taskChit.tags.includes(spec.tag)) {
    return { status: 'met', evidence: { tag: spec.tag, present: true } };
  }
  return {
    status: 'unmet',
    missing: [spec.tag],
    evidence: { tag: spec.tag, present: false, allTags: taskChit.tags },
  };
}

/**
 * `task-output-nonempty` — minimum bar for any step where the agent
 * must SAY what they did. Reads `taskChit.fields.task.output` (the
 * 1.3 prose summary). Trim before length-checking so a string of
 * only whitespace doesn't qualify as "non-empty." Trivially `met`
 * or `unmet`.
 */
function checkTaskOutputNonempty(
  _spec: { kind: 'task-output-nonempty' },
  taskChit: Chit<'task'>,
): CheckResult {
  const output = (taskChit.fields.task as TaskFields).output ?? '';
  if (output.trim().length > 0) {
    return { status: 'met', evidence: { length: output.length } };
  }
  return {
    status: 'unmet',
    missing: ['task.output'],
    evidence: { reason: 'task.output is empty or whitespace-only' },
  };
}

/**
 * `multi` — composed check. Status precedence:
 *
 *   1. Any sub-check `unmet` → `unmet` (definite failure beats
 *      no-signal).
 *   2. Else, any sub-check `unable-to-check` → `unable-to-check`
 *      (we lack signal on at least one piece; can't claim met).
 *   3. Else, all sub-checks `met` → `met`.
 *
 * Aggregated `missing` collects from every unmet sub-check (caller
 * sees the full list, not just the first). Evidence is the array of
 * sub-results (preserves per-sub-check evidence + reason for
 * diagnostics). Recursive — sub-specs can themselves be `multi`.
 */
function checkMulti(
  spec: { kind: 'multi'; specs: readonly ExpectedOutputSpec[] },
  taskChit: Chit<'task'>,
  corpRoot: string,
  opts: CheckExpectedOutputOpts,
): CheckResult {
  const subResults = spec.specs.map((sub) =>
    checkExpectedOutput(sub, taskChit, corpRoot, opts),
  );

  const anyUnmet = subResults.some((r) => r.status === 'unmet');
  const anyUnable = subResults.some((r) => r.status === 'unable-to-check');
  const aggregateMissing = subResults.flatMap((r) => r.missing ?? []);

  if (anyUnmet) {
    return {
      status: 'unmet',
      missing: aggregateMissing,
      evidence: { subResults },
    };
  }
  if (anyUnable) {
    const reasons = subResults
      .filter((r) => r.status === 'unable-to-check')
      .map((r) => r.reason ?? 'unspecified');
    return {
      status: 'unable-to-check',
      reason: `${reasons.length} sub-check${reasons.length === 1 ? '' : 's'} unable: ${reasons.join('; ')}`,
      evidence: { subResults },
    };
  }
  return { status: 'met', evidence: { subResults } };
}

// ─── Stub checkers (real impls land in subsequent commits) ─────────

/**
 * `chit-of-type` — queries the chit store for produced chits of the
 * given type. Real implementation lands in commit 8 of this PR
 * (queryChits integration + role-vs-slot expansion + ALL-tags
 * post-filter + claimedAt fallback). Until then, returns
 * `unable-to-check` so a partial deploy (this commit landed but not
 * commit 8) doesn't crash audit.
 */
function checkChitOfType(
  _spec: { kind: 'chit-of-type'; chitType: string; withTags?: readonly string[] },
  _taskChit: Chit<'task'>,
  _corpRoot: string,
  _opts: CheckExpectedOutputOpts,
): CheckResult {
  return {
    status: 'unable-to-check',
    reason: 'chit-of-type checker not implemented (lands in commit 8 of feat/2.1-walk-api)',
  };
}

/**
 * `branch-exists` — git shell-out for branch presence. Real impl in
 * commit 10 (uses safeGitExec helper from commit 9 with worktree-
 * aware cwd + ENOENT/EACCES/timeout handling).
 */
function checkBranchExists(
  _spec: { kind: 'branch-exists'; branchPattern: string },
  _taskChit: Chit<'task'>,
  _corpRoot: string,
  _opts: CheckExpectedOutputOpts,
): CheckResult {
  return {
    status: 'unable-to-check',
    reason: 'branch-exists checker not implemented (lands in commit 10 of feat/2.1-walk-api)',
  };
}

/**
 * `commit-on-branch` — git shell-out for commits since claimedAt.
 * Real impl in commit 10.
 */
function checkCommitOnBranch(
  _spec: { kind: 'commit-on-branch'; branchPattern: string; sinceClaim?: boolean },
  _taskChit: Chit<'task'>,
  _corpRoot: string,
  _opts: CheckExpectedOutputOpts,
): CheckResult {
  return {
    status: 'unable-to-check',
    reason: 'commit-on-branch checker not implemented (lands in commit 10 of feat/2.1-walk-api)',
  };
}

/**
 * `file-exists` — fs.existsSync against worktree-aware cwd. Real
 * impl in commit 10.
 */
function checkFileExists(
  _spec: { kind: 'file-exists'; pathPattern: string },
  _taskChit: Chit<'task'>,
  _corpRoot: string,
  _opts: CheckExpectedOutputOpts,
): CheckResult {
  return {
    status: 'unable-to-check',
    reason: 'file-exists checker not implemented (lands in commit 10 of feat/2.1-walk-api)',
  };
}
