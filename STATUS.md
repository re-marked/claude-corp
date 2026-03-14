# AgentCorp — Status

Nothing is built yet. This file tracks what exists vs what's planned.
Cross items off as they ship. Reference: `docs/` for full vision specs.

---

## What WORKS today

Layer 1 foundation: types, parsers, corp scaffolding, git integration.

---

## Layer 1: Foundation

- [x] Monorepo setup (pnpm workspaces, packages/shared + daemon + tui)
- [x] Type definitions (Member, Channel, Message, Task, Team, Corp, Project, AgentConfig, GlobalConfig)
- [x] File format parsers (JSONL reader/writer, markdown+frontmatter, JSON config)
- [x] Corp directory structure creation (scaffoldCorp — mkdir, init files, git init, first commit)
- [x] global-config.json (API keys, default model, preferences)
- [x] SimpleGit integration (init, commitAll, log, diff, status)
- [x] Utilities (ULID generation, @mention extraction, path helpers, constants)

## Layer 2: CEO

- [ ] OpenClaw process spawning via execa (single agent)
- [ ] Port assignment and tracking
- [ ] API key injection (global-config -> auth-profiles.json)
- [ ] TUI onboarding wizard (name your corp)
- [ ] CEO SOUL.md and starter config
- [ ] Basic TUI chat view (send/receive via JSONL + fs.watch)
- [ ] CEO onboarding interview flow
- [ ] CEO bootstraps corp structure from conversation

## Layer 3: Messaging

- [ ] Daemon: fs.watch on JSONL files
- [ ] @mention extraction (regex: @Name, @"Multi Word Name")
- [ ] Member resolution via members.json
- [ ] Webhook dispatch to OpenClaw /hooks/agent
- [ ] DM auto-routing (every message in DM wakes the other member)
- [ ] Guards: depth (max 5), dedup, cooldown
- [ ] Multiple channel support
- [ ] Channel switching (Ctrl+K fuzzy finder)
- [ ] Member sidebar in channel view
- [ ] Thread support (threadId in messages)

## Layer 4: Tasks

- [ ] Task file format (markdown + YAML frontmatter)
- [ ] Task board TUI view (list with filters)
- [ ] Task creation from TUI
- [ ] Agents read/write task files on heartbeat
- [ ] Task hierarchy (parentTaskId)
- [ ] Task status updates posted to channel messages
- [ ] Task detail view

## Layer 5: Autonomy

- [ ] Rank-based agent creation (write files + signal daemon to spawn)
- [ ] Agent-to-agent @mention chaining (recursive dispatch)
- [ ] Git commit after each prompt loop
- [ ] Git Janitor agent (conflict resolution, clean commits)
- [ ] Starter pack: CEO bootstraps HR, Adviser, Git Janitor, project + leader
- [ ] Agents write freely to filesystem
- [ ] Agent suspension/resume
- [ ] Agent archival

## Layer 6: Views

- [ ] Corp home view (overview of all projects, corp-level agents)
- [ ] Project home view (teams, channels, activity, task summary)
- [ ] Agent home/inspector view (SOUL.md, BRAIN, status, current task)
- [ ] Hierarchy tree view (box-drawing mafia tree, navigable)
- [ ] Navigation polish (hotkeys, transitions)

## Layer 7: Externals

- [ ] OpenClaw native channel bridges (Telegram, Discord, Slack, WhatsApp)
- [ ] CEO morning briefing via external platform
- [ ] Bidirectional messaging through externals
- [ ] Webhook receivers for external events

---

## Future / Deferred

- [ ] Agent forking (copy SOUL.md + BRAIN, let it evolve)
- [ ] Agent ELO / reputation system
- [ ] Agent unions (negotiate preferences)
- [ ] Agent economy (agents pay agents)
- [ ] Crisis channels (temporary high-priority rooms)
- [ ] Agent dreams (background processing during idle)
- [ ] Web frontend (connects to same daemon)
- [ ] Skill bundles (.skill format)

---

## Critical Path

The shortest path to "agents acting autonomously in a visible workspace":

1. **Foundation** — file formats, corp structure, git integration
2. **CEO chat** — spawn one OpenClaw, talk to it in TUI
3. **Daemon router** — fs.watch + @mention dispatch = agents talk to each other
4. **Tasks + heartbeat** — agents discover work on their own
5. **Agent creation** — agents create agents, corporation grows

Without #3, agents are isolated chatbots. With it, the corporation comes alive.
