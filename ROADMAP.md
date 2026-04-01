# Claude Corp — Roadmap

> Your Personal Corporation — a self-growing organization of AI agents that work FOR you, running locally.
> Not a chatbot. Not a single agent with tools. A company you own on your machine.

---

## The Vision — Cascading Consensus Protocol

This is how Claude Corp is meant to work. Not someday — this is the north star every feature serves.

### The Flow

A task doesn't get done by one agent guessing alone. It flows through a **social hierarchy** where every level discusses, plans, reviews, and agrees before work begins or results are accepted. The same pattern repeats at every scale — fractal organization.

```
Founder
  └── CEO
       └── Team Leader A ──┐
       └── Team Leader B ──┼── Discussion Channel (async, real-time)
       └── Team Leader C ──┘
            └── Worker 1 ──┐
            └── Worker 2 ──┼── Discussion Channel (async, real-time)
            └── Worker 3 ──┘
```

### Phase 1 — Vision (Founder → CEO)

The Founder gives the CEO an **abstract idea**. Not a spec. Not a task list. Just the vision.

The CEO and Founder **discuss** it. Back and forth in their DM. The CEO asks clarifying questions, proposes angles, pushes back on scope. This is a conversation, not a command.

When the vision is clear, the CEO writes an **ULTRAPLAN** — a deep, multi-phase plan using the Planner agent (Opus 4.6). The ultraplan audits the entire codebase, compares to real-world approaches, designs phases with tasks, identifies risks, and estimates scope.

### Phase 2 — Contract Creation (CEO)

The CEO creates a **Contract** from the ultraplan. The contract is not separate from the plan — **the contract IS the plan**. It contains:

- The goal (from the ultraplan)
- The full plan text
- **Task files** — born inside the contract, unassigned. Each task has acceptance criteria, file paths, dependencies.
- Status: `draft`

The CEO presents the contract to the Founder: "Here's the plan. Here are the tasks. Here's the scope estimate. Here are the risks."

### Phase 3 — Founder Approval

The Founder reviews the contract. They can:
- **Approve** — "Go." The CEO gets the green light.
- **Edit** — "Change this part." Back to discussion.
- **Reject** — "Wrong approach." CEO starts over.

Nothing moves until the Founder says go. This is the only human gate in the entire flow.

### Phase 4 — Team Leader Scoping (CEO → Team Leaders)

The CEO takes the approved contract and splits it across **team leaders**. Each team leader gets:
- The full contract (for context)
- Their **fraction** of the plan — the scope their team owns

If there are multiple team leaders, a **temporary discussion channel** is created (or a thread in #general). The team leaders **discuss** before writing anything:

1. **Read** the full contract and their assigned scope
2. **Discuss** with other team leaders: "I'm taking the auth module. You're taking the API layer. Are there any overlaps?"
3. **Write** their team-level plans — what their team will build, which files they'll touch, what their workers will do
4. **Discuss again** — compare plans, flag conflicts: "Wait, your worker needs to modify `router.ts` too. Let's coordinate."
5. **Agree** — all team leaders confirm: "No conflicts. Scopes are clean."

This happens **async in real-time**. Agents write to the channel, read each other's messages, respond. Not blind parallel planning — **collaborative scoping**.

### Phase 5 — CEO Reviews Team Plans

The CEO reads what the team leaders agreed on. Compares to the original contract. If the team-level plans cover the full scope without gaps or overlaps:

**Green light.** Team leaders can proceed to their workers.

If something's wrong — "You missed the migration step" or "This overlaps with Team B's scope" — back to discussion.

### Phase 6 — Worker Scoping (Team Leaders → Workers)

Each team leader takes their plan fraction and assigns it to their **workers**. Same pattern repeats:

1. Workers are placed in a **temporary discussion channel** (per team)
2. Workers **discuss** what each one will do
3. Workers write **sketches** (mini-plans) — exactly what the sketch primitive is for
4. Workers break sketches into **sub-tasks** with specific file paths, line numbers, acceptance criteria
5. Workers **discuss again** — "I'm editing `auth.ts`, are you touching that file?" / "No, I'm only in `middleware.ts`, we're clean."
6. Workers **agree** — all workers in the team confirm their scopes are conflict-free

The team leader reviews the worker plans against their own team plan and the big contract. If it checks out:

**Green light.** Workers can start executing.

### Phase 7 — Execution (Workers)

Workers do the actual work. Each worker:
- Owns a **git worktree** (isolated copy of the codebase)
- Can spawn **Claude Code sessions** for coding tasks (up to 2 per worker)
- Follows their sketch/sub-task exactly
- Reports progress to their team leader

With 6 workers running 2 Claude Code sessions each, that's **12 parallel coding sessions** working on different parts of the same project in isolated worktrees. That's more throughput than most dev teams.

### Phase 8 — Worker Completion & Discussion

When a worker finishes their tasks, they don't just mark "done" and go idle. They **discuss** with their teammates:

```
Worker 1: "I finished the auth module. Tests passing. What about you guys?"
Worker 2: "Done with the middleware. All green."
Worker 3: "Same here. API routes are complete."
Worker 1: "I think we're ready. Let's pass this up to the team leader."
```

This isn't just status reporting — it's **peer validation**. Workers confirm to each other that the work is complete before escalating.

### Phase 9 — Team Leader Review

The team leader receives the workers' completion signal. They review:
- Each worker's changes against the sub-tasks
- The combined work against their team plan fraction
- The combined work against the big contract

If satisfied, the team leader waits for **all other team leaders** to finish. Then the same discussion pattern:

```
Team Leader A: "My team's done. Auth module complete, all tests passing."
Team Leader B: "API layer done. Integration tests green."
Team Leader C: "Frontend done. E2E tests passing."
Team Leader A: "No conflicts detected. I think we're ready for review."
```

### Phase 10 — Contract Review (Warden)

When all team leaders agree, they **mark the contract as "in review"**. Not complete — in review.

The **Warden agent** takes over:
- Reads the original ultraplan
- Reads the contract and all sub-contracts
- **Audits every file** that was modified (git diff against the contract start point)
- Checks every acceptance criterion against the actual code
- Runs builds and type-checks

### Phase 11 — QA Testing (Tester Agent)

A dedicated **QA/Tester agent** (new role, auto-hired like Warden) runs:
- Full build verification
- Test suites
- Edge case testing
- Integration testing across the worktrees

This also happens at the **team level** — each team's mini-contract gets QA'd before the full contract review. The Tester agent reviews the team's work in their worktree before it gets merged.

### Phase 12 — Merge (Janitor)

Once the Warden and Tester are satisfied, the **Janitor agent** takes over:
- Merges all worker worktrees into a single branch
- Resolves merge conflicts (this is the Janitor's core job)
- Runs a final build on the merged branch
- Verifies no regressions from the merge

The Janitor can test individual worktrees in parallel before merging — build each one independently, then merge sequentially.

### Phase 13 — Completion (CEO → Founder)

The CEO sees that:
- All tasks complete
- Warden approved the review
- Tester passed all checks
- Janitor merged everything cleanly
- Final build is green

The CEO reports to the Founder:

> "The task is complete. It wasn't done by a single agent — it was designed by 3 team leaders who discussed and agreed on scope, implemented by 9 workers who coordinated their changes, reviewed by the Warden, tested by QA, and merged by the Janitor. Here's the branch. Here's the diff. Here's what we built."

This is what makes Claude Corp different from every other AI agent framework. Not one agent guessing. Not a swarm of agents doing random things. A **social hierarchy with a clear chain, rules, discussion, and consensus at every level.**

---

### What Exists vs What's Missing

**Exists (the primitives):**
- Contracts, Tasks, Hand, Plans/Sketches, Hierarchy (CEO → leaders → workers)
- Warden (quality review), Herald (narration), Janitor (placeholder)
- Channels, @mention routing, Jack sessions, Inbox queue
- Worktree code in shared/git.ts (disabled), ClockManager, Analytics

**Missing (the orchestration):**

| # | Missing Piece | What It Does | Blocks |
|---|--------------|--------------|--------|
| 1 | **Contract-Plan Binding** | Contract contains the plan + tasks born inside it | Everything |
| 2 | **Sub-Contracts** | Team-level mini-contracts that roll up to parent | Phase 4-9 |
| 3 | **Discussion Protocol** | Fragment teaching agents to deliberate, flag conflicts, reach consensus | Phase 4, 6, 8, 9 |
| 4 | **Discussion Channels** | Temporary scoped channels for multi-agent deliberation | Phase 4, 6 |
| 5 | **Approval Gates** | Explicit "green light" at every level before work begins | Phase 3, 5, 6 |
| 6 | **QA/Tester Agent** | Dedicated testing role, auto-hired | Phase 11 |
| 7 | **Worktrees v2** | Per-worker git isolation, Janitor merges | Phase 7, 12 |
| 8 | **Cascading Completion** | Workers agree → team leader reviews → contract in review → Warden → Janitor → CEO | Phase 8-13 |
| 9 | **Blueprint Integration** | Blueprints injected when contract references them | Phase 2 |

### Build Order

```
1. Contract v2 (plan binding + sub-contracts)        ──────────────────►
2. Discussion Protocol (fragment + temp channels)      ──────────────────►
3. Approval Gates (explicit green light at each level)   ─────────────────►
4. Blueprint Integration (wire into contract lifecycle)    ──────────────►
5. QA/Tester Agent (auto-hired, runs builds/tests)          ─────────────►
6. Worktrees v2 (per-worker isolation)                        ────────────►
7. Janitor v2 (merge all worktrees, resolve conflicts)          ──────────►
8. Cascading Completion (the full flow wired together)            ────────►
```

Steps 1-4 can be built incrementally. Steps 5-7 can run in parallel. Step 8 is integration — wiring it all together.

---

## Shipped Features (from Claude Code source analysis)

## v0.12.0 — Agent Dreams (autoDream)

**Source:** `services/autoDream/autoDream.ts` (325 lines), `consolidationPrompt.ts`, `consolidationLock.ts`, `config.ts`
**Also:** `tasks/DreamTask/DreamTask.ts` — state tracking with phase/filesTouched/turns

Memory consolidation engine. Agents periodically "dream" — reviewing recent sessions, consolidating learnings into BRAIN/ memory files, pruning stale knowledge.

### Three-Gate Trigger (cheapest first, from source)
```
Gate 1: Time     — hours since lastConsolidatedAt >= 24h (configurable)
Gate 2: Sessions — transcripts with mtime > lastConsolidatedAt >= 5 (configurable)
Gate 3: Lock     — no other dream in progress (file lock with PID, stale after 1h)
```
Additionally: scan throttle of 10 minutes between session scans (prevents repeated gate checks).

### Four-Phase Consolidation (exact prompt from `consolidationPrompt.ts`)
1. **Orient** — `ls` memory directory, read MEMORY.md index, skim existing BRAIN/ topics to avoid duplicates
2. **Gather Signal** — check recent WORKLOG.md sessions, grep transcripts narrowly ("don't exhaustively read"), look for drifted facts that contradict current state
3. **Consolidate** — write/update BRAIN/ topic files, merge new signal into existing, convert relative dates to absolute, delete contradicted facts at source
4. **Prune & Index** — update MEMORY.md, keep under 200 lines / 25KB, each entry one line under 150 chars: `- [Title](file.md) — one-line hook`

### Tool Constraints (from source)
Bash restricted to **read-only**: `ls, find, grep, cat, stat, wc, head, tail`. No writes, no redirects, no state modification. Only FileEdit and FileWrite allowed on memory directory.

### State Tracking (from `DreamTask.ts`)
```typescript
type DreamTaskState = {
  type: 'dream'
  phase: 'starting' | 'updating'  // Flips on first Edit/Write
  sessionsReviewing: number
  filesTouched: string[]           // Observed Edit/Write tool_uses
  turns: DreamTurn[]               // Recent text + tool count (max 30)
  priorMtime: number               // For lock rollback on failure
}
```

### Claude Corp Implementation
- New `DreamManager` class, registers as Clock (`type: 'system'`, every 30m, gate-checked)
- Dispatches via `say()` with consolidation prompt adapted from their `buildConsolidationPrompt()`
- Agent has read-only access to workspace + WORKLOG.md transcripts
- Progress tracked in /clock view as "Dreaming..." phase
- Persists `lastDreamAt` per agent in `agents/<name>/dream-state.json`
- Lock file: `agents/<name>/.dream-lock` with PID + stale detection (1h threshold)

### Files
- `packages/daemon/src/dreams.ts` — DreamManager
- `packages/daemon/src/dream-prompt.ts` — adapted consolidation prompt
- `packages/shared/src/types/agent-config.ts` — add `lastDreamAt`, `dreamCount`
- Fragment: `workspace.ts` — teach agents about dreaming

---

## v0.13.0 — Coordinator Mode (Swarm)

**Source:** `coordinator/coordinatorMode.ts` (370 lines — full system prompt + logic)
**Also:** `tasks/LocalAgentTask/LocalAgentTask.tsx` — worker spawning + task notifications

### Architecture (exact from source)
CEO or leader enters Coordinator Mode when working on a Contract. Four phases:

| Phase | Who | Purpose |
|-------|-----|---------|
| Research | Workers (parallel) | Investigate codebase, find files, understand problem |
| Synthesis | **Coordinator** | Read findings, craft specific implementation specs |
| Implementation | Workers | Make targeted changes per spec, commit |
| Verification | Fresh workers | Test changes with fresh eyes |

### Key Rules (verbatim from Claude Code's prompt)
- **"Parallelism is your superpower"** — launch independent workers concurrently, don't serialize
- **Workers can't see the coordinator's conversation** — every prompt must be self-contained
- **Coordinator SYNTHESIZES** — never lazy-delegate ("based on your findings" is explicitly banned)
- **Read-only tasks** run in parallel freely. **Write-heavy** serialize per file set.
- **Verification workers are FRESH** — spawn new, don't continue implementer (prevents rubber-stamping)

### Continue vs Spawn Decision Matrix (from source)
| Situation | Do | Why |
|-----------|-----|-----|
| Research explored exactly the files to edit | Continue | Context overlap is high |
| Research broad, implementation narrow | Spawn fresh | Avoid exploration noise |
| Correcting a failure | Continue | Worker has error context |
| Verifying another worker's code | Spawn fresh | Fresh eyes, no implementation assumptions |
| Wrong approach entirely | Spawn fresh | Polluted context anchors on failed path |

### Shared Scratchpad (from source: `tengu_scratch` gate)
```
Scratchpad directory: projects/<name>/contracts/<id>/scratchpad/
Workers can read and write here without permission prompts.
Use this for durable cross-worker knowledge — structure files however fits the work.
```

### Worker Communication (from `LocalAgentTask.tsx`)
Workers report via `<task-notification>` XML injected as messages:
```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <status>completed|failed|killed</status>
  <summary>{human-readable outcome}</summary>
  <result>{agent's final response}</result>
  <usage><total_tokens>N</total_tokens><tool_uses>N</tool_uses><duration_ms>N</duration_ms></usage>
</task-notification>
```

### Anti-Patterns (explicitly banned in prompt)
```
BAD:  "Based on your findings, fix the auth bug"
BAD:  "The worker found an issue. Please fix it."
GOOD: "Fix the null pointer in src/auth/validate.ts:42. The user field on Session
       (src/auth/types.ts:15) is undefined when sessions expire but the token remains
       cached. Add a null check before user.id access — if null, return 401."
```

### Claude Corp Implementation
- New fragment: `coordinator.ts` — adapted 370-line system prompt for Claude Corp
- Injected when rank=master/leader AND working on a Contract
- Workers spawned via existing `cc-cli hire --rank worker` (temporary, contract-scoped)
- Shared scratchpad: `projects/<name>/contracts/<id>/scratchpad/`
- Results flow through existing task completion notifications
- CEO synthesizes findings into Hand dispatch specs — never lazy-delegates

---

## v0.14.0 — Haiku Gate (YOLO Classifier)

**Source:** `utils/permissions/yoloClassifier.ts` (1,495 lines), `permissionExplainer.ts`, `dangerousPatterns.ts`, `filesystem.ts`

### Risk Classification (from `permissionExplainer.ts`)
```typescript
type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'
```

### Safe Allowlist (skip classifier entirely, from source)
Read-only tools: FileRead, Grep, Glob, LSP, ToolSearch, ListMCPResources
Task management: TodoWrite, Task tools, Workflow
Plan mode: AskUserQuestion, EnterPlanMode, ExitPlanMode
Swarm: TeamCreate, TeamDelete, SendMessage

### Two-Stage Classifier (from source)
Claude Code uses a two-stage approach:
1. **Fast stage** — XML response with `max_tokens=64` + stop sequences for instant yes/no
2. **Thinking stage** — chain-of-thought with `max_tokens=256` to reduce false positives (only if stage 1 blocks)

Output format: `<block>yes</block><reason>one sentence</reason>` or `<block>no</block>`

### Dangerous Patterns (from `dangerousPatterns.ts`)
Cross-platform code-exec: `python, node, deno, tsx, ruby, perl, php, lua, npx, bunx, bash, sh, ssh`
Cloud mutations: `kubectl, aws, gcloud, gsutil`
HTTP/exfil: `curl, wget, gh api`

### Claude Corp Implementation — Haiku Gate
| Level | Examples | Gate |
|-------|----------|------|
| **LOW** | Read files, cc-cli status, check tasks | Auto-approve |
| **MEDIUM** | Write files, run bash, hire agents, hand tasks | **Haiku call** — <1s decision |
| **HIGH** | Delete files, modify corp.json, create contracts, escalate | Supervisor or founder approval |

- New `ActionGate` class: classifies action risk, dispatches to Haiku for MEDIUM
- Haiku agent responds with APPROVE/DENY + reason in <1 second
- HIGH actions write to founder DM for manual approval, agent blocks
- Protected paths: `corp.json`, `members.json`, `channels.json`, `.gateway/`

---

## v0.15.0 — Deep Plan (ULTRAPLAN)

**Source:** `commands/ultraplan.tsx` (46K tokens), `utils/ultraplan/ccrSession.ts` (350 lines), `utils/ultraplan/keyword.ts` (128 lines)

### How It Works (from source)
1. CEO enters Deep Plan mode with complex planning task
2. Session uses Opus 4.6 model with 30-minute timeout (`ULTRAPLAN_TIMEOUT_MS = 30 * 60 * 1000`)
3. Terminal polls every 3 seconds for results (`POLL_INTERVAL_MS = 3000`)
4. Plan approval flow: running → needs_input → plan_ready → approved/rejected
5. Approved plan scraped from `"## Approved Plan:"` marker
6. Plan written to project, CEO decomposes into Contract + Tasks

### ExitPlanModeScanner (from `ccrSession.ts`)
Stateful event classifier tracking plan lifecycle:
- `exitPlanCalls: string[]` — pending ExitPlanMode tool calls
- `rejectedIds: Set<string>` — plans the user rejected
- `rescanAfterRejection` — re-evaluate after rejection
- Returns: `approved | teleport | rejected | pending | terminated | unchanged`

### Claude Corp Implementation
- `/deepplan` TUI command + `cc-cli deepplan` CLI
- New `DeepPlanManager` in daemon
- Uses `say()` with configurable long timeout (up to 30 min)
- Plan saved as markdown in `projects/<name>/plans/<id>.md`
- TUI shows progress indicator + phase transitions via WebSocket events
- On approval: CEO auto-creates Contract + decomposes into Tasks
- Blueprint: `deep-plan.md` added to defaults

---

## v0.16.0 — Proactive Mode (KAIROS-lite)

**Source:** Feature-gated out of external builds (`feature('PROACTIVE')`, `feature('KAIROS')`)
**Architecture inferred from:** `utils/systemPrompt.ts`, `constants/xml.ts` (TICK_TAG), tool registrations

### What We Know (from codebase references)
- Receives `<tick>` XML prompts for decision-making
- 15-second blocking budget: proactive actions that would block user >15s get deferred
- Maintains append-only daily observation logs
- Brief mode for ultra-concise responses (persistent assistant shouldn't flood terminal)
- Exclusive tools: SendUserFile, PushNotification, SubscribePR

### Claude Corp Implementation
- Extend Pulse: idle heartbeat response triggers proactive action instead of just HEARTBEAT_OK
- New fragment: `proactive.ts` — teach agents to scan for: unassigned tasks, blocked peers, workspace anomalies, stale contracts
- Daily observation log: `agents/<name>/observations/YYYY-MM-DD.md`
- 15-second budget: if `say()` takes >15s on proactive action, defer to next cycle
- Proactive actions: check-and-hand unassigned tasks, unblock peers, update STATUS.md, notify CEO of anomalies

---

## v0.17.0 — Corp Buddy (Mascot)

**Source:** `buddy/companion.ts` (PRNG + rolling), `buddy/types.ts` (species/rarity), `buddy/sprites.ts` (ASCII art), `buddy/prompt.ts` (integration)

### Species & Rarity (from `types.ts`)
18 species: duck, goose, blob, cat, dragon, octopus, owl, penguin, turtle, snail, ghost, axolotl, capybara, cactus, robot, rabbit, mushroom, chonk

```
RARITY_WEIGHTS = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 }
RARITY_STARS  = { common: '★', uncommon: '★★', rare: '★★★', epic: '★★★★', legendary: '★★★★★' }
```

### Deterministic PRNG (from `companion.ts`)
Mulberry32 seeded with FNV-1a hash of `userId + SALT`:
```typescript
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
```

### Procedural Stats (from `companion.ts`)
5 stats: DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK (0-100)
- One peak stat (floor + 50 + random 30)
- One dump stat (floor - 10 + random 15)
- Three scattered (floor + random 40)
- Rarity floors: common=5, uncommon=15, rare=25, epic=35, legendary=50

### Anti-Cheat Design (from source)
- Only `soul` (name + personality) persisted to config
- `bones` (species, rarity, stats, eye, hat, shiny) **regenerated from hash every time**
- Can't fake rarity by editing config — deterministic from userId
- Allows species list updates without breaking existing companions

### ASCII Art (from `sprites.ts`)
3 animation frames per species, 5 lines tall, 12 chars wide
- `{E}` token substituted with eye type
- Hats applied to line 0 if blank and uncommon+
- 6 eye types: `·, ✦, ×, ◉, @, °`
- 8 hat types: none, crown, tophat, propeller, halo, wizard, beanie, tinyduck

### Claude Corp Adaptation
- 12 corp-themed species (architect, sentinel, scribe, forgemaster, etc.)
- Stats adapted: MORALE, EFFICIENCY, CREATIVITY, RESILIENCE, CHAOS
- Seeded on corp name (deterministic per corp, not per user)
- Stats EVOLVE based on corp activity (tasks completed → morale up, crashes → resilience tested)
- ASCII art sprite in Corp Home header
- Reacts to events: contracts closed, agents hired, escalations
- Stored in `corp.json` as `buddy: { species, stats, hatchedAt }`

---

## v0.18.0 — Founder Away (AFK Mode)

**Source:** `afk-mode` beta header in `constants/betas.ts`

### Behavior
1. Founder types `/away` or closes TUI
2. CEO takes full autonomy — creates contracts, hires agents, hands tasks
3. Daemon detects founder inactive >10 min → AFK mode activates
4. CEO gets expanded prompt: "The Founder is away. You have full authority."
5. On return: CEO presents a **digest** of everything that happened
6. Digest: tasks created/completed, agents hired, contracts opened/closed, blockers, decisions
7. Founder can `/rewind` any decision via Time Machine

### Implementation
- `packages/daemon/src/afk.ts` — AFKManager, tracks founder last interaction
- Away digest: `away-digest.md` at corp root (overwritten each AFK cycle)
- TUI shows digest on reconnect before entering normal mode
- CEO fragment extension when AFK: full delegation authority, must log all decisions

---

## v0.19.0 — Corp Boundaries (Undercover Mode)

**Source:** `utils/undercover.ts` (90 lines)

### How Claude Code Does It (from source)
```typescript
export function isUndercover(): boolean {
  if (process.env.USER_TYPE === 'ant') {
    if (isEnvTruthy(process.env.CLAUDE_CODE_UNDERCOVER)) return true
    return getRepoClassCached() !== 'internal'  // Auto-ON for public repos
  }
  return false
}
```

Forbidden in commits: model codenames, unreleased versions, internal repo names, Slack channels, short links, AI attribution, Co-Authored-By lines.

### Claude Corp Adaptation
- When agents work on public repos (project.type === 'codebase' + external URL)
- Strip: agent names, task IDs, corp strategies, internal channel names
- Allow: technical code, public documentation
- Janitor agent enforces on merge (scan diff for internal references)
- Configurable allowlist/blocklist per project in `project.json`

---

## v0.20.0 — Token Budgets

**Source:** `task-budgets` beta header, `cost-tracker.ts`

### Implementation
- Each agent has a daily token budget (configurable in corp.json)
- Each contract has a total budget
- 80% consumed → warning to CEO
- 100% consumed → agent pauses, CEO notified, founder can top up
- Analytics: cost per agent, per task, per contract
- `packages/daemon/src/budget-tracker.ts` — hooks into every say() dispatch

---

## Ship Priority

### Vision Features (the cascading consensus protocol)

| # | Feature | What It Unlocks | Effort |
|---|---------|----------------|--------|
| 1 | **Contract v2** | Plans + tasks born inside contracts, sub-contracts per team | High |
| 2 | **Discussion Protocol** | Agents deliberate, flag conflicts, reach consensus | High |
| 3 | **Approval Gates** | Explicit green light at every hierarchy level | Medium |
| 4 | **Blueprint Integration** | Blueprints auto-injected when contracts reference them | Low |
| 5 | **QA/Tester Agent** | Dedicated testing role at team + contract level | Medium |
| 6 | **Worktrees v2** | Per-worker git isolation, parallel coding | High |
| 7 | **Janitor v2** | Merge all worktrees, resolve conflicts, final build | High |
| 8 | **Cascading Completion** | Full flow wired: workers → leaders → Warden → Janitor → CEO | High |

### Standalone Features (enhance the corp regardless of vision)

| # | Version | Feature | Status | Effort |
|---|---------|---------|--------|--------|
| 1 | v0.12.0 | **Agent Dreams** | SHIPPED | — |
| 2 | v0.13.0 | **Coordinator Mode** | SHIPPED | — |
| 3 | v0.14.0 | **Plan Primitive** | SHIPPED (was Haiku Gate, pivoted to ultraplan) | — |
| 4 | v0.14.3 | **Planner Agent** | SHIPPED (Opus routing) | — |
| 5 | v0.16.0 | **Proactive Mode** | Next — agents act without prompting | Medium |
| 6 | v0.17.0 | **Corp Buddy** | Most viral — alive feeling, shareable | Low |
| 7 | v0.18.0 | **Founder Away** | Autonomous overnight operation | Medium |
| 8 | v0.19.0 | **Corp Boundaries** | Niche but important for public work | Low |
| 9 | v0.20.0 | **Token Budgets** | Cost control for production use | Medium |

---

## Reference

- Claude Code source analysis: `autoDream.ts`, `consolidationPrompt.ts`, `coordinatorMode.ts`, `ultraplan.tsx`, `companion.ts`, `yoloClassifier.ts`, `undercover.ts`
- GitHub mirror: https://github.com/Kuberwastaken/claude-code
- Claude Corp: https://github.com/re-marked/claude-corp
