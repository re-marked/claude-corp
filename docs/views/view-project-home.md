---
title: Project Home View
type: view
status: draft
framework: Ink (React for CLI)
usage: project overview, navigate to teams/channels/tasks
related:
  - "[[view-corp-home]]"
  - "[[view-channel]]"
  - "[[view-task-board]]"
  - "[[view-agent-home]]"
  - "[[flow-task]]"
---

# Project Home View

The project-level overview. Shows everything about a single project: its teams, agents, channels, and task summary. This is the hub from which the user navigates into specific teams, channels, or the project task board.

## Layout

```
+------------------------------------------------------------------+
|  < Back                    SaaS Launch                             |
|------------------------------------------------------------------|
|                                                                    |
|  Teams                                                             |
|  -----                                                             |
|  > Engineering       lead-eng + 3 workers     5 tasks active       |
|    Design            design-lead + 2 workers  3 tasks active       |
|    QA                qa-lead + 1 worker        2 tasks active       |
|                                                                    |
|  Project Agents                                                    |
|  --------------                                                    |
|  * pm-saas           working    managing 10 open tasks             |
|                                                                    |
|  Channels                                                          |
|  --------                                                          |
|    #saas-general     12 unread                                     |
|    #saas-standup     3 unread                                      |
|    #saas-decisions   --                                            |
|                                                                    |
|  Tasks                                                             |
|  -----                                                             |
|    pending: 4    assigned: 3    in_progress: 5                     |
|    completed: 12    blocked: 1    failed: 0                        |
|                                                                    |
+------------------------------------------------------------------+
|  Enter: open | Tab: section | Esc: back | t: tasks | Ctrl+K: find |
+------------------------------------------------------------------+
```

## Sections

### Header

Project name centered. Left side: `< Back` indicator (Escape returns to [[view-corp-home]]). The header is not interactive — navigation is via keybindings.

### Teams

A selectable list of teams within the project. Each team shows:

- **Name**: Team directory name
- **Composition**: Team leader name + worker count
- **Active tasks**: Count of tasks with status `assigned` or `in_progress` in the team's `tasks/` directory

Select a team and press Enter to navigate to that team's channel (the primary team channel). Teams are read from `projects/<project>/teams/*/`.

### Project Agents

Agents scoped to the project level (workspace at `projects/<project>/agents/<slug>/`). Typically the project manager. Shows status, current activity (derived from recent messages or task updates).

Select an agent and press Enter to navigate to its [[view-agent-home]].

### Channels

Lists all channels associated with this project:
- Project-level broadcast channels
- Team channels (grouped or flat, depending on count)

Each channel shows:
- **Name**: Channel slug with kind prefix (`#` for broadcast/team, `@` for DM)
- **Unread count**: Number of messages since the user's last read position (tracked in a local state file)

Select a channel and press Enter to open the [[view-channel]].

Unread tracking: the TUI maintains a `.read-positions.json` file in the corp root that maps channel paths to the last-read byte offset. Any messages after that offset are "unread".

### Task Summary

A compact summary of all tasks in the project, grouped by status. Shows counts for each status: pending, assigned, in_progress, completed, blocked, failed.

This section is not selectable row-by-row. Press `t` to open the full [[view-task-board]] filtered to this project.

## Data Sources

| Data | Source |
|------|--------|
| Project name | Directory name under `projects/` |
| Teams | `ls projects/<project>/teams/` |
| Team composition | `members.json` filtered by team |
| Project agents | `members.json` filtered by project scope, type: agent |
| Channels | `projects/<project>/channels/*/channel.json` + corp-level channels tagged with project |
| Task counts | YAML frontmatter `status` field parsed from all `.md` files in `projects/<project>/tasks/` and `projects/<project>/teams/*/tasks/` |
| Unread counts | `.read-positions.json` compared to current JSONL file size |

## Navigation

| Key | Action |
|-----|--------|
| Up/Down arrows | Move selection within current section |
| Tab | Cycle between sections |
| Enter | Open selected item |
| Escape | Back to [[view-corp-home]] |
| `t` | Open [[view-task-board]] for this project |
| `Ctrl+K` | Channel fuzzy finder (scoped to this project by default, type more to search globally) |
