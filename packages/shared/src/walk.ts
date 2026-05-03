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

import type { Chit, BlueprintStep, BlueprintFields, ContractFields, TaskFields } from './types/chit.js';
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
