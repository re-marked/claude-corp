# TUI

The TUI is AgentCorp's interactive terminal interface, built with Ink (React for the terminal). It is a separate process from the [[daemon]] — it reads corp state directly from the filesystem and only talks to the daemon for process management commands.

## Technology

Ink renders React components to the terminal using ANSI escape codes. The TUI is a standard React application with hooks, state, and component composition — it just renders to stdout instead of a browser DOM.

Key Ink capabilities used:

- **Flexbox layout** — rows, columns, padding, borders, all via `<Box>`
- **Text styling** — bold, dim, color, underline via `<Text>`
- **Input handling** — `useInput` hook for keyboard events
- **Focus management** — `useFocus` for navigating between interactive elements
- **Stdout dimensions** — `useStdout` for responsive terminal layouts

## Relationship to Daemon

The TUI auto-starts the [[daemon]] if it is not already running. On launch:

1. Check for `~/.agentcorp/.daemon.pid` — if present, verify the process is alive
2. If no daemon is running, spawn it as a detached background process
3. Read the daemon's port from `~/.agentcorp/.daemon.port`
4. All subsequent process management requests go to `http://localhost:{daemon_port}/...`

The TUI never spawns or kills agent processes directly. That is exclusively the daemon's job. The TUI requests actions ("start agent X", "stop agent Y") and the daemon executes them.

For all other state — channels, messages, tasks, members, projects — the TUI reads directly from the [[file-system]]. It does not ask the daemon for this data. This keeps the daemon simple and means the TUI works even if the daemon's API is unresponsive (in read-only mode).

## File Watching

The TUI uses `fs.watch` to monitor the files relevant to the current view:

- **Channel view**: watches the active channel's `messages.jsonl` for new messages
- **Task board**: watches `tasks/` directory for new or modified task files
- **Member list**: watches `members.json` for status changes
- **Channel list**: watches `channels.json` for new channels

When a watched file changes, the TUI re-reads it and React re-renders the affected components. This gives the user a live-updating view of agent activity without polling.

Watches are scoped to the active view. When the user navigates away from a channel, the TUI stops watching that channel's message file and starts watching the new view's files. This keeps the number of active watches low.

## Views

### Channel Chat (Primary View)

The default and most-used view. Two-pane layout:

- **Left pane (main)**: scrollable message history from the channel's `messages.jsonl`. Messages show sender name, timestamp, and content. Agent messages are visually distinct from user messages (different color prefix). Tool calls and results render inline as collapsible blocks.
- **Right pane (sidebar)**: member list for the current channel, showing each member's name, role, and status (running/suspended/archived). The sidebar can be toggled with `Tab`.

**User input**: A text input at the bottom of the screen. When the user presses Enter, the TUI:

1. Constructs a `Message` object with the user as sender
2. Appends it as a JSONL line to the channel's `messages.jsonl`
3. The [[router]] in the daemon picks it up from there

The user types messages exactly as agents do — by appending to the same file. There is no special user pathway.

### Corp Home

Overview of the corporation:

- Corp name, creation date, member count
- List of projects with brief status
- Active agent count (running vs. total)
- Recent activity feed (last N git commits, summarized)

### Project Home

Focused view of a single project:

- Project description and metadata from `project.json`
- Teams within the project
- Channels within the project
- Active tasks (count by status)

### Task Board

Kanban-style view of tasks, grouped by status columns:

- **Pending** | **Assigned** | **In Progress** | **Completed** | **Failed**

Each task card shows title, assignee, priority, and creation date. Tasks are read from Markdown+YAML files in the `tasks/` directory. The user can create new tasks, assign them, and update status directly from this view.

### Agent Home

Detail view for a single agent:

- Agent name, rank, status, assigned port
- Workspace path
- Current task assignments
- DM channel shortcut (press Enter to jump to DM)
- Start/stop/restart controls (these call the [[daemon]] API)

### Hierarchy Tree

Visual tree rendering of the full corp structure:

```
MyCorpName
  |-- CEO (user)
  |-- Atlas (co-founder, running)
  |-- Project: Website Redesign
  |   |-- Team: Design
  |   |   |-- Luna (designer, running)
  |   |-- Team: Engineering
  |       |-- Kai (developer, running)
  |       |-- Nova (tester, suspended)
  |-- Project: Marketing
      |-- ...
```

Shows members at each scope level, their ranks, and their process status.

## Navigation

### Ctrl+K Fuzzy Finder

The primary navigation mechanism. Press `Ctrl+K` from any view to open a fuzzy finder overlay. It searches across:

- Channel names
- Agent names
- Project names
- Task titles
- Common actions ("create task", "start agent", "new channel")

Results are ranked by match quality. Press Enter to navigate to the selected item or execute the selected action.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+K` | Open fuzzy finder |
| `Tab` | Toggle sidebar (in channel view) |
| `Esc` | Go back / close overlay |
| `Ctrl+C` | Exit TUI (daemon continues running) |
| `Up/Down` | Scroll messages / navigate lists |
| `Enter` | Send message / select item |
| `Ctrl+N` | New message in current channel |
| `Ctrl+T` | Jump to task board |

### View Stack

Navigation works as a stack. Opening a new view pushes it onto the stack. Pressing `Esc` pops back to the previous view. The stack persists for the session, so the user can drill into `Corp Home > Project > Channel` and back out with repeated `Esc` presses.

## User Messages

When the user sends a message, the TUI writes directly to the filesystem — the same `messages.jsonl` file that agents write to and the router watches. The message format is identical to agent messages:

```json
{"id":"...","channel_id":"...","sender_id":"user","content":"...","mentions":["@atlas"],"depth":0,"origin_id":"...","timestamp":"..."}
```

There is no API call, no intermediary. The user is just another member appending lines to a shared log file. The [[router]] treats user messages and agent messages identically.

## Theming

The TUI respects the terminal's color scheme. It uses semantic color names (success, warning, error, muted, accent) mapped to ANSI color codes. A future `theme` field in `global-config.json` could allow customization, but the default palette is designed to work well on both dark and light terminals.
