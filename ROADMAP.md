# Claude Corp — Roadmap

> Built independently. Validated by the Claude Code source leak (March 31, 2026).
> Every feature below traced to actual TypeScript from the leaked 512K-line codebase.
> Source: [Kuberwastaken/claude-code](https://github.com/Kuberwastaken/claude-code) (1,905 files)

---

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

| # | Version | Feature | Why First | Effort |
|---|---------|---------|-----------|--------|
| 1 | v0.12.0 | **Agent Dreams** | Self-contained, we have BRAIN/MEMORY, direct translation from source | Medium |
| 2 | v0.13.0 | **Coordinator Mode** | Highest impact — structured multi-agent is the killer feature | High |
| 3 | v0.14.0 | **Haiku Gate** | Safety + governance, builds trust | Medium |
| 4 | v0.17.0 | **Corp Buddy** | Most viral — alive feeling, shareable | Low |
| 5 | v0.15.0 | **Deep Plan** | Complex planning capability | Medium |
| 6 | v0.16.0 | **Proactive Mode** | Agents work without prompting | Medium |
| 7 | v0.18.0 | **Founder Away** | Autonomous overnight operation | Medium |
| 8 | v0.19.0 | **Corp Boundaries** | Niche but important for public work | Low |
| 9 | v0.20.0 | **Token Budgets** | Cost control for production use | Medium |

---

## Reference

- Key source files analyzed: `autoDream.ts`, `consolidationPrompt.ts`, `consolidationLock.ts`, `coordinatorMode.ts`, `ultraplan.tsx`, `ccrSession.ts`, `companion.ts`, `types.ts`, `sprites.ts`, `yoloClassifier.ts`, `dangerousPatterns.ts`, `filesystem.ts`, `undercover.ts`
- GitHub mirror: https://github.com/Kuberwastaken/claude-code
- Claude Corp: https://github.com/re-marked/claude-corp
