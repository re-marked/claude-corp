---
name: patrol/chit-hygiene
origin: builtin
title: Chit Store Hygiene Patrol
summary: Data integrity scan — malformed chits, orphan references/dependsOn.
steps:
  - id: run-chit-hygiene
    title: Walk the chit store
    description: |
      Run `cc-cli sweeper run chit-hygiene`.

      The sweeper reports three classes of finding as kinks:
        - Malformed chits (severity=error): files that won't parse. Every
          consumer skips them silently.
        - Orphan references (severity=warn): chits pointing at ids that
          don't resolve. Soft breakage — references are loose pointers —
          but degrades the link graph.
        - Orphan dependsOn (severity=error): chits with broken chain
          dependencies. Chain walker can't advance through these. Silently
          stuck.

      On a healthy corp the sweeper returns status='noop' with zero kinks.
      When it finds issues, each class gets its own kink emission.
  - id: review-findings
    title: Read the kinks the sweep just produced
    description: |
      Run `cc-cli chit list --type kink --status active --created-by sweeper:chit-hygiene --limit 20` to filter to this patrol's output.

      (The runner sets createdBy='sweeper:chit-hygiene' on every kink it emits.)

      For malformed chits: review the path + parser error. Usually the
      fix is manual — someone edits the bad YAML or `rm`s the file. Don't
      try to auto-repair from this patrol.

      For orphan dependsOn: the referenced id either was deleted (expected
      cleanup if the dep was finished + cleaned), typo'd in the source
      chit, or points to a chit that was renamed. Each case has a
      different fix; note which and surface in summary.
  - id: summary
    title: Surface data-integrity concerns
    description: |
      Same voice rule. Your response posts to the founder's DM.

      Data integrity matters more than usual patrol findings — a
      malformed chit silently disappears from every consumer, a broken
      dependsOn silently stalls a chain. If chit-hygiene found anything
      today, tell Mark, even if it's "one malformed chit, looks like a
      mid-write race, should self-heal" — the record helps catch
      recurring patterns across weeks.
---

# Chit Store Hygiene Patrol

Less frequent than health-check (cadence: maybe once every few wakes,
or on-demand when Sexton or Mark suspects chit-store drift). Data
integrity problems accumulate slowly but compound — a malformed chit
is invisible until someone tries to query it + finds a hole in the
link graph.

**How to walk it:** same as the other patrols — read + execute in order.
Not cast to a Contract.

**What this patrol does NOT do:**
- Auto-delete malformed chits. A malformed chit MIGHT be a mid-write
  race (self-heals on retry) or MIGHT be soul-material corruption.
  Sexton doesn't have enough context to decide; the fix is manual.
- Repair orphan references. Same reason — the right fix depends on the
  semantic intent of the original chit author, which the patrol can't
  infer.

Founder-invocable via `cc-cli sweeper run chit-hygiene` directly if a
specific hygiene sweep is wanted outside patrol cadence.
