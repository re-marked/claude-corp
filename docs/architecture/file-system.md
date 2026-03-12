# File System

AgentCorp has no database. All state lives in files on disk, organized inside git repositories. This is a deliberate architectural choice, not a limitation.

## Why Files

**Git-trackable.** Every corp is a git repo. Every change an agent makes — writing a message, updating a task, modifying its memory — becomes a git commit. You can `git log` to see everything that happened, `git diff` to see what changed, and `git revert` to undo anything. This is version control for your entire organization, for free.

**Human-readable.** You can `cat` any file and understand the corp's state. No query language, no admin panel, no ORM — just files you can read with any text editor.

**Agent-accessible.** OpenClaw agents operate on files natively. They read Markdown, write Markdown, parse JSON. The [[agent-runtime]] does not need a database client or API adapter — the filesystem IS the API.

**Portable.** Copy the corp folder to another machine, run `agentcorp start`, and everything works. No database dumps, no migration scripts, no connection strings.

**Transparent.** Nothing is hidden. There is no opaque binary format, no encrypted blob, no state buried in a process's memory. If it exists, it is a file, and you can see it.

## The Trade-Off

Files are bad at complex queries. You cannot efficiently ask "show me all tasks assigned to Agent X across all projects, sorted by priority, created in the last week." The [[tui]] handles common views by reading and indexing files in memory at startup. For rare or complex queries, you grep.

This trade-off is acceptable because:

- Corps are small (tens of agents, not thousands)
- The TUI caches and indexes what it needs
- Agents do not need complex queries — they read their own workspace
- Git history IS the audit log, no query needed

## Three File Formats

### Markdown + YAML Frontmatter

Used for agent workspace files and tasks.

```markdown
---
id: task-001
title: Design the landing page
status: assigned
assignee: luna
priority: high
created: 2026-03-12T10:00:00Z
---

# Design the Landing Page

Create a modern, responsive landing page for the product.
Focus on clear value proposition and a single CTA.

## Requirements
- Mobile-first responsive design
- Hero section with animation
- Feature grid (3 columns)
```

Agent files like `SOUL.md`, `MEMORY.md`, `HEARTBEAT.md`, and `AGENTS.md` also use this format. The YAML frontmatter carries structured metadata; the Markdown body carries freeform content that agents read and reason about.

The parser in `shared` handles frontmatter extraction and validation.

### JSON

Used for configuration and registries.

```json
{
  "name": "my-corp",
  "created": "2026-03-12T10:00:00Z",
  "owner": "user"
}
```

JSON files include:

- `corp.json` — corporation metadata
- `project.json` — project metadata
- `team.json` — team metadata
- `members.json` — member registry (agents and users, with status, rank, port)
- `channels.json` — channel registry (name, kind, member list)
- `global-config.json` — API keys, daemon settings, port ranges

All JSON files have corresponding TypeScript schemas in `shared` and are validated on read.

### JSONL (JSON Lines)

Used for message logs. One JSON object per line, one line per message.

```jsonl
{"id":"msg-001","channel_id":"ch-general","sender_id":"user","content":"@atlas Let's plan the sprint","mentions":["atlas"],"depth":0,"origin_id":"msg-001","timestamp":"2026-03-12T10:00:00Z"}
{"id":"msg-002","channel_id":"ch-general","sender_id":"atlas","content":"I'll review the backlog and propose priorities. @luna can you share the design status?","mentions":["luna"],"depth":1,"origin_id":"msg-001","timestamp":"2026-03-12T10:00:05Z"}
```

JSONL is append-only by convention. The [[router]] and [[tui]] append new messages to the end of the file. They never modify or delete existing lines. This makes `fs.watch` + byte-offset tracking reliable — new content is always at the end.

Why JSONL instead of a single JSON array:

- **Append-friendly** — no need to parse the entire file to add a message
- **Streaming reads** — read line by line from any offset
- **Concurrent-write safe** — multiple writers can append without corrupting each other (on POSIX systems, small writes to append-mode files are atomic)
- **Git-friendly** — each message is a single line, so diffs show exactly which messages were added

## Global Config

`~/.agentcorp/global-config.json` lives outside any corp. It contains:

```json
{
  "api_keys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "AIza..."
  },
  "daemon": {
    "port_range": [18800, 18999],
    "log_level": "info"
  },
  "defaults": {
    "model": "claude-sonnet-4-20250514",
    "provider": "anthropic"
  }
}
```

API keys are never stored inside a corp directory. The [[daemon]] reads them from here and injects them into each agent's `auth-profiles.json` at spawn time. This means the corp repo can be shared (or published) without leaking credentials.

## File Watching Strategy

Both the [[tui]] and the [[daemon]] rely on `fs.watch` for live updates:

- The **daemon's router** watches all `messages.jsonl` files for new messages to dispatch
- The **TUI** watches files relevant to the current view for live rendering

Watches are created per-file, not recursively, to keep the scope predictable. When new channels or projects are created, both the daemon and TUI detect the new entries in `channels.json` / `project.json` and add watches for the new files.

## File Locking

There is no file locking. Concurrent writes are managed by convention:

- JSONL files are append-only; small appends are atomic on POSIX
- JSON config files are written atomically (write to temp file, then rename)
- Markdown files are written by a single agent (each agent has its own workspace)
- `members.json` and `channels.json` are written only by the [[daemon]]

If a collision occurs (rare, because agents have separate workspaces), git detects the conflict and the Git Manager in the daemon logs it.

## Directory Layout

See [[corp-structure]] for the full directory tree with explanations.
