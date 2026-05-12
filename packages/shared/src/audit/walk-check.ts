/**
 * Project 2.3 — walk-aware audit check. Composes the 2.1 surfaces
 * (`getWalkPosition` + `checkExpectedOutput`) into a single helper the
 * cc-cli audit hook calls AFTER `runAudit` returns. The split is
 * deliberate: `runAudit` stays pure (no I/O) for testability;
 * walk-check does the chit / git / fs reads at the CLI boundary.
 *
 * Five-state outcome (richer than checkExpectedOutput's three) so
 * the CLI can distinguish "this task isn't part of a walk" from
 * "this task IS in a walk but the step has no expectedOutput" — the
 * former is graceful no-walk degradation (ad-hoc work), the latter
 * is the documented vacuous-truth case (walk with deliberately
 * unenforced step). Same approve effect, different log lines, so
 * post-hoc analysis can tell why a particular task wasn't gated.
 *
 *   - `no-walk`         → task is tagless ad-hoc, OR walk-tagged but
 *                          neither the walk lookup nor the task-
 *                          carried fallback yield an expectedOutput
 *                          spec to run. Audit unchanged. (Blueprint
 *                          drift — blueprint deleted / step removed
 *                          after cast — does NOT fall here; the
 *                          task-carried spec keeps the gate alive.)
 *   - `no-spec`         → walk resolved but step has no
 *                          expectedOutput. Vacuous met per 2.1
 *                          checker contract; audit unchanged.
 *   - `met`             → spec ran, all artifacts present.
 *   - `unmet`           → spec ran, artifact(s) missing. Carries a
 *                          rendered teaching message naming the
 *                          missed step, expected output shape, and
 *                          the cc-cli verb that produces it.
 *   - `unable-to-check` → checker couldn't fire (git not in PATH,
 *                          gh missing, network down). Audit treats
 *                          as approved-with-warning + logs.
 *
 * The teaching message lives here (not in audit.ts) so the CLI
 * stays a thin orchestrator AND the test suite can pin the
 * agent-facing wording without driving the whole hook flow.
 */

import type { Chit, TaskFields } from '../types/chit.js';
import type {
  ExpectedOutputSpec,
  ExpectedOutputKind,
} from '../types/expected-output.js';
import {
  checkExpectedOutput,
  getWalkPosition,
  getWalkStepId,
  getWalkBlueprintName,
  type CheckExpectedOutputOpts,
  type CheckResult,
} from '../walk.js';

/**
 * Discriminated union returned by `runWalkCheck`. Five states; the
 * CLI's decision matrix branches on `status`.
 *
 * Every state except `no-walk` carries `stepId` so log entries can
 * thread the same step identifier across multiple sessions on the
 * same task — useful for Sexton's stalled-walk patrol detecting
 * "this step has been failing checks for N cycles."
 */
export type WalkCheckOutcome =
  | { readonly status: 'no-walk' }
  | { readonly status: 'no-spec'; readonly stepId: string; readonly blueprintName: string }
  | {
      readonly status: 'met';
      readonly stepId: string;
      readonly blueprintName: string;
      readonly kind: ExpectedOutputKind;
    }
  | {
      readonly status: 'unmet';
      readonly stepId: string;
      readonly blueprintName: string;
      readonly kind: ExpectedOutputKind;
      readonly missing: readonly string[];
      readonly teachingMessage: string;
    }
  | {
      readonly status: 'unable-to-check';
      readonly stepId: string;
      readonly blueprintName: string;
      readonly kind: ExpectedOutputKind;
      readonly reason: string;
    };

/**
 * Run the walk-aware check for a task. Five-state outcome — see
 * WalkCheckOutcome.
 *
 * `slug` is the agent's member id; threaded into the teaching message
 * so the prose says "produced by you" rather than "produced by the
 * assignee" (less ambiguous at read time when the agent is the one
 * staring at the block).
 *
 * `opts.cwd` is forwarded to `checkExpectedOutput` for shell-out
 * checkers (branch-exists / commit-on-branch / file-exists). Audit
 * passes the agent's workspace path — Clearinghouse Employees
 * already work inside their feature worktree, so the agent dir IS
 * the worktree path in the Clearinghouse pattern. Falls back to
 * corpRoot inside the checker when cwd is absent.
 */
export function runWalkCheck(
  corpRoot: string,
  taskChit: Chit<'task'>,
  slug: string,
  opts: CheckExpectedOutputOpts = {},
): WalkCheckOutcome {
  // Resolve the spec + identifiers we'll use. Two paths:
  //
  //   1. Walk-position resolves (blueprint + contract still intact)
  //      → use walkPos.expectedOutput + walkPos.stepId/blueprintName.
  //
  //   2. Walk-position is null but the task carries its pre-expanded
  //      expectedOutput from cast time → use the task field +
  //      identifiers from the task's `blueprint:*` / `blueprint-step:*`
  //      tags. Codex P2 on PR #211: task.fields.task.expectedOutput is
  //      stored at cast specifically so audit can still enforce when
  //      the blueprint is edited/deleted or the step is removed AFTER
  //      cast (the documented drift case in walk.ts:174-186). Without
  //      this fallback, blueprint-drift silently bypasses enforcement
  //      — every cast task whose blueprint changes mid-flight escapes
  //      the gate.
  //
  // Tagless ad-hoc tasks (no walk-step tag at all) fall through to
  // no-walk — those genuinely have no walk to enforce.
  const walkPos = getWalkPosition(taskChit, corpRoot);

  let spec: ExpectedOutputSpec | null;
  let stepId: string;
  let blueprintName: string;
  if (walkPos) {
    spec = walkPos.expectedOutput;
    stepId = walkPos.stepId;
    blueprintName = walkPos.blueprintName;
  } else {
    const taskFields = taskChit.fields.task as TaskFields;
    const taskSpec = taskFields.expectedOutput ?? null;
    const tagStepId = getWalkStepId(taskChit);
    const tagBlueprintName = getWalkBlueprintName(taskChit);
    if (!taskSpec || !tagStepId || !tagBlueprintName) {
      // Genuinely ad-hoc (no walk tags) OR walk-tagged but with no
      // cast-time spec to enforce (deferred-validation case). Both
      // are no-walk from the gate's perspective.
      return { status: 'no-walk' };
    }
    spec = taskSpec;
    stepId = tagStepId;
    blueprintName = tagBlueprintName;
  }

  if (spec === null) {
    return {
      status: 'no-spec',
      stepId,
      blueprintName,
    };
  }

  const result = checkExpectedOutput(spec, taskChit, corpRoot, opts);
  const kind = spec.kind;

  if (result.status === 'met') {
    return {
      status: 'met',
      stepId,
      blueprintName,
      kind,
    };
  }

  if (result.status === 'unable-to-check') {
    return {
      status: 'unable-to-check',
      stepId,
      blueprintName,
      kind,
      reason: result.reason ?? 'unable-to-check (no reason given by checker)',
    };
  }

  // unmet — render the teaching message and return.
  return {
    status: 'unmet',
    stepId,
    blueprintName,
    kind,
    missing: result.missing ?? [],
    teachingMessage: renderTeachingMessage({
      spec,
      result,
      stepId,
      blueprintName,
      taskId: taskChit.id,
      slug,
    }),
  };
}

/**
 * Render the per-kind teaching message shown in the audit block.
 * Names the missed step + expected artifact shape + the cc-cli
 * verb that produces it. The agent reads this in their session
 * after audit blocks; the goal is "they can fix it without re-
 * reading the blueprint."
 *
 * Recursive on `multi` — walks `evidence.subResults` in parallel
 * with `spec.specs` (same order, contract enforced by checkMulti)
 * and renders teaching for each unmet sub-spec. Falls back to a
 * generic enumeration when the evidence shape isn't what we expect
 * (defensive — should never fire given the in-package contract).
 */
interface TeachingContext {
  readonly spec: ExpectedOutputSpec;
  readonly result: CheckResult;
  readonly stepId: string;
  readonly blueprintName: string;
  readonly taskId: string;
  readonly slug: string;
}

export function renderTeachingMessage(ctx: TeachingContext): string {
  const { spec, stepId, blueprintName, taskId, slug } = ctx;
  const where = `step \`${stepId}\` (in walk \`${blueprintName}\`)`;

  switch (spec.kind) {
    case 'chit-of-type': {
      const tagsClause = spec.withTags && spec.withTags.length > 0
        ? ` with tags [${spec.withTags.map((t) => `\`${t}\``).join(', ')}]`
        : '';
      return (
        `Walk-aware audit blocked: ${where} expected a chit of type \`${spec.chitType}\`${tagsClause} ` +
        `created by you (\`${slug}\`) since you claimed the step. None found in the chit store. ` +
        `Produce the chit before \`cc-cli done\` — the workflow's next step depends on it.`
      );
    }

    case 'branch-exists': {
      return (
        `Walk-aware audit blocked: ${where} expected a git branch matching \`${spec.branchPattern}\` ` +
        `to exist in the worktree. No matching branch found. Create it (\`git switch -c <name>\`) ` +
        `or move your work onto the expected branch before \`cc-cli done\`.`
      );
    }

    case 'commit-on-branch': {
      const sinceClause = spec.sinceClaim === false
        ? ''
        : ' since you claimed the step';
      return (
        `Walk-aware audit blocked: ${where} expected at least one commit on branch ` +
        `\`${spec.branchPattern}\`${sinceClause}. No matching commit found. Commit your work ` +
        `(\`git commit -m "..."\`) on the right branch before \`cc-cli done\`.`
      );
    }

    case 'file-exists': {
      return (
        `Walk-aware audit blocked: ${where} expected a file at \`${spec.pathPattern}\`. ` +
        `File not found in the worktree. Create the artifact (or check the path) before \`cc-cli done\`.`
      );
    }

    case 'tag-on-task': {
      return (
        `Walk-aware audit blocked: ${where} expected tag \`${spec.tag}\` on this task chit ` +
        `(\`${taskId}\`). Tag is missing. Add it with \`cc-cli chit tag ${taskId} +${spec.tag}\` ` +
        `before \`cc-cli done\` — the tag is how the step's completion signal is recorded.`
      );
    }

    case 'task-output-nonempty': {
      return (
        `Walk-aware audit blocked: ${where} expected \`task.output\` to contain a prose summary ` +
        `of what you did. The field is empty. Pass at least one \`--completed "..."\` argument to ` +
        `\`cc-cli done\` (the flag accepts multiple — one per discrete thing you finished). The ` +
        `--completed entries get joined with newlines into task.output during handoff promotion, ` +
        `and downstream steps + audits read that field.`
      );
    }

    case 'multi': {
      const subSpecs = spec.specs;
      const evidence = ctx.result.evidence as { subResults?: readonly CheckResult[] } | undefined;
      const subResults = evidence?.subResults ?? [];

      // Render teaching for every unmet sub-spec; skip met / unable
      // sub-specs in the prose (unable surfaces in the unable-to-check
      // log path; met is silent). Defensive fallback: when subResults
      // count diverges from subSpecs (shouldn't happen — checkMulti
      // builds them in lockstep), enumerate the spec kinds so the
      // agent at least sees what was expected.
      if (subResults.length === subSpecs.length && subResults.length > 0) {
        const lines: string[] = [];
        for (let i = 0; i < subSpecs.length; i++) {
          const sub = subSpecs[i]!;
          const subResult = subResults[i]!;
          if (subResult.status !== 'unmet') continue;
          lines.push(
            renderTeachingMessage({
              spec: sub,
              result: subResult,
              stepId,
              blueprintName,
              taskId,
              slug,
            }),
          );
        }
        if (lines.length === 0) {
          // Shouldn't happen: checkMulti returns 'unmet' iff at least
          // one sub-result is unmet. Fall through to the generic
          // enumeration below.
        } else if (lines.length === 1) {
          return lines[0]!;
        } else {
          return (
            `Walk-aware audit blocked: ${where} requires multiple outputs; ${lines.length} ` +
            `of ${subSpecs.length} sub-checks failed:\n\n` +
            lines.map((l, i) => `  ${i + 1}. ${l}`).join('\n\n')
          );
        }
      }

      const kindList = subSpecs.map((s) => `\`${s.kind}\``).join(', ');
      return (
        `Walk-aware audit blocked: ${where} requires multiple outputs (${kindList}); ` +
        `at least one sub-check failed. Re-read the step's expectedOutput spec to see which artifacts are needed.`
      );
    }
  }
}
