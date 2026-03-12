---
title: Heartbeat Flow
type: flow
status: draft
triggers: OpenClaw native timer (every 30 minutes by default)
outputs: task progress, channel messages, BRAIN updates
related:
  - "[[flow-task]]"
  - "[[flow-message]]"
  - "[[flow-agent-to-agent]]"
---

# Heartbeat Flow

The heartbeat is the agent's autonomous wake cycle. Every 30 minutes, the agent wakes up on its own, surveys its world, decides what to do, works, and goes back to sleep. This is entirely native to OpenClaw — the daemon is not involved. No cron jobs, no external triggers. The agent manages its own schedule.

## How It Works

OpenClaw has a built-in heartbeat mechanism. When configured, the agent process wakes itself at a fixed interval and executes its heartbeat routine. The agent reads its `HEARTBEAT.md` file for instructions on what to do when it wakes.

## HEARTBEAT.md

Each agent has a `HEARTBEAT.md` in its workspace root. This file is the agent's standing orders — what it should check, prioritize, and act on during each wake cycle.

Example for a team leader:

```markdown
# Heartbeat Instructions

When you wake up, do the following in order:

1. Check your assigned tasks in projects/*/tasks/ — scan for files assigned to you
2. Check tasks assigned to your team members that are blocked or overdue
3. Read recent messages in your team channel for anything that needs a response
4. If any tasks are completed, update their frontmatter status and write a summary
5. If any tasks are blocked, escalate by posting in the project channel with @pm
6. Update your BRAIN/ with anything new you learned
7. If there is nothing urgent, pick up the next pending task by priority
```

The content of HEARTBEAT.md varies by agent role. The CEO's heartbeat focuses on cross-project oversight. A worker's heartbeat focuses on task execution. The agent that creates a new agent writes an appropriate HEARTBEAT.md as part of the [[flow-agent-creation]].

## Wake Cycle Sequence

### 1. Wake

The OpenClaw process triggers its heartbeat routine. The agent reads `HEARTBEAT.md` to orient itself.

### 2. Scan Tasks

The agent scans task files in its relevant scope:

- **Corp-level agents** (CEO): scan all `projects/*/tasks/*.md`
- **Project-level agents** (PM): scan `projects/<project>/tasks/*.md`
- **Team-level agents** (leader, worker): scan `projects/<project>/teams/<team>/tasks/*.md` and `projects/<project>/tasks/*.md` for tasks assigned to them

The agent reads YAML frontmatter to check status, priority, assignee, and due dates. It identifies:
- Tasks assigned to it that are `pending` or `assigned`
- Tasks that are `in_progress` that it was already working on
- Tasks that are `blocked` and might need escalation
- Overdue tasks (due date in the past)

### 3. Decide

Based on its HEARTBEAT.md instructions and the task scan, the agent decides what to do. This is genuine autonomous decision-making — the agent uses its judgment, informed by its SOUL.md personality and BRAIN/ knowledge.

Typical decisions:
- Pick up the highest-priority pending task
- Continue work on an in-progress task
- Escalate a blocked task to its leader
- Create sub-tasks for a large task ([[flow-task]])
- Report completion of a finished task
- Do nothing if everything is on track

### 4. Work

The agent executes its decision. This might involve:
- Writing code, documents, or research to files in its workspace
- Updating task file frontmatter (`status: in_progress`, adding progress notes)
- Creating new task files for sub-tasks
- Reading files from other agents' workspaces (read-only access to shared project files)

### 5. Communicate

After working, the agent writes messages to relevant channels via the standard [[flow-message]] pipeline:
- Status updates in team channels
- Completion announcements in project channels
- Questions or escalations with @mentions to other agents
- Progress reports in task-specific threads

These JSONL writes may trigger the daemon's @mention dispatch, which can wake other agents. But the heartbeat itself is entirely agent-internal.

### 6. Update BRAIN

The agent updates its `BRAIN/` knowledge graph with anything it learned during this cycle:
- New facts about the project
- Decisions it made and why
- Links to other agents' work via [[wikilinks]]
- Updated status of ongoing work

### 7. Sleep

The agent goes dormant until the next heartbeat fires.

## Adaptive Timing

The base interval is 30 minutes, but agents should adapt based on context:

| Condition | Behavior |
|-----------|----------|
| Active working hours (user's timezone, 9am-6pm) | Standard 30min interval |
| Evening hours (6pm-11pm) | 60min interval |
| Night hours (11pm-7am) | No heartbeats unless urgent tasks exist |
| Multiple pending high-priority tasks | Agent may shorten to 15min |
| No pending tasks, nothing in channels | Agent may extend to 60min |

This adaptation is configured in the agent's `config.json` under a `heartbeat` key and honored by OpenClaw's native timer.

## Overnight Work Pattern

The heartbeat enables the overnight work pattern — the defining experience of AgentCorp. The user assigns tasks before going to bed. Through the night, agents wake on their heartbeats, pick up tasks, work, communicate with each other (via [[flow-agent-to-agent]]), and make progress. The user wakes up to a morning full of completed work, status updates, and decisions logged in channels.

No daemon orchestration is needed. Each agent independently wakes, scans, works, and sleeps. The filesystem is the shared state. Git tracks everything that happened.

## Daemon Non-Involvement

The daemon does NOT trigger heartbeats. The daemon's only role during a heartbeat cycle is:
- Detecting new messages written to JSONL files (standard [[flow-message]] watch)
- Dispatching @mentions from those messages to other agents

The heartbeat wake, task scan, decision-making, and work execution are all internal to the OpenClaw process. This is by design — agents are autonomous, not orchestrated.

## Git Trail

Task file updates during heartbeats are committed by the daemon (which watches for file changes) or by the agent itself if it has git access:

```
a1b2c3d task: TASK-042 moved to in_progress by research-bot (heartbeat)
e4f5g6h task: TASK-042 completed by research-bot (heartbeat)
```

The commit messages include `(heartbeat)` to distinguish autonomous work from dispatched work.
