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

import type { Chit } from './types/chit.js';

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
