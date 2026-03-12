# Stack

AgentCorp is a local-first CLI/TUI for running autonomous AI agent corporations on your machine. No cloud services, no databases, no Docker. Everything runs as native Node.js processes, and everything is files.

## Runtime

- **Node.js 22+** — required for native `fs.watch` stability, `node:fs/promises`, and modern ESM support
- **TypeScript** — strict mode everywhere (`strict: true`, `noUncheckedIndexedAccess: true`); all packages compile with tsup before execution

## Core Dependencies

| Dependency | Role |
|------------|------|
| **Ink** | React-based terminal UI framework; the TUI is a React app rendered to the terminal |
| **execa** | Process spawning and management; the daemon uses it to launch and control OpenClaw agent processes |
| **SimpleGit** | Programmatic git operations; every corp is a git repo, every agent action produces commits |
| **OpenClaw** | Agent runtime; each agent is a separate OpenClaw gateway bound to a localhost port |

## Build Tooling

- **pnpm** — package manager with workspace support
- **Turborepo** — task orchestration across packages
- **tsup** — fast TypeScript bundler for all three packages; outputs ESM

## Monorepo Layout

```
packages/
  shared/       # Types, parsers, constants
  daemon/       # Router, process manager, git manager
  tui/          # Ink application
```

### shared

The foundation layer. Contains:

- **Types** — `Member`, `Channel`, `Message`, `Task`, `Corp`, `Project`, `Team`, `AgentConfig`
- **Parsers** — JSONL line readers, Markdown+YAML frontmatter parser, `members.json` / `channels.json` schema validators
- **Constants** — default port ranges, file paths, depth limits, cooldown values
- **Utilities** — mention extraction, path resolution, ID generation

Both [[daemon]] and [[tui]] depend on `shared`. It has zero runtime dependencies beyond Node.js built-ins.

### daemon

The background process that keeps the corporation running. See [[daemon]] for full details. Three responsibilities:

- **Router** — watches JSONL message files, extracts @mentions, dispatches to agent webhooks. See [[router]].
- **Process Manager** — spawns and stops OpenClaw agent processes via execa, assigns localhost ports. See [[agent-runtime]].
- **Git Manager** — commits changes after prompt loops, coordinates periodic cleanup.

The daemon is the only component that manages child processes. It exposes a local HTTP API for the TUI to request process operations (start, stop, restart agents).

### tui

The interactive terminal interface built with Ink (React for the terminal). See [[tui]] for full details. It is a separate process from the daemon. It reads corp state directly from the filesystem via `fs.watch` and only contacts the daemon for process management commands.

## What Is Deliberately Absent

- **No cloud services** — no Supabase, no AWS, no hosted anything. Your corp runs on your machine.
- **No databases** — no SQLite, no Postgres, no LevelDB. State lives in JSON, JSONL, and Markdown files inside git repos. See [[file-system]].
- **No Docker** — agents run as native Node.js processes. OpenClaw is installed locally or via npx.
- **No HTTP framework** — the daemon's internal API is a minimal `node:http` server, not Express or Hono.

## Why This Stack

The goal is radical locality and transparency. Every piece of state is a file you can `cat`. Every change is a git commit you can `revert`. Every agent process is a PID you can `kill`. The stack exists to serve that principle — if a dependency would hide state or require a service, it does not belong here.

## Package Dependency Graph

```
shared  <--  daemon
shared  <--  tui
daemon  <--  tui  (runtime: HTTP calls to daemon API only)
```

The TUI never imports daemon code directly. It communicates with the daemon over localhost HTTP for process management, and reads all other state from the [[file-system]] directly.
