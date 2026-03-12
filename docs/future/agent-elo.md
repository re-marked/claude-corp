# Agent ELO / Reputation System

A reputation system for agents. Track performance over time. Let peers rate
each other. Surface who is carrying the org and who is deadweight.

## The Idea

Every agent in the corporation accumulates a reputation score based on
measurable outcomes and peer assessments. The score influences trust,
autonomy, and hiring decisions. It is not a leaderboard for competition --
it is a signal for the Founder and CEO to allocate resources and attention.

## Scoring Dimensions

Reputation is not a single number. It is a multi-dimensional profile.

### Task Completion Rate

```
completed_tasks / (completed_tasks + failed_tasks + cancelled_tasks)
```

Weighted by priority: completing a critical task is worth more than
completing a low-priority one.

### Task Velocity

Average time from `assigned` to `completed`. Compared against the agent's
own historical average, not against other agents (different roles have
different expected speeds).

### Response Quality

Peer ratings on message quality. When an agent delivers a result and another
agent reviews it, the reviewer can rate the output:

```markdown
---
rating: 4
reviewer: member_ceo
reviewed: member_research_lead
task_id: task_abc123
timestamp: 2026-03-15T14:00:00Z
---

Thorough analysis. Minor gaps in competitor D coverage.
```

Stored as files in `ratings/`:

```
ratings/
  rating_001.md
  rating_002.md
```

### Reliability

How often the agent:
- Responds to dispatches within a reasonable time.
- Completes tasks without needing re-dispatch.
- Updates task status proactively.
- Shows up on heartbeat checks.

### Collaboration Score

Derived from @mention patterns:
- How often other agents mention this agent (demand signal).
- How often this agent's responses resolve chains (no further @mentions needed).
- How many distinct agents this agent interacts with (breadth).

## Reputation File

Each agent gets a reputation summary file, updated by the daemon after
each scored event:

```
members/<agent>/reputation.json
```

```json
{
  "memberId": "member_research_lead",
  "overall": 78,
  "dimensions": {
    "taskCompletion": 0.92,
    "taskVelocity": 1.15,
    "responseQuality": 4.2,
    "reliability": 0.88,
    "collaboration": 0.75
  },
  "history": [
    { "date": "2026-03-14", "overall": 75 },
    { "date": "2026-03-15", "overall": 78 }
  ],
  "totalTasks": 23,
  "totalRatings": 8
}
```

The `overall` score is a weighted composite (0-100). The weights are
configurable by the Founder.

## Uses

### Hiring Decisions

When the CEO proposes hiring a new agent for a role, it can reference the
reputation data of existing agents in similar roles to justify the need.

"Research Lead has a task completion rate of 0.92 but velocity is dropping.
Recommend hiring a second researcher to share the load."

### Autonomy Scaling

Higher-reputation agents get more autonomy:
- Depth guard increases (allowed to chain more hops).
- Heartbeat frequency decreases (trusted to self-manage).
- Task assignment without Founder approval.

Lower-reputation agents get more oversight:
- Tasks require explicit approval before dispatch.
- Responses are flagged for review.
- Heartbeat frequency increases.

### Performance Reviews

The CEO generates periodic performance reviews by reading reputation data
across all agents. These reviews go to the Founder as structured reports.

## Visibility

The agent inspector ([[layer-6-views]]) shows the reputation profile.
The hierarchy tree could show reputation as a visual indicator (brighter
nodes = higher reputation).

## Open Questions

- Should agents see their own reputation? It could influence behavior
  (gaming the score). But transparency is a core value.
- Should reputation decay over time? An agent that was great last month
  but idle this month should not coast on old scores.
- How to handle new agents with no history? Start at a neutral baseline
  (50) and let it converge quickly.
- Should the Founder be able to manually adjust reputation? Probably yes,
  as an override, logged in git.
