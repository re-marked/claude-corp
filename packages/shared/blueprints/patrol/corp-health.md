---
name: patrol/corp-health
origin: builtin
title: Corp-wide Coordination Patrol
summary: Cross-agent coordination checks — orphaned tasks, chain stalls, role-pool imbalances.
steps:
  - id: run-orphantask
    title: Find queued-but-unowned tasks
    description: |
      Run `cc-cli sweeper run orphantask`.

      An orphan task is workflowStatus=queued + no assignee (or assignee is
      archived/missing) + no active blocker. Forward motion stalled only
      because nobody owns the work. Common upstream cause: a blueprint
      cast that partially succeeded, an agent that created a task without
      --assignee, or a fire that didn't reassign the member's queued work.

      If any orphans found: they block chain progress. Reassign via
      `cc-cli hand --to <slot-or-role> --chit <id>`. Your judgment on
      slot vs role pool.
  - id: review-role-pool-state
    title: Check role-pool imbalances
    description: |
      Run `cc-cli members` (or `cc-cli agents`) to see the current pool.

      For each Employee role you see, ask:
        - Is this role's queue depth drifting? A pool of 1 backend-engineer
          with 8 queued tasks = an imbalance pre-bacteria.
        - Are there members with kind='employee' whose workspaces look
          stale (no recent work) + whose pool-mates are active?

      This step is pre-1.10 scaffolding. Once bacteria ships, bacteria
      handles queue-depth → spawn/collapse automatically. Until then, the
      check is observational — name what you see in your summary if it's
      worth Mark's attention.
  - id: review-contract-progress
    title: Scan for stalled contracts
    description: |
      Run `cc-cli chit list --type contract --status active --limit 20`.

      For any contract that's been active > N hours with no task progress
      (check each contract's referenced tasks via `cc-cli chit read
      <contract-id> --json`), that's a chain stall. Different from
      per-agent stuck (agentstuck's territory) — this is contract-level,
      often a cross-role blocker that didn't get filed or a Warden review
      that sat unclaimed.

      Note what you find; don't try to unblock it in-patrol (that's
      founder / Contract Lead territory). Surface in your summary if the
      stall matters.
  - id: summary
    title: Surface anything Mark should see
    description: |
      Same voice rule as health-check: your response text posts to the
      founder's DM. Speak when the patrol found something; stay quiet
      when it was clean.

      Corp-health is typically quieter than health-check — most ticks are
      no-op on this patrol. That's fine. Cross-agent coordination
      problems accumulate slowly; running this every 30-60 min is enough.
---

# Corp-wide Coordination Patrol

Complement to `patrol/health-check`. Where health-check is per-agent
("is this slot alive + making progress?"), corp-health is cross-agent
("are tasks routed correctly? are contracts advancing? are role pools
balanced?").

Cadence: less frequent than health-check — Sexton typically runs this
every few wakes, not every wake. Hot failures (dead agents, stuck tasks)
surface via health-check within 5 min; cross-agent coordination issues
develop over hours and don't need minute-granularity detection.

**How to walk it:** same as health-check — read each step's description
in order, execute in-session, move to the next. This blueprint is read +
walked, NOT cast to a Contract.

**Limitations as of 1.9.6:**
- Bacteria (1.10) not shipped → role-pool imbalance detection is
  observational only, no auto-scale.
- Shipping (1.12) not shipped → no merge-queue check in this patrol yet.
  When 1.12 lands, a separate `patrol/merge-queue-status` will carry that.
