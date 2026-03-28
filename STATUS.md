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
- **Model Selector**: corp-wide default + per-agent override, fallback chain (auto-retry on 529/503), /model TUI wizard, hot reload via gateway config rewrite
- **Threads + Channel Modes**: [thread] prefix, announce/mention/open modes, debate protocol
- **Tool Event Visibility**: real-time tool calls displayed inline in TUI chat
- **File-Based Hiring**: agents drop .md in hiring/ → HireWatcher auto-hires
- **blockedBy Dependencies**: task frontmatter, auto-unblock when all blockers complete
- Themes: Corporate / Mafia / Military picker during onboarding
- Projects & Teams: /project + /team commands, project-scoped channels
- Git tracking: auto-commit after agent actions (10s debounce)
- Silent logger: daemon logs go to file only when TUI runs (no garbled output)
- Autonomous task loop VERIFIED: /task → @mention assignee → agent reads TASKS.md → works → completed
- Agent-written code VERIFIED: Atlas built /who, /ping, /uptime. Clawdigy built Ctrl+K fix, ASCII art script.

---

## Layer 1–9: COMPLETE (see below)

## Layer 10: Externals

- [ ] OpenClaw native channel bridges (Telegram, Discord, Slack, WhatsApp)
- [ ] CEO morning briefing via external platform
- [ ] Bidirectional messaging through externals
- [ ] Webhook receivers for external events

---

## Future / Open

- [ ] Custom themes (name your own ranks, custom colors)
- [ ] Agent suspension/resume/archival
- [ ] Git Janitor agent (auto-resolves merge conflicts)
- [ ] Starter pack: CEO bootstraps agents from a single conversation brief
- [ ] Agent forking (copy SOUL.md + BRAIN, let it evolve independently)
- [ ] Agent ELO / reputation system (track agent reliability over time)
- [ ] /kudos command (public shoutouts with tracking)
- [ ] /assign @agent <task> — inline task creation from chat
- [ ] /standup — trigger all agents to report their current status
- [ ] Morning CEO briefings (daily summary of overnight work)
- [ ] Web frontend (connects to same daemon, browser-based UI)
- [ ] Per-agent model overrides via separate gateway instances (current: OpenClaw only reads corp default per-agent, workaround: re-trigger config reload)
- [ ] Steampunk aesthetic (direction set, old implementation removed, rebuild properly)
- [ ] Per-run analytics dashboard (agent participation, timing, deliverables)

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
16. ~~**Threads + channel modes** — [thread] prefix, announce/mention/open modes, debate protocol~~
17. ~~**Skills system** — 50 bundled skills from 6 repos, XML injection with when_to_use, 30K char limit~~
18. ~~**Model selector** — corp-wide default + per-agent override, fallback chain, /model wizard, hot reload~~
