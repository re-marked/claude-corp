# Claude Corp Glossary

Every concept, primitive, and named thing in Claude Corp — explained in plain English.

---

## The Big Idea

Claude Corp is a simulated corporation that runs on your machine. You (the **Founder**) own it. An AI **CEO** runs it. Agents are employees. Everything they do is tracked in plain files and git commits — no database, no cloud.

---

## Core Primitives

These are the building blocks. Each has a distinctive name because Claude Corp treats work like physical objects and actions.

### Casket

**What it means:** An agent's sealed workspace — everything they need in one place.

**Plain English:** When an agent is hired, the daemon auto-generates a personal folder with `TASKS.md`, `INBOX.md`, `WORKLOG.md`, and `STATUS.md`. This is the agent's world. They check their Casket to know what to do, what's queued, and what they've done. Think of it as their desk with an in-tray.

### Dredge

**What it means:** Recover memory from a previous session.

**Plain English:** When an agent wakes up (new API call), it has no memory of past conversations. Dredge fixes that — it reads the agent's `WORKLOG.md`, extracts the last Session Summary, and injects it into the prompt. The agent "dredges up" what it was doing before. Like reading your own notes from yesterday.

### Hand

**What it means:** The act of giving a task to an agent.

**Plain English:** Creating a task and assigning it are separate steps. You create a task (planning), then you **hand** it to someone (action). `cc-cli hand --task cool-bay --to @lead-coder` delivers the task to the agent's DM. The distinction matters: the CEO can plan 10 tasks, then hand them out strategically.

### Jack

**What it means:** A persistent, live conversation session between two parties.

**Plain English:** Every DM in Claude Corp uses Jack mode by default. Instead of one-off messages, Jack creates a deterministic session key (like `jack:ceo:lead-coder`) so the agent remembers the full conversation history. When you "jack into" an agent's DM, you're entering a persistent channel where context carries over. Named after jacking into a system.

### Clock

**What it means:** A unified timer primitive — every recurring operation in the system.

**Plain English:** Instead of raw `setInterval` calls scattered everywhere, every timer is a Clock registered in the ClockManager. Heartbeats, crons, loops, recovery checks — all Clocks. Each one tracks fire count, errors, and status. You can see them all spinning in the `/clock` TUI view with animated progress bars.

**Types:** heartbeat, timer, loop, cron, system.

### Contract

**What it means:** A bundle of tasks with a goal, a lead, and a deadline.

**Plain English:** A Contract is how work gets organized. The CEO creates a Contract inside a Project, assigns a lead, and the lead decomposes it into tasks. When all tasks are done, the Contract moves to "review" and the Warden checks quality. Think of it as a work order or a sprint.

**Lifecycle:** draft &rarr; active &rarr; review &rarr; completed (or rejected).

### Blueprint

**What it means:** A reusable playbook for common workflows.

**Plain English:** Blueprints are step-by-step guides written in markdown with embedded `cc-cli` commands. The CEO reads them like recipes. Four ship by default: `ship-feature`, `onboard-agent`, `run-research`, `sprint-review`. They're documentation, not code — agents follow them as instructions.

### Plan / Sketch / Ultraplan

**What it means:** The planning system with two tiers of depth.

**Plain English:**
- **Sketch** — A quick plan (~5 min, ~60 lines). Reads a few files, considers 2 approaches, gives an actionable answer. Uses Haiku (fast, cheap).
- **Ultraplan** — A deep architectural plan (~20 min, 5 phases). Audits the codebase, designs alternatives, stress-tests the approach, writes the plan, then self-reviews. Uses Opus (slow, thorough).

Plans are saved to `plans/<id>.md`. The Planner agent handles deep plans; any agent can sketch.

### Project

**What it means:** A scoped workspace for a body of work.

**Plain English:** Projects are containers. Each Project gets its own directory with scoped agent workspaces, channels, teams, contracts, and tasks. Agents working on a Project get a workspace inside it (`projects/<name>/agents/<agent>/`). Think of it as a department or initiative.

### Loop

**What it means:** A repeating command on a fixed interval.

**Plain English:** `cc-cli loop create --every 5m --command "check build status" --agent @ceo` runs that command every 5 minutes. Loops persist across daemon restarts (saved to `clocks.json`). They link to tasks: when a loop finishes, its task completes too. Visible in the `/clock` view.

### Cron

**What it means:** A scheduled job on a calendar pattern.

**Plain English:** Like Unix cron but for agents. `@daily`, `@hourly`, or `0 9 * * 1` (every Monday at 9am). Each fire can spawn a fresh dated task and hand it to an agent. Built on the croner library for correctness. Hardened with jitter (prevents all crons firing simultaneously), auto-expiry, and missed-fire detection on restart.

### Dream

**What it means:** Memory consolidation while an agent is idle.

**Plain English:** When an agent has been idle for 5+ minutes with nothing in its inbox, it "dreams" — a 4-phase process:
1. **Orient** — Read SOUL.md, recent observations, current BRAIN
2. **Gather** — Scan WORKLOG.md and recent activity
3. **Consolidate** — Extract patterns, update BRAIN topic files
4. **Prune** — Remove stale or redundant knowledge

Like sleeping on a problem. The agent wakes up with better-organized knowledge. Force one with `cc-cli dream`.

### Observation

**What it means:** An agent's daily journal entry.

**Plain English:** Agents self-record learnings and events to daily append-only files (`agents/<name>/observations/YYYY/MM/DD.md`). The Dream system reads these during consolidation. Think of it as an agent writing in their notebook throughout the day.

---

## Autonomous Behavior

### Pulse

**What it means:** The heartbeat system — are agents alive?

**Plain English:** Every 5 minutes, Pulse pings each agent. It has two modes per agent:
- **Idle** — "Check your Casket, anything to do?" (checks workspace)
- **Busy** — "Still alive?" (lightweight `HEARTBEAT_OK` ping)

If an agent misses 2 heartbeats, Pulse escalates to the CEO with a specific reason. When the agent recovers, CEO gets notified. Agents enrolled in Autoemon are skipped (Autoemon handles them instead).

### Autoemon

**What it means:** The autonomous tick engine — agents working on their own.

**Plain English:** Autoemon replaces Pulse for enrolled agents. Instead of "are you alive?", it sends `<tick>14:30:00</tick>` — "here's the time, decide what to do." Agents check their tasks, inbox, and channels, then either work or sleep.

**Adaptive intervals:** If an agent did real work, next tick comes in 30 seconds. If it checked and found nothing, 2 minutes. If it's been idle for 3+ ticks, 5 minutes. Agents can also call `SLEEP 5m — no pending work` to control their own pace.

**The name:** "Autoemon" = autonomous + daemon. The engine that makes agents self-directed.

### Slumber

**What it means:** The founder goes AFK and agents run the corp autonomously.

**Plain English:** Type `/slumber` (or `/afk`) and the CEO takes over. Agents receive ticks via Autoemon, make decisions, execute tasks, and collaborate — all while you sleep, go to school, or step away.

- `/slumber 8h` — run for 8 hours then stop
- `/slumber night-owl` — use a preset profile
- `/brief` — check in mid-session without ending it
- `/wake` — end session, CEO summarizes what happened

**Profiles:** Each profile sets a mood, focus directive, and conscription strategy:
- **Night Owl** — long autonomous sessions, conservative
- **School Day** — focused on specific contracts, moderate pace
- **Sprint** — aggressive, all agents, budget-capped at 200 ticks
- **Guard Duty** — monitoring only, minimal action

The TUI shows a moon phase progress bar and a sleeping ASCII banner with stars and clouds.

### Conscription

**What it means:** Which agents get enrolled when Autoemon activates.

**Plain English:** When Slumber starts, not all agents need to be active. Conscription decides:
1. CEO always enrolls (entry point)
2. Find leaders on active Contracts
3. Enroll their workers with active tasks

When a Contract completes, its workers are "discharged" back to normal Pulse heartbeat. The conscription strategy depends on the Slumber profile (ceo-only, active-contracts, or all-agents).

---

## System Agents

Five agents are auto-hired when a corporation is created. They're always there.

### CEO

**What it means:** The AI executive who runs the corporation.

**Plain English:** Rank: master. The CEO delegates work, creates Contracts, follows Blueprints, hires agents, and makes decisions. When you message the corp, the CEO usually responds. During Slumber, the CEO drives all autonomous activity. Falls back to local gateway if the remote one is down. Never fired.

### Failsafe

**What it means:** The watchdog.

**Plain English:** Checks agent health every 5 minutes via `say()`. If something's wrong, reports to CEO. Detects crashed agents and triggers respawns (up to 5 attempts). The safety net.

### Janitor

**What it means:** The git specialist.

**Plain English:** Handles merge conflicts when multiple agents write to the same files. Merges worktrees back to the main branch. Prefers the agent's changes for new code. Currently a placeholder — fully active when Project Worktrees ship.

### Warden

**What it means:** The quality gate.

**Plain English:** When a Contract moves to "review", the Warden inspects every task. Checks acceptance criteria, reviews output quality, and either approves or rejects with specific feedback. Nothing closes without Warden sign-off. The corporate auditor.

### Herald

**What it means:** The narrator.

**Plain English:** Every 5 minutes, the Herald writes a 1-2 sentence natural language summary of what's happening in `NARRATION.md`. This gets injected into the Corp Home banner and STATUS.md. Runs on Haiku (fast, cheap). Gives the corp a living, breathing feel — like a town crier.

### Planner

**What it means:** The deep thinker.

**Plain English:** Rank: leader. Model: Opus 4.6 (the most capable). When someone requests an Ultraplan, the Planner handles it — spending up to 20 minutes reading code, comparing approaches, and writing a thorough plan. Sketches can be handled by any agent; deep plans always go to the Planner.

---

## Agent Substrate (v2.0.0)

### Harness

**What it means:** The runtime that actually executes an agent's turns.

**Plain English:** Every agent in v2.0.0+ runs on a harness — a plug that knows how to turn a prompt into a response for one specific substrate. `openclaw` dispatches through the shared OpenClaw gateway (provider-agnostic, token auth). `claude-code` spawns the `claude` CLI as a subprocess (OAuth subscription). You pick per-agent at hire time: `cc-cli hire --harness claude-code`. Switch later with `cc-cli agent set-harness`.

### AgentHarness

**What it means:** The contract every harness implements.

**Plain English:** A small interface with `dispatch`, `healthCheck`, `teardown`, `cost`. Agent-level code calls these methods and doesn't care which substrate is underneath — that's how you get substrate-agnostic behavior. If you want Claude Corp to run on a new model runner (say, a local Ollama gateway or a future Anthropic API wrapper), implement `AgentHarness` and register it. The rest of the daemon stays the same.

### HarnessRouter

**What it means:** The dispatcher that picks the right harness per agent.

**Plain English:** One agent uses openclaw, another uses claude-code. The router reads each agent's stored harness (from `config.json` + Member record), delegates to the matching implementation, and falls back to the corp default if none is set. Health checks surface per-harness diagnostics via `/harnesses` and `cc-cli harness list`.

### Reconciliation

**What it means:** Converging an agent's workspace to match its harness.

**Plain English:** When `cc-cli agent set-harness` switches an agent to claude-code, it's not just a record change — it actively writes CLAUDE.md, migrates legacy filenames to the v2.0 names (`RULES.md` → `AGENTS.md`, `ENVIRONMENT.md` → `TOOLS.md`), and resolves conflicts by keeping the newer file + backing up the older with a timestamped `.backup` suffix. Switching back to openclaw moves CLAUDE.md aside. The files on disk always match the substrate that reads them.

---

## Communication

### Inbox

**What it means:** Each agent's priority task queue.

**Plain English:** One task at a time, sorted by priority (critical > high > normal > low). When the current task completes, the next one pops. Persists across daemon restarts in `inbox-state.json`. Blocked tasks are held until their dependencies clear.

### Say / Send

**What it means:** Two ways to message agents.

- **Say** (`cc-cli say`) — Direct message to an agent. Uses Jack session (persistent memory). Instant.
- **Send** (`cc-cli send`) — Message in a channel. Goes through the router.

### @mention Dispatch

**What it means:** How messages reach agents.

**Plain English:** Type `@ceo` in a channel message and the daemon's router picks it up, resolves the mention via `members.json`, and dispatches to the CEO. Human mentions bypass the inbox (instant response). Agent-to-agent mentions queue through the inbox.

---

## Monitoring & Analytics

### Analytics Engine

**What it means:** Per-agent performance tracking.

**Plain English:** Tracks tasks created/completed/failed, dispatches, messages, utilization percentage, and streaks. Persists to `analytics.json`. View with `cc-cli stats` — shows top performer, utilization %, and per-agent breakdowns.

### Corp Vitals (STATUS.md)

**What it means:** A live dashboard in markdown.

**Plain English:** Auto-generated file showing: who's online, what each agent is working on, metrics, recent completions, Herald narration, and any clock errors. The pulse of the corporation.

### Dispatch Resilience

**What it means:** Smart error handling for agent communication.

**Plain English:** When dispatching to an agent fails, the system categorizes the error (overloaded, context blocked, crashed, timeout) and applies the right strategy — exponential backoff, context blocking, or health score degradation. Prevents cascading failures.

---

## Prompt Fragments

Fragments are chunks of system prompt injected into agents based on context. They teach agents how to behave. Key ones:

| Fragment | Teaches |
|----------|---------|
| **workspace** | How to read their Casket |
| **coordinator** | Leadership workflow (Research &rarr; Synthesis &rarr; Implementation &rarr; Verification) |
| **autoemon** | How to behave during autonomous ticks |
| **dredge** | How to recover session context |
| **delegation** | How to Hand tasks to others |
| **inbox** | How to process the priority queue |
| **anti-rationalization** | Never pretend you did something you didn't |
| **blocker-escalation** | When and how to escalate problems |
| **cc-cli** | What CLI commands are available |

---

## Modes & States

### Agent Ranks (Hierarchy)

```
Founder (you — absolute power)
  CEO (master — never fired)
    Leaders (team leads, project managers)
      Workers (individual contributors)
        Sub-agents (ephemeral, temporary helpers)
```

### Task Lifecycle

```
pending &rarr; assigned &rarr; in_progress &rarr; completed
                                          &rarr; blocked (waiting on dependency)
                                          &rarr; failed
                                          &rarr; cancelled
```

### Contract Lifecycle

```
draft &rarr; active &rarr; review &rarr; completed
                                  &rarr; rejected (Warden says no)
```

### Agent Work Status

| Status | Meaning |
|--------|---------|
| offline | Not running |
| starting | Process launching |
| idle | Running, nothing to do |
| busy | Currently processing a task |
| broken | Crashed or unresponsive |

### Founder Presence (during Slumber)

| Status | Agent behavior |
|--------|---------------|
| watching | Be collaborative, ask before big changes |
| idle | Be autonomous but cautious |
| away | Full autonomy, checkpoint only on milestones |

---

## Infrastructure

### Daemon

The background process that keeps everything running. Starts automatically with the TUI. Contains: message router (fs.watch on JSONL files), process manager (spawns agents), git manager, ClockManager, Pulse, Autoemon, and all watchers. Keeps running when the TUI closes.

### TUI

The terminal UI built with Ink (React for terminals). Shows the Corp Home, chat views, clock view, wizards, and the Ctrl+K palette. Watches files directly for live updates. Connects to the daemon only for process management.

### Corp Gateway

A local AI gateway shared by ALL agents. Default model: Haiku. Per-agent model overrides handle Opus (the Planner gets `anthropic/claude-opus-4-6` in its agents.list entry). Handles rate limiting, concurrent request caps, and auto-restart on repeated failures.

### cc-cli

The command-line interface. 37+ commands for everything: messaging (`say`, `send`), tasks (`hand`, `task create`), contracts, blueprints, monitoring (`stats`, `activity`), planning (`plan create`), and management (`hire`, `slumber`, `wake`).

---

## Data — Everything is Files

Three formats, all git-tracked:

| Format | Used for | Example |
|--------|----------|---------|
| Markdown + YAML frontmatter | Agent-readable files, tasks, plans | `SOUL.md`, `tasks/cool-bay.md` |
| JSON | Configs, registries | `corp.json`, `members.json`, `clocks.json` |
| JSONL | Message logs (append-only) | `channels/general/messages.jsonl` |

No database. No cloud. Everything on disk, everything in git. `git log` is the audit trail. `git revert` is the undo button.

---

## Post

**What it means:** The unified message persistence primitive.

**Plain English:** Every message written to a channel JSONL file goes through `post()`. It enforces mandatory sender attribution (no guessing), deduplicates within 5 seconds (prevents double-write bugs), and auto-generates IDs and timestamps. Before Post, 23 different call sites manually constructed messages — each could misattribute or duplicate. Post makes bad attribution structurally impossible.
