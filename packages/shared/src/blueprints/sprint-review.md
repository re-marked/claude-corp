---
name: sprint-review
description: Review completed work, report to Founder, plan next sprint
steps: 5
roles: [CEO, All Agents, Founder]
estimated: 30-60 minutes
---

# Sprint Review Blueprint

## Step 1: Gather Completed Contracts
```
cc-cli contract list --status completed
```
List everything the corp shipped since the last review.

## Step 2: Per-Agent Performance
```
cc-cli stats
```
Check: tasks completed, utilization %, streaks, error counts per agent.
Identify top performers and struggling agents.

## Step 3: Review Blocked Items
```
cc-cli contract list --status active
cc-cli tasks --status blocked
```
What's stuck? Why? What needs the Founder's input?

## Step 4: Compile Report
DM the Founder with a structured summary:

```
cc-cli say --agent ceo --message "Sprint review:

SHIPPED:
- [Contract 1]: [one-line summary]
- [Contract 2]: [one-line summary]

IN PROGRESS:
- [Contract 3]: X% complete, lead: @agent

BLOCKED:
- [Issue]: needs Founder decision on [what]

TEAM:
- Top performer: @agent (N tasks, streak of M)
- Needs attention: @agent (stuck on X)

NEXT:
- Proposed contracts for next sprint"
```

## Step 5: Plan Next Sprint
Based on Founder's feedback:
```
cc-cli contract create --project <name> --title "..." --goal "..." --lead @<slug>
```
Follow the `ship-feature` blueprint for each new contract.

## Tips
- Run sprint reviews weekly or after major milestones
- The Herald's narration history (NARRATION.md) gives a timeline of what happened
- Use `cc-cli activity --last 50` for detailed event history
- The Warden's approval/rejection notes are valuable feedback for the team
