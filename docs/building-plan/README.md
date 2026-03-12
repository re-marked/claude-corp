# Building Plan

AgentCorp is built in seven layers. Each layer depends on the one before it.
Skip nothing; the abstractions compound.

## The Layers

| Layer | Name | What It Delivers |
|-------|------|------------------|
| [[layer-1-foundation]] | Foundation | Project scaffold, file formats, corp directory structure, types, git |
| [[layer-2-ceo]] | CEO | Spawn OpenClaw, onboarding wizard, DM chat, corp bootstrap |
| [[layer-3-messaging]] | Messaging | Daemon router, fs.watch, @mention dispatch, channel switching |
| [[layer-4-tasks]] | Tasks | Task files, heartbeat integration, task board TUI |
| [[layer-5-autonomy]] | Autonomy | Rank-based agent creation, agent-to-agent chaining, git commits |
| [[layer-6-views]] | Views | Corp home, project home, hierarchy tree, agent inspector |
| [[layer-7-externals]] | Externals | OpenClaw native bridges, external notifications |

## Dependency Graph

```
Layer 1: Foundation
    |
Layer 2: CEO
    |
Layer 3: Messaging
    |
Layer 4: Tasks
    |
Layer 5: Autonomy
    |
Layer 6: Views
    |
Layer 7: Externals
```

Layers 6 and 7 are somewhat independent of each other -- views can be built
without externals and vice versa -- but both require layers 1-5 to be solid.

## Architecture at a Glance

AgentCorp is a monorepo with three packages:

| Package | Role |
|---------|------|
| `packages/shared` | Types, file format parsers, constants. No runtime deps. |
| `packages/daemon` | Long-running process. Watches filesystem, routes messages, manages agent processes. |
| `packages/tui` | Ink-based terminal UI. Connects to daemon via IPC. |

The daemon is the brain. The TUI is a viewport. A future [[web-version]] would be
another viewport connecting to the same daemon.

## Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript (strict)
- **TUI framework**: Ink (React for the terminal)
- **Process management**: execa (spawn and manage OpenClaw agents)
- **Git**: SimpleGit (every corp mutation is a commit)
- **File formats**: JSONL (messages), Markdown+frontmatter (tasks, identity), JSON (config)
- **Agent runtime**: OpenClaw (local gateway mode)

## Core Principle

Everything is a file. Messages are JSONL lines. Tasks are markdown documents.
Agent identity is SOUL.md. The corporation is a directory tree tracked by git.
There is no database. The filesystem IS the database. Git IS the audit log.

## What "Done" Means Per Layer

Each layer doc specifies concrete deliverables. A layer is done when:

1. All listed files and modules exist and pass type-checking.
2. The described TUI views render correctly.
3. The daemon handles the described events without error.
4. Manual testing confirms the happy path works end-to-end.
5. The layer's git commits tell a coherent story.
