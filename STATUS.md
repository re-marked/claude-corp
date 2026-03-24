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
- **Corp Home**: default landing view — agent status grid, activity feed, task summary
- **CLI Package**: 11 commands for non-interactive management (init, start, stop, send --wait, dogfood, etc.)
- **WebSocket Streaming**: real-time token-by-token agent responses via daemon event bus
- **CorpContext**: centralized state via React Context — all views use useCorp()
- **Agent Task Queue**: one dispatch at a time per agent, overflow queued and drained automatically
- **Response Chain**: task completion → CEO notified → CEO DMs Founder with report
- **Metadata Tagging**: external OpenClaw writes filtered via source:'router'/'user' tags
- **Anti-Hallucination Rules**: agents must verify file writes, run builds, prove work
- **Resilience**: gateway auto-restart, dispatch retry, stale daemon kill, git HEAD auto-repair
- Themes: Corporate / Mafia / Military picker during onboarding
- Projects & Teams: /project + /team commands, project-scoped channels
- Git tracking: auto-commit after agent actions (10s debounce)
- Silent logger: daemon logs go to file only when TUI runs (no garbled output)
- Autonomous task loop VERIFIED: /task → @mention assignee → agent reads TASKS.md → works → completed
- Agent-written code VERIFIED: Atlas built /who, /ping, /uptime. Clawdigy built Ctrl+K fix, ASCII art script.

---

## Layer 1: Foundation — DONE

- [x] Monorepo setup (pnpm workspaces, packages/shared + daemon + tui + cli)
- [x] Type definitions (Member, Channel, Message, Task, Team, Corp, Project, AgentConfig, GlobalConfig)
- [x] File format parsers (JSONL reader/writer, markdown+frontmatter, JSON config)
- [x] Corp directory structure creation (scaffoldCorp — mkdir, init files, git init, first commit)
- [x] global-config.json (API keys, default model, preferences)
- [x] SimpleGit integration (init, commitAll, log, diff, status)
- [x] Utilities (ULID generation, @mention extraction, path helpers, constants)

## Layer 2: CEO — DONE

- [x] Two-tier architecture: CEO = user's OpenClaw (exoskeleton), workers = shared corp gateway
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
- [x] Guards: depth (max 5), dedup (message-level + dispatch-level), cooldown
- [x] Recent channel history (last 50 messages) included in every dispatch
- [x] WebSocket event bus for real-time streaming (replaces HTTP polling)
- [x] Command palette (Ctrl+K — search channels, agents, views, commands)
- [x] Auto-watch new channel directories
- [x] Mention regex handles trailing punctuation (@CEO! resolves correctly)
- [x] Bare @mention substitutes previous message as content
- [x] Unique session keys per dispatch (no OpenClaw concurrency conflicts)
- [x] 15-minute dispatch + spinner timeouts (agents can work long)
- [x] Agent task queue (busy agents queue dispatches, drain on completion)
- [x] Metadata source tagging (filters external OpenClaw tool-execution writes)

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
- [x] Task completion → CEO notification chain (system + agent @mention)

## Layer 5: Autonomy — DONE

- [x] Shared corp gateway (one OpenClaw process, agents.list for all workers)
- [x] Corp gateway hot-reload (OpenClaw detects agents.list changes dynamically)
- [x] Corp gateway adopts existing process / kills stale 401 gateways
- [x] Corp gateway health monitor (30s periodic check)
- [x] Gateway auto-restart on crash (3 retries, exponential backoff, auth re-copy)
- [x] Agent auth copied from user's ~/.openclaw auth-profiles
- [x] Agent hiring flow (create workspace + add to corp gateway + DM channel)
- [x] /hire TUI wizard (interactive: name → rank select → description)
- [x] Rank validation (canHire — owner > master > leader > worker > subagent)
- [x] CEO-initiated hiring (curl to daemon API from system message instructions)
- [x] Agent-to-agent @mention chaining (CEO → Atlas → CEO, verified working)
- [x] Multi-agent fan-out dispatch (@CEO @Researcher in one message)
- [x] Rainbow @mentions (static in chat, animated in input bar)
- [x] Git auto-commit after agent actions (10s debounce, 60s janitor)
- [x] Daemon file logger + /logs command
- [x] Anti-hallucination rules in dispatch system message

## Layer 6: Views — DONE

- [x] View stack navigation (push/pop with breadcrumbs + status bar)
- [x] Corp Home dashboard (agent grid, activity feed, task summary, ASCII logo)
- [x] Hierarchy tree view (box-drawing ├── └──, status diamonds ◆/◇)
- [x] Agent inspector view (SOUL excerpt, tasks, brain files)
- [x] Task board view (filtered list, status icons, priority colors)
- [x] Task detail view (full markdown body)
- [x] Warm charcoal theme (orange accents, rounded borders, diamond status icons)
- [x] System messages styled with ┊ prefix
- [x] Unified Ctrl-key navigation (C-K palette, C-H home, C-T tasks, C-D ceo, Esc back)
- [x] Command palette with unread indicators (● dot on channels with new messages)
- [x] Corp selector when multiple corps exist
- [x] Member sidebar (Ctrl+M toggle, live daemon status)
- [x] Dynamic terminal tab title (corp name + online count / channel name)
- [x] Silent daemon logger (logs to file only, no garbled TUI output)
- [x] Ink Static for message history (scrollable terminal buffer)
- [x] Time Machine: 5s git snapshots, /tm timeline browser, rewind/forward any point
- [x] Bracketed paste: terminal-level paste detection, mixed typed + pasted content, PUA markers

## Layer 7: CLI — DONE

- [x] Non-interactive CLI package (packages/cli/)
- [x] init: create corp without TUI (--name, --user, --theme)
- [x] start/stop: daemon lifecycle (foreground, SIGINT graceful)
- [x] status/agents: daemon and agent status (--json for machine parsing)
- [x] send --wait: message to channel, poll for agent response
- [x] hire: add agents via CLI (--name, --rank, --soul)
- [x] dogfood: project + 3 agents + task in one command
- [x] messages: read channel history (--last N, --json)
- [x] tasks: list/filter tasks
- [x] logs: tail daemon log
- [x] getCorpRoot queries running daemon (multi-corp support)

## Layer 8: Streaming — DONE

- [x] SSE streaming from OpenClaw (stream:true, chunk parsing, [DONE] sentinel)
- [x] WebSocket event bus (daemon pushes stream_token, dispatch_start/end to TUI)
- [x] useDaemonEvents hook (WebSocket client with auto-reconnect)
- [x] Live streaming preview in chat (agent name + spinner + growing text)
- [x] "X is working..." indicator during tool execution (empty content phase)
- [x] GET /streaming HTTP endpoint (fallback for CLI)

## Layer 9: State Management — DONE

- [x] CorpContext provider with useCorp() hook
- [x] All views migrated: CorpHome, ChatView, Hierarchy, TaskBoard, TaskDetail, AgentInspector, CommandPalette
- [x] Centralized members, channels, corp, daemonClient, daemonPort
- [x] refreshMembers() / refreshChannels() for on-demand updates

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

## Robustness — DONE

- [x] Stale corp cleanup: scaffoldCorp nukes broken remnants
- [x] listCorps checks members.json not just directory
- [x] Gateway starts on first hire, hot-reloads on subsequent
- [x] Gateway auth copied from user's OpenClaw, not empty globalConfig
- [x] Stale 401 gateways killed and respawned
- [x] Gateway health monitor (30s periodic check)
- [x] Stale daemon kill on startup (PID file + taskkill on Windows)
- [x] isDaemonRunning trusts port file on Windows (cross-process PID check fails)
- [x] fs.watch EPERM error handling (auto re-watch on Windows)
- [x] Message-level dedup (processedMsgIds prevents double dispatch)
- [x] Dispatch-level dedup (msgId:targetId prevents same message to same agent twice)
- [x] .gateway/ gitignored (prevents nested repo commit failures)
- [x] Git HEAD auto-repair (broken reference → orphan branch reset)

## Slash Commands — DONE

- [x] /hire — agent hiring wizard
- [x] /task — task creation wizard
- [x] /project — project creation wizard
- [x] /team — team creation wizard
- [x] /dogfood — project + dev team + task in one shot
- [x] /who, /m, /members — online roster with status
- [x] /ping — pong! system message
- [x] /uptime — daemon uptime + total message count
- [x] /channels, /ch — list all channels
- [x] /logs — recent daemon logs
- [x] /home, /h, /t, /a — navigation shortcuts
- [x] /help — list all available commands (built by Architect agent)
- [x] /stats — corp statistics (built by Coder agent)
- [x] /version — package versions (built by Coder agent, verified by Reviewer)
- [x] /weather — OpenWeatherMap weather data (built by Coder after blocker resolution)

## Layer 11: Escalation & Recovery — DONE

- [x] 5-level escalation chain (self → supervisor → CEO → Founder as last resort)
- [x] Failure recovery fragment (review feedback loop, evidence-based disagreement)
- [x] BLOCKED auto-notification (task-watcher @mentions task creator)
- [x] CEO proactive triage (checks blocked tasks, solves before bothering Founder)
- [x] Blocker resolution loop VERIFIED: BLOCKED → escalate → resolve → resume → complete
- [x] 9/9 escalation chain test (missing weather-config.json correctly blocked and escalated)
- [x] Agent-to-agent feedback: Reviewer provides specific FAIL details to implementer
- [x] Evidence-based disagreement: agents push back with proof, supervisor breaks ties

## Layer 10: Externals

- [ ] OpenClaw native channel bridges (Telegram, Discord, Slack, WhatsApp)
- [ ] CEO morning briefing via external platform
- [ ] Bidirectional messaging through externals
- [ ] Webhook receivers for external events

---

## Future / Deferred

- [ ] Custom themes (name your own ranks)
- [x] ~~Multiline paste support~~ — v0.4: bracketed paste mode with mixed typed + pasted content
- [ ] Thread support (threadId in messages)
- [ ] Agent suspension/resume/archival
- [ ] Git Janitor agent
- [ ] Starter pack: CEO bootstraps agents from conversation
- [ ] Agent forking (copy SOUL.md + BRAIN, let it evolve)
- [ ] Agent ELO / reputation system
- [ ] /kudos command (public shoutouts with tracking)
- [ ] /assign @agent <task> — inline task creation
- [ ] /standup — trigger all agents to report status
- [ ] Morning CEO briefings
- [ ] Web frontend (connects to same daemon)
- [x] ~~Auto-resume blocked tasks~~ — v0.3.1 sibling notification handles this
- [x] ~~Multi-step task pipelines~~ — DECIDED: CEO coordinates workflow, not a rigid pipeline engine. v0.3.1 auto-notifies siblings on completion. CEO adapts mid-project. Verified working in 5-agent research test + content-corp launch post pipeline.
- [x] Agent memory (MEMORY.md + BRAIN/ knowledge graph framework — exists, agents can use it)

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
10. ~~**CLI** — non-interactive management, testable without TUI~~
11. ~~**Streaming** — WebSocket event bus, real-time token preview~~
12. ~~**State** — CorpContext, useCorp(), centralized state~~
13. ~~**Escalation** — 5-level chain, BLOCKED auto-notify, blocker resolution loop~~
14. **Next**: multi-step pipelines, agent memory, auto-resume blocked tasks
