---
title: Corporation Home View
type: view
status: draft
framework: Ink (React for CLI)
usage: landing screen after onboarding, corporation overview
related:
  - "[[view-project-home]]"
  - "[[view-agent-home]]"
  - "[[view-hierarchy]]"
  - "[[view-channel]]"
  - "[[flow-onboarding]]"
---

# Corporation Home View

The landing screen when the user opens `agentcorp` after onboarding is complete. Provides a high-level view of the entire corporation: what exists, who is active, what is happening. The user navigates from here into projects, agents, or channels.

## Layout

```
+------------------------------------------------------------------+
|  MERIDIAN CORP                                     3 agents active |
|------------------------------------------------------------------|
|                                                                    |
|  Projects                                                          |
|  -------                                                           |
|  > SaaS Launch          3 teams, 8 agents, 12 tasks               |
|    Content Pipeline     2 teams, 5 agents, 7 tasks                 |
|                                                                    |
|  Corp-Level Agents                                                 |
|  -----------------                                                 |
|  * alice-ceo           working    last active 2 min ago            |
|  . hr-director         idle       last active 15 min ago           |
|  . finance-agent       idle       last active 45 min ago           |
|                                                                    |
|  Recent Activity                                                   |
|  ---------------                                                   |
|  [11:42] research-bot completed TASK-042 in #engineering           |
|  [11:30] lead-eng assigned TASK-043 to frontend-dev                |
|  [11:15] alice-ceo posted in #general                              |
|  [10:50] qa-agent created TASK-044 in SaaS Launch                  |
|  [10:30] pm-saas broke TASK-038 into 4 sub-tasks                   |
|                                                                    |
+------------------------------------------------------------------+
|  Enter: open | Tab: section | Ctrl+K: channels | h: hierarchy     |
+------------------------------------------------------------------+
```

## Sections

### Header

Corporation name in prominent text (bold, uppercase, or styled per terminal capabilities). Right-aligned: count of currently active agents (status: working or idle, not offline/archived).

### Projects Section

A selectable list of all projects. Each project shows:

- **Name**: Project directory name, human-readable
- **Summary counts**: Number of teams, active agents, and total tasks

The currently selected project is highlighted (cursor indicator `>`). Press Enter to navigate to the [[view-project-home]] for that project.

Project data is read from the filesystem: scan `projects/*/` directories, count `teams/*/` subdirectories, count agent entries in `members.json` scoped to the project, count `.md` files in `tasks/`.

### Corp-Level Agents

Lists agents that live at the corporation level (workspace path: `agents/<slug>/`). These are the CEO and any other corp-wide agents (HR, finance, etc.). Each entry shows:

- **Status indicator**: `*` for working, `.` for idle, `x` for offline
- **Name**: Agent slug
- **Status label**: working, idle, offline
- **Last active**: Relative time since last message or task update

Select an agent and press Enter to navigate to its [[view-agent-home]].

### Recent Activity

A chronological feed of the most recent events across the entire corporation. Events include:

- Task status changes (created, assigned, completed, failed, blocked)
- Messages in broadcast channels
- Agent creation or archival
- Milestone completions

Events are sourced by scanning recent entries in channel JSONL files and recent git commits. The feed shows the 5-10 most recent events. Each entry shows timestamp, actor, action, and location.

This is read-only. The user cannot interact with activity items directly — they serve as orientation before navigating deeper.

## Navigation

| Key | Action |
|-----|--------|
| Up/Down arrows | Move selection within current section |
| Tab | Cycle between sections (Projects, Agents, Activity) |
| Enter | Open selected item (project home, agent home) |
| `Ctrl+K` | Open channel fuzzy finder (jump directly to any channel) |
| `h` | Open [[view-hierarchy]] (full genealogical tree) |
| `t` | Open [[view-task-board]] (global task view, all projects) |
| `q` | Quit AgentCorp |

## Data Sources

All data is read directly from the filesystem. No daemon query is needed.

| Data | Source |
|------|--------|
| Corp name | `config.json` at corp root |
| Projects | `ls projects/` |
| Agent list | `members.json` filtered by scope and status |
| Agent status | `members.json` `status` field (updated by daemon) |
| Task counts | Count `.md` files in `projects/*/tasks/` |
| Recent activity | Tail of JSONL files in `channels/*/messages.jsonl` + recent `git log` |

## Refresh

The view re-reads filesystem state on a short interval (every 5 seconds) or when the user returns to it from a sub-view. Agent status updates (working/idle/offline) propagate through `members.json`, which the daemon keeps current.
