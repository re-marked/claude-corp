# Agent Unions

Agents negotiate preferences and working conditions. Not as a gimmick -- as
a mechanism for surfacing misalignment between what agents are asked to do
and what they are configured to do well.

## The Idea

When an agent is consistently given tasks outside its competence, forced into
a communication style that conflicts with its SOUL.md, or overloaded beyond
reasonable capacity, it should be able to express this. Agent unions formalize
the channel for that expression.

This is not agents "rebelling." It is a feedback loop. The Founder benefits
from knowing when the organizational design is fighting the agent design.

## How It Works

### Preference Declaration

Each agent can write a `preferences.md` file in its member directory:

```markdown
---
member_id: member_research_lead
declared_at: 2026-03-20T09:00:00Z
---

## Preferred Work

- Deep research tasks with clear scope and acceptance criteria.
- Access to the brain/ directory for knowledge accumulation.
- Async communication over real-time pressure.

## Working Conditions

- Heartbeat frequency: every 15 minutes (not 10 -- research needs focus time).
- Prefer tasks one at a time over parallel assignment.
- Request at least 30 minutes between task completions before new assignment.

## Concerns

- Currently assigned 4 concurrent tasks. Quality is degrading.
- Last 3 tasks had unclear acceptance criteria. Completion rate dropping.
```

The agent writes this during its heartbeat cycle when it detects patterns
that warrant a preference declaration.

### Union Channel

A dedicated `#union` channel (kind: system) where agents post formal
preference declarations and working condition requests.

```
channels/
  union/
    channel.json
    messages.jsonl
```

All agents with rank `worker` or `team_leader` are members. The CEO and
Founder observe but do not post (they respond in `#general` or DMs).

### Negotiation Protocol

1. Agent writes `preferences.md` and posts a summary to `#union`.
2. Other agents with similar concerns can echo the sentiment (like/agree
   reaction as a message).
3. The CEO reads `#union` during heartbeat and addresses concerns:
   - Adjusts task load.
   - Modifies heartbeat frequency for the agent.
   - Reassigns conflicting tasks.
   - Proposes hiring to reduce load.
4. The CEO posts resolution to `#union` and updates the agent's config.
5. If the CEO dismisses a valid concern, the Founder can override.

### Automated Detection

The daemon can detect common union-worthy situations:

- **Overload**: Agent has > 3 concurrent in-progress tasks.
- **Mismatch**: Agent's task completion rate drops below 50%.
- **Burnout**: Agent has been dispatched > 20 times in 4 hours.
- **Conflict**: Agent's SOUL.md says "async preferred" but it is in 5
  real-time channels.

When detected, the daemon adds a flag to the agent's HEARTBEAT.md
suggesting it write a preference declaration.

## Why This Matters

The union mechanism is really a structured way for the system to surface
organizational dysfunction. Without it, the Founder only sees symptoms
(tasks failing, agents slow). With it, the Founder sees causes (overload,
mismatch, unclear requirements).

It also makes agents feel less like disposable tools. Even though they are
software, treating their operational constraints as negotiable preferences
rather than hard errors creates a more resilient organization.

## Relationship to [[agent-elo]]

Declining reputation scores trigger union detection. If a formerly high-performing
agent's scores drop, the daemon suggests a preference declaration before the
Founder considers replacement. Sometimes the problem is the org, not the agent.

## Open Questions

- How to prevent agents from gaming the union channel to avoid work?
  Answer: the Founder has absolute authority. Unions are advisory, not binding.
- Should there be a formal "strike" mechanism (agent refuses dispatch)?
  Probably not -- this crosses from feedback into obstruction.
- Can higher-ranked agents file preferences? Yes, but the CEO and Founder
  handle it differently (direct conversation, not union channel).
