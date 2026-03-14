# AgentCorp — Status

Cross items off as they ship. Reference: `docs/` for full vision specs.

---

## What WORKS today

- Layer 1: types, parsers, corp scaffolding, git integration
- Layer 2: CEO connects to user's existing OpenClaw, TUI onboarding + chat
- Layer 3 (partial): async router with fs.watch, @mention dispatch, channel switching

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

- [x] Two-tier architecture: CEO = user's OpenClaw, workers = shared corp gateway (future)
- [x] Auto-detect user's OpenClaw gateway from ~/.openclaw/openclaw.json
- [x] Remote agent mode (connect to existing gateway, no process spawning)
- [x] Local agent mode (spawn OpenClaw via execa, port allocation, health check)
- [x] CEO workspace files (SOUL.md, AGENTS.md, HEARTBEAT.md, IDENTITY.md, USER.md)
- [x] Corp context injection (system message with agent dir, corp path, members)
- [x] File-reference context (point agent to SOUL.md/AGENTS.md, don't inline)
- [x] TUI onboarding wizard (name yourself, name your corp, connect to OpenClaw)
- [x] Basic TUI chat view (send/receive via JSONL + fs.watch)
- [ ] CEO onboarding interview flow (emergent from SOUL.md, not hardcoded)
- [ ] CEO bootstraps corp structure from conversation

## Layer 3: Messaging

- [x] Daemon router: fs.watch on all channel JSONL files with byte-offset tracking
- [x] Async dispatch (sendMessage writes to JSONL, router dispatches via fs.watch)
- [x] DM auto-routing (every message in DM wakes the other member)
- [x] @mention routing in broadcast/team/system channels
- [x] Guards: depth (max 5), dedup, cooldown (agent-to-agent only, user bypasses)
- [x] Recent channel history (last 50 messages) included in every dispatch
- [x] Smart thinking spinner (shows only when dispatch expected, 30s timeout)
- [x] Channel switching (Tab key, fuzzy search, arrow navigation)
- [x] Auto-watch new channel directories
- [x] Dispatch prediction (sendMessage returns { dispatching: boolean })
- [ ] Member sidebar in channel view
- [ ] Thread support (threadId in messages)
- [ ] Fix: old messages replayed on daemon restart

## Layer 4: Tasks

- [ ] Task file format (markdown + YAML frontmatter)
- [ ] Task board TUI view (list with filters)
- [ ] Task creation from TUI
- [ ] Agents read/write task files on heartbeat
- [ ] Task hierarchy (parentTaskId)
- [ ] Task status updates posted to channel messages
- [ ] Task detail view

## Layer 5: Autonomy

- [ ] Shared corp gateway (one OpenClaw process, agents.list for all workers)
- [ ] Agent hiring flow (create workspace + add to corp gateway)
- [ ] Rank-based agent creation (write files + signal daemon)
- [ ] Agent-to-agent @mention chaining (recursive dispatch)
- [ ] Git commit after each prompt loop
- [ ] Git Janitor agent (conflict resolution, clean commits)
- [ ] Starter pack: CEO bootstraps HR, Adviser, Git Janitor, project + leader
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

1. ~~**Foundation** — file formats, corp structure, git integration~~
2. ~~**CEO chat** — connect to OpenClaw, talk to it in TUI~~
3. ~~**Daemon router** — fs.watch + @mention dispatch = agents talk to each other~~
4. **Tasks + heartbeat** — agents discover work on their own
5. **Agent creation** — agents create agents, corporation grows

Without #3, agents are isolated chatbots. With it, the corporation comes alive.
