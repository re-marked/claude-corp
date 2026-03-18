# AgentCorp — Status

Cross items off as they ship. Reference: `docs/` for full vision specs.

---

## What WORKS today

- Layer 1: types, parsers, corp scaffolding, git integration
- Layer 2: CEO connects to user's existing OpenClaw, TUI onboarding + chat
- Layer 3: async router, @mention dispatch, channel history, channel switching
- Layer 4: task files, /task wizard, API, TASKS.md live inbox, auto-assignment dispatch
- Layer 5: shared corp gateway, /hire wizard, CEO-initiated hiring, multi-agent chat
- Git tracking: auto-commit after agent actions (10s debounce)
- Autonomous task loop VERIFIED: /task → @mention assignee → agent reads TASKS.md → works → updates status → completed

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

- [x] Two-tier architecture: CEO = user's OpenClaw, workers = shared corp gateway
- [x] Auto-detect user's OpenClaw gateway from ~/.openclaw/openclaw.json
- [x] Remote agent mode (connect to existing gateway, no process spawning)
- [x] Local agent mode (spawn OpenClaw via execa, port allocation, health check)
- [x] CEO workspace files (SOUL.md, AGENTS.md, HEARTBEAT.md, IDENTITY.md, USER.md)
- [x] Corp context injection (system message with agent dir, corp path, members)
- [x] File-reference context (point agent to SOUL.md/AGENTS.md/TASKS.md, don't inline)
- [x] TUI onboarding wizard (name yourself, name your corp, connect to OpenClaw)
- [x] Basic TUI chat view (send/receive via JSONL + fs.watch)
- [ ] CEO onboarding interview flow (emergent from SOUL.md, not hardcoded)
- [ ] CEO bootstraps corp structure from conversation

## Layer 3: Messaging

- [x] Daemon router: fs.watch on all channel JSONL files with byte-offset tracking
- [x] Async dispatch (sendMessage writes to JSONL, router dispatches via fs.watch)
- [x] DM auto-routing (every message in DM wakes the other member)
- [x] @mention routing in broadcast/team/system channels
- [x] Router handles 'system' sender for automated notifications
- [x] Guards: depth (max 5), dedup, cooldown (agent-to-agent only, user bypasses)
- [x] Recent channel history (last 50 messages) included in every dispatch
- [x] Named typing indicator ("CEO is typing..." not generic "Thinking...")
- [x] Channel switching (Tab key, fuzzy search, arrow navigation)
- [x] Auto-watch new channel directories
- [x] Dispatch prediction with agent names
- [x] Mention regex handles trailing punctuation (@CEO! resolves correctly)
- [x] Bare @mention substitutes previous message as content
- [x] Unique session keys per dispatch (no OpenClaw concurrency conflicts)
- [x] 15-minute dispatch + spinner timeouts (agents can work long)
- [ ] Member sidebar in channel view
- [ ] Thread support (threadId in messages)

## Layer 4: Tasks

### Phase A — Task primitives (done)
- [x] Task file format (markdown + YAML frontmatter in tasks/)
- [x] Task primitives (createTask, readTask, updateTask, listTasks)
- [x] Task CRUD API (POST /tasks/create, GET /tasks, GET /tasks/:id, PATCH /tasks/:id)
- [x] /task TUI wizard (title → priority → assignee → description)
- [x] /task preview hint while typing
- [x] Task event messages in #tasks channel ([TASK] created, status changes)
- [x] Task instructions in agent system message
- [x] tasks/ directory in corp scaffolding

### Phase B — Task automation (done)
- [x] TASKS.md live inbox per agent (refreshed on every change + every 5 min)
- [x] Auto @mention assignee in #tasks on task creation (immediate dispatch)
- [x] Agents auto-join #tasks channel on hire
- [x] TaskWatcher: fs.watch on tasks/ for agent-created/modified task files
- [x] Duplicate event suppression (API create + TaskWatcher don't double-post)
- [x] OpenClaw native heartbeat configured on corp gateway (every 10 min)
- [x] Stale task detection in TASKS.md (10min assigned, 2hr in_progress warnings)

### Phase C (deferred to Layer 6)
- [ ] Task board TUI view (list with filters and keyboard shortcuts)
- [ ] Task detail view (full body + progress notes)
- [ ] Task hierarchy rendering (parentTaskId indentation)

## Layer 5: Autonomy

- [x] Shared corp gateway (one OpenClaw process, agents.list for all workers)
- [x] Corp gateway hot-reload (OpenClaw detects agents.list changes dynamically)
- [x] Corp gateway adopts existing process that survived Ctrl+C
- [x] Agent hiring flow (create workspace + add to corp gateway + DM channel)
- [x] /hire TUI wizard (interactive: name → rank select → description)
- [x] /hire command preview hint while typing
- [x] System message confirmation after hiring
- [x] Rank validation (canHire — owner > master > leader > worker > subagent)
- [x] CEO-initiated hiring (curl to daemon API from system message instructions)
- [x] Agent-to-agent @mention chaining (CEO → Researcher → CEO, verified working)
- [x] Multi-agent fan-out dispatch (@CEO @Researcher in one message)
- [x] Rainbow @mentions (static in chat, animated in input bar)
- [x] Member list auto-refresh when new agents are hired
- [x] Git auto-commit after agent actions (10s debounce, 60s janitor)
- [ ] Git Janitor agent (conflict resolution, clean commits)
- [ ] Starter pack: CEO bootstraps agents from onboarding conversation
- [ ] Agent suspension/resume
- [ ] Agent archival

## Layer 6: Views

- [ ] Corp home view (overview of all projects, corp-level agents)
- [ ] Project home view (teams, channels, activity, task summary)
- [ ] Agent home/inspector view (SOUL.md, BRAIN, status, current task)
- [ ] Hierarchy tree view (box-drawing mafia tree, navigable)
- [ ] Task board view (from Layer 4 Phase C)
- [ ] Navigation polish (hotkeys, transitions)

## Layer 7: Externals

- [ ] OpenClaw native channel bridges (Telegram, Discord, Slack, WhatsApp)
- [ ] CEO morning briefing via external platform
- [ ] Bidirectional messaging through externals
- [ ] Webhook receivers for external events

---

## MUST BUILD — Corporation Themes (after Layer 6)

Onboarding theme picker: Corporate / Mafia / Military / Custom.
Changes ALL display text (rank names, channels, SOULs, system messages, TUI colors).
Internal rank system unchanged — purely cosmetic layer. See `docs/building-plan/future-themes.md`.

| Internal rank | Corporate | Mafia | Military |
|---|---|---|---|
| owner | Founder | Godfather | Commander |
| master | CEO | Underboss | General |
| leader | Director | Capo | Captain |
| worker | Employee | Soldier | Private |
| subagent | Contractor | Associate | Recruit |

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

1. ~~**Foundation** — file formats, corp structure, git integration~~
2. ~~**CEO chat** — connect to OpenClaw, talk to it in TUI~~
3. ~~**Daemon router** — fs.watch + @mention dispatch = agents talk to each other~~
4. ~~**Agent creation** — agents create agents, corporation grows~~
5. ~~**Tasks** — file-based tasks, auto-assignment, TASKS.md live inbox~~
6. ~~**Autonomous loop** — /task → auto-dispatch → agent works → completed~~
7. **Views** — corp home, agent inspector, task board (Layer 6)
