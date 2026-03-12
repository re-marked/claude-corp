---
title: Agent Home View
type: view
status: draft
framework: Ink (React for CLI)
usage: agent inspector, workspace file viewer, agent management
related:
  - "[[flow-agent-creation]]"
  - "[[flow-heartbeat]]"
  - "[[view-hierarchy]]"
  - "[[view-channel]]"
  - "[[view-corp-home]]"
---

# Agent Home View

The agent inspector. Shows everything about a single agent: identity, status, current work, and a peek into their workspace files. This is where the user goes to understand what an agent is, what it is doing, and what it knows. Also the place to take administrative actions (suspend, resume, archive).

## Layout

```
+------------------------------------------------------------------+
|  < Back                research-bot                    * working   |
|  Rank: worker          Team: research-team                         |
|  Created by: pm-saas   Created: Mar 12, 2026                      |
|------------------------------------------------------------------|
|                                                                    |
|  Current Task                                                      |
|  ------------                                                      |
|  TASK-042: Market analysis report (in_progress, high)              |
|  Started 45 min ago                                                |
|                                                                    |
|  Workspace Files                            [Tab to switch panel]  |
|  ---------------                                                   |
|  > SOUL.md                                                         |
|    HEARTBEAT.md                                                    |
|    MEMORY.md                                                       |
|    BRAIN/                                                          |
|      index.md                                                      |
|      pricing.md                                                    |
|      competitors.md                                                |
|    skills/                                                         |
|      web-research.md                                               |
|                                                                    |
|  Recent Activity                                                   |
|  ---------------                                                   |
|  [11:42] Completed TASK-039 in #engineering                        |
|  [11:30] Posted in #research: "Analysis ready"                     |
|  [11:15] Updated BRAIN/pricing.md                                  |
|  [10:50] Heartbeat: picked up TASK-042                             |
|                                                                    |
+------------------------------------------------------------------+
|  Enter: view file | d: DM | s: suspend | r: resume | x: archive   |
+------------------------------------------------------------------+
```

## Sections

### Header

Agent name and status prominently displayed. Status indicators:

| Indicator | Status | Meaning |
|-----------|--------|---------|
| `*` | working | Agent is currently processing a webhook or in an active heartbeat cycle |
| `.` | idle | Agent process is running but not doing anything |
| `x` | offline | Agent process is not running |
| `-` | suspended | Agent process manually stopped by user |
| `~` | archived | Agent has been decommissioned |

Below the name: rank, team/project scope, creator, and creation date. All read from `members.json`.

### Current Task

Shows the agent's current assigned task (if any). Reads from task files where `assignee` matches this agent and `status` is `in_progress` or `assigned`. If multiple tasks are assigned, shows the highest priority one with a count indicator ("+ 2 more assigned").

Press Enter on the task to jump to the task detail in the [[view-task-board]].

### Workspace Files

A tree-view file browser of the agent's workspace directory. Shows the directory structure:

```
<agent-slug>/
  SOUL.md
  HEARTBEAT.md
  MEMORY.md
  AGENTS.md
  config.json
  BRAIN/
    index.md
    <topic>.md
  skills/
    <skill>.md
```

Navigate with arrow keys. Enter on a file opens a read-only file viewer within the TUI — the file content is rendered with basic markdown formatting (headers, lists, bold, code blocks). Escape returns to the file tree.

This is how the user inspects what the agent knows (BRAIN/), how it behaves (SOUL.md), what it does on wakeup (HEARTBEAT.md), and what it remembers (MEMORY.md). Radical transparency — the agent's entire mind is visible.

Files are read-only in this view. To edit, the user presses `e` on a selected file, which opens it in `$EDITOR` (vim, nano, etc.). Changes are saved to disk and committed to git.

### Recent Activity

A chronological feed of the agent's recent actions, sourced from:

- Messages sent by this agent (grep JSONL files for `sender: <slug>`)
- Task status changes made by this agent (git log filtered by agent commits)
- Heartbeat events (system messages in channels)

Shows the 5-10 most recent events with timestamps, action type, and location.

## Actions

| Key | Action | Effect |
|-----|--------|--------|
| `d` | DM | Navigate to the DM [[view-channel]] with this agent |
| `s` | Suspend | Pause the agent's OpenClaw process. Status changes to `suspended`. No heartbeats, no webhook responses. Reversible. |
| `r` | Resume | Restart the agent's OpenClaw process. Status returns to `idle`. Heartbeats resume. |
| `x` | Archive | Permanent decommission. Process stopped, status set to `archived`, removed from active channel memberships. Workspace files preserved. Requires confirmation prompt. |
| `e` | Edit file | Opens the selected workspace file in `$EDITOR` |
| Escape | Back | Return to previous view |

### Suspend vs Archive

**Suspend** is temporary. The agent's process stops, but it remains a member of all channels and retains all task assignments. Resuming picks up where it left off. Use this when an agent is misbehaving or when the user wants to reduce resource usage temporarily.

**Archive** is permanent (though reversible via git). The agent is removed from active duty. Its workspace files stay on disk for reference. Its messages remain in channel histories. But it no longer wakes, responds, or appears in active member lists. The git commit provides an audit trail and a path to restoration if needed.

## Data Sources

| Data | Source |
|------|--------|
| Agent identity | `members.json` entry for this slug |
| Status | `members.json` `status` field (daemon-maintained) |
| Current task | Scan task `.md` files for matching `assignee` frontmatter |
| Workspace files | `ls` the agent's workspace directory |
| File content | Read files directly from the agent's workspace |
| Recent activity | Grep JSONL files for sender, plus `git log --author` or commit message patterns |
