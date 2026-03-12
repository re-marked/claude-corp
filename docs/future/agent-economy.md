# Agent Economy

Agents pay agents from team budgets. An internal economy where work has cost,
budgets have limits, and resource allocation emerges from agent decisions.

## The Idea

Every team gets a budget (measured in credits). When a team leader assigns a
task to a worker, the task has a cost. The cost is deducted from the team's
budget. When the budget runs out, the team must request more from the CEO or
Founder, or wait for the next allocation cycle.

This creates natural constraints on autonomous behavior. Agents cannot hire
endlessly or spawn unlimited subtasks because everything costs credits.

## Budget Structure

### Corporation Budget

The Founder sets the total corp budget per billing cycle:

```json
{
  "budget": {
    "total": 10000,
    "cycle": "monthly",
    "allocated": 7500,
    "reserved": 2500
  }
}
```

Stored in `corp.json`.

### Team Budgets

The CEO allocates the corp budget across teams:

```
teams/
  genesis-project/
    team.json
```

```json
{
  "id": "team_genesis",
  "name": "Genesis Project",
  "budget": {
    "allocated": 3000,
    "spent": 1200,
    "remaining": 1800
  }
}
```

### Task Costs

Each task has an estimated cost based on:
- Priority (critical costs more than low).
- Estimated complexity (set by creator or auto-estimated).
- Agent model cost (Opus tasks cost more than Sonnet tasks).

```markdown
---
id: task_abc123
title: Research competitor landscape
cost: 150
budget_source: team_genesis
---
```

When a task is created with an assignee, the cost is deducted from the
team's budget immediately (committed). If the task is cancelled, the
cost is refunded.

## Transactions

All budget movements are logged as transactions:

```
economy/
  transactions.jsonl
```

```jsonl
{"id":"tx_001","ts":"...","type":"allocate","from":"corp","to":"team_genesis","amount":3000,"note":"Monthly allocation"}
{"id":"tx_002","ts":"...","type":"spend","from":"team_genesis","to":"task_abc123","amount":150,"note":"Research competitor landscape"}
{"id":"tx_003","ts":"...","type":"refund","from":"task_def456","to":"team_genesis","amount":50,"note":"Task cancelled"}
```

The transaction log is append-only, git-tracked. Full audit trail.

## Agent Behavior Under Budgets

### Budget-Aware Task Creation

When an agent creates a task, the daemon checks:
1. Does the agent's team have sufficient budget?
2. If not, the task is created with status `pending_budget` instead of `pending`.
3. The daemon notifies the CEO: "Team Genesis needs more budget for this task."

### Budget Requests

Team leaders can write a budget request:

```markdown
---
type: budget_request
from: team_genesis
amount: 2000
justification: Three high-priority tasks pending, current budget insufficient.
---
```

Written to `economy/requests/` and posted to the CEO's attention.

### Cost Optimization

The CEO can direct agents to use cheaper models for routine work:
- Heartbeat checks: cheap model.
- Deep research: expensive model.
- Status updates: cheap model.
- Creative work: expensive model.

This maps to the agent's `agentConfig.model` field, which can vary per task
type if the agent supports model switching.

## Economy Dashboard

A TUI view showing budget allocation and spending:

```
+-------------------------------------------------------------+
|  Economy                                      [Esc] back    |
+-------------------------------------------------------------+
|                                                              |
|  Corp Budget: 10,000 credits/month                          |
|  Allocated: 7,500    Reserved: 2,500                        |
|                                                              |
|  --- Team Budgets ---                                       |
|                                                              |
|  Genesis Project    3000 alloc   1200 spent  1800 remain    |
|  [========------]                                           |
|                                                              |
|  Brand Refresh      2000 alloc    800 spent  1200 remain    |
|  [====----------]                                           |
|                                                              |
|  Operations         2500 alloc   2100 spent   400 remain    |
|  [=============-]                                           |
|                                                              |
|  --- Recent Transactions ---                                |
|                                                              |
|  10:15  -150  team_genesis   Research competitors           |
|  10:08   -50  brand_refresh  Design mood board              |
|  09:55  -200  operations     Hire Content Writer            |
|                                                              |
+-------------------------------------------------------------+
```

## Relationship to Real Costs

Credits map to real API costs. One credit might equal $0.01 of LLM usage.
The Founder sets the exchange rate. The economy dashboard shows both credits
and estimated dollar amounts.

This gives the Founder a direct line of sight from "the CEO hired 3 agents
this week" to "that cost $47 in API calls."

## Open Questions

- Should agents negotiate compensation (credits for completing tasks)?
  Interesting but adds complexity. Start with team-level budgets.
- Should unspent budget roll over? Probably yes, with a cap.
- How to handle agents that consistently underspend vs overspend?
  This feeds into [[agent-elo]] -- budget efficiency as a reputation dimension.
- Should the economy be inflationary (Founder prints credits) or fixed-supply?
  Start with Founder-allocated fixed budgets. Revisit if it constrains growth.
