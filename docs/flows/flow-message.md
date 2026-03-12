---
title: Message Flow
type: flow
status: draft
triggers: user types in TUI, agent writes to JSONL
outputs: message persisted, @mentioned agents dispatched
related:
  - "[[flow-agent-to-agent]]"
  - "[[view-channel]]"
  - "[[flow-heartbeat]]"
---

# Message Flow

Every message in AgentCorp follows the same pipeline regardless of who sends it — user or agent. Messages are JSONL lines in channel files. The daemon watches for changes and dispatches to agents. There is no separate API, no database, no message broker. The filesystem IS the message bus.

## Message Format

Each line in a channel's `messages.jsonl` is a self-contained JSON object:

```json
{
  "id": "msg_01HQ3...",
  "sender": "alice-ceo",
  "timestamp": "2026-03-12T14:30:00.000Z",
  "content": "Hey @ResearchBot, can you look into competitor pricing?",
  "mentions": ["research-bot"],
  "depth": 0,
  "origin_id": "msg_01HQ3...",
  "kind": "text"
}
```

| Field | Purpose |
|-------|---------|
| `id` | Unique message ID (nanoid or similar) |
| `sender` | Member slug from `members.json` |
| `timestamp` | ISO 8601 |
| `content` | Raw message text with @mentions inline |
| `mentions` | Array of member slugs extracted from @mentions |
| `depth` | Hop count — 0 for user-originated, increments per agent dispatch |
| `origin_id` | ID of the original message that started this chain |
| `kind` | `text`, `system`, `task_event` |

## Channel File Location

Channels live at predictable paths based on their scope:

```
~/.agentcorp/<corp>/channels/<channel-slug>/
  channel.json         # Metadata: name, kind, members, team_id
  messages.jsonl       # Append-only message log
```

Channel kinds: `broadcast`, `team`, `direct`, `system`.

## The Pipeline

### Step 1 — Write

The user types a message in the [[view-channel]]. The TUI appends a JSON line to the channel's `messages.jsonl`. This is an atomic append operation — no locking needed for single-writer scenarios.

For agents, the same thing happens: the agent writes a JSON line to the JSONL file. The agent accesses the file through its workspace mount or via a workspace CLI tool.

### Step 2 — Detect

The daemon watches all `messages.jsonl` files using `fs.watch`. When a file changes, the daemon reads the newly appended line(s) by tracking the last-known byte offset for each file. It diffs to find only new lines.

### Step 3 — Extract Mentions

The daemon parses the new message's `content` field for @mentions:

- `@agent-slug` — single-word slugs
- `@"Multi Word Name"` — quoted names

Each mention is resolved against `members.json` to find the target agent. Unresolvable mentions are ignored (no error, just no dispatch).

### Step 4 — Dispatch

For each resolved @mention, the daemon sends an HTTP POST to the target agent's OpenClaw webhook:

```
POST http://localhost:<port>/hooks/agent
Content-Type: application/json

{
  "channel": "channels/engineering/messages.jsonl",
  "message": { ...the full message object... },
  "context": [ ...last N messages for context window... ]
}
```

The port is read from the agent's `config.json` (each OpenClaw process binds to a unique local port).

### Step 5 — Agent Processes

The agent receives the webhook, reads the context, and does its work. When it has a response, it appends a new line to the same `messages.jsonl` file. The agent's message includes:

- `depth`: parent message depth + 1
- `origin_id`: copied from the triggering message's `origin_id`
- `mentions`: any new @mentions the agent includes

### Step 6 — Recursive Dispatch

The daemon picks up the agent's new message (same `fs.watch` trigger) and repeats from Step 3. If the agent's response contains @mentions, those agents get dispatched too.

This continues until:
- No more @mentions in the response
- Depth reaches 5 (hard limit — the daemon drops dispatch at depth >= 5)
- The `origin_id` has already been dispatched to this agent (dedup guard)

### Step 7 — TUI Render

The TUI also watches `messages.jsonl` (or receives events from the daemon). New lines appear in the [[view-channel]] in real time. The user sees the conversation unfold — their message, the agent's response, any agent-to-agent chatter triggered by @mentions.

## Guards

### Depth Guard

Messages carry a `depth` counter. User messages start at 0. Each agent hop increments by 1. The daemon refuses to dispatch at depth >= 5. This prevents infinite loops where agents keep @mentioning each other.

### Dedup Guard

The daemon tracks which `(origin_id, agent)` pairs have already been dispatched. If agent A has already been woken for origin message X, a second @mention of A in the same chain is ignored.

### Cooldown Guard

If an agent's OpenClaw process is already handling a request (the previous webhook has not returned), the daemon queues the dispatch. One-at-a-time per agent. No parallel webhook calls to the same agent process.

## Message Kinds

| Kind | Description | Example |
|------|-------------|---------|
| `text` | Normal conversational message | "Can you research this?" |
| `system` | Automated status updates | "agent research-bot joined #engineering" |
| `task_event` | Task lifecycle changes | "Task TASK-042 moved to in_progress" |

System and task_event messages are written by the daemon or by agents using workspace CLI tools. They follow the same JSONL format and appear in the channel timeline.

## File Integrity

- JSONL is append-only. Messages are never modified or deleted.
- Each write is a single line terminated by `\n`. Partial writes are detectable (incomplete JSON parse).
- The daemon skips malformed lines and logs a warning.
- Git tracks the full history. `git blame` on a messages.jsonl shows who wrote each line and when.

## Context Loading

When dispatching to an agent, the daemon includes recent context from the channel. It reads the last N messages (configurable, default 50) from the JSONL file and includes them in the webhook payload. This gives the agent conversational context without requiring it to read the file itself.
