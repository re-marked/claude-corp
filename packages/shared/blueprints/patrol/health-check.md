---
name: patrol/health-check
origin: builtin
title: Corp Health Patrol
summary: Per-tick per-agent health sweep — silentexit + agentstuck + kink review.
steps:
  - id: run-silentexit
    title: Respawn any silent-exited slots
    description: |
      Run `cc-cli sweeper run silentexit`. Read the output.

      If it respawned any slots, note the count and the slugs. If nothing
      was dead, the sweeper returns status='noop' — that's the normal path.
      Continue to the next step regardless; silentexit + agentstuck are
      complementary reads, not either/or.
  - id: run-agentstuck
    title: Flag live-but-stuck agents
    description: |
      Run `cc-cli sweeper run agentstuck`. Read the output.

      silentexit found DEAD processes; agentstuck finds LIVE agents whose
      current task hasn't advanced in 30+ minutes. Different failure modes,
      different sweepers.

      If any agents got flagged, note their slugs + how long they've been
      stuck. Decide per-agent whether to nudge them via `cc-cli say --agent
      <slug> --message "..."` — your judgment, not a rule.
  - id: review-kinks
    title: Review open kinks from prior patrols
    description: |
      Run `cc-cli chit list --type kink --status active --limit 20`.

      These are unresolved operational findings. Look for:
        - Severity=error kinks (data integrity, repeated respawn failures)
        - High occurrenceCount kinks (same condition has been fixed and
          re-occurred across many patrols — likely a root cause unaddressed)
        - Patterns across subjects (e.g. three agents stuck on similar tasks
          at similar times suggests coordination drift)

      You don't have to act on every kink. Note the ones that merit attention.
  - id: summary
    title: Surface anything Mark should see
    description: |
      Your response text in this session posts to your DM with the founder
      automatically.

      If this patrol surfaced a signal worth telling the founder about —
      repeated respawn failures, a stuck agent you can't nudge back, a
      pattern across kinks — say it in your response. Keep it short; a
      sentence or two per concern is enough.

      If the patrol was clean (noops across the board, nothing notable in
      kinks), respond with empty/minimal text and exit. Nothing posts when
      there's nothing to say; quiet patrols are correct patrols.

      Also: if you want the observation to compound into BRAIN over time,
      write a separate observation chit:
      `cc-cli observe "<what you noticed>" --from sexton --category NOTICE --importance 2`.
      Kinks are operational; observations are soul material. Different streams.
---

# Corp Health Patrol

Sexton walks this patrol on each Pulse-wake (~5-minute cadence). It is the
load-bearing per-tick read of corp health.

**How to walk it:** read each step's description in order, execute the
instruction in your session, move to the next. This blueprint is NOT cast
to a Contract + Task chits — patrols are too lightweight for that shape;
the Contract lifecycle (Warden sign-off, acceptance criteria per step,
draft→active→review→completed) was built for work that ships something,
not for a 5-minute repeating sweep. See REFACTOR.md 1.9 for the design turn.

**Scope:** per-agent operational health — dead processes, stuck tasks,
accumulated kinks. Cross-agent coordination checks live in
`patrol/corp-health`. Chit-store data integrity scans live in
`patrol/chit-hygiene`.

**Output:** kinks per step (the sweepers emit them with dedup + auto-resolve
handled by the runner) + an optional summary message in your DM with the
founder + an optional observation chit for anything that should compound
into BRAIN over time. No patrol-run chit, no artifact of the walk itself —
the kinks ARE the trail.
