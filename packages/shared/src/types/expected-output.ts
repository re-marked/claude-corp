/**
 * ExpectedOutputSpec — Project 2.1 schema for what a blueprint step is
 * expected to mechanically produce. Walk-aware audit (Project 2.3) reads
 * this spec and dispatches to per-kind checkers (chit query, git
 * shell-out, fs check, etc.) to enforce that the agent actually produced
 * what the workflow expected before approving `cc-cli done`.
 *
 * Discriminated union by `kind`. Extensible by design — each new kind is
 * one validator entry (in chit-types.ts) + one checker function (in the
 * future walk.ts module shipping in PR 2 of Project 2.1). Anticipated
 * future kinds (deferred to 2.8 if blueprint authoring needs them):
 * tests-pass, pr-exists, git-tag-exists.
 *
 * Templated string fields (`branchPattern`, `pathPattern`, `withTags[]`)
 * are Handlebars-templated against the cast-time vars + task fields,
 * matching the existing 1.8 blueprint template-expansion model.
 *
 * The checker contract (defined in walk.ts in PR 2 of 2.1):
 *   checkExpectedOutput(step, taskChit, corpRoot, opts?) →
 *     { status: 'met' | 'unmet' | 'unable-to-check', missing?, evidence?, reason? }
 *
 * Three-state outcome — `unable-to-check` covers environmental failures
 * (git not in PATH, gh CLI missing, network down) so transient infra
 * never locks agents out of `done`. Repeated unable-to-check on the
 * same step surfaces as a kink via Sexton's patrol next cycle.
 */

/**
 * Step expected to produce a chit of a given type. The most common kind
 * for steps that produce a structured artifact (clearance-submission,
 * review-comment, observation, etc.).
 *
 * Audit's checker queries chits matching:
 *   { type: chitType, createdBy: assignee, since: claimedAt, withTags }
 *
 * The createdBy + since filters are load-bearing: a step's expectedOutput
 * is "the agent working THIS step produced this chit during their work
 * on it," not "this chit type exists somewhere in the corp." Without
 * those filters, false positives across agents + step boundaries would
 * make the audit useless.
 */
export interface ExpectedOutputChitOfType {
  readonly kind: 'chit-of-type';
  readonly chitType: string;
  /** Optional tag patterns the produced chit must carry. Handlebars-templated. */
  readonly withTags?: readonly string[];
}

/**
 * Step expected to produce a git branch matching a templated pattern
 * (e.g. `feat/{{feature}}`). Audit shell-outs to `git branch --list`
 * with the expanded pattern; non-empty result means the branch exists.
 *
 * Worktree-aware: audit passes the task's worktree path as cwd if the
 * task has one allocated (Clearinghouse pattern); otherwise corpRoot.
 * Without worktree-awareness, branches living in feature worktrees
 * would be invisible to checks running in the corp's primary checkout.
 */
export interface ExpectedOutputBranchExists {
  readonly kind: 'branch-exists';
  /** Handlebars-templated git branch pattern (e.g. `feat/{{feature}}`). */
  readonly branchPattern: string;
}

/**
 * Step expected to produce ≥1 commit on the named branch since the
 * agent claimed the step. The canonical user is the `implement` step
 * in `ship-feature` — the agent transitions dispatched → in_progress
 * (sets claimedAt), does work, commits, and audit verifies "yes there
 * was committed work during this step."
 *
 * Defaults to since-claim (`sinceClaim: true`). Setting `sinceClaim:
 * false` makes the check "any commits on this branch ever" — useful
 * for steps that verify a branch HAS work (e.g. handoff to ship)
 * regardless of when it was committed.
 */
export interface ExpectedOutputCommitOnBranch {
  readonly kind: 'commit-on-branch';
  readonly branchPattern: string;
  /** Default true — only commits since claimedAt count. Set false to count any commits ever. */
  readonly sinceClaim?: boolean;
}

/**
 * Step expected to produce a file at a specific path. Handlebars-
 * templated path resolved against worktree-aware cwd.
 *
 * Not git-aware — checks the working tree, not commits. A file added
 * to the working tree but not committed satisfies file-exists; for the
 * commit signal use commit-on-branch.
 */
export interface ExpectedOutputFileExists {
  readonly kind: 'file-exists';
  readonly pathPattern: string;
}

/**
 * Step expected to add a specific tag to its own Task chit. Lightweight
 * signal for steps that don't produce external artifacts (decision
 * steps, gate steps where the "output" is the agent acknowledging by
 * tagging). No shell-out, no chit query — pure tag check.
 */
export interface ExpectedOutputTagOnTask {
  readonly kind: 'tag-on-task';
  readonly tag: string;
}

/**
 * Step expected to fill in `task.output` (the agent's prose summary
 * from 1.3's structured task I/O). Minimum bar for any step where the
 * agent must SAY what they did, even when no other artifact is produced.
 */
export interface ExpectedOutputTaskOutputNonempty {
  readonly kind: 'task-output-nonempty';
}

/**
 * Composed spec — all sub-specs must be `met` for the composed check to
 * be `met`. If any sub-check returns `unable-to-check`, the composed
 * status propagates as `unable-to-check` (graceful degradation on
 * environmental failures). If all sub-checks ran and at least one
 * returned `unmet`, the composed status is `unmet`.
 *
 * Allows steps with multiple expected outputs (e.g. a step that should
 * both produce a chit AND make a git commit). Recursive — sub-specs
 * can themselves be `multi`, though deep nesting is uncommon.
 */
export interface ExpectedOutputMulti {
  readonly kind: 'multi';
  readonly specs: readonly ExpectedOutputSpec[];
}

/**
 * The discriminated union. New kinds added here + in chit-types.ts's
 * validateExpectedOutput + in walk.ts's per-kind checker. Three changes
 * per new kind keeps the surface bounded and the additions greppable.
 */
export type ExpectedOutputSpec =
  | ExpectedOutputChitOfType
  | ExpectedOutputBranchExists
  | ExpectedOutputCommitOnBranch
  | ExpectedOutputFileExists
  | ExpectedOutputTagOnTask
  | ExpectedOutputTaskOutputNonempty
  | ExpectedOutputMulti;

/**
 * Discriminator string set — derived once for validators that need to
 * enforce the kind field is one of the known values. Single source of
 * truth so a new kind added to the union is one place to update here.
 */
export const EXPECTED_OUTPUT_KINDS = [
  'chit-of-type',
  'branch-exists',
  'commit-on-branch',
  'file-exists',
  'tag-on-task',
  'task-output-nonempty',
  'multi',
] as const;

export type ExpectedOutputKind = typeof EXPECTED_OUTPUT_KINDS[number];
