# Claude Corp — Roadmap

> Built independently. Validated by the Claude Code source leak (March 31, 2026).
> Every feature below is mapped to real TypeScript from both codebases.

---

## v0.12.0 — Agent Dreams (autoDream)

**Source:** `claude-code-leaked/services/autoDream/` — 4 files, ~325 lines
**Claude Corp equivalent:** New `packages/daemon/src/dreams.ts`

Memory consolidation engine. Agents periodically "dream" — reviewing their recent sessions, consolidating learnings into durable memory files, and pruning stale knowledge.

### Three-Gate Trigger
1. **Time gate:** 24 hours since last consolidation (configurable)
2. **Session gate:** 5+ sessions with activity since last consolidation
3. **Lock gate:** No other dream is in progress (prevents pile-up)

### Four-Phase Consolidation
1. **Orient** — read MEMORY.md index, skim existing BRAIN/ topics
2. **Gather Signal** — scan recent WORKLOG.md sessions, grep transcripts for key events
3. **Consolidate** — write/update BRAIN/ topic files, merge new signal into existing topics, convert relative dates to absolute, delete contradicted facts
4. **Prune & Index** — update MEMORY.md, keep it under 200 lines, remove stale pointers

### Implementation
- New `DreamManager` class in daemon
- Registers as a Clock (`type: 'system'`, fires every 30 min but gate-checked)
- Dispatches via `say()` to the agent with the consolidation prompt
- Agent has read-only access to its own workspace + transcripts
- Progress tracked as a background task in /clock view
- Persists `lastDreamAt` per agent in `agents/<name>/dream-state.json`

### Files
- `packages/daemon/src/dreams.ts` — DreamManager
- `packages/daemon/src/dream-prompt.ts` — consolidation prompt (adapted from Claude Code's `consolidationPrompt.ts`)
- `packages/shared/src/types/agent-config.ts` — add `lastDreamAt`, `dreamCount`
- Fragment update: `workspace.ts` — teach agents about dreaming

---

## v0.13.0 — Coordinator Mode (Swarm)

**Source:** `claude-code-leaked/coordinator/coordinatorMode.ts` — full system prompt (370 lines)
**Claude Corp equivalent:** CEO becomes a coordinator when working on Contracts

### Architecture
The CEO (or any leader agent) can enter **Coordinator Mode** when working on a Contract:
1. **Research phase** — spawn parallel workers to investigate the codebase
2. **Synthesis phase** — coordinator reads findings, writes specific implementation specs
3. **Implementation phase** — workers make targeted changes per spec
4. **Verification phase** — separate workers verify (fresh eyes, not the implementer)

### Key Design Principles (from Claude Code)
- "Parallelism is your superpower" — launch independent workers concurrently
- Workers can't see the coordinator's conversation — every prompt must be self-contained
- Coordinator SYNTHESIZES findings, never lazy-delegates ("based on your findings" is banned)
- Continue workers for related follow-up, spawn fresh for unrelated work
- Read-only tasks run in parallel, write-heavy tasks serialize per file set

### Implementation
- New fragment: `coordinator.ts` — injected when agent has rank 'master' or 'leader' AND is working on a Contract
- **Shared scratchpad** — `projects/<name>/contracts/<id>/scratchpad/` — workers read/write without permission prompts
- Coordinator prompt adapted from Claude Code's 370-line system prompt
- Workers spawned via existing `cc-cli hire --rank worker` (temporary, scoped to contract)
- Results arrive via task completion notifications (we already have `dispatchCompletionToCeo`)

### Files
- `packages/daemon/src/fragments/coordinator.ts` — coordinator mode system prompt
- `packages/shared/src/contracts.ts` — add `scratchpadPath` to contracts
- Fragment update: `delegation.ts` — teach about coordinator mode phases

---

## v0.14.0 — Haiku Gate (YOLO Classifier)

**Source:** `claude-code-leaked/tools/permissions/` — risk classification + ML auto-approval
**Claude Corp equivalent:** Haiku-based action classifier for agent risk management

### Risk Classification
| Level | Examples | Gate |
|-------|----------|------|
| **LOW** | Read files, run cc-cli status, check tasks | Auto-approve |
| **MEDIUM** | Write files, run bash, hire agents, hand tasks | **Haiku Gate** — <1s decision |
| **HIGH** | Delete files, modify corp config, create contracts, spend tokens | Supervisor or founder approval |

### Implementation
- New `ActionGate` class in daemon
- Before any agent tool execution, classify the action's risk level
- MEDIUM actions → dispatch to a Haiku agent with action description + context
- Haiku responds APPROVE or DENY with reason
- <1 second round-trip (Haiku is fast + cheap)
- HIGH actions → write to founder's DM for approval, agent blocks until approved

### Files
- `packages/daemon/src/action-gate.ts` — ActionGate with risk classification
- `packages/daemon/src/haiku-classifier.ts` — Haiku dispatch for MEDIUM actions
- `packages/shared/src/types/action.ts` — ActionRisk type
- Fragment update: all fragments mention action risk levels

---

## v0.15.0 — ULTRAPLAN (Deep Plan)

**Source:** `claude-code-leaked/commands/ultraplan.tsx` — 46K tokens
**Claude Corp equivalent:** Long-running planning sessions for complex projects

### How It Works
1. Founder says: "Plan the authentication system for our app"
2. CEO enters Deep Plan mode — creates a CCR-like planning session
3. CEO uses Opus to think for up to 30 minutes (our version: configurable timeout)
4. Results polled every 3 seconds (we use existing Clock + WebSocket events)
5. Plan written to `projects/<name>/plans/<id>.md`
6. Founder reviews in TUI, approves → CEO decomposes into Contract + Tasks

### Implementation
- New `/deepplan` TUI command
- New `DeepPlanManager` in daemon
- Uses existing `say()` with a long timeout (up to 30 min)
- Plan saved as markdown with YAML frontmatter (like contracts)
- TUI shows progress indicator while planning
- Blueprint for "deep-plan" workflow added to defaults

### Files
- `packages/daemon/src/deep-plan.ts` — DeepPlanManager
- `packages/cli/src/commands/deepplan.ts` — CLI interface
- `packages/tui/src/views/chat.tsx` — /deepplan command
- `packages/shared/src/blueprints/deep-plan.md` — blueprint

---

## v0.16.0 — Proactive Mode (KAIROS-lite)

**Source:** `claude-code-leaked/assistant/` — KAIROS always-on assistant
**Claude Corp equivalent:** Agents proactively act when idle, with a blocking budget

### Behavior
- Idle agents don't just wait — they **scan for work and act**
- 15-second blocking budget: any proactive action that would block for >15s gets deferred
- Agents maintain append-only daily observation logs
- Proactive actions: check for unassigned tasks, clean up workspace, update status, help blocked peers

### Implementation
- Extend Pulse heartbeat: when an idle agent responds to heartbeat with "found pending work," the agent acts on it instead of just reporting HEARTBEAT_OK
- New fragment: `proactive.ts` — teach agents to look for work during idle heartbeats
- Daily observation log: `agents/<name>/observations/YYYY-MM-DD.md`
- 15-second budget enforced by the daemon: if say() takes >15s on a proactive action, don't block other operations

### Files
- `packages/daemon/src/proactive.ts` — ProactiveManager
- `packages/daemon/src/fragments/proactive.ts` — proactive behavior fragment
- Agent workspace: `observations/` directory

---

## v0.17.0 — Corp Buddy (Mascot)

**Source:** `claude-code-leaked/buddy/` — Tamagotchi system
**Claude Corp equivalent:** Per-corp mascot that reacts to corp activity

### Design
- Deterministic per corp using Mulberry32 PRNG seeded on corp name
- 12 species across 4 rarity tiers (Common, Uncommon, Rare, Legendary)
- Procedural stats: MORALE, EFFICIENCY, CREATIVITY, RESILIENCE, CHAOS (0-100)
- ASCII art sprite shown in Corp Home header
- Reacts to events: tasks completed → morale up, agents crash → resilience tested, contracts closed → efficiency up
- Stats evolve based on corp activity, not randomly

### Implementation
- `packages/shared/src/buddy.ts` — species definitions, PRNG, stat generation
- `packages/tui/src/components/buddy-sprite.tsx` — ASCII art renderer
- `packages/tui/src/views/corp-home.tsx` — buddy in header
- `packages/daemon/src/buddy-engine.ts` — event reactions, stat evolution
- Stored in `corp.json` as `buddy: { species, stats, hatched }`

---

## v0.18.0 — Founder Away (AFK Mode)

**Source:** Claude Code's `afk-mode` beta header
**Claude Corp equivalent:** Full CEO autonomy while founder sleeps/works

### Behavior
1. Founder types `/away` or just closes the TUI
2. CEO takes full autonomy — creates contracts, hires agents, hands tasks
3. When founder returns: CEO presents a **digest** of everything that happened
4. Digest includes: tasks created/completed, agents hired, contracts opened/closed, blockers hit, decisions made
5. Founder can `/rewind` any decision they disagree with (Time Machine)

### Implementation
- `packages/daemon/src/afk.ts` — AFKManager
- Tracks founder's last interaction timestamp
- After 10 min of no interaction → AFK mode activates
- CEO gets an expanded system prompt with full autonomy
- Digest written to `away-digest.md` at corp root
- TUI shows digest on reconnect

---

## v0.19.0 — Corp Boundaries (Undercover Mode)

**Source:** `claude-code-leaked/utils/undercover.ts`
**Claude Corp equivalent:** Prevent agents from leaking internal corp info to public repos

### Behavior
- When agents work on public codebases, strip internal corp info from commits
- Block: agent names, internal task IDs, corp strategies, internal channel messages
- Allow: technical code, public-facing documentation

### Implementation
- `packages/daemon/src/boundaries.ts` — BoundaryFilter
- Hooks into git commits: scans commit messages and diffs for internal references
- Configurable allowlist/blocklist per project
- Janitor agent enforces boundaries on merge

---

## v0.20.0 — Token Budgets

**Source:** Claude Code's `task-budgets` beta header
**Claude Corp equivalent:** Per-agent and per-contract token/cost limits

### Behavior
- Each agent has a daily token budget
- Each contract has a total budget
- When budget is 80% consumed → warning to CEO
- When budget is exhausted → agent pauses, CEO notified, founder can top up
- Analytics track cost per agent, per task, per contract

### Implementation
- `packages/shared/src/types/budget.ts` — Budget type
- `packages/daemon/src/budget-tracker.ts` — BudgetTracker
- Hooks into every say() dispatch: counts tokens from OpenClaw response
- Daily reset for agent budgets, contract budgets persist

---

## Ship Priority

| # | Version | Feature | Impact | Effort |
|---|---------|---------|--------|--------|
| 1 | v0.12.0 | Agent Dreams | High — agents learn and improve | Medium |
| 2 | v0.13.0 | Coordinator Mode | Very High — structured multi-agent work | High |
| 3 | v0.14.0 | Haiku Gate | High — safety + governance | Medium |
| 4 | v0.15.0 | ULTRAPLAN/Deep Plan | High — complex planning | Medium |
| 5 | v0.16.0 | Proactive Mode | Medium — agents work without prompting | Medium |
| 6 | v0.17.0 | Corp Buddy | Medium — viral appeal + alive feeling | Low |
| 7 | v0.18.0 | Founder Away | High — autonomous overnight operation | Medium |
| 8 | v0.19.0 | Corp Boundaries | Low — niche use case | Low |
| 9 | v0.20.0 | Token Budgets | Medium — cost control | Medium |

---

## Reference

- Claude Code leaked source: `C:/Users/psyhik1769/claude-code-leaked/`
- GitHub mirror: https://github.com/Kuberwastaken/claude-code
- Claude Corp: https://github.com/re-marked/claude-corp
