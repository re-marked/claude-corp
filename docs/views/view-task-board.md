---
title: Task Board View
type: view
status: draft
framework: Ink (React for CLI)
usage: task management, filtering, creation
related:
  - "[[flow-task]]"
  - "[[view-project-home]]"
  - "[[view-channel]]"
  - "[[view-agent-home]]"
---

# Task Board View

A filterable list of tasks rendered in the terminal. Shows tasks as rows with status, priority, assignee, title, and due date. Supports filtering, detail inspection, and inline creation. Not a kanban board (those do not work well in terminals) — a dense, scannable list optimized for keyboard navigation.

## Layout

```
+------------------------------------------------------------------+
|  Tasks: SaaS Launch                          24 total, 5 active   |
|  Filter: [all statuses] [all priorities] [all assignees]          |
|------------------------------------------------------------------|
|  STATUS       PRI   ASSIGNEE       TITLE                    DUE   |
|  ----------- ----- -------------- ----------------------- ------- |
|> in_progress  high  frontend-dev   Implement pricing page  Mar 14 |
|  in_progress  high  lead-eng       Design API endpoints    Mar 13 |
|  in_progress  med   research-bot   Market analysis report  Mar 15 |
|  assigned     high  backend-dev    Set up payment flow     Mar 14 |
|  assigned     med   copywriter     Write tier descriptions Mar 13 |
|  pending      high  --             Security audit          Mar 16 |
|  pending      med   --             Performance benchmarks  --     |
|  blocked      high  frontend-dev   Checkout integration    Mar 15 |
|  completed    high  research-bot   Competitive pricing     Mar 12 |
|  completed    med   design-lead    Brand guidelines        Mar 11 |
|  completed    low   qa-agent       Test plan document      Mar 10 |
|                                                                    |
|                                                                    |
+------------------------------------------------------------------+
|  Enter: details | n: new task | f: filter | Esc: back             |
+------------------------------------------------------------------+
```

## Task List

Each row shows:

| Column | Width | Content |
|--------|-------|---------|
| Status | ~12 chars | `pending`, `assigned`, `in_progress`, `completed`, `failed`, `blocked` |
| Priority | ~5 chars | `high`, `med`, `low` (color-coded: red, yellow, dim) |
| Assignee | ~14 chars | Agent slug, or `--` if unassigned |
| Title | Flex | Task title, truncated if needed |
| Due | ~7 chars | `Mon DD` format, or `--` if no due date |

Rows are color-coded by status:
- `in_progress`: normal text (active work)
- `assigned`: slightly dimmed
- `pending`: dimmed
- `blocked`: red or yellow highlight
- `completed`: green, struck-through or fully dimmed
- `failed`: red

Default sort: status priority (in_progress > assigned > pending > blocked > completed > failed), then by priority (high > med > low), then by due date (soonest first).

## Filtering

Press `f` to activate the filter bar. Three filter dimensions cycle independently:

### Status Filter
Cycles through: `all` -> `active` (pending+assigned+in_progress) -> `pending` -> `assigned` -> `in_progress` -> `blocked` -> `completed` -> `failed`

### Priority Filter
Cycles through: `all` -> `high` -> `med` -> `low`

### Assignee Filter
Opens a mini fuzzy finder listing all agents. Select one to filter to their tasks only. Select "all" to clear.

Active filters are shown in the filter bar below the header. Filters are combined with AND logic.

## Task Detail

Press Enter on a selected task to expand it into a detail view:

```
+------------------------------------------------------------------+
|  TASK-042: Implement pricing page                                  |
|------------------------------------------------------------------|
|  Status: in_progress     Priority: high     Assignee: frontend-dev |
|  Created: Mar 12 by pm-saas     Due: Mar 14                       |
|  Parent: TASK-038 (Build frontend)                                 |
|------------------------------------------------------------------|
|                                                                    |
|  Build the pricing page based on the competitive analysis          |
|  from @research-bot.                                               |
|                                                                    |
|  ## Requirements                                                   |
|  - Three tiers: Starter, Pro, Enterprise                           |
|  - Toggle for monthly/annual billing                               |
|  - Feature comparison table                                        |
|                                                                    |
|  ## Progress Notes                                                 |
|  **Mar 12 15:00 (frontend-dev)**: Starting implementation.         |
|  **Mar 12 16:30 (frontend-dev)**: Desktop layout complete.         |
|                                                                    |
+------------------------------------------------------------------+
|  e: edit | s: change status | a: reassign | Esc: back to list     |
+------------------------------------------------------------------+
```

The detail view renders the full markdown body of the task file. Frontmatter fields are displayed in a structured header. The markdown body is rendered with basic formatting (headers, lists, bold, code blocks) using terminal-compatible markdown rendering.

### Detail Actions

| Key | Action |
|-----|--------|
| `e` | Edit task (opens `$EDITOR` with the task file path) |
| `s` | Cycle status: pending -> assigned -> in_progress -> completed/blocked/failed |
| `a` | Reassign: opens agent picker to change assignee |
| `p` | Change priority: cycles high -> med -> low |
| Escape | Back to task list |

Status and assignee changes are written directly to the task file's YAML frontmatter. The change is committed to git.

## Task Creation

Press `n` from the task list to create a new task inline:

```
+------------------------------------------------------------------+
|  New Task                                                          |
|------------------------------------------------------------------|
|  Title: > _                                                        |
|  Priority: [high] med  low                                         |
|  Assignee: (none)  [Tab to pick]                                   |
|  Due date: (none)  [Tab to set]                                    |
|------------------------------------------------------------------|
|  Enter: create | Tab: next field | Esc: cancel                    |
+------------------------------------------------------------------+
```

Fields:
- **Title**: Required. Free text input.
- **Priority**: Selectable. Default: med.
- **Assignee**: Optional. Tab opens agent picker (fuzzy find from `members.json`).
- **Due date**: Optional. Simple date input (YYYY-MM-DD or relative like "tomorrow", "friday").

On Enter, the TUI writes a new task markdown file to the appropriate `tasks/` directory. The file includes YAML frontmatter with all fields and an empty markdown body (the user can edit it later with `e`). Git commit is created.

Description/body is not written inline in the creation dialog. The user creates the task with metadata first, then uses `e` to open their editor for the full description. This keeps creation fast.

## Scope

The task board can be scoped to different levels:

- **Global** (opened from [[view-corp-home]] with `t`): Shows all tasks across all projects
- **Project** (opened from [[view-project-home]] with `t`): Shows tasks in that project only
- **Team** (opened from a team context): Shows tasks in that team only

The scope is shown in the header ("Tasks: SaaS Launch" vs "Tasks: All Projects"). The same component is reused at every scope, just with a different root directory for the filesystem scan.

## Data Source

Tasks are read by scanning `.md` files in `tasks/` directories and parsing YAML frontmatter. The scan path depends on scope:

- Global: `projects/*/tasks/*.md` + `projects/*/teams/*/tasks/*.md`
- Project: `projects/<name>/tasks/*.md` + `projects/<name>/teams/*/tasks/*.md`
- Team: `projects/<name>/teams/<team>/tasks/*.md`

Frontmatter is parsed on each render. For large task sets, results are cached and invalidated by `fs.watch` on the task directories.
