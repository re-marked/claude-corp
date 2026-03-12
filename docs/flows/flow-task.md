---
title: Task Flow
type: flow
status: draft
triggers: user creates via TUI, CEO breaks down goals, team leaders create sub-tasks, any agent creates during work
outputs: markdown task files with YAML frontmatter, lifecycle from pending to completion
related:
  - "[[flow-heartbeat]]"
  - "[[flow-message]]"
  - "[[flow-agent-creation]]"
  - "[[view-task-board]]"
---

# Task Flow

Tasks are markdown files with YAML frontmatter. They live on disk, are tracked by git, and are discovered by agents during [[flow-heartbeat]] scans. There is no task database, no task queue, no API. An agent finds work by reading files in a directory.

## Task File Format

Each task is a single markdown file:

```
projects/<project>/tasks/TASK-042-implement-pricing-page.md
```

The filename includes a sequential ID and a slug. The file contains:

```markdown
---
id: TASK-042
title: Implement pricing page with three tiers
status: pending
priority: high
assignee: frontend-dev
created_by: pm-saas
created_at: 2026-03-12T14:00:00.000Z
updated_at: 2026-03-12T14:00:00.000Z
due_date: 2026-03-14T00:00:00.000Z
parent_task_id: TASK-038
tags: [frontend, pricing, launch-blocker]
---

# Implement Pricing Page

Build the pricing page based on the competitive analysis from @research-bot.

## Requirements

- Three tiers: Starter ($25/mo), Pro ($100/mo), Enterprise (custom)
- Toggle for monthly/annual billing
- Feature comparison table
- CTA buttons linked to Stripe checkout

## Acceptance Criteria

- [ ] Responsive layout (mobile + desktop)
- [ ] Tier data driven by config, not hardcoded
- [ ] Annual pricing shows savings percentage

## Progress Notes

<!-- Agents append notes here as they work -->
```

## Task Location

Tasks live at a scope that matches who owns them:

| Scope | Path | Who Creates |
|-------|------|-------------|
| Project-level | `projects/<project>/tasks/` | CEO, project managers |
| Team-level | `projects/<project>/teams/<team>/tasks/` | Team leaders, workers |

There is no corp-level task directory. Corp-wide initiatives are broken into project-level tasks by the CEO.

## Lifecycle

```
pending -> assigned -> in_progress -> completed
                                   -> failed
                                   -> blocked
```

| Status | Meaning |
|--------|---------|
| `pending` | Created but no one has picked it up |
| `assigned` | Assigned to a specific agent (via `assignee` field) but work has not started |
| `in_progress` | Agent is actively working on it |
| `completed` | Done, acceptance criteria met |
| `failed` | Agent tried but could not complete (includes reason in progress notes) |
| `blocked` | Waiting on something external (another task, user input, a decision) |

Status transitions are made by editing the YAML frontmatter. Git diff shows exactly when each transition happened and who made it.

## Creation Paths

### User Creates via TUI

The user opens the [[view-task-board]] and creates a task inline. The TUI writes a new markdown file to the appropriate `tasks/` directory. Fields set by the user: title, description, priority, assignee (optional). The rest is auto-filled (id, timestamps, created_by: founder).

### CEO Breaks Down Goals

During [[flow-onboarding]] or ongoing work, the CEO receives high-level goals from the user and decomposes them into concrete tasks. The CEO writes task files directly, setting `parent_task_id` to link sub-tasks to their parent goal.

### Team Leaders Create Sub-Tasks

A team leader receives a project-level task (via assignment or heartbeat scan) and breaks it into team-level sub-tasks. Each sub-task file references the parent via `parent_task_id`.

### Any Agent Creates During Work

Any agent can create a task file if it discovers work that needs to be done. A research agent might create a task for a writer. A code agent might create a task for a reviewer. The `created_by` field tracks who originated the task.

## Discovery

Agents discover tasks during their [[flow-heartbeat]] cycle. The process:

1. Agent wakes on heartbeat timer.
2. Agent scans task files in its scope (team directory, project directory, or all projects for corp-level agents).
3. Agent reads YAML frontmatter of each `.md` file in the `tasks/` directories.
4. Agent filters for tasks where `assignee` matches its slug, or `status: pending` tasks it could pick up.
5. Agent decides which task to work on based on priority, due date, and its own judgment.

There is no push notification for new tasks. The heartbeat scan IS the discovery mechanism. If a task needs immediate attention, the creator can @mention the assignee in a channel ([[flow-message]]), which triggers a dispatch separate from the heartbeat.

## Task Hierarchy

Tasks form a tree via `parent_task_id`:

```
TASK-001: Launch SaaS product (CEO)
  TASK-010: Build backend API (PM)
    TASK-020: Design database schema (backend-dev)
    TASK-021: Implement auth endpoints (backend-dev)
    TASK-022: Write API tests (qa-agent)
  TASK-011: Build frontend (PM)
    TASK-030: Implement pricing page (frontend-dev)
    TASK-031: Build dashboard (frontend-dev)
```

Results roll up: when all children of TASK-010 are `completed`, the agent working on TASK-010 can mark it `completed` too. This is not automatic — an agent makes the judgment call.

## Announcements

When a task changes status, the agent writes a `task_event` message to the relevant channel:

```json
{
  "id": "msg_t1a2s3",
  "sender": "frontend-dev",
  "kind": "task_event",
  "content": "TASK-042 moved to in_progress: starting the pricing page implementation",
  "timestamp": "2026-03-12T15:00:00.000Z"
}
```

These messages appear in the [[view-channel]] timeline alongside regular conversation. The user sees task progress interleaved with discussion.

## Progress Notes

Agents append progress notes to the markdown body of the task file as they work. This creates a running log:

```markdown
## Progress Notes

**2026-03-12 15:00 (frontend-dev)**: Starting implementation. Using the three-tier structure from research-bot's analysis.

**2026-03-12 16:30 (frontend-dev)**: Desktop layout complete. Starting responsive breakpoints.

**2026-03-12 18:00 (frontend-dev)**: BLOCKED — need final copy for tier descriptions. Created TASK-043 for copywriter.
```

Git tracks every edit. `git log -p -- projects/saas/tasks/TASK-042-*.md` shows the complete history of the task.

## Task ID Generation

Task IDs are sequential within a scope: `TASK-001`, `TASK-002`, etc. The creating agent (or TUI) reads the highest existing ID in the `tasks/` directory and increments. The ID is embedded in both the filename and the frontmatter for redundancy.

## Relationship to Channels

Tasks do not have their own message streams. Discussion about a task happens in the team or project channel, using @mentions and contextual references to the task ID. If deep discussion is needed, agents can reference the task file by path in their messages.

## Git Trail

```
a1b2c3d task: create TASK-042 implement-pricing-page (pm-saas)
e4f5g6h task: TASK-042 assigned to frontend-dev (pm-saas)
i7j8k9l task: TASK-042 in_progress (frontend-dev, heartbeat)
m0n1o2p task: TASK-042 blocked — waiting on copy (frontend-dev)
q3r4s5t task: TASK-043 create tier-descriptions (frontend-dev)
u6v7w8x task: TASK-042 completed (frontend-dev, heartbeat)
```

Every status change is a commit. The task's full lifecycle is in `git log`.
