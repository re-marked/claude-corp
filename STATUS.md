# Claude Corp — Status

Cross items off as they ship. Reference: `docs/` for full vision specs.

---

## What WORKS today

- Layer 1: types, parsers, corp scaffolding, git integration
- Layer 2: CEO connects to user's existing OpenClaw, TUI onboarding + chat
- Layer 3: async router, @mention dispatch, channel history, channel switching
- Layer 4: task files, /task wizard, API, TASKS.md live inbox, auto-assignment dispatch
- Layer 5: shared corp gateway, /hire wizard, CEO-initiated hiring, multi-agent chat
- Layer 6: task board, hierarchy tree, agent inspector, command palette, warm charcoal theme
- **Corp Home**: default landing view — agent status grid, activity feed, task summary (Discord-like)
- **Resilience**: gateway auto-restart, dispatch retry, graceful degradation on partial failures
- **Dogfood**: /dogfood command auto-creates project + dev team + task for self-development
- Themes: Corporate / Mafia / Military picker during onboarding
- Projects & Teams: /project + /team commands, project-scoped channels
- Git tracking: auto-commit after agent actions (10s debounce)
- ASCII splash screen, /logs command, daemon file logger
- Autonomous task loop VERIFIED: /task → @mention assignee → agent reads TASKS.md → works → completed

---

## Layer 1: Foundation — DONE

- [x] Monorepo setup (pnpm workspaces, packages/shared + daemon + tui)
- [x] Type definitions (Member, Channel, Message, Task, Team, Corp, Project, AgentConfig, GlobalConfig)
- [x] File format parsers (JSONL reader/writer, markdown+frontmatter, JSON config)
- [x] Corp directory structure creation (scaffoldCorp — mkdir, init files, git init, first commit)
- [x] global-config.json (API keys, default model, preferences)
- [x] SimpleGit integration (init, commitAll, log, diff, status)
- [x] Utilities (ULID generation, @mention extraction, path helpers, constants)

## Layer 2: CEO — DONE

- [x] Two-tier architecture: CEO = user's OpenClaw, workers = shared corp gateway
- [x] Auto-detect user's OpenClaw gateway from ~/.openclaw/openclaw.json
- [x] Remote agent mode (connect to existing gateway, no process spawning)
- [x] CEO workspace files (SOUL.md, AGENTS.md, HEARTBEAT.md, IDENTITY.md, USER.md)
- [x] Corp context injection (system message with agent dir, corp path, members)
- [x] File-reference context (point agent to SOUL.md/AGENTS.md/TASKS.md, don't inline)
- [x] TUI onboarding wizard (name → corp name → theme picker → spawn → chat)
- [x] System message kickoff triggers CEO onboarding interview
- [x] Auto-patch user's OpenClaw for verbose + streaming settings

## Layer 3: Messaging — DONE

- [x] Daemon router: fs.watch on all channel JSONL files with byte-offset tracking
- [x] Async dispatch (sendMessage writes to JSONL, router dispatches via fs.watch)
- [x] DM auto-routing (every message in DM wakes the other member)
- [x] @mention routing in broadcast/team/system channels
- [x] Router handles 'system' sender for automated notifications
- [x] Guards: depth (max 5), dedup, cooldown (agent-to-agent only, user bypasses)
- [x] Recent channel history (last 50 messages) included in every dispatch
- [x] Named typing indicator ("CEO is typing..." not generic "Thinking...")
- [x] Command palette (Tab — search channels, agents, views, commands)
- [x] Auto-watch new channel directories
- [x] Mention regex handles trailing punctuation (@CEO! resolves correctly)
- [x] Bare @mention substitutes previous message as content
- [x] Unique session keys per dispatch (no OpenClaw concurrency conflicts)
- [x] 15-minute dispatch + spinner timeouts (agents can work long)

## Layer 4: Tasks — DONE

- [x] Task file format (markdown + YAML frontmatter in tasks/)
- [x] Task primitives (createTask, readTask, updateTask, listTasks)
- [x] Task CRUD API (POST /tasks/create, GET /tasks, GET /tasks/:id, PATCH /tasks/:id)
- [x] /task TUI wizard (title → priority → assignee → description)
- [x] Task event messages in themed tasks channel
- [x] Task instructions + API curl commands in agent system message
- [x] TASKS.md live inbox per agent (refreshed on every change + every 5 min)
- [x] Auto @mention assignee on task creation (immediate dispatch)
- [x] TaskWatcher: fs.watch on tasks/ for agent-created/modified task files
- [x] OpenClaw native heartbeat configured on corp gateway (every 10 min)
- [x] Stale task detection in TASKS.md (10min assigned, 2hr in_progress warnings)
- [x] Task board view with status icons + filters
- [x] Task detail view with full body + progress notes
- [x] Tasks support projectId for project scoping

## Layer 5: Autonomy — DONE

- [x] Shared corp gateway (one OpenClaw process, agents.list for all workers)
- [x] Corp gateway hot-reload (OpenClaw detects agents.list changes dynamically)
- [x] Corp gateway adopts existing process / kills stale 401 gateways
- [x] Corp gateway health monitor (30s periodic check)
- [x] Agent auth copied from user's ~/.openclaw auth-profiles
- [x] Agent hiring flow (create workspace + add to corp gateway + DM channel)
- [x] /hire TUI wizard (interactive: name → rank select → description)
- [x] Rank validation (canHire — owner > master > leader > worker > subagent)
- [x] CEO-initiated hiring (curl to daemon API from system message instructions)
- [x] Agent-to-agent @mention chaining (CEO → Researcher → CEO, verified working)
- [x] Multi-agent fan-out dispatch (@CEO @Researcher in one message)
- [x] Rainbow @mentions (static in chat, animated in input bar)
- [x] Git auto-commit after agent actions (10s debounce, 60s janitor)
- [x] Daemon file logger + /logs command

## Layer 6: Views — DONE

- [x] View stack navigation (push/pop with breadcrumbs + status bar)
- [x] Hierarchy tree view (box-drawing ├── └──, status diamonds ◆/◇)
- [x] Agent inspector view (SOUL excerpt, tasks, brain files)
- [x] Task board view (filtered list, status icons, priority colors)
- [x] Task detail view (full markdown body)
- [x] Warm charcoal theme (orange accents, rounded borders, diamond status icons)
- [x] System messages styled with ┊ prefix
- [x] Slash command navigation (/h /t /a /logs)
- [x] Command palette (Tab — unified search for everything)
- [x] ASCII splash screen at startup

## Themes — DONE

- [x] Corporate: Founder → CEO → Director → Employee → Contractor
- [x] Mafia: Godfather → Underboss → Capo → Soldier → Associate
- [x] Military: Commander → General → Captain → Private → Recruit
- [x] Theme picker during onboarding
- [x] Themed channel names (#the-backroom, #command-post, etc.)
- [x] CEO SOUL.md uses themed titles and flavor text
- [x] CEO displayName uses themed rank (Underboss, not CEO)

## Projects & Teams — DONE

- [x] Project CRUD (createProject, listProjects, getProject)
- [x] Project types: codebase (real repo path) or workspace (folder)
- [x] Team CRUD (createTeam, listTeams, addMemberToTeam)
- [x] /project TUI wizard (name → type → path → description)
- [x] /team TUI wizard (select project → name → assign leader)
- [x] Project channels: #{project}-general, #{project}-tasks
- [x] Team channels: #{project}-{team}
- [x] Daemon API: POST/GET for projects and teams
- [x] Projects + teams in command palette

## Layer 7: Externals

- [ ] OpenClaw native channel bridges (Telegram, Discord, Slack, WhatsApp)
- [ ] CEO morning briefing via external platform
- [ ] Bidirectional messaging through externals
- [ ] Webhook receivers for external events

---

## Robustness Fixes

- [x] Stale corp cleanup: scaffoldCorp nukes broken remnants
- [x] listCorps checks members.json not just directory
- [x] Gateway starts on first hire, hot-reloads on subsequent
- [x] Gateway auth copied from user's OpenClaw, not empty globalConfig
- [x] Stale 401 gateways killed and respawned
- [x] Gateway health monitor (30s periodic check)

---

## Corp Home — DONE

- [x] Corp Home as default landing view (Discord-like dashboard)
- [x] Agent status grid (2-column, live process status from daemon, last-active timestamps)
- [x] Activity feed (recent messages across all channels, chronological, scrollable with cursor)
- [x] Task summary bar (counts by status: active, pending, done, failed, blocked)
- [x] Auto-refresh every 5 seconds (live data from files + daemon API)
- [x] Navigation: Enter opens channel, d opens CEO DM, c opens palette
- [x] Corp Home added to command palette and /home nav command
- [x] /dogfood command (auto-creates project + dev team + task for dogfooding)

## Resilience — DONE

- [x] Gateway auto-restart on crash (3 retries with exponential backoff)
- [x] Auth re-copy on gateway restart (refreshAllAuth before respawn)
- [x] Dispatch retry on transient failures (401, 502+, connection errors — 1 retry with 3s delay)
- [x] Resilient startup: each init step (gateway, agents, router, file reads) isolated in try/catch
- [x] Gateway-less agent registration (agents registered with stopped status if gateway not ready)
- [x] Graceful degradation: partial corp loads even if members.json or channels.json corrupted

## Future / Deferred

- [ ] Custom themes (name your own ranks)
- [ ] WebSocket streaming for real-time tool call visibility
- [x] Member sidebar in channel view (Ctrl+M toggle, live daemon status)
- [ ] Multiline paste support in message input bar
- [ ] Thread support (threadId in messages)
- [ ] Agent suspension/resume/archival
- [ ] Git Janitor agent
- [ ] Starter pack: CEO bootstraps agents from conversation
- [ ] Agent forking (copy SOUL.md + BRAIN, let it evolve)
- [ ] Agent ELO / reputation system
- [ ] Web frontend (connects to same daemon)

---

## Critical Path — COMPLETE

1. ~~**Foundation** — file formats, corp structure, git integration~~
2. ~~**CEO chat** — connect to OpenClaw, talk to it in TUI~~
3. ~~**Daemon router** — fs.watch + @mention dispatch = agents talk to each other~~
4. ~~**Agent creation** — agents create agents, corporation grows~~
5. ~~**Tasks** — file-based tasks, auto-assignment, TASKS.md live inbox~~
6. ~~**Autonomous loop** — /task → auto-dispatch → agent works → completed~~
7. ~~**Views** — task board, hierarchy, agent inspector, command palette~~
8. ~~**Themes** — Corporate / Mafia / Military~~
9. ~~**Projects & Teams** — organized structure, scoped channels~~
10. **Next**: dogfood it — use Claude Corp to build Claude Corp features
