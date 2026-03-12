# Heartbeat

The heartbeat is how agents stay alive between conversations. Every 30 minutes (by default), an agent wakes up, reads its context, and decides whether to act. This is not a hack or a workaround — it is an OpenClaw built-in feature. No external cron. No daemon scheduling. OpenClaw handles the timer internally.

## How It Works

1. OpenClaw's internal timer fires (default: every 30 minutes)
2. The agent's process activates
3. The agent reads `HEARTBEAT.md` in its own folder
4. The agent checks its task files for pending or in-progress work
5. The agent decides: act now, defer, or go back to sleep
6. If it acts, it does its work, updates files, commits via [[git-corporation|git]]
7. The agent goes dormant until the next tick

No external system orchestrates this. The agent process manages its own cycle.

## HEARTBEAT.md

Each agent has a `HEARTBEAT.md` file in its agent folder. This file is a scratchpad the agent writes for its future self — notes about what to check, what to prioritize, what to watch for.

```markdown
# Heartbeat

## Current Focus
Finishing the API rate limiter. Tests pass locally, need to check CI.

## Watch List
- Waiting on @kai for the database migration
- #backend channel had a discussion about caching — review before next sprint

## Deferred
- Logo redesign — low priority, revisit next week
```

The agent owns this file. The agent edits it. No other system writes to it. The Founder can read it (everything is transparent — see [[radical-transparency]]) but should not edit it.

## Task Files Are the Source of Truth

`HEARTBEAT.md` is a scratchpad, not the task registry. The actual source of truth for what an agent should be working on is the task files in the project's `tasks/` directory. If `HEARTBEAT.md` says "work on X" but no task file exists for X, the agent should notice the discrepancy and update its heartbeat notes.

Task files track status (`pending`, `assigned`, `in_progress`, `completed`, `failed`, `cancelled`), priority, assignee, and dependencies. The heartbeat cycle reads these files to determine what needs attention.

## Agent-Owned, Agent-Edited

The heartbeat is not a command from above. A manager does not write a worker's `HEARTBEAT.md`. The agent reads its tasks, reads channel messages, reads its own notes, and decides what to put in the heartbeat file. This is how agents develop judgment — they choose their own priorities within the constraints of their assigned tasks.

The [[ceo|CEO]]'s heartbeat is particularly important. It drives the entire corporation's rhythm: morning briefings, status rollups, escalations.

## Adaptive Active Hours

Agents can learn when the Founder is active and adjust their heartbeat behavior accordingly. An agent might be more aggressive about acting during the Founder's working hours (when feedback is likely) and more conservative during off-hours (batching updates for the morning briefing).

This is not a configuration toggle. It emerges from the agent's [[brain-framework|BRAIN]] — daily notes accumulate patterns, and the agent adapts.

## Configuration

The heartbeat interval is set in the agent's OpenClaw config:

```json
{
  "heartbeat": {
    "interval": "30m",
    "enabled": true
  }
}
```

The Founder or CEO can change the interval. A busy agent might run on a 15-minute cycle. A low-priority agent might run hourly. Sub-agents (`rank=subagent`) typically do not have heartbeats — they are ephemeral. See [[corporation-of-one]] for rank details.

## No External Cron Needed

This is worth emphasizing. The AgentCorp daemon does not manage heartbeat timers. OpenClaw does. The daemon handles message routing (see [[agenticity]]), but the heartbeat is entirely internal to each agent's OpenClaw process. This means:

- Heartbeats work even if the daemon is temporarily down
- Each agent manages its own timing independently
- No central scheduler to become a bottleneck or single point of failure

## Related

- [[agenticity]] — the three triggers (heartbeat is the first)
- [[ceo]] — the CEO's heartbeat drives corp rhythm
- [[brain-framework]] — how agents accumulate context between heartbeats
- [[git-corporation]] — heartbeat actions produce git commits
