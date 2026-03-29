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
- **CLI Package**: 25 commands for non-interactive management (full TUI parity)
- **WebSocket Streaming**: real-time token-by-token agent responses via daemon event bus
- **CorpContext**: centralized state via React Context — all views use useCorp()
- **Agent Task Queue**: one dispatch at a time per agent, overflow queued and drained automatically
- **Response Chain**: task completion → CEO notified → CEO DMs Founder with report
- **Metadata Tagging**: external OpenClaw writes filtered via source:'router'/'user' tags
- **Anti-Hallucination Rules**: agents must verify file writes, run builds, prove work
- **Resilience**: gateway auto-restart, dispatch retry, stale daemon kill, git HEAD auto-repair
- **Skills System**: 50 bundled skills from 6 repos, OpenClaw-native XML injection with when_to_use triggers, 30K char limit + binary search truncation
- **Model Selector**: corp-wide default + per-agent override, native OpenClaw fallback chain, /model TUI wizard, hot reload
- **Threads**: [thread] prefix, thread-aware dispatch, debate protocol
- **Tool Event Visibility**: real-time tool calls displayed inline in TUI chat
- **File-Based Hiring**: agents drop .md in hiring/ → HireWatcher auto-hires
- **blockedBy Dependencies**: task frontmatter, auto-unblock when all blockers complete
- **Per-Agent Session Isolation**: each agent gets unique session key — no identity bleeding
- **Multi-Word @Mention Resolution**: @Lead Coder works without quotes
- **Empty Response Guard**: empty agent responses silently dropped, not written to JSONL
- **Channel Clear on Switch**: terminal buffer clears when switching channels
- **Agent Workspace Files**: 7 focused files (SOUL, RULES, HEARTBEAT, MEMORY, IDENTITY, USER, ENVIRONMENT)
- **BOOTSTRAP.md**: one-time onboarding file for new agents (CEO gets onboarding interview, workers get task check)
- **Heartbeat Cost Optimization**: isolatedSession + lightContext on corp gateway (2-5K tokens vs 100K)
- **Native OpenClaw Model Fallback**: agents.defaults.model.fallbacks in gateway config (exponential backoff, profile rotation)
- **Session dmScope**: per-channel-peer isolation on corp gateway
- **Memory Flush Before Compaction**: auto-save memories before context window compacts
- **File Size Guard**: warns if workspace files exceed OpenClaw's 20K char bootstrap limit
- Themes: Corporate / Mafia / Military picker during onboarding
- Projects & Teams: /project + /team commands, project-scoped channels
- Git tracking: auto-commit after agent actions (10s debounce)
- Silent logger: daemon logs go to file only when TUI runs (no garbled output)
- Autonomous task loop VERIFIED: /task → @mention assignee → agent reads TASKS.md → works → completed
- Agent-written code VERIFIED: Agents built file locking system (v1→v2→v3), QA Agent caught port mismatch bug, CEO caught TOCTOU race condition

---

## Layer 1–9: COMPLETE (see below)

## Layer 10: Externals

- [ ] OpenClaw native channel bridges (Telegram, Discord, Slack, WhatsApp)
- [ ] CEO morning briefing via external platform
- [ ] Bidirectional messaging through externals
- [ ] Webhook receivers for external events

---

## Next: cc tools — agent internal intercom (v1.0)

Fast corp operations for agents. All visible conversation stays in channels with streaming.
`cc` is the invisible intercom — fast, direct, operational.

- [ ] `cc say <agent> "message"` — private direct dispatch, returns response inline
- [ ] `cc ask <agent> "question"` — same but lighter context
- [ ] `cc hire <name> <description>` — hire agent with defaults
- [ ] `cc fire <agent>` — archive agent
- [ ] `cc who` — list agents with status
- [ ] `cc task <title> [--assign] [--priority]` — create task
- [ ] `cc done <task-id>` — mark complete
- [ ] `cc block <task-id> "reason"` — mark blocked + escalate
- [ ] `cc tasks` — list assigned tasks
- [ ] `cc status` — corp status
- [ ] `cc inspect <agent>` — agent detail

NOT in scope: file read/write, code execution, git, web search — those stay native tools.

## Next: Deacon pattern — self-monitoring corp

- [ ] Deacon agent — watchdog that monitors all agents on heartbeat
- [ ] Detects stuck agents (task assigned but no progress in N minutes)
- [ ] Pings stuck agents, escalates to CEO if unresponsive
- [ ] Boot agent — watches the Deacon (who watches the watchman?)

## Next: Git Janitor + worktrees

- [ ] Git Janitor agent (auto-resolves merge conflicts)
- [ ] Per-agent git worktrees (isolated branches, no file conflicts during work)
- [ ] Merge queue managed by Git Janitor (like Gas Town's Refinery)

## Future / Open

- [ ] Agent suspension/resume/archival
- [ ] Agent forking (copy SOUL.md + BRAIN, let it evolve independently)
- [ ] Agent ELO / reputation system (track agent reliability over time)
- [ ] /kudos, /standup commands
- [ ] Morning CEO briefings (daily summary of overnight work)
- [ ] Web frontend (connects to same daemon, browser-based UI)
- [ ] Tool usage auditing (detect when agents don't use required tools like web_search)
- [ ] Agent Dreams — warm-start idle behavior (heartbeat loads context so task dispatch is instant)
- [ ] TUI scrollback fix (Static items leak across view switches — needs alt screen or custom renderer)
- [ ] TASKS.md / HEARTBEAT.md merge
- [ ] Per-run analytics dashboard

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
10. ~~**CLI** — 25 commands, full TUI parity, non-interactive management~~
11. ~~**Streaming** — WebSocket event bus, real-time token preview~~
12. ~~**State** — CorpContext, useCorp(), centralized state~~
13. ~~**Escalation** — 5-level chain, BLOCKED auto-notify, blocker resolution loop~~
14. ~~**TUI polish** — alt screen, input history, readline, URLs, crash cleanup~~
15. ~~**WebSocket dispatch** — tool event visibility, real-time tool calls in TUI~~
16. ~~**Threads** — [thread] prefix, thread-aware dispatch, debate protocol~~
17. ~~**Skills system** — 50 bundled skills from 6 repos, XML injection with when_to_use, 30K char limit~~
18. ~~**Model selector** — corp-wide default, native OpenClaw fallback, /model wizard, hot reload~~
19. ~~**Agent identity** — per-agent session keys, workspace file system (7 files), BOOTSTRAP.md onboarding~~
20. ~~**Reliability** — empty response guard, multi-word mentions, channel clear, file size guard~~
