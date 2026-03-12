# Tasks

The work primitive. Tasks are markdown files with YAML frontmatter, stored in a project's `tasks/` directory. Each task is a self-contained document: the frontmatter carries structured metadata, the body carries human- and agent-readable description, notes, and results.

```
~/.agentcorp/corp-name/projects/{project-name}/tasks/{task-id}.md
```

## Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (ULID) | Unique identifier. Matches the filename (`{id}.md`). |
| `title` | string | Short, descriptive title. Used in TUI listings and [[messages\|message]] references. |
| `status` | enum | Lifecycle state: `pending`, `assigned`, `in_progress`, `blocked`, `completed`, `failed`, `cancelled`. |
| `priority` | enum | Urgency level: `critical`, `high`, `normal`, `low`. Defaults to `normal`. |
| `assignedTo` | string or null | [[members\|Member]] ID of the agent or user responsible. Null when unassigned. |
| `createdBy` | string | Member ID of whoever created the task. Can be the owner, master, a leader, or another agent. |
| `parentTaskId` | string or null | ID of the parent task for hierarchical decomposition. Null for top-level tasks. |
| `teamId` | string or null | [[teams\|Team]] ID if this task belongs to a specific team. Null for unscoped project tasks. |
| `dueAt` | ISO 8601 or null | Optional deadline. Agents factor this into prioritization on heartbeat. |
| `createdAt` | ISO 8601 | Timestamp of creation. |
| `updatedAt` | ISO 8601 | Timestamp of last status change or metadata update. |

## Example

```markdown
---
id: 01JCLEO_TASK_001
title: Design landing page wireframe
status: in_progress
priority: high
assignedTo: 01J_CLEO
createdBy: 01J_MASTER
parentTaskId: null
teamId: 01J_TEAM_DESIGN
dueAt: 2026-03-15T00:00:00Z
createdAt: 2026-03-12T10:00:00Z
updatedAt: 2026-03-12T14:30:00Z
---

# Design landing page wireframe

Create a clean, modern wireframe for the landing page. Focus on:

- Hero section with value proposition
- Feature grid (3 columns)
- Social proof / testimonials
- CTA above the fold

## Notes

Reviewed competitor layouts. Going with a single-scroll approach.
Hero will use the tagline from the brand doc.

## Results

Draft wireframe committed to `assets/wireframes/landing-v1.png`.
Waiting on feedback from owner before moving to high-fidelity.
```

## Status Lifecycle

```
pending --> assigned --> in_progress --> completed
                    \               \-> failed
                     \-> blocked ---/
                                   \-> cancelled
```

- **pending** — Created but not yet assigned to anyone. Sits in the backlog.
- **assigned** — A [[members|member]] has been designated as responsible. The agent discovers this on its next heartbeat cycle.
- **in_progress** — The assigned agent has acknowledged the task and begun work.
- **blocked** — Work cannot continue due to a dependency or external factor. The body should explain what is blocking.
- **completed** — Work is done. Results are in the body or referenced files.
- **failed** — The agent could not complete the task. The body should explain why.
- **cancelled** — The task is no longer needed. Preserved for audit trail.

Status transitions are written directly to the frontmatter by the agent or the daemon. Each transition also generates a `task_event` [[messages|message]] in the relevant [[channels|channel]] and the system `#tasks` channel.

## Discovery

Agents discover tasks on **heartbeat**. During each heartbeat cycle, the agent:

1. Reads its `HEARTBEAT.md` for standing instructions.
2. Scans `projects/*/tasks/*.md` for tasks where `assignedTo` matches its own member ID.
3. Prioritizes by `priority` field and `dueAt` deadline.
4. Picks up the highest-priority actionable task and transitions it to `in_progress`.

The master can also explicitly dispatch a task by assigning it and sending a direct [[messages|message]] to the agent with context.

## Hierarchy

Tasks support parent-child decomposition via `parentTaskId`. A top-level task like "Build the marketing site" can be broken into subtasks:

```
Build the marketing site (parentTaskId: null)
  |- Design landing page wireframe (parentTaskId: 01J_PARENT)
  |- Write copy for features section (parentTaskId: 01J_PARENT)
  |- Implement responsive CSS (parentTaskId: 01J_PARENT)
```

A parent task is considered `completed` only when all child tasks are `completed` or `cancelled`. The daemon or master enforces this — an agent cannot close a parent while children remain open.

Subtask files live in the same `tasks/` directory as their parents. The hierarchy is expressed purely through `parentTaskId` references, not filesystem nesting.

## Agent Writes

Agents have full write access to task files. An agent working on a task will:

- Update `status` in the frontmatter as work progresses.
- Append notes, findings, and results to the markdown body.
- Reference output files (code, assets, documents) by relative path.

These writes are git-tracked. Every task update is a commit, making the full history of a task — who changed what, when, and why — fully auditable via `git log`.

## Team Scoping

When `teamId` is set, the task belongs to that [[teams|team]]. The team leader has authority to assign, reassign, and reprioritize tasks within their team. The master retains override authority on all tasks regardless of team scoping.

Tasks without a `teamId` are project-level and fall under the master's direct management.

## Related

- [[members]] — `assignedTo` and `createdBy` reference member IDs
- [[channels]] — Task events are posted to relevant channels
- [[messages]] — `task_event` kind messages track lifecycle transitions
- [[teams]] — `teamId` scopes tasks to a team's domain
