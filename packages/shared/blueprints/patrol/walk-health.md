---
name: patrol/walk-health
origin: builtin
title: Walk Health Patrol
summary: Detect stalled walks — contracts with open steps that nobody's working on past the threshold.
steps:
  - id: run-walk-stalled
    title: Walk the active contracts
    description: |
      Run `cc-cli sweeper run walk-stalled`.

      The sweeper scans every active blueprint-backed contract and flags
      one as stalled when ALL of these are true:
        - No task on the contract is in `clearance` workflowStatus
          (Pressman owns those — agent-absence there is correct, not a
          stall).
        - No open step's assignee resolves to a live (non-archived)
          Member id. Role-assigned tasks without a slot count as
          unassigned at this layer — the role pool hasn't materialized.
        - Last forward motion (most-recent completed task's updatedAt,
          or contract.createdAt if no task has completed) is older than
          the stall threshold (default 30 min — 6 Pulse ticks).

      The sweeper emits a `warn` kink per stalled contract with the
      last-completed step, the orphan steps, and a suggested
      `cc-cli hand` re-routing.

      On a healthy corp the sweeper returns status='noop' with zero
      kinks. When it finds stalls, each contract gets its own kink
      (dedup keyed on contractId — repeated patrols bump
      occurrenceCount rather than spamming).
  - id: review-findings
    title: Read the kinks this sweep produced
    description: |
      Run `cc-cli chit list --type kink --status active --created-by sweeper:walk-stalled --limit 20`
      to filter to this patrol's output.

      Each kink body names: the walk blueprint, the last-completed step,
      every open orphan step (with task id + workflowStatus + assignee
      if any), and a `cc-cli hand` template per orphan task. The
      occurrenceCount tells you how many patrol cycles this stall has
      been alive — 1 is fresh, 5+ has been sitting for half an hour
      unattended.
  - id: decide-per-stall
    title: Decide what to do with each stall
    description: |
      Three judgment paths per kink — your call, not a rule:

      **Nudge.** Most common. The orphan task wants a fresh assignee.
      Run the suggested `cc-cli hand --to <slot-or-role> --chit <task-id>`
      with a role-pool when you don't have a specific slot in mind, or
      a slot id when one is appropriate. After handing, the kink will
      auto-resolve on the next patrol cycle (the contract starts moving
      again — sweeper finds no stall — runner closes the kink with
      resolution=auto-resolved).

      **Escalate.** When the stall has a non-obvious cause — repeated
      occurrence after re-Hand, a blueprint shape that always stalls,
      a missing role in members.json — DM the founder via the existing
      channel path so the structural problem surfaces. In a no-humans
      corp the DM becomes a permanent kink record; founder reads it on
      their next session.

      **Accept.** When the stall is intentional (Contract paused on a
      long-lead external dependency, blueprint authoring in progress,
      etc.), acknowledge the kink by closing it and stamping the
      resolution field:
      `cc-cli chit update <kink-id> --status closed --set-field kink.resolution=acknowledged --from sexton`.
      Closed kinks are history; the next patrol's recurrence (if any)
      starts at occurrenceCount=1 again — a recurrence is its own event.
  - id: summary
    title: Surface anything Mark should see
    description: |
      Your response text in this session posts to your DM with the
      founder automatically.

      Tell the founder when:
        - A stall keeps recurring after you nudged it (the second
          Hand didn't take — root cause is upstream).
        - A whole blueprint's worth of contracts are stalling at the
          same step (the blueprint shape itself is broken).
        - You can't tell from the kink + the chit store what the right
          decision is.

      If the patrol was clean (noop, no kinks) OR all stalls had
      clear nudge paths you took, respond with empty/minimal text and
      exit. Quiet patrols are correct patrols.

      Optionally write an observation chit when the patterns are worth
      compounding into BRAIN:
      `cc-cli observe "<what you noticed about walk health>" --from sexton --category NOTICE --importance 2`.
---

# Walk Health Patrol

Sexton walks this patrol alongside `patrol/health-check` on each
Pulse-wake. Health-check covers per-agent operational state (dead
processes, stuck slots); walk-health covers per-contract forward
motion. Different failure modes, different sweepers.

**Why it pairs with the 2.3 walk-aware audit gate.** Audit catches
agents at `cc-cli done` who try to advance past a missing
expectedOutput — that's the FRONT door. Walk-stalled catches the BACK
door: walks whose agents never reach `done` at all. Silent
decommission, founder override, daemon death, anti-loop release after
a transient infra flake — all leave Contracts with open steps and
nobody on them. Together the gate + the patrol close the enforcement
loop.

**Scope:** per-contract walk-forward-motion. Cross-agent coordination
checks live in `patrol/corp-health`. Chit-store data integrity scans
live in `patrol/chit-hygiene`. Per-agent stuck detection lives in
`patrol/health-check` (via the `agentstuck` sweeper).

**Threshold:** 30 minutes default — 6 Pulse ticks of zero motion.
Future enhancement: `--vars stallThresholdMin=N` blueprint var
pass-through to the sweeper for per-corp tuning. Right now the
default applies; founder can edit the sweeper module if a different
corp shape needs a different bar.

**Output:** one kink per stalled contract (dedup keyed on contractId)
+ an optional summary message in your DM with the founder + an
optional observation chit for compounding patterns. No patrol-run
chit, no artifact of the walk itself — the kinks ARE the trail.
