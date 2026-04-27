---
name: patrol/conflict-resolution
origin: builtin
title: Clearinghouse Conflict Resolution Patrol
summary: |
  Author-side flow when a Pressman blocker routes to your role.
  Read the blocker, fetch the branch, resolve, re-submit via
  cc-cli done. Substitute-author-friendly: doesn't assume the
  original author is still alive.
steps:
  - id: read-blocker
    title: Read the escalation chit Pressman filed
    description: |
      `cc-cli chit read <escalation-id>`. The body contains:

      - The submission id + branch name
      - The originating author's slug (you may or may not be them
        depending on role-resolver dispatch)
      - The summary: rebase conflict / test failure / hook rejection
      - The detail: per-file conflict list, per-test failure names,
        or hook output

      If the originating author isn't you, this is a substitute
      pickup — read the relevant context (the linked task chit's
      acceptanceCriteria, contract goal, recent commits on the
      branch) before attempting the resolution.
  - id: pull-branch
    title: Pull the PR branch into your sandbox
    description: |
      `git fetch origin <branch>` + `git checkout <branch>` in your
      agent workspace. The branch on origin has the latest commits
      from before Pressman attempted the rebase. You're picking up
      where the author left off.
  - id: resolve
    title: Apply the resolution
    description: |
      Per blocker category:

      - **Rebase conflict** — `git rebase origin/main` locally; the
        same conflicts Pressman saw will appear. Resolve them
        manually. The blocker chit lists the conflicted files and
        worst triviality per file as a hint.
      - **Test failure** — read the named tests; reproduce locally;
        fix the code or fix the tests (per the failure shape).
        Re-run `pnpm test` to confirm.
      - **Hook rejection** — the hook's output is captured in the
        blocker. Address what it complained about (often missing
        reviewer signoff, branch-name format, secret detection).

      If the resolution requires changes the original author would
      object to (architectural shift, scope expansion), file a
      counter-escalation rather than guessing.
  - id: commit-and-push
    title: Commit + push to origin
    description: |
      `git add` + `git commit -m "<concise message>"` + `git push
      origin <branch>` (force-with-lease since the branch may have
      been rebased locally).
  - id: re-submit
    title: Run cc-cli done on the chain step
    description: |
      The blocker is filed as an escalation against your task chit.
      Resolving the underlying issue advances the task back to
      `under_review` (via cc-cli block --resolve or by completing
      the chain step normally). Then run cc-cli done; audit
      approves; enterClearance re-fires; submission re-enters the
      Pressman queue. No manual cc-cli clearinghouse submit
      needed — the standard flow handles re-submission.
  - id: log-takeover
    title: Write a brief observation if you took over from another author
    description: |
      Substitute pickups are worth noting for CULTURE.md compounding:
      `cc-cli observe "Picked up <branch> from <originating-author>;
      the conflict was <type>; resolved by <approach>" --from <you>
      --category NOTICE --importance 2`. Helps the corp learn which
      conflict patterns repeat.
---

# Clearinghouse Conflict Resolution Patrol

The substitute-author flow when Pressman files a blocker. Walked
by whoever the role-resolver dispatches to (original author if
alive and idle; otherwise any Employee of the role; otherwise
bacteria spawns one).

## Why role-scoped, not slot-scoped

Original author may be decommissioned by the time the blocker
fires. If the routing required them specifically, work would
strand on every author rotation. Role-scoping means the corp
absorbs the loss; substitute can pick up cold using the
pedagogical context the blocker chit carries.

## What stays with the original author

The originating-author field on the blocker carries Toast's
slug as context — when the substitute reads "this was Toast's
PR," they understand the sandbox state, prior decisions, and
whether to consult Toast's prior observations / handoff chits
in agent:toast/ scope.

## When to escalate beyond your role

If the resolution requires authority you don't have (changing
acceptance criteria, expanding scope, deciding whether the
contract goal still applies), counter-escalate via cc-cli
escalate to engineering-lead or contract-lead. Don't guess.
