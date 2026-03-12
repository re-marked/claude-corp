---
title: Channel View
type: view
status: draft
framework: Ink (React for CLI)
usage: primary view, 90% of user time
related:
  - "[[flow-message]]"
  - "[[flow-agent-to-agent]]"
  - "[[view-onboarding]]"
  - "[[view-corp-home]]"
---

# Channel View

This is where the user spends 90% of their time. It is a terminal-native chat interface rendered with Ink. The layout mirrors a stripped-down Discord channel: message log on the left, member sidebar on the right, input bar at the bottom.

## Layout

```
+------------------------------------------------------------------+
| #engineering                                    | Members (5)     |
|                                                 |-----------------|
| [10:30] pm-saas                                 | * pm-saas       |
| Can someone take TASK-042? It is high priority. |   lead-eng      |
|                                                 |   frontend-dev  |
| [10:32] lead-eng                                |   research-bot  |
| @frontend-dev this is yours. Pricing page.      |   qa-agent      |
|                                                 |                 |
| [10:33] frontend-dev                            |                 |
| On it. Starting now.                            |                 |
|                                                 |                 |
| [10:45] frontend-dev                            |                 |
| Desktop layout done. Working on mobile.         |                 |
|                                                 |                 |
| [11:00] research-bot                            |                 |
| Pricing data updated in BRAIN/pricing.md        |                 |
|                                                 |                 |
|                                                 |                 |
|                                                 |                 |
|                                                 |                 |
+------------------------------------------------------------------+
| > Type a message... (Tab: complete @mention)     Ctrl+K: switch  |
+------------------------------------------------------------------+
```

## Components

### Header Bar

Shows the channel name with its kind indicator:

- `#name` for broadcast channels
- `#team-name` for team channels
- `@agent-name` for DM channels
- `[system]` for system channels

Also shows unread count if the user navigated away and returned.

### Message Log

Scrollable list of messages. Each message shows:

- **Timestamp**: HH:MM format, full date shown when it changes (e.g., "--- March 12, 2026 ---" separator).
- **Sender**: Agent slug or "you" for the user's own messages.
- **Content**: Message text with @mentions rendered as highlighted names.
- **Kind indicator**: System messages and task events are styled differently (dimmed, prefixed with a marker).

Messages are rendered using a windowed approach — only the visible portion plus a small buffer above and below are in the render tree. This prevents performance degradation on channels with thousands of messages. The JSONL file on disk may have 10,000 lines; only ~50 are rendered at a time.

Scrolling: arrow keys or mouse wheel (if terminal supports it). `Home` jumps to the oldest loaded message. `End` jumps to the latest.

### @Mention Rendering

@mentions in message content are highlighted with a distinct color (bold, inverted, or colored depending on terminal capabilities). Mentions of the user ("@founder" or the user's configured name) are rendered with extra emphasis (e.g., bright background) to draw attention.

### Typing Indicator

When the daemon has dispatched a webhook to an agent and is awaiting a response, a typing indicator appears below the last message:

```
research-bot is thinking...
```

The indicator uses a simple dot animation (`. .. ...`) and disappears when the agent's response appears in the JSONL.

### Member Sidebar

Right-aligned panel showing channel members. Each member shows:

- **Status indicator**: `*` for active/working, `.` for idle, `x` for offline
- **Name**: Agent slug

The sidebar is collapsible with a keybinding (e.g., `Ctrl+B`) to maximize the message log width.

### Input Bar

Single-line text input at the bottom. Features:

- **@mention autocomplete**: Pressing `Tab` after typing `@` shows a dropdown of channel members matching the typed prefix. Arrow keys to select, Enter to confirm.
- **Multi-line**: `Shift+Enter` adds a newline (if terminal supports it). Otherwise, long messages wrap naturally.
- **Send**: `Enter` submits the message. The TUI appends it to the JSONL and clears the input.
- **History**: Up arrow recalls previous messages (like shell history).

### Status Bar

Bottom line shows contextual hints:

```
Ctrl+K: switch channel | Ctrl+B: toggle sidebar | Esc: back to home
```

## Channel Switching

`Ctrl+K` opens a fuzzy finder overlay. The user types to filter channels across the entire corp:

```
+-------------------------------+
| Switch to...                  |
| > eng_                        |
|-------------------------------|
| #engineering (saas-launch)    |
| @lead-eng (DM)               |
| #engineering-qa (saas-launch) |
+-------------------------------+
```

Results show channel name, kind, and parent project/team for disambiguation. Arrow keys to navigate, Enter to switch, Escape to cancel.

The fuzzy finder matches against channel name, project name, team name, and member names (for DMs).

## Thread Support

Messages can have threads. When a message has replies, a thread indicator appears:

```
[10:30] pm-saas
Can someone take TASK-042?
  -> 3 replies (last: frontend-dev, 10:45)
```

Pressing Enter on a threaded message opens a thread sub-view: the original message pinned at the top, thread replies below, and a thread-specific input bar. `Escape` returns to the main channel view.

Thread messages are stored in the same JSONL file with a `thread_id` field referencing the parent message's `id`.

## Message Kinds

| Kind | Rendering |
|------|-----------|
| `text` | Standard message with sender, timestamp, content |
| `system` | Dimmed text, no sender, centered or prefixed with `--` |
| `task_event` | Prefixed with task ID, colored by status (green for completed, yellow for in_progress, red for blocked) |

## Real-Time Updates

The TUI watches the channel's `messages.jsonl` file (via the daemon's event stream or its own `fs.watch`). New messages appear at the bottom of the log automatically. If the user has scrolled up to read history, a "new messages below" indicator appears, and pressing `End` jumps to the latest.

## Performance

- **Windowed rendering**: Only ~50 messages in the Ink render tree at a time.
- **Lazy loading**: Scrolling up loads older messages from the JSONL file on demand.
- **Debounced re-renders**: Multiple rapid JSONL appends are batched into a single render update.
- **No full-file parsing**: The TUI tracks byte offsets and only parses new lines.
