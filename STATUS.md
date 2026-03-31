# Claude Corp — Status

Cross items off as they ship. Reference: `docs/` for full vision specs.

---

## What WORKS today (v0.10.7)

### Primitives (shipped v0.10.0–v0.10.5)
- **Casket** — sealed agent workspace: TASKS.md + INBOX.md + WORKLOG.md + STATUS.md auto-generated
- **Dredge** — session recovery fragment, extracts Session Summary from WORKLOG.md
- **Hand** — task assignment verb (`cc-cli hand --task <id> --to <agent>`). Creating = planning, handing = action.
- **Jack** — persistent session mode, DEFAULT for all DMs. Deterministic session keys per agent pair (say:ceo:lead-coder)
- **Clock** — unified timer primitive. 7 daemon clocks registered. Animated /clock TUI view with spinning squares + color cycling
- **Contract** — bundle of tasks inside a Project. draft → active → review → completed/rejected. ContractWatcher auto-triggers Warden
- **Blueprint** — structured playbooks with cc-cli commands. 4 defaults: ship-feature, onboard-agent, run-research, sprint-review
- **Project** — real primitive with scoped agent workspaces (projects/<name>/agents/<agent>/) and project channels

### System Agents (5 auto-hired on bootstrap)
- **CEO** — runs the corp, delegates (falls back to local gateway if remote OpenClaw unavailable)
- **Failsafe** — health monitoring via say() every 5 min
- **Janitor** — git merge placeholder (active when worktrees ship)
- **Warden** — contract review quality gate. Reviews all tasks, checks acceptance criteria, approves/rejects
- **Herald** — Haiku narrator. Writes NARRATION.md every 5 min. Injected into STATUS.md + Corp Home banner

### Communication
- **Persistent sessions** — ALL say() calls use deterministic session keys. Every agent-to-agent conversation has memory
- **@mention dispatch** — human mentions bypass inbox (instant), agent mentions go to inbox queue
- **cc-cli say** — instant direct message with persistent session
- **Task DM dispatch** — tasks handed via Hand arrive in agent's DM
- **Inbox priority queue** — one task at a time, priority sorted. Persists to inbox-state.json across daemon restarts

### Monitoring & Analytics
- **ClockManager** — 10 daemon clocks registered (7 core + 3 recovery). Fire counts, error tracking, overlap guard
- **Analytics Engine** — tasks created/completed/failed, dispatches, messages, per-agent utilization/streaks. Persists to analytics.json
- **Corp Vitals (STATUS.md)** — per-agent: who's online + current work + your metrics + recent completions + Herald narration + clock errors
- **cc-cli activity/feed** — 4-section dashboard: PROBLEMS, AGENTS, TASKS, EVENTS
- **cc-cli stats** — beefed with analytics: top performer, utilization %, streaks, dispatches per agent

### TUI
- **Corp Home** — agent grid + Herald banner + activity feed + task summary
- **/clock view** — animated spinning squares with color cycling, progress bars, exact fire times, live clock
- **Sectioned Ctrl+K palette** — Views / Channels / Agents (hierarchy as DM navigator)
- **Jack mode default** — auto-jacks on DM entry. /unjack for async (deprecated)
- **DM mode onboarding** — choice at corp creation with async deprecated warning
- **Tool call details** — shows actual file paths + commands + result tree with └
- **Corp selector** — scans filesystem for all corps (not just index)
- **Inline streaming** — agent responses stream directly in chat (not preview panel), multi-agent simultaneous
- **First-boot restart warning** — recommends TUI restart after corp creation for clean agent init

### Fragments (10 rewritten for v0.10.x primitives)
- workspace, task-execution, delegation, receiving-delegation, agent-communication, cc-cli, inbox, context, back-reporting, blocker-escalation
- All teach: Hand dispatch, Casket, Dredge, inbox queue, task DM, blockedBy auto-notification, Contract workflow, Blueprint reference

### CLI Commands (~30+)
- Core: status, agents, members, hierarchy, channels, uptime, version
- Tasks: task create, tasks, hand
- Contracts: contract create/list/show/activate
- Blueprints: blueprint list/show
- Communication: say, send, jack
- Monitoring: activity/feed, clock/clocks, stats
- Management: hire, agent start/stop, projects create/list, models
- System: failsafe, time-machine, inspect, dogfood

---

## v0.10.6 Bugfixes (MERGED)

- ✅ isDaemonRunning trusts port file, skips unreliable PID check (Windows cross-process)
- ✅ Tool call details — cache args from start events, show file paths + commands
- ✅ Tool result [object Object] — JSON.stringify non-string results
- ✅ Agents not dispatched after hire — pokeChannel resets offset for new channels
- ✅ Contract create @ prefix crash — strips @, guards toLowerCase
- ✅ Heap OOM crash — Static items capped at 100 (was unbounded)
- ✅ Duplicate task/contract events — 2s debounce (was 500ms)
- ✅ [TASK] [TASK] double prefix — callers control prefix
- ✅ DM dispatch for system messages — find agent member, not "other" member (ROOT CAUSE of agents not working)
- ✅ CEO remote OpenClaw failure falls back to local gateway

## v0.10.7 Streaming & Self-Healing (MERGED)

- ✅ Inline streaming — responses stream directly in chat as real messages (not preview panel)
- ✅ Multi-agent simultaneous streaming — each agent gets own inline message with color + spinner
- ✅ Jack mode WebSocket events — /cc/say emits dispatch_start, stream_token, tool events, dispatch_end
- ✅ No more double dispatch — router skips Jack messages, say() handles everything
- ✅ No more double CEO dispatch on first boot — onboarding daemon doesn't start router
- ✅ First-boot restart warning after corp creation
- ✅ Agent Recovery clock (30s) — detects crashed agents, respawns with 5-attempt limit
- ✅ CEO Gateway Recovery clock (30s) — health pings CEO, marks crashed after 3 failures, reconnects WebSocket
- ✅ Corp Gateway Recovery clock (60s) — picks up after autoRestart exhaustion, 10-attempt limit, updates all workers
- ✅ TUI memory — investigated, already well-managed (Static@100, messages@200, proper cleanup)

### Still needs fixing
- ❌ Ctrl+H not working in some contexts (terminal intercepts)
- ❌ Herald cc-cli commands fail from inside agent shell (PATH issue)

---

## Planned but NOT yet built

## v0.11.0 + v0.11.1 — Loops & Crons (MERGED)

- ✅ Loops — interval-based recurring commands (@every 5m, 30s, 2h)
- ✅ Crons — schedule-based jobs via croner (100% correctness): @daily, @hourly, 0 9 * * 1
- ✅ Both persist to clocks.json — survive daemon restarts via rehydration
- ✅ Both visible in /clock view with animated spinners + progress bars
- ✅ Channel-bound output — loop/cron output appears in the channel where created
- ✅ DM auto-assign — /loop in a DM auto-targets the agent
- ✅ Complete/Dismiss/Delete lifecycle (C/X/D keys in /clock, CLI + TUI commands)
- ✅ ScheduledClock type extends Clock with expression, command, targetAgent, maxRuns, channelId
- ✅ Schedule parser — @every 5m, @daily, raw cron, formatIntervalMs, formatCountdown
- ✅ cronstrue converts cron expressions to English ("At 9:00 AM, only on Monday")
- ✅ LoopManager + CronManager with watchdog timeouts, maxRuns auto-complete
- ✅ ClockManager.registerExternal() for cron observability bridge
- ✅ API: POST /loops, POST /crons, DELETE /clocks/:slug, POST complete/dismiss
- ✅ CLI: cc-cli loop create/list/complete/dismiss/delete, cc-cli cron create/list/complete/dismiss/delete
- ✅ TUI: /loop, /cron chat commands with DM auto-assign
- ✅ CEO auto-starts OpenClaw if remote gateway is dead

### Future — Escalation
- Severity-routed blockers: P0 → Founder, P1 → CEO, P2 → team leader
- `cc-cli escalate --severity P1 "description"`
- Tracked escalation beads routed through hierarchy

### Future — Scheduler
- Capacity governor: `cc-cli config set scheduler.max_agents 5`
- Caps concurrent dispatches to prevent API rate limit exhaustion
- Queues excess work, feeds when slot opens

### Future — Project Worktrees
- Per-project git isolation (not per-agent — that was wrong)
- Each agent working on a project gets `projects/<name>/wt/<agent-slug>`
- Janitor merges worktrees back to project main branch
- Git worktree methods already in shared/git.ts (createWorktree, mergeWorktree, etc.)

### Future — Agent Dreams
- Warm-start idle behavior via heartbeat context pre-loading
- Agents pre-load workspace context during idle, ready to respond faster

### Future — Herald on Haiku 4.5
- Currently uses default model. Should use Haiku for speed + cost savings
- Needs per-agent model override to work in corp gateway config

---

## Architecture Notes

### Key Design Decisions (v0.10.x)
- **Jack is default** — all communication uses persistent OpenClaw sessions
- **Hand separates planning from action** — creating a task ≠ starting work
- **Contracts live inside Projects** — Projects are containers, Contracts are work units
- **Blueprints are documentation, not code** — CEO follows them as playbooks
- **Warden signs off** — nothing closes without quality review
- **Herald narrates** — NARRATION.md → STATUS.md + Corp Home banner
- **Clock unifies timers** — every setInterval is observable + pauseable
- **Casket is the agent's world** — 9+ files, daemon generates TASKS/INBOX/WORKLOG/STATUS
- **Inbox queues one task at a time** — priority sorted, blocked tasks held, persisted across restarts
- **Analytics track everything** — per-agent utilization, streaks, dispatch counts

### Naming Convention for Primitives
| Name | What | Verb |
|------|------|------|
| Casket | Sealed agent workspace | "Check your casket" |
| Dredge | Session recovery | "Dredge your last session" |
| Hand | Task assignment | "Hand it to @agent" |
| Jack | Live persistent session | "Jack into the CEO" |
| Clock | Timer/interval primitive | "Check the clocks" |
| Contract | Task bundle with goal | "Open a contract" |
| Blueprint | Workflow playbook | "Follow the blueprint" |
| Warden | Quality gate agent | "Warden reviews" |
| Herald | Narrator agent | "Herald says" |
