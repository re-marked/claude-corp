# Claude Corp — Status

Cross items off as they ship. Reference: `docs/` for full vision specs.

---

## v2.0.0 — Harness-Agnostic Corps (MERGED, PRs #87–#98)

**The new chapter:** Claude Corp is no longer tied to any single agent runtime. Every agent picks a registered substrate at hire time (or later via `cc-cli agent set-harness`), and the daemon's `HarnessRouter` dispatches each message through the right plug. Same `AgentHarness` contract; any harness that implements it is a first-class citizen.

**Why it matters now:** Anthropic banned OpenClaw subscription auth. Without substrate-agnostic dispatch, users on Claude Max subscriptions (no API key) had no path to run Claude Corp. v2.0.0 makes that path first-class, without losing OpenClaw's provider-agnostic multi-provider support.

### What shipped across the rollout (PRs #87–#98)

| Area | Summary |
|---|---|
| **Harness abstraction** (#87) | `AgentHarness` interface, `OpenClawHarness` wrap (zero-behavior-change default), `HarnessRegistry`, `MockHarness`, lifecycle wiring |
| **Per-agent routing** (#88) | `HarnessRouter`, harness persisted to `config.json` + Member, `/agents` + `/harnesses` APIs, `cc-cli agents` column, `cc-cli agent set-harness`, `cc-cli harness list/health`, `cc-cli inspect` |
| **Claude Code harness** (#89–#93) | `ClaudeCodeHarness` over `claude --print --verbose --output-format stream-json` on OAuth subscription auth, cost tracking, 4 Windows spawn hotfixes (shell quoting, binary resolution, --verbose flag requirement, absolute-cwd handling) |
| **Agent onboarding** (#94) | Harness-aware `defaultRules` + `defaultEnvironment` templates, files on disk renamed to OpenClaw-recognized `AGENTS.md` + `TOOLS.md` (so they finally reach both substrates' system prompts), `buildClaudeMd` template with SOUL preamble + `@./` imports, daemon-startup filename migration, `cc-cli hire --harness` |
| **API bug fixes** (#96–#98) | Three instances of the same bug class — HTTP handlers silently dropping body fields. `/agents/hire` dropped `harness`, `/tasks/create` dropped `projectId`/`blockedBy`/`acceptanceCriteria`, `/projects/create` dropped `displayName`. All fixed + regression tests at the HTTP boundary |
| **Set-harness reconciliation** (this PR) | `cc-cli agent set-harness` now actively re-scaffolds the workspace: migrates legacy filenames with newer-wins conflict resolution (older copy moved to `.backup.<ts>`), writes CLAUDE.md when switching to claude-code, moves CLAUDE.md aside when switching back. Switching harness is now a real migration, not a record-only lie |
| **Doc alignment** | README badge bumped + harness-agnostic framing, ROADMAP top note, CLAUDE.md corp layout, SOUL + workspace fragment + onboard-agent blueprint + planner heartbeat + init/onboarding kickoff messages all updated to the v2.0 filenames |

### Live-verified end-to-end

Hired TestPilot2 with `--harness claude-code` in the hc-test corp, dispatched via `cc-cli say`. Response reflected IDENTITY.md content verbatim — the claude CLI auto-discovered CLAUDE.md, resolved all 11 `@./` imports, and the workspace files reached the system prompt. Proof the full loop works.

### Test suite

499/499 green. New coverage: 63 tests for PR #94, 5 each for the three HTTP-body fixes, 13 for the reconciler. Regression coverage now includes the HTTP boundary seam that was invisible to unit tests before.

---

## What WORKS today (v1.0.0)

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

## v0.11.2 — Loop-Task Link + Cron Task Spawning (MERGED)

- ✅ Loop-task bidirectional lifecycle: loop complete → task complete, task complete → loop stop
- ✅ Cron task spawning: each fire creates fresh dated task + hands it to agent via DM
- ✅ Missed cron detection on restart (log, skip to next)
- ✅ Fragments teach agents loop-task links, cron spawning, when to use each

## v0.11.3 — Smart Heartbeat + Gateway Fixes (MERGED)

- ✅ Pulse rewritten: per-agent two-state heartbeat (idle → check casket, busy → HEARTBEAT_OK)
- ✅ Staggered pings (1.5s delay) — no thundering herd
- ✅ Escalation to CEO after 2 missed heartbeats with specific reason
- ✅ Recovery notification — CEO told when escalated agent comes back
- ✅ Corp gateway: always fallback model, maxConcurrent: 2, stripped cooldown state
- ✅ Auto-restart user OpenClaw on 3 consecutive overloaded errors
- ✅ Comprehensive stale process cleanup on TUI restart (scans all ports)

## v0.11.3.1 — Polish (MERGED)

- ✅ /hand command: DM auto-assign, agent validation, busy warning, task title + priority
- ✅ Task wizard: removed assignee step, added acceptance criteria, shows /hand hint
- ✅ Command autocomplete: 26 commands with syntax hints + descriptions + Tab complete
- ✅ Wizard Ink crash fix (flexGrow → minHeight)
- ✅ Loop error suppression (first error shown, rest silent until recovery)

### Still needs building
- Task wizard: blockedBy field
- /loop info <name> — detail view for specific loop
- Loop-task link testing with real agents

## v0.12.0 — Agent Dreams (MERGED)

- ✅ 4-phase memory consolidation: Orient → Gather → Consolidate → Prune (adapted from Claude Code's autoDream)
- ✅ Natural idle trigger: 5min idle + no pending inbox + 1h since last dream
- ✅ Dream state persisted to `agents/<name>/dream-state.json`
- ✅ Force dream via API: `POST /dream` + `cc-cli dream`
- ✅ Lock mechanism with PID + race detection + 1h stale threshold
- ✅ Uses Jack session key for DM context continuity
- ✅ Dream consolidation clock registered in ClockManager (every 2m scan)

## v0.13.0 — Coordinator Mode (MERGED)

- ✅ 172-line coordinator prompt fragment (adapted from Claude Code's coordinatorMode.ts, 370 lines)
- ✅ Injected for all master/leader rank agents
- ✅ 4-phase workflow: Research → Synthesis → Implementation → Verification
- ✅ Anti-lazy-delegation rules ("Never say 'based on your findings, fix it'")
- ✅ Continue-vs-spawn decision matrix
- ✅ Parallelism as superpower — concurrent workers for research
- ✅ Verification with fresh eyes only (not the implementer)

## v0.14.0 — Plan Primitive (MERGED)

- ✅ Two-tier planning: Sketch (5m, ~60 lines) + Ultraplan (20m, 5-phase deep audit)
- ✅ Sketch: reads 2-5 files, considers 2 approaches, 80-line cap, actionable
- ✅ Ultraplan: 5 phases — Audit Codebase → Design & Compare → Stress-Test → Write Plan → Self-Review
- ✅ Plans saved to `plans/<id>.md` with frontmatter (id, title, type, author, status)
- ✅ Plan approval UI in TUI (approve/edit/dismiss with TextInput)
- ✅ Rotating status verbs (brewing/devising/architecting/contemplating...)
- ✅ cc-cli plan create/list/show commands

## v0.14.3 — Planner Agent + Opus Routing (MERGED)

- ✅ Planner agent auto-hired on bootstrap (like Failsafe/Warden/Herald)
- ✅ Rank: leader, Model: claude-opus-4-6
- ✅ Opus agents route to remote gateway (user's OpenClaw), NOT corp gateway (Haiku)
- ✅ hireAgent() detects Opus model → skips corp gateway, calls spawnAgent()
- ✅ initCorpGateway() skips Opus agents on rehydration
- ✅ Deep plans auto-route to Planner (Opus), sketches use any agent

### Bugs fixed during v0.14.3 testing
- ✅ acceptanceCriteria missing from DaemonClient.createTask type
- ✅ cc-cli send misattributed messages to busy agent (now passes founder ID)

---

## v0.14.3 Full Test Report (April 1, 2026)

**Corp:** full-test | **Agents:** 7 | **Duration:** 16 min | **Build:** clean (0 type errors)

| # | Feature | Status | Metric |
|---|---------|--------|--------|
| 1 | **Ultraplan (Opus)** | PASS | 251 lines, 17KB, ~10min, 8 phases, parallelism strategy, file change summary |
| 2 | **Sketch (Haiku)** | PASS | 57 lines, 4.4KB, 50s, grounded in code, within 80-line cap |
| 3 | **Readable IDs** | PASS | Task `cool-bay` (word-pair), member slugs (ceo, planner, herald) |
| 4 | **Loops** | PASS | 30s interval, fired 25x in 12.5min, persisted to clocks.json, deleted cleanly |
| 5 | **Crons** | PASS | @hourly → "Every hour", nextFireAt correct, persisted |
| 6 | **Pulse Heartbeat** | PASS | 7 agents pinged sequentially (~6s stagger), 6/7 responded, idle/busy detection |
| 7 | **Agent Dreams** | PASS | Warden + Herald auto-dreamed, Janitor force dream worked, 4-phase protocol |
| 8 | **Coordinator Mode** | PASS | 172-line fragment injected for master/leader rank |
| 9 | **Agent Hiring** | PASS | Researcher hired, 7-agent hierarchy, DM channel created, joined #general |
| 10 | **Message Routing** | PASS* | @CEO dispatched, CEO responded with onboarding. *senderId bug found + fixed |
| 11 | **Clock System** | PASS | 10+ system clocks, fire counts tracked, gateway health, git snapshots |
| 12 | **Corp Stats** | PASS | 7/7 online, 47 dispatches, per-agent utilization %, 10 channels |

**Ultraplan quality (Opus vs Haiku):**
| Metric | Haiku (v0.14.2) | Opus (v0.14.3) |
|--------|-----------------|----------------|
| Time | 200s (3.3 min) | ~600s (10 min) |
| Lines | 469 | 251 (denser) |
| Size | — | 17KB |
| Phases | 5 | 8 + parallelism graph |
| Real file paths | Yes | Yes (verified by reading) |
| Risk matrix | 3 risks | 7 risks with mitigations |
| Acceptance criteria | 12 items | 9 items |
| Worker assignment | Generic | Named roles (worker-types, worker-core, worker-cli, worker-verifier) |

**Dream auto-trigger confirmed:**
- Warden: dream #1 completed at 12:25:14 (idle trigger, clean)
- Herald: dream #1 completed at 12:25:22 (idle trigger, clean)
- CEO: dream triggered at 12:26:22 (hit API rate limit from ultraplan)
- Janitor: force dream worked, detected new signal (Herald's plan)

**Pulse heartbeat cycle captured (12:33):**
```
CEO       — miss (rate limit, miss #4)
Failsafe  — (idle) responded OK     +6s
Janitor   — (idle) responded OK     +6s
Warden    — (idle) responded OK     +6s
Herald    — (idle) responded OK     +7s
Planner   — (idle) responded OK     +10s
Researcher— (idle) responded OK     +6s
Results: 6 responded, 1 missed
```

---

## v0.16.0 — Foundation Upgrade (MERGED)

- ✅ 4 new fragments: tool-result-management, context-persistence, scratchpad, checkpoint
- ✅ Anti-rationalization v2 (3 new patterns from Claude Code)
- ✅ Context injection: platform, shell, timezone, locale, continuity hints
- ✅ Observation logs: daily append-only journals (agents/<name>/observations/YYYY/MM/)
- ✅ Cron hardening: jitter, durable/ephemeral, auto-expiry, scheduler lock, missed detection v2
- ✅ Dispatch resilience: error categorization, exponential backoff, context blocking, health scores

## v0.16.1 — Autoemon Core (MERGED)

- ✅ AutoemonManager: tick engine with adaptive intervals (30s→5m based on agent behavior)
- ✅ 5 tick message types with context enrichment (<tick>, <presence>, <mood>, <focus>)
- ✅ Autoemon fragment: 136-line prompt teaching autonomous work (from Claude Code proactive prompt)
- ✅ Conscription cascade: CEO → leaders on contracts → workers with tasks
- ✅ Sleep handling: SLEEP command parsing, interruption on user DM / urgent task / manual wake
- ✅ Sleeping DM banner: animated ASCII night sky with stars, moon, clouds
- ✅ Founder presence tracking: watching/idle/away from TUI WebSocket + interaction time
- ✅ Telemetry: autoemon-telemetry.jsonl with per-tick records

## v0.16.2 — SLUMBER Mode (MERGED)

- ✅ /slumber [duration|profile], /afk — CEO acknowledges then ticks start
- ✅ /wake — CEO summarizes what happened (digest is CEO's own words)
- ✅ /brief — mid-SLUMBER check-in without ending session
- ✅ Duration timer with auto-stop + CEO wrap-up
- ✅ Moon phase status bar: 🌑→🌕 cycling with progress
- ✅ Founder presence injected into ticks (watching/idle/away)
- ✅ All dispatches on jack:<slug> session (full conversation memory)
- ✅ CEO on corp gateway (killed double dispatch + personal Claude leak)

## v0.16.3 — SLUMBER Premium (MERGED)

- ✅ 4 profiles: 🦉 Night Owl, 🎒 School Day, ⚡ Sprint, 🛡️ Guard Duty
- ✅ Profile mood + focus injected per tick (<mood>, <focus> XML tags)
- ✅ Conscription strategies: ceo-only / active-contracts / all-agents per profile
- ✅ Budget cap: max ticks before auto-stop (Sprint = 200 ticks)
- ✅ Message styling: ☾ muted indigo night theme for SLUMBER messages
- ✅ Analytics: productivity bar chart, tick breakdown, per-agent stats, top actions
- ✅ /slumber profiles, /slumber stats commands
- ✅ Profile validation for custom profiles

## v1.1.0 — Harness Abstraction (MERGED, PR #87)

**Motivation:** Anthropic banned OpenClaw subscription auth; Claude Corp needs to run on Claude Code's OAuth auth. First step: abstract the dispatch layer so per-agent harness selection becomes possible.

- ✅ `AgentHarness` interface — single contract (dispatch, healthCheck, teardown, cost) over any agent runtime
- ✅ `OpenClawHarness` wraps existing dispatch (backward-compat default, zero behavior change)
- ✅ `HarnessRegistry` — plugin-style registration keyed by harness name
- ✅ `MockHarness` — deterministic in-process harness for testing
- ✅ Daemon lifecycle integration: router @mention, heartbeat inbox, `/say` API all go through the harness
- ✅ Optional `harness` field added to `Member` + `Corporation` + `AgentSpec` types
- ✅ Parameterized AgentHarness contract test applied to both real + mock harnesses

## v1.1.3 — Per-Agent Harness Routing (MERGED, PR #88)

- ✅ `HarnessRouter` — delegates each dispatch to the agent's configured harness (fallback to default)
- ✅ `hireAgent` + `setupAgentWorkspace` persist resolved harness to `config.json` + Member record
- ✅ `/agents` API returns resolved harness per agent; `cc-cli agents` shows harness column
- ✅ `/harnesses` API lists registered harnesses + their health
- ✅ `cc-cli agent set-harness --agent <id> --harness <name>` — switch substrate on a live agent
- ✅ `cc-cli harness list` / `cc-cli harness health` — per-harness diagnostics
- ✅ `cc-cli inspect` shows resolved harness per agent

## v1.1.4 — Claude Code Harness (MERGED, PRs #89-93)

- ✅ `ClaudeCodeHarness` — AgentHarness over the `claude` CLI using OAuth subscription auth (not API key, since Anthropic banned OpenClaw subscription usage)
- ✅ Streams JSON events from `claude --print --verbose --output-format stream-json` into Claude Corp's unified event stream
- ✅ Per-dispatch + cumulative cost tracking
- ✅ Registered alongside `openclaw` harness at daemon startup
- ✅ 4 Windows spawn hotfixes:
  - Shell quoting + `cmd.exe` metacharacter handling via `quoteForWindowsCmd`
  - `claude` binary resolved to absolute path at init (PATH walk + PATHEXT honored), no shell mode
  - `--verbose` flag added (required by claude when combining `--print` with stream-json output)
  - `resolveWorkspace` handles absolute `agentDir` (matches api.ts convention)

## v1.2.0 — Claude Code Agent Onboarding (MERGED, PR #94)

**The unlock:** OpenClaw's workspace bootstrap loader auto-injects files only when the basename is in a hardcoded set (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md`). Claude Corp had been writing `RULES.md` + `ENVIRONMENT.md` — silently dropped. Fix: rename on disk so both OpenClaw auto-load + Claude Code `@import` converge on the same handles.

- ✅ Harness-aware templates: `defaultRules` + `defaultEnvironment` branch on harness, name substrate-specific tool vocab (`Read`/`Write`/`Edit`/`Bash` vs `read`/`exec`/`process`)
- ✅ OpenClaw-recognized basenames on disk: writes `AGENTS.md` + `TOOLS.md` (internal template names keep `rules`/`environment` for semantic clarity)
- ✅ `migrateAgentWorkspaceFilenames` — idempotent rename of legacy `RULES.md` / `ENVIRONMENT.md` on corp + project-scoped agents, runs at daemon startup; flags conflicts, doesn't clobber
- ✅ `CLAUDE.md` per Claude Code agent: SOUL embodiment preamble (verbatim OpenClaw phrasing so the agent embodies SOUL across substrates) + `@./` imports of always-on identity files + current state (STATUS/INBOX/TASKS) + read-on-demand footer for BRAIN/observations/WORKLOG
- ✅ `cc-cli hire --harness <claude-code|openclaw>` — picks substrate at agent creation
- ✅ 63 new tests across 5 files; full suite 472/472 passing

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

### ~~Future — Agent Dreams~~ SHIPPED v0.12.0
- ~~Warm-start idle behavior via heartbeat context pre-loading~~
- Shipped as 4-phase memory consolidation (Orient → Gather → Consolidate → Prune)

### ~~Future — Herald on Haiku 4.5~~ SHIPPED
- Herald runs on corp gateway (Haiku) by default. Per-agent model routing works.
- Opus agents (CEO, Planner) route to remote gateway. Haiku agents use corp gateway.

### Future — Proactive Mode (KAIROS-lite)
- Agents act without being prompted — monitor channels, detect patterns, take initiative
- Adapted from Claude Code's KAIROS system
- Next major feature after v0.14.3

### Future — Corp Buddy (Tamagotchi)
- Per-corp mascot that reflects corp health/mood
- Adapted from Claude Code's buddy system

### Future — Founder Away (AFK Mode)
- CEO autonomy while user sleeps — autonomous task execution, morning briefing
- Queue management, escalation deferral

### Future — Token Budgets
- Per-agent cost limits, usage tracking, budget alerts

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
