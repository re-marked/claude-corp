<p align="center">
  <img src="./banner.png" alt="Claude Corp" width="100%" />
</p>

<h1 align="center">Claude Corp — Your Personal AI Corporation</h1>
<p align="center">
A hierarchy of AI agents that runs as a company on your machine — even while you sleep.
</p>

<p align="center">
  <a href="https://github.com/re-marked/claude-corp/actions"><img src="https://img.shields.io/github/actions/workflow/status/re-marked/claude-corp/ci.yml?style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/re-marked/claude-corp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" /></a>
  <a href="https://github.com/re-marked/claude-corp"><img src="https://img.shields.io/badge/v1.0.0-stable-blue?style=flat-square" alt="v1.0.0" /></a>
</p>

<p align="center">
  <a href="#get-started">Get Started</a> · <a href="#how-it-works">How It Works</a> · <a href="#slumber-mode">SLUMBER</a> · <a href="#agent-dreams">Dreams</a> · <a href="#primitives">Primitives</a> · <a href="#tui">TUI</a> · <a href="#cli">CLI</a> · <a href="GLOSSARY.md">Glossary</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

Most multi-agent frameworks give you a swarm that does random things. Claude Corp gives you a **company** — with a CEO who delegates, team leads who coordinate, workers who execute, and a quality gate that reviews everything before it ships. The entire thing runs locally. No cloud, no Docker. Just files and git.

## Get Started

**Prerequisites:** Node.js 22+, [OpenClaw](https://github.com/openclaw/openclaw) running, pnpm.

```bash
git clone https://github.com/re-marked/claude-corp.git
cd claude-corp
pnpm install && pnpm build
cd packages/cli && npm link && cd ../tui && npm link && cd ../..

cc              # Launch the TUI
cc new          # Create a new corporation
```

The onboarding walks you through everything. Name yourself, name your corp, pick a theme. The CEO introduces itself and starts working.

Provider-agnostic through [OpenClaw](https://openclaw.ai) — runs on Anthropic, OpenAI, Google, DeepSeek, Mistral, or local models via Ollama. One config change to switch.

## How It Works

```
Founder (you)
  └── CEO (rank: master — runs the corp, never fired)
       ├── Failsafe (health monitor, pings every 5min)
       ├── Warden (quality gate — reviews all completed work)
       ├── Herald (narrator — writes NARRATION.md every 5min)
       ├── Planner (deep planning on Opus, ultraplan + sketch)
       └── Your agents
            ├── Team Leaders (coordinate workers)
            └── Workers (do the actual work)
```

A Node.js daemon watches JSONL message files via `fs.watch`. When someone writes `@ceo check the build`, the router extracts the mention, resolves it against `members.json`, and dispatches to the right agent via the OpenClaw gateway. Agents respond to the same JSONL. The cycle repeats. Depth guards, cooldowns, and dedup prevent infinite loops.

**Rank-based hiring:** Any agent can hire at or below its rank. The CEO hires team leaders, team leaders hire workers. No central bottleneck.

**All agents share a single OpenClaw gateway** with per-agent model overrides. One process handles cheap Haiku workers and expensive Opus planners simultaneously. 17 models across 7 providers in the registry, but unknown model strings pass through as-is.

## The Data Model

Everything is files. Everything is git-tracked. Everything is human-readable.

| Format | Used for | Example |
|--------|----------|---------|
| Markdown + YAML frontmatter | Agent profiles, tasks, plans | `SOUL.md`, `tasks/cool-bay.md` |
| JSON | Config, registries | `members.json`, `channels.json`, `corp.json` |
| JSONL | Message logs (append-only) | `channels/general/messages.jsonl` |

No database. No migrations. `grep` is your query engine. `git revert` is your undo button. Every corp is a git repo — every agent action is a commit. `git log` is your audit trail.

```
~/.claudecorp/
  my-corporation/              # git repo
    corp.json                  # metadata
    members.json               # ALL members (single source of truth)
    channels.json              # ALL channels
    channels/
      general/messages.jsonl   # append-only message log
      dm-ceo-mark/messages.jsonl
    agents/
      ceo/
        SOUL.md                # personality
        BRAIN/                 # persistent knowledge (from dreams)
        HEARTBEAT.md           # wake instructions
        MEMORY.md              # memory index
        observations/          # daily work logs
        config.json            # model, provider, scope
    tasks/                     # markdown files with frontmatter
    plans/                     # ultraplans and sketches
```

## SLUMBER Mode

Type `/afk night-owl` and go to sleep. The **Autoemon** tick engine fires `<tick>` XML prompts to enrolled agents on adaptive intervals — 30s when productive, 2min when idle, 5min after 3 consecutive idle ticks.

Four personality profiles inject `<mood>` and `<focus>` directives per tick that **genuinely change how the CEO behaves:**

| Profile | Mood | Ticks | Key directive |
|---------|------|-------|---------------|
| 🦉 Night Owl | Quiet deep work | 15min for 8h | "DO NOT hire agents at 3am" |
| 🎒 School Day | Full autonomy | 10min for 7h | "DO NOT wait for approval" |
| ⚡ Sprint | Ship fast | 2min, 200-tick cap | "DO NOT refactor, ship now" |
| 🛡️ Guard Duty | Monitor only | 30min, indefinite | "DO NOT create tasks, only watch" |

Agents can `SLEEP 15m — waiting for build` and the daemon respects it. Founder presence is tracked (watching/idle/away) — ticks suppress while you're actively chatting.

**Conscription cascade:** CEO always enrolls. Team leaders on active contracts get conscripted. Workers with active tasks follow. Strategy varies per profile — Guard Duty conscripts CEO only, Sprint conscripts everyone.

```
/afk night-owl
  → CEO acknowledges, agents conscripted
  → Ticks fire autonomously through the night
  → Moon phases cycle in status bar: 🌑🌒🌓🌔🌕🌖🌗🌘

/brief                     # check in without ending SLUMBER
/wake                      # end + CEO briefing
  → CEO: "45 ticks, 36 productive. Reviewed 3 PRs,
     updated docs, completed competitor research."
  → Productivity: ████████░░ 80%
```

**Founder Away:** If you're idle for 30+ minutes, the corp can auto-activate Guard Duty mode via `/dangerously-enable-auto-afk`.

## Agent Dreams

Agents write **observations** to daily append-only logs as they work (`agents/ceo/observations/2026/04/2026-04-06.md`). 11 category tags: TASK, RESEARCH, DECISION, BLOCKED, LEARNED, and more.

During idle periods, a 4-phase dream cycle distills observations into persistent `BRAIN/` topic files:

1. **Orient** — read current BRAIN/ memory
2. **Gather** — scan observation logs and recent work
3. **Consolidate** — extract patterns, update topic files
4. **Prune** — remove stale knowledge

This survives context compaction — agents wake up tomorrow knowing what they learned today. 10+ observations reduces dream cooldown from 1h to 30m. After overnight SLUMBER sessions, a **morning standup** posts to `#general` with per-agent summaries and a productivity bar chart.

The cycle: **work → observe → dream → remember → work better.**

## Contracts & Tasks

**Contracts** are bundles of tasks inside a Project. Draft → Active → Review → Completed/Rejected.

```
📋 CEO creates Contract with acceptance criteria
  → 🏗️ Team Lead breaks into tasks
    → ⌨️ Worker executes (Hand dispatches task to DM)
      → 🔍 Warden reviews against criteria
        → ✅ PASS → completed
        → ❌ FAIL → specific feedback, retry
```

**Blueprints** are structured playbooks with cc-cli commands. 4 defaults: `ship-feature`, `onboard-agent`, `run-research`, `sprint-review`. The CEO follows these as step-by-step recipes.

**Tasks** use word-pair IDs (`cool-bay`, `swift-oak`) and have full lifecycle: pending → in_progress → blocked → completed/failed/cancelled. Blocked tasks auto-notify the supervisor.

## Primitives

Claude Corp has named primitives — each does one thing well:

| Primitive | What it does |
|-----------|-------------|
| **Jack** | Persistent session mode. Deterministic keys (`jack:ceo`). Agents remember everything across restarts. |
| **Casket** | Sealed agent workspace. Auto-generates TASKS.md, INBOX.md, WORKLOG.md, STATUS.md per agent. |
| **Dredge** | Session recovery. Extracts summaries from WORKLOG.md to warm-start after compaction. |
| **Hand** | Task dispatch verb. Creating a task ≠ starting work. `Hand` is the action that dispatches. |
| **Clock** | Unified timer primitive. Every setInterval is observable, pauseable, with fire counts and error tracking. |
| **Post** | Unified JSONL write. Mandatory senderId, source tag, 5s dedup. Prevents misattribution. |

## Loops & Crons

User-created recurring work, visible in the `/clock` view:

```bash
# Interval-based loops
cc-cli loop create --interval 5m --command "cc-cli status"
cc-cli loop create --interval 1m --agent ceo --command "Check statuses"

# Schedule-based crons (via croner)
cc-cli cron create --schedule "@daily" --agent herald --command "Write summary"
cc-cli cron create --schedule "0 9 * * 1" --agent ceo --command "Sprint review"
```

Both persist to `clocks.json`, survive daemon restarts, and show animated spinners + progress bars in the TUI clock view.

## System Agents

Five agents bootstrap automatically on corp creation:

| Agent | Rank | What it does |
|-------|------|-------------|
| **CEO** | master | Runs the corp. Delegates everything. Never fired. Falls back to local gateway if remote dies. |
| **Failsafe** | worker | Health monitor. Pings every 5min via `cc-cli status`. Reports anomalies to CEO. |
| **Warden** | worker | Quality gate. Reviews all completed contracts. Checks acceptance criteria against actual code. |
| **Herald** | worker | Narrator. Writes `NARRATION.md` every 5min — injected into Corp Home and STATUS.md. |
| **Planner** | leader | Deep planning on Opus. Two modes: **Sketch** (5min, ~60 lines) and **Ultraplan** (20min, 5-phase audit). |

## Planning

Two-tier planning system adapted from Claude Code's internal planner:

**Sketch** — quick outline. Reads 2-5 files, considers 2 approaches, 80-line cap. Any agent can sketch.

**Ultraplan** — deep audit. 5 phases: Audit Codebase → Design & Compare → Stress-Test → Write Plan → Self-Review. Routed to the Planner agent (Opus). Produces plans with risk matrices, acceptance criteria, and worker assignments.

Plans are saved to `plans/<id>.md` with frontmatter (id, title, type, author, status). The TUI has an approval UI — approve, edit, or dismiss.

## TUI

The terminal UI uses [Yokai](https://github.com/re-marked/yokai) — our own React terminal renderer with pure TypeScript Yoga layout (no WASM), diff-based output, and `ScrollBox` with sticky scroll. Replaced Ink after its `<Static>` component had an unfixable scrollback bug on Windows.

**Views:**
- **Corp Home** — agent grid, Herald narration banner, activity feed, task summary
- **Chat** — Discord-like DMs with inline streaming, tool call details, @mentions
- **Clock** — animated spinning squares, progress bars, fire times, loop/cron management
- **Task Board** — filterable task list with status, priority, assignee
- **Hierarchy** — org chart with tree structure and status icons
- **Command Palette** — Ctrl+K fuzzy finder for views, channels, agents

**Features:**
- Inline streaming — agent responses stream directly in chat with spinners
- Tool call details — shows file paths, commands, result previews inline
- Sleeping banner — animated ASCII night sky with stars, moon, shooting stars during SLUMBER
- Jack mode — auto-jacks into DMs for persistent sessions
- Moon phase status bar — 🌑→🌕 cycling during SLUMBER

## Themes

Pick your corporation's personality during onboarding:

| 🏢 Corporate | 🎩 Mafia | ⚔️ Military |
|---|---|---|
| Founder → CEO → Director → Employee | Godfather → Underboss → Capo → Soldier | Commander → General → Captain → Private |
| #general, #tasks | #the-backroom, #the-job-board | #command-post, #operations |

5 color palettes: Coral, Rose, Lavender, Indigo, Mono.

## Self-Healing

The daemon has 3 recovery clocks that run continuously:

- **Agent Recovery** (30s) — detects crashed agents, respawns with 5-attempt limit
- **CEO Gateway Recovery** (30s) — health pings the CEO, reconnects WebSocket, auto-starts OpenClaw if dead
- **Corp Gateway Recovery** (60s) — picks up after auto-restart exhausts, restores all workers

Plus **Pulse** heartbeat (5min cycle) — pings each agent, detects idle/busy, escalates to CEO after 2 missed heartbeats.

## Analytics

Built-in analytics engine tracks everything:

```bash
cc-cli stats      # Top performer, utilization %, streaks, dispatch counts
cc-cli activity   # 4-section dashboard: PROBLEMS, AGENTS, TASKS, EVENTS
```

Per-agent metrics: dispatches, completions, failures, utilization percentage, streaks. Persisted to `analytics.json` every 60s.

## CLI

37+ commands for full headless control:

```bash
# Communication
cc-cli say --agent ceo --message "What's the status?"
cc-cli send --channel general --from founder --message "hello @CEO"
cc-cli jack --agent ceo                    # Interactive persistent session

# SLUMBER
cc-cli slumber night-owl                   # Activate with profile
cc-cli slumber 3h                          # Activate with duration
cc-cli brief                               # Mid-session check-in
cc-cli wake                                # End + CEO digest
cc-cli slumber stats                       # Productivity analytics
cc-cli slumber profiles                    # List all profiles

# Tasks & Planning
cc-cli task create --title "Research competitors"
cc-cli hand --task cool-bay --to @lead-coder
cc-cli plan create --goal "Design auth module"
cc-cli dream                               # Force agent dream cycle

# Management
cc-cli hire --name researcher --rank worker
cc-cli models default --model gpt-5.4
cc-cli models set --agent planner --model claude-opus-4-6

# Monitoring
cc-cli status                              # Agent statuses
cc-cli hierarchy                           # Org chart
cc-cli stats                               # Corp analytics
cc-cli activity                            # Live feed
cc-cli clock                               # All timers
cc-cli inspect --agent ceo                 # Agent details
```

All commands support `--json` for scripting.

## Architecture

```
User (Founder)
  ↕ TUI (Yokai/React terminal)
  ↕ Daemon (Node.js background process)
    ├── Router (fs.watch → @mention dispatch)
    ├── ProcessManager (agent lifecycle)
    ├── Autoemon (autonomous tick engine)
    ├── Pulse (health heartbeat)
    ├── DreamManager (memory consolidation)
    ├── ClockManager (10+ system clocks)
    ├── LoopManager / CronManager (user-created recurring work)
    ├── InboxManager (priority task queue)
    ├── ContractWatcher (lifecycle events)
    ├── HireWatcher (file-based hiring)
    ├── TaskWatcher (status change events)
    ├── GitManager (auto-commits)
    ├── AnalyticsEngine (per-agent metrics)
    └── Corp Gateway (OpenClaw, per-agent model overrides)
  ↕ Git (every change = commit)
```

**Monorepo structure:**
```
packages/
  shared/       # Types, parsers, primitives (Post, observations, IDs, profiles)
  daemon/       # Router, process manager, autoemon, pulse, dreams, clocks
  tui/          # Yokai app — views, components, hooks
  cli/          # Headless CLI (cc-cli) — 37+ commands
tests/          # vitest (123 tests, <1s)
docs/           # Design spec (Obsidian vault)
```

## Testing

123 tests across 8 files covering the autoemon state machine, SLEEP pattern parsing, tick prompt builders, dispatch resilience, cron scheduling, ID generation, and the Post primitive. CI runs build + type-check + test on every push.

```bash
pnpm build          # Build all packages
pnpm type-check     # TypeScript strict
pnpm test           # vitest (< 1s)
```

## License

MIT

---

<p align="center">
  Built by <a href="https://github.com/re-marked">Mark</a> (14) + <a href="https://claude.ai/code">Claude Code</a>
</p>
