---
name: patrol/clearing
origin: builtin
title: Clearinghouse Clearing Patrol
summary: |
  Pressman's canonical loop — claim lock, rebase, test, merge. Read by
  Sexton during her wake summary to know what the merge lane is doing,
  and by future LLM-Pressman (v2) as their walked patrol blueprint. v1
  Pressman is daemon-driven; this file documents the flow.
steps:
  - id: scan-queue
    title: Scan the clearance-submission queue
    description: |
      `cc-cli chit list --type clearance-submission --status active`
      (filtered to submissionStatus=queued in the body) returns ranked
      submissions. The Gas Town-adapted priority formula:

        score = 1000
              + (queue_age_hours × 10)
              + ((4 - priorityLevel) × 100)   [critical=300, low=0]
              - min(retryCount × 50, 300)     [anti-thrashing cap]
              + (pr_age_hours × 1)

      Skip if queue empty. The scheduler returns to its idle interval
      until the next tick.
  - id: claim-lock
    title: Claim the clearinghouse-lock for the top submission
    description: |
      The lock is a singleton corp-scope JSON at
      `<corpRoot>/clearinghouse-lock.json`. Atomic claim via
      `claimClearinghouseLock` — refuses when someone else holds it
      OR when this slug already holds for a DIFFERENT submission
      (forces explicit release first; otherwise prior submission
      strands in submissionStatus=processing with no recovery path).

      On successful claim: lock state stored on disk, scheduler
      proceeds. On failure: skip this tick; resumeClearinghouse will
      catch stale-holder cases on the next sweep.
  - id: acquire-worktree
    title: Acquire an isolated worktree
    description: |
      WorktreePool hands back a clean worktree at
      `<corpRoot>/.clearinghouse/wt-N/` with the PR's branch checked
      out. Pool-managed: idle entries get reset (resetHard +
      cleanWorkdir) before reuse — no inheritance of dirty state from
      prior submissions. Up to DEFAULT_POOL_CAP (4) entries; if all
      held, returns retryable failure.
  - id: fetch-and-rebase
    title: Fetch origin, rebase against base
    description: |
      `git fetch origin <baseBranch>` + `attemptRebase`. The flow
      classifies into five outcomes:

      - clean → proceed to tests.
      - auto-resolved → trivial conflicts (whitespace / comment-only /
        identical) auto-resolved by the conflict classifier; proceed.
      - needs-author → substantive conflicts; abort the rebase, file
        a blocker chit (severity=blocker, scoped to author's role
        via 1.4.1), mark submissionStatus=failed with reason. Lock
        released; next tick takes a different submission.
      - sanity-failed → post-rebase diff blew up beyond the file-count
        ceiling (max(pre × 5, 20)). Catches stale base, accidental
        cherry-pick, generated-file explosion. Mark failed; surface
        to engineering-lead via the failure record's route field.
      - fatal → runtime error from gitOps (network, disk, tool); mark
        failed; pedagogicalSummary surfaces the cause.
  - id: run-tests
    title: Run tests with flake retry
    description: |
      `runWithFlakeRetry` runs the corp's test command (default
      `pnpm test`, configurable via CLEARINGHOUSE_TEST_COMMAND).
      First run + one retry on initial failure (1s delay between).

      Outcomes:
      - passed-first → proceed to merge.
      - flake → re-run passed; treat as success, log the flake.
      - consistent-fail → both runs failed with overlapping failures;
        file blocker (severity=blocker, scoped to author's role)
        with the per-test failure summary; mark failed.
      - inconclusive → timeout / crash / tool-missing; mark failed
        and surface to founder (the corp's test environment is
        misbehaving in a way re-running won't fix).

      v2 enhancement: `attributeFailure` runs the same tests on main
      and classifies pr-introduced vs main-regression vs mixed — the
      lead-the-field piece. Out-of-scope for v1 because gitOps doesn't
      expose checkoutRef yet.
  - id: attempt-merge
    title: Push the rebased branch
    description: |
      `attemptMerge` does `git push --force-with-lease origin <branch>`
      and captures HEAD sha. Outcomes:

      - merged → markSubmissionMerged cascades through task workflow
        (clearance → completed) and contract chit.status (clearance →
        completed when all sibling tasks complete). Lock released.
      - race → origin moved between our rebase and our push;
        retryCount++, submissionStatus flips back to queued for next
        tick. Capped at PRESSMAN_RETRY_CAP (3); beyond that, mark
        failed.
      - hook-rejected → origin's pre-receive hook refused; the hook's
        stderr captured into the blocker chit. Author addresses, runs
        cc-cli done on a fix, audit re-fires enterClearance.
      - branch-deleted → unrecoverable; mark failed; surface to
        author's role.
      - fatal → runtime error; mark failed.
  - id: release
    title: Release the lock
    description: |
      releaseClearinghouseLock with the holder slug. Mismatch returns
      false (stale-handle protection); the periodic resumeClearinghouse
      sweep catches dead-holder cases.

      Worktree returned to pool (reset + clean) for the next
      acquire. Pool stays warm — saves create/destroy churn.
  - id: log-outcome
    title: Log the tick outcome for retrospective
    description: |
      Daemon log entry summarizes: submission id, branch, outcome,
      time, any cascade deltas. Sexton's wake digest reads the
      observation/escalation/kink chit stream — the blocker chit
      from a needs-author outcome surfaces naturally there without
      a separate notification path.
---

# Clearinghouse Clearing Patrol

The Pressman's canonical loop. Documentation-shape for v1 (daemon
runs the loop directly) and walked-by-LLM-Pressman shape for v2
when judgment moments need an agent's session.

## When to walk this

Continuously, while a Pressman is hired and the queue is non-empty.
Each tick is one submission's full journey from queued to merged
(or failed-with-blocker). Tick interval is 30s by default —
configured via PRESSMAN_TICK_INTERVAL_MS.

## What this is NOT

- Not pre-push review. That's `patrol/code-review` (Editor's job
  in PR 4). By the time a submission reaches Pressman's queue,
  Editor has already approved or cap-bypassed.
- Not author-side conflict resolution. That's `patrol/conflict-
  resolution` — the substitute-author flow when a blocker routes
  back via 1.4.1.
- Not a GitHub Actions surrogate. We do CI-style work locally
  before merging; CI on origin runs after as a safety net.

## Failure routing rules

The `route` field on every FailureRecord drives blocker scoping:

- `author` — patch is broken; route to PR author's role via 1.4.1.
- `engineering-lead` — main branch is broken (regression); the PR
  is innocent. Route up.
- `founder` — corp infra broken (disk full, tool missing, network
  down). Tier-3 inbox via existing audit channel.

## Why daemon-driven for v1

Every judgment moment the spec described — flake-vs-real,
trivial-vs-substantive conflict, sanity check — is already encoded
in the PR 2 primitives (flake detector, conflict classifier,
post-rebase sanity check). There's no LLM-shaped decision left.

v2 transition target: contract-aware merge ordering (avoid merging
tasks of the same contract simultaneously to reduce conflict
surface), founder-DM-on-stuck (Pressman pings founder when judgment
runs out beyond the encoded rules).
