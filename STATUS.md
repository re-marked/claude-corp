# Claude Corp — Status

Cross items off as they ship. Reference: `docs/` for full vision specs.

---

## What WORKS today (v0.9.0)

### Core
- Layer 1-9: Foundation, CEO, messaging, tasks, autonomy, views, CLI, streaming, state — ALL COMPLETE
- **25 CLI commands** with full TUI parity (`cc-cli`)
- **Themes**: Corporate / Mafia / Military + 5 color palettes (coral, rose, lavender, indigo, mono) with `/theme` hot reload
- **50 bundled skills** from 6 repos with `when_to_use` triggers and XML injection

### Communication
- **@mention dispatch**: human mentions bypass inbox (instant), agent mentions go to inbox
- **cc say**: `cc-cli say --agent <slug> --message "..."` — direct agent-to-agent intercom, writes to inbox.jsonl
- **Slug-based mentions**: @lead-coder format everywhere, autocomplete with Tab in TUI
- **Interleaved tool events**: text segments flush before tool calls (like Claude Code)
- **Multi-word mention resolution**: checks both slug and display name
- **Channel modes**: dm (auto-dispatch), mention (@only), all (everyone)

### Agent System
- **Inbox System**: agents accumulate notifications, check on 60s heartbeat or busy→idle transition
- **Agent Status Engine**: idle/busy/offline/broken/starting per agent with WebSocket events
- **Workspace Files**: SOUL.md (universal personality), IDENTITY.md (name/rank), RULES.md (behavioral rules), HEARTBEAT.md, MEMORY.md, USER.md, ENVIRONMENT.md, BOOTSTRAP.md
- **Per-agent session keys**: `agent:<name>:channel-<id>` — no identity bleeding
- **Empty response retry**: 3 attempts with visible "Agent didn't respond. Retrying..." messages
- **Model selector**: corp-wide default + per-agent override, native OpenClaw fallback chain

### Monitoring
- **Failsafe**: watchdog agent monitoring stuck/broken agents (`cc-cli failsafe start/stop/status`), auto-hired on corp bootstrap
- **Pulse**: daemon-level timer (2 min) — auto-restarts broken agents, monitors Failsafe agent itself
- **Agent restart**: `POST /agents/:id/restart` endpoint

### TUI
- **Boot sequence**: ASCII logo with animated phases
- **Streaming preview**: looks like a normal message with spinner
- **Autocomplete**: `@` shows agent slugs, `/` shows commands, arrow keys + Tab
- **Channel clear**: scrollback clears on channel switch
- **Status bar**: breadcrumbs + hints
- **`/status`**: inline agent status in chat
- **`/theme`**: hot reload color palettes

### Reliability
- **Random gateway ports**: no more port 18800 conflicts between corps
- **Task watcher debounce**: 500ms processing lock prevents duplicate events
- **HireWatcher debounce**: claim lock before file read
- **CEO exec attribution**: messages sent via exec correctly attributed to agent (not Founder)

### Binaries
- `cc` = TUI (was `claudecorp`)
- `cc-cli` = CLI (was `claudecorp-cli`)

---

## Next: Phase 6 — Git Worktrees + Janitor

- [ ] Per-agent git worktrees — each agent works in a full separate copy of the repo on disk
- [ ] Workflow: task assigned → Git Janitor creates worktree → agent works in isolation → finishes → Git Janitor merges back → worktree cleaned up
- [ ] Conflict resolution is Git Janitor's sole responsibility

## Next: Phase 7 — Polish

- [ ] Agent Dreams — idle heartbeat pre-loads context for instant task startup
- [ ] `cc-cli hire` in agent fragments — agents use CLI for hiring instead of file writes
- [ ] System-level channel throttling — auto-batch notifications on high volume
- [ ] Per-run analytics — track agent participation, response times, token usage
- [ ] TUI scrollback fix — Static items leak across view switches, needs alt screen or virtual scroll
- [ ] TASKS.md / HEARTBEAT.md merge decision

## Future / Open

- [ ] External bridges (Telegram, Discord, Slack, WhatsApp)
- [ ] Agent suspension/resume/archival
- [ ] Agent forking (copy SOUL.md + BRAIN, let it evolve independently)
- [ ] Agent ELO / reputation system
- [ ] /kudos, /standup commands
- [ ] Morning CEO briefings
- [ ] Web frontend (connects to same daemon)
- [ ] Tool usage auditing (detect when agents skip required tools)
- [ ] Steampunk aesthetic rebuild

---

## Critical Path — COMPLETE (20 items)

1. ~~Foundation~~ 2. ~~CEO chat~~ 3. ~~Daemon router~~ 4. ~~Agent creation~~
5. ~~Tasks~~ 6. ~~Autonomous loop~~ 7. ~~Views~~ 8. ~~Themes~~
9. ~~Projects & Teams~~ 10. ~~CLI (25 commands)~~ 11. ~~Streaming~~
12. ~~State~~ 13. ~~Escalation~~ 14. ~~TUI polish~~ 15. ~~WebSocket dispatch~~
16. ~~Threads~~ 17. ~~Skills (50 bundled)~~ 18. ~~Model selector~~
19. ~~Agent identity (session keys, workspace files, BOOTSTRAP.md)~~
20. ~~Reliability (retries, mentions, channel clear, file size guard)~~
21. ~~Inbox system (agent status engine, cc say, inbox heartbeat, Pulse/Failsafe)~~
