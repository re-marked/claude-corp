---
name: onboard-agent
description: Hire and onboard a new agent into the corp
steps: 5
roles: [CEO, New Agent, Mentor]
estimated: 15-30 minutes
---

# Onboard Agent Blueprint

## Step 1: Hire the Agent
```
cc-cli hire --name "<agent-name>" --rank worker
```
Or into a project:
```
cc-cli hire --name "<agent-name>" --rank worker --project <project-name>
```
The agent is created with default SOUL.md, AGENTS.md, HEARTBEAT.md.

## Step 2: Assign a Mentor (optional but recommended)
Pick an experienced agent to mentor the new hire:
```
cc-cli say --agent <mentor-slug> --message "You're mentoring @<new-agent>. Help them get oriented."
```

## Step 3: Hand First Task
Don't leave the agent idle. Give them something real immediately:
```
cc-cli task create --title "Read project docs and summarize key architecture" --to @<new-agent> --priority normal
```
Start small. Build confidence. Increase scope.

## Step 4: Monitor Onboarding
Watch the new agent's first task:
```
cc-cli activity --agent <new-agent-slug>
```
Check their DM for progress narration. If stuck > 5 minutes, Failsafe flags it.

## Step 5: Evaluate & Assign Real Work
After first task completes:
- If quality is good → assign to a contract as a worker
- If quality needs work → hand another practice task with specific feedback
- If quality is poor → consider re-hiring with better SOUL.md/AGENTS.md

## Tips
- New agents read their Casket on first dispatch (BOOTSTRAP.md guides them)
- The BOOTSTRAP.md auto-deletes after first run
- Agents with project scope only see project channels — less noise
- The Herald will narrate when a new agent joins
