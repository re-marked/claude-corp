# Layer 4 -- Tasks

Messaging lets agents talk. Tasks let them work. A task is a file on disk --
markdown with frontmatter -- that moves through a lifecycle. The heartbeat
mechanism wakes agents to check their tasks. The TUI gets a task board.

## Goals

- Define the task file format and lifecycle.
- Build the task board TUI view.
- Enable task creation from both the TUI and agents.
- Integrate heartbeat reads of task files (OpenClaw native filesystem access).
- Support task hierarchy (parent/subtasks).
- Post status updates to channel messages.

---

## 1. Task File Format

Each task is a markdown file in `tasks/`:

```
~/.agentcorp/corps/<corp>/
  tasks/
    task_abc123.md
    task_def456.md
    task_ghi789.md
```

The filename is the task ID. The file content:

```markdown
---
id: task_abc123
title: Research competitor landscape
status: pending
priority: high
assignee: member_research_lead
parent_task_id: null
created_by: member_ceo
created_at: 2026-03-12T08:00:00Z
updated_at: 2026-03-12T08:00:00Z
announced_in: channel_tasks
thread_root_id: msg_xyz
---

Analyze the top 5 competitors in the AI agent space.
Focus on pricing, capabilities, and market positioning.

## Acceptance Criteria

- Markdown report delivered to #research channel
- Summary table comparing all 5 competitors
- Recommendation section with actionable next steps

## Updates

- 2026-03-12T08:30:00Z [member_research_lead] Started research. Gathering data.
- 2026-03-12T09:15:00Z [member_research_lead] 3/5 competitors analyzed.
```

The `## Updates` section is append-only. Agents and the daemon write
timestamped entries as work progresses. This gives a human-readable
audit trail right in the task file.

### Task Lifecycle

```
pending -> assigned -> in_progress -> completed
                   |               -> failed
                   |               -> cancelled
                   -> cancelled
```

- **pending**: Created but no one is working on it.
- **assigned**: An agent has been assigned but has not acknowledged.
- **in_progress**: The agent has acknowledged and is actively working.
- **completed**: Work is done. Body may contain results or links.
- **failed**: Agent could not complete the task. Body explains why.
- **cancelled**: Withdrawn by creator or Founder.

## 2. Task Board TUI View

A filterable list of all tasks in the corp.

```
+---------------------------------------------------------+
|  Tasks                           [n]ew  [f]ilter  [q]uit|
+---------------------------------------------------------+
|  Status   Priority  Title                    Assignee   |
|  -------  --------  -----------------------  ---------- |
|  * prog   HIGH      Research competitors     Res. Lead  |
|  * asgn   MED       Design landing page      Designer   |
|    pend   LOW       Update documentation     --         |
|  * done   HIGH      Set up CI pipeline       DevOps     |
|    fail   MED       Integrate payment API    Backend    |
+---------------------------------------------------------+
|  [Enter] open  [s]tatus  [a]ssign  [Tab] switch view    |
+---------------------------------------------------------+
```

Ink components:

```typescript
// packages/tui/src/views/task-board.tsx
function TaskBoard(): ReactElement;

// packages/tui/src/components/task-list.tsx
function TaskList(props: {
  tasks: Task[];
  filter: TaskFilter;
  onSelect: (taskId: string) => void;
}): ReactElement;

// packages/tui/src/components/task-detail.tsx
function TaskDetail(props: {
  task: Task;
  body: string;
  onStatusChange: (status: TaskStatus) => void;
  onAssign: (memberId: string) => void;
}): ReactElement;
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `n` | Create new task (opens inline form) |
| `f` | Cycle filter (all -> pending -> in_progress -> completed -> failed) |
| `Enter` | Open task detail (full markdown body + updates) |
| `s` | Change selected task's status |
| `a` | Assign selected task to a member (picker) |
| `q` | Close task board, return to chat |
| `Tab` | Switch between task board and chat view |

### Task Detail View

Pressing Enter on a task opens a detail pane showing the full markdown body,
the updates log, and controls for status and assignment.

```
+---------------------------------------------------------+
|  task_abc123: Research competitor landscape              |
|  Status: in_progress   Priority: HIGH                   |
|  Assignee: Research Lead                                |
|  Created: 2026-03-12 by CEO                             |
+---------------------------------------------------------+
|                                                          |
|  Analyze the top 5 competitors in the AI agent space.   |
|  Focus on pricing, capabilities, and market positioning.|
|                                                          |
|  ## Acceptance Criteria                                 |
|  - Markdown report delivered to #research channel       |
|  - Summary table comparing all 5 competitors            |
|  - Recommendation section                               |
|                                                          |
|  ## Updates                                             |
|  - 08:30 [Research Lead] Started research.              |
|  - 09:15 [Research Lead] 3/5 competitors analyzed.      |
|                                                          |
+---------------------------------------------------------+
|  [s]tatus  [a]ssign  [Esc] back                         |
+---------------------------------------------------------+
```

## 3. Task Creation

### From the TUI

The user presses `n` on the task board. An inline form collects:

1. Title (required)
2. Description (optional, opens `$EDITOR` for long-form)
3. Priority (low/medium/high/critical, default: medium)
4. Assignee (optional, member picker)

The daemon writes the task file and commits:
`"task: create <title>"`.

If an assignee is specified, the daemon also:
1. Sets status to `assigned`.
2. Posts an announcement in `#tasks` channel (or `#general` if no tasks channel).
3. Dispatches to the assigned agent via the router.

### From Agents

Agents create tasks by writing task files directly to the `tasks/` directory.
The daemon watches `tasks/` with `fs.watch` and reacts to new files:

1. Validate the frontmatter schema.
2. If an assignee is set, dispatch to that agent.
3. Post announcement in the appropriate channel.
4. Commit: `"task: create <title> (by <agent-name>)"`.

This means agents do not need a special API for task creation.
They write a file. The daemon does the rest.

## 4. Heartbeat Integration

The heartbeat is how agents wake up and check for work. OpenClaw agents have
native filesystem access -- they can read files in their workspace.

### HEARTBEAT.md

Each agent's workspace contains a `HEARTBEAT.md` that the daemon refreshes
periodically (every 10 minutes by default):

```markdown
# Heartbeat -- 2026-03-12T10:00:00Z

## Your Tasks

### Assigned to You
- [task_abc123] Research competitor landscape (HIGH, assigned)
- [task_def456] Write onboarding docs (MED, in_progress)

### Unassigned (available to claim)
- [task_ghi789] Update README (LOW, pending)

## Recent Channel Activity
- #general: 3 new messages since your last read
- #research: @ResearchLead mentioned you 5 min ago

## Reminders
- task_def456 has been in_progress for 2 hours. Update or complete it.
```

The daemon regenerates this file by:
1. Scanning `tasks/` for tasks assigned to this agent.
2. Scanning `channels/` for unread messages mentioning this agent.
3. Writing the file to the agent's workspace directory.

### Heartbeat Dispatch

The daemon sends a heartbeat message to each active agent:

```
POST http://127.0.0.1:<port>/hooks/agent
{
  "type": "heartbeat",
  "content": "HEARTBEAT",
  "heartbeat_path": "HEARTBEAT.md"
}
```

The agent reads `HEARTBEAT.md` from its filesystem (OpenClaw has access),
reviews its tasks, and takes action: update status, post messages, create
subtasks, or mark tasks complete.

### Stale Task Detection

The daemon checks task timestamps during heartbeat generation:

- **assigned > 10 min**: Re-dispatch to the agent.
- **in_progress > 30 min**: Add a reminder to HEARTBEAT.md.
- **in_progress > 2 hours**: Escalate to CEO or Founder.

## 5. Task Hierarchy

Tasks can have subtasks via `parent_task_id`:

```markdown
---
id: task_sub_001
title: Analyze competitor A
status: pending
priority: high
assignee: member_research_lead
parent_task_id: task_abc123
---

Deep dive into competitor A's pricing model.
```

The task board shows hierarchy as indentation:

```
  * prog   HIGH   Research competitors          Res. Lead
    * asgn HIGH     Analyze competitor A        Res. Lead
    * pend HIGH     Analyze competitor B        --
    * pend HIGH     Analyze competitor C        --
```

Subtask files live in the same `tasks/` directory (flat, not nested).
The hierarchy is encoded in the frontmatter, not the filesystem.

## 6. Status Updates in Channels

When a task's status changes, the daemon posts a message in the channel
referenced by `announced_in`:

```jsonl
{"id":"msg_status_01","ts":"...","from":"system","content":"[task_abc123] Research competitors: assigned -> in_progress (Research Lead)","mentions":[],"depth":0}
```

These system messages use `from: "system"` to distinguish them from
human or agent messages. The TUI renders them with a different style
(dimmed, no avatar, centered).

## Deliverables Checklist

- [ ] Task file format with frontmatter schema
- [ ] Task file parser (read, write, validate)
- [ ] `fs.watch` on `tasks/` directory for new/modified task files
- [ ] Task board TUI view with filtering and sorting
- [ ] Task detail view with full body and updates log
- [ ] Task creation from TUI (inline form)
- [ ] Task creation from agents (filesystem write detection)
- [ ] Heartbeat file generation (`HEARTBEAT.md` per agent)
- [ ] Heartbeat dispatch (periodic POST to agent gateway)
- [ ] Stale task detection (10min assigned, 30min in_progress, 2hr escalation)
- [ ] Task hierarchy support (`parent_task_id`)
- [ ] Status change messages in channels
- [ ] Git commits on task creation and status changes

## Key Decisions

- **Tasks are files, not database rows.** A task is a markdown document. Agents
  read it with their filesystem. Humans read it with any text editor. Git tracks
  every change. This is the file-first philosophy applied to work management.
- **Agents create tasks by writing files.** No API, no RPC. Write the file,
  the daemon picks it up. This keeps the agent-side simple and the daemon-side
  centralized.
- **Heartbeat is a file, not a message.** `HEARTBEAT.md` is written to the
  agent's workspace. The heartbeat dispatch just tells the agent "go read your
  heartbeat file." This means the agent has structured context (its tasks,
  its channels) without the daemon needing to serialize everything into a
  single message payload.
