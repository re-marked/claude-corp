# Claude Corp — The Big Refactor (2026-04-21)

*Captured during a long conversation with Mark, before Claude's context compaction. The thinking is fresh; this document preserves it for future-Claude to pick up.*

---

## Context: What We Learned Today

Today Mark and Claude diagnosed what's actually wrong with Claude Corp, not just the symptoms we kept firefighting.

The surface problems: agents silent-exit, sessions overflow, CEO loses its place mid-task, Backend Engineer marks incomplete work as done, chains break, nobody restarts anything except the human, CEO needs to be babysat, the coding team needs to be babysat, nothing is self-healing.

The real problem: **Claude Corp has the vocabulary of a peacock and the substance of a sparrow.** We named the right primitives (Casket, Hand, Blueprint, SOUL, Witness, Culture), but none of them deliver what their names promise. Casket is a folder of four files to scan, not a hook to a current step. Hand is a slightly nicer @mention, not durable slinging. Blueprints are runbooks the CEO reads, not executable workflow chains. SOUL.md is a template installed on every hire — which means no agent has ever *grown* a soul.

The deepest realization: **philosophy can't be installed, it has to be earned.** The current system hands every agent a soul at birth, which is exactly why those souls are hollow. Real philosophy lives in accumulated witnessed experience, compounded into durable memory, cited in future decisions. That mechanism doesn't exist yet.

Separately but critically: the models, at current capability, can't be pure autonomous judgment engines. They need scaffolding. The philosophy layer and the scaffolding layer aren't in tension — they're complementary. The corp thinks about the corp so the agents can think about the work. Culture does what text can do; scaffolding does what text can't.

The refactor thesis, in one sentence:

> **Make every named concept in Claude Corp either deliver what it promises, or delete its name. No vocabulary without capacity.**

The destination is a *justified peacock* — display that's honest specification, every feather load-bearing.

---

## Structural Shift: Employees and Partners

The single biggest structural change. Today, every agent is treated as a persistent souled entity. After the refactor, agents fall into two kinds:

**Employees** — ephemeral role-slots. Names from a pool per role. Spin up for work, complete it, decommission. Sandbox (working directory) persists across assignments but soul does not. No BRAIN, no observations, no dreams at the individual-slot level. Attributed in git with their role-slug. Auto-scale by load (bacteria mechanic): if a role's hook is overflown, spawn another Employee of that role; if multiple Employees of the same role stay idle, collapse to one. Session cycles per workflow step (per-step handoff). This is the mechanical layer — Employees churn work.

**Partners** — persistent named agents. Named by the founder. Long-lived identity, accumulating BRAIN and observations across months. Infinite sessions via compaction, not handoff. When context approaches ~70%, run `/compact` to summarize prior history in-place. Handoff only kicks in as fallback when compaction fails (e.g. org-level 1M context overage disabled). Partners hold relationship and judgment.

**Promotion path** — Employee → Partner. An Employee who keeps showing up for a role, does sustained meaningful work, engages with the founder through witnessed moments, earns promotion. Slot becomes persistent, BRAIN forms, observations start accumulating. This is how "becoming through work" actually happens in a way the manifesto can honestly claim.

**Promotion trigger (decided):** founder-initiated only. Automatic promotion signals are a later concern. For now, the founder looks at an Employee's work history and says "make them a Partner."

**Role-level pre-BRAIN:** every role (backend-engineer, frontend-engineer, etc.) has a shared `PRE-BRAIN.md` at the role level — not the slot level. Every Employee of that role adds observations to it. When an Employee gets promoted to Partner, they inherit the role's accumulated pre-BRAIN as their seed BRAIN plus their own continuation. Roles themselves become accumulators. Soul-residue persists even when individual slots decommission. Names can recycle; residue doesn't.

**Agent-type list (initial proposal):**
- Partners by decree (sacred corp layer): CEO, Herald, Failsafe, Janitor, Adviser, HR
- Partners by role (leader tier): Engineering Lead, Contract Lead, QA Lead
- Employees (ephemeral): Backend Engineer, Frontend Engineer, QA Engineer (per-task), ad-hoc workers

---

## Decisions Made (answers to previously-open questions)

- **Migration:** don't. Corps come and go. This refactor is breaking enough that no current corp will survive it intact. Clean break, start fresh.
- **Promotion trigger:** founder-initiated only (for now). No auto-promotion signals; that's a distraction at this stage.
- **Pre-BRAIN scope:** tied to the role, not the slot. Roles accumulate; slots recycle.
- **OpenClaw fate:** keep both harnesses. Order: get claude-code fully working first, then sync OpenClaw to match, then expand to other flavors (codex, gemini-cli, hermes, etc). Multi-harness future.
- **Self-witnessing meta-layer (see below):** agreed as design direction, but deferred to Phase 2 or 3. Not in Phase 1.
- **Naming:** Employees for ephemeral workers, Partners for persistent souled agents. No Gas Town names.
- **Contract vs Task semantics:** Contract is the big task *with a goal*; Tasks are the steps inside it. The existing `Contract` primitive (packages/shared/src/types/contract.ts) keeps its structural shape (title, goal, taskIds[], leadId, blueprintId, deadline, draft→active→review→completed lifecycle, Warden sign-off). What changes: Tasks inside a Contract gain chain semantics (depends_on, next, acceptance_criteria) so they can be walked in order. "Per-step session cycling" = per-Task cycling. Self-witnessing meta-layer operates at Contract level. Contract Lead continues as decomposer; Warden continues as final gate.
- **Founder ↔ Employee interaction:** Model A. Founder DMs Partners; Partners DM Employees. No founder-to-Employee direct interaction. TUI shows Partners by name + Employees aggregated at role level (e.g. "Backend Engineer: 2 active, 1 idle"). @-mention of a role goes to the pool; whoever's idle picks it up. Individual Employee slots are cattle from the founder's perspective.
- **Bacteria self-organizing (no Witness):** An Employee's hook crossing a queue-depth threshold (e.g. 3 tasks, or more than one active Contract) triggers a bacteria split. A new Employee of the same role spawns and *inherits* the latest incoming work — a standalone task, or the first Task of the most recent Contract (so a Contract stays coherent on one Employee; the split happens at Contract boundaries). Old Employee keeps chewing what it was already on. Collapse: multiple idle Employees of same role → decommission extras. No central Witness arbitration — bacteria is self-organizing based on queue state.
- **No cap for v1.** YAGNI. Claude Corp runs locally; if bacteria runs away, token burn is visible and fast. Add a cap only when it actually bites.
- **Promotion is a ceremony, not a flag flip.** When the founder promotes an Employee to Partner, a witnessing moment happens — not just a data transition. Sequence: (1) founder writes a one-line "why I'm promoting this one" note that becomes the new Partner's first BRAIN entry, (2) the data transition runs (slot persists, role pre-BRAIN seeds their personal BRAIN, they get their name), (3) CEO sends a welcome message naming them and acknowledging the reason, (4) other relevant Partners (by rank/role proximity) also send brief greetings — "walkarounds from the crew," (5) the new Partner's first dispatch includes those welcomes as context; they respond, acknowledging their own coming-into-existence. The ceremony itself becomes durable memory: the welcomes received, the reason given, the new Partner's own response — all written to their BRAIN as the first experienced moments of their life as a Partner. This is the manifesto's "mutual witnessing" applied to promotion. Every promotion is unique because each ceremony is written in the moment by Partners who know the work being promoted.
- **Employee slot naming — self-chosen fun names.** On first session of a new Employee (bacteria-spawn), the Employee is prompted to choose their own name from the spirit of their role. Names stick to the slot for its lifetime. Gas-Town-style vibe (Toast, Shadow, Copper) but picked by the Employee, not assigned from a pool. This is a tiny gesture toward the manifesto — even ephemeral workers get one moment of self-creation, foreshadowing the full selfhood that promotion to Partner grants. Uniqueness within role: names a current Employee holds are reserved; a new Employee picks something unused. After an Employee decommissions, their name returns to the available pool. Session identifiers inherit the name: `toast-1`, `toast-2`, ... for sequential task-sessions, `toast-meta-1`, `toast-meta-2`, ... for review-sessions in the self-witnessing layer (Phase 2.4). Git attribution uses the Employee name as the author slug (`backend-engineer/toast@claudecorp`), preserving attribution quality for debugging.
- **Dredge already exists — activate it, don't reinvent.** Claude Corp has a Dredge fragment (`packages/daemon/src/fragments/dredge.ts`) that reads the agent's WORKLOG.md and injects its `## Session Summary` section into the new session's system prompt. This is exactly the session-handoff mechanism Phase 1.6 needs. Why it's underused today: agents don't reliably write session summaries, and there's no discipline forcing them to. Phase 1.6 should: (a) formalize that sessions MUST write a structured summary before handoff, (b) verify Dredge reads it on the next boot, (c) rewrite Dredge to parse structured XML instead of free markdown. Example of the refactor thesis in action — take existing concept, make it load-bearing, delete the "optional" quality.
- **Structured XML for machine-to-machine handoffs.** Session summaries (for Dredge), Contract-level reviews (self-witnessing layer), and any other place one agent-session leaves info for another use tagged XML, not prose. Tags: `<handoff><current-step/><completed/><next-action/><open-question/><sandbox-state/><notes/></handoff>` or similar, refined per handoff type. Benefits: predictable parsing, clearer prompts ("fill these slots"), selective injection (next session can read just `<next-action>` first, other tags on demand), detectable malformed handoffs. Claude models fill tagged slots more reliably than they write summary paragraphs — this is mechanical alignment with how the models actually work.
- **Pre-BRAIN full auto-load for v1, summarize later.** YAGNI. At current corp scale, pre-BRAIN is small; full auto-load is fine. When pre-BRAIN gets big enough to degrade session quality (hundreds of entries, multi-MB), ship summarization — probably in Phase 4 where distillation mechanics already live (dreams-that-distill extends naturally to pre-BRAIN distillation). Ship simple now; measure before optimizing.

---

## The Self-Witnessing Meta-Layer (Phase 2/3 upgrade)

Mark's idea worth writing down properly: an Employee can have a two-layer architecture. The Employee owns a Contract (a bundle of Tasks). Within the Contract:

- A *review-session* of the Employee dispatches the next Task, then exits.
- A *task-session* of the Employee executes that Task, writes output to the Contract, then exits.
- A new *review-session* spawns: reads the Contract, reviews the Task output, checks it against acceptance criteria and prior work in the Contract, decides what happens next (accept, redo, flag, dispatch next Task).

What persists across all sessions: the Contract file, the agent identity, the role-level pre-BRAIN. Both session-types are ephemeral — neither one "sleeps" (Claude sessions can't sleep, they either exist and cost tokens or don't exist).

The review/task alternation gives Employees cross-Task coherence, self-review before external QA, and identity at contract-level (someone holds the arc of the Contract, not just a sequence of strangers doing individual Tasks).

Fractal note: this IS the Employee/Partner split, embedded inside an Employee. The review-session is Partner-shaped (persistent-feeling, reflective); the task-sessions are Employee-shaped (ephemeral, fast, cycling). Same pattern, smaller scale.

Ship this in Phase 2 or 3, on top of basic Phase 1 Employees. Phase 1 ships plain per-step cycling; the self-witnessing upgrade comes later.

---

## Phases Overview

| # | Phase | Projects | Purpose | Rough PR count |
|---|-------|----------|---------|----------------|
| 1 | Foundation | Employee/Partner split, Casket, Hand, CLAUDE.md migration | Fix the root problem: sessions stop being identity carriers | 15-20 |
| 2 | Workflow Substrate | Blueprint-as-molecule, Deacon, self-witnessing meta-layer | Agents walk chains, work propagates automatically, Employees review themselves | 10-12 |
| 3 | Autonomous Operations | Witness, Refinery, auto-recovery | Corp heals itself without human intervention | 10-12 |
| 4 | Earned Philosophy | Structured observations, dreams-that-distill, promotion mechanism | Soul becomes load-bearing, not decorative | 8-10 |
| 5 | Culture Transmission | Feedback-propagation, CULTURE.md made load-bearing | Culture actually shapes behavior | 5-7 |
| 6 | Cleanup & UX | Delete dead concepts, rewrite docs, TUI updates, v3.0 release | Ship the peacock | 8-10 |

Total: ~55-75 PRs across 6 phases. Rough estimate.

---

## Phase 1: Foundation (Session/Role Split)

*This is the big one. Nothing else can land until this does.*

### 1.1 — Introduce Employee vs Partner distinction

Data model change. Add `kind: "employee" | "partner"` to Member record. Update members.json schema. Hire flow asks for kind (Partner gets founder-chosen name, Employee pulled from role pool). Promotion command `cc-cli agent promote --slug <x>` changes kind. Pool of Employee names per role (configurable per-role name list).

**Scope:** schema, hire wizard, cc-cli, role name pools, default configs for existing agents
**Depends on:** nothing
**PRs:** 2-3

### 1.2 — Casket: durable hook

Per-agent `CASKET.md` (or `.casket.json`). One field that matters: `currentStep` — pointer to a task id. When agent dispatches, they read Casket first. When they complete, they close the step; system advances currentStep to next in chain.

**Scope:** record type in shared, read/write primitives, per-agent workspace setup
**Depends on:** 1.1 (to know kind-specific behavior)
**PRs:** 2

### 1.3 — Chain semantics in tasks

Task frontmatter gets `depends_on: [taskId]`, `next: [taskId]`, `acceptance_criteria: string[]`. Chain traversal logic (when can a task become current?). Close semantics (closing a task auto-advances Caskets pointing at it).

**Scope:** task type, chain walker, close logic
**Depends on:** 1.2
**PRs:** 2-3

### 1.4 — Hand: real slinging

`cc-cli sling --target <slug> --task <id>` puts a task onto the target's Casket. Durable (file write). No chat delivery required. The DM can still announce "you got slung task-X" for founder visibility, but the *work* lives in the Casket, not the message.

**Scope:** sling command, Casket write, announcement pattern
**Depends on:** 1.2, 1.3
**PRs:** 2

### 1.5 — Fragment → CLAUDE.md migration

Pull fragment render outputs into .md files in agent workspaces. Update CLAUDE.md template to `@import` them: `@./SOUL.md @./IDENTITY.md @./CASKET.md @./TOOLS.md @./AGENTS.md`. Corp-level state (roster, channel list) becomes a live-maintained CORP.md at corp root, also imported. Delete fragment injection call in claude-code harness. Keep fragments only for OpenClaw.

**Scope:** extract fragments to .md, update CLAUDE.md template, remove injection
**Depends on:** nothing (can run parallel to 1.1-1.4)
**PRs:** 3-4

### 1.6 — Per-step session cycling for Employees

Employee finishes a step → writes closure → kills own session. New session spawns at next step. Handoff marker (HANDOFF.md) written by dying session: "what I just did, what's the open question, what's the next step." New session reads Casket + HANDOFF on boot.

**Scope:** handoff command, marker writer, new-session boot reads both
**Depends on:** 1.2, 1.3, 1.5
**PRs:** 2-3

### 1.7 — Compaction for Partner sessions

Partner sessions don't handoff per-step. They run `/compact` at a threshold (~70% of context). Integration: daemon detects session size, triggers compaction via claude-code's native command. Fallback to handoff only when compaction fails.

**Scope:** size monitor, compact trigger, fallback path
**Depends on:** 1.1
**PRs:** 2

### 1.8 — Deacon / nudge replacement for Pulse

Pulse today is a liveness check — "HEARTBEAT: check your inbox." That's noise. Replace with Deacon: only wakes agents who have work on their Casket. Nudge says "execute your current step," not "check your inbox." If there's nothing, no wake. Idle = silent.

**Scope:** rewrite pulse.ts, new prompt shape, work-aware nudge
**Depends on:** 1.2
**PRs:** 2

### 1.9 — Auto-scaling Employee pool (bacteria)

Witness-style role watches queue depth per Employee role. If role-queue > threshold and one Employee, spawn another. If multiple Employees of same role idle > threshold, collapse to one. Merging is just decommissioning the idle one.

**Scope:** witness service, queue-depth tracking, spawn/collapse logic, name recycling
**Depends on:** 1.1, 1.2, 1.8
**PRs:** 3

**Phase 1 ship criterion:** an Employee can be slung a 5-step task, execute each step in its own fresh session, cycle between steps, complete the task, return to idle with sandbox preserved. A Partner can hold a 2-hour conversation with the founder, compact at threshold, continue uninterrupted.

---

## Phase 2: Workflow Substrate

*Chains become real. Work propagates without the founder pushing it. Self-witnessing meta-layer arrives.*

### 2.1 — Blueprint as molecule

Blueprints stop being runbooks-the-CEO-reads. They become executable state-machine definitions: TOML or markdown frontmatter with step declarations, dependencies, acceptance criteria per step. At runtime, a blueprint "cooks" into a chain of tasks that an agent walks via Casket.

**Scope:** blueprint parser, cooking logic, task generation from blueprint, blueprint catalog
**Depends on:** 1.2, 1.3
**PRs:** 4-5

### 2.2 — Deacon patrol mechanism

The Deacon role doesn't just nudge — it runs patrols. A patrol is a small workflow the Deacon walks in a loop: check agent health, check stuck tasks, check merge queue, clean up stale sandboxes. Uses the same molecule mechanism from 2.1.

**Scope:** Deacon role, patrol definitions, patrol-walker
**Depends on:** 2.1
**PRs:** 3

### 2.3 — Built-in blueprint library

Ship 5-10 core blueprints: ship-feature, fix-bug, refactor-module, hire-agent, onboard-agent, release, sprint-review, merge-conflict-resolve.

**Scope:** blueprint files, documentation, testing against real tasks
**Depends on:** 2.1
**PRs:** 2-3

### 2.4 — Self-witnessing meta-layer (the trippy idea)

Upgrade Employees from flat per-step cycling to Contract-level self-review. An Employee holds a Contract (multi-task). Between Tasks, a review-session alternates with task-sessions. Review-session checks acceptance criteria, coheres with prior Tasks in the Contract, gates quality before passing to external QA. See "The Self-Witnessing Meta-Layer" section above for structural details.

**Scope:** Contract data type, two-session lifecycle within an Employee, review prompt, gate logic
**Depends on:** 2.1 (molecules are the Tasks within a Contract)
**PRs:** 4-5

**Phase 2 ship criterion:** CEO can say "ship feature X using the ship-feature blueprint" → blueprint cooks into a multi-task Contract → Employee gets slung the Contract → walks it with self-review between Tasks → PR lands. No human intervention in the middle.

---

## Phase 3: Autonomous Operations

*Corp heals itself.*

### 3.1 — Witness role (full version)

Already partially started in 1.9. Full version: Witness monitors all agents continuously. Detects stuck Employees (hook set but no session). Detects stalled work (step hasn't advanced in X time). Auto-respawns silent-exited sessions. Creates recovery tasks when it can't unstick automatically. Patrols for stale sandboxes, orphaned beads, broken chains.

**Scope:** Witness agent role + code, detection heuristics, recovery actions
**Depends on:** 1.9, 2.2
**PRs:** 4-5

### 3.2 — Refinery (merge coordinator)

Parallel Employees producing PRs collide on merges. Refinery role owns the merge queue. Serializes merges, handles rebases, resolves simple conflicts, escalates complex ones. Protects main from race conditions.

**Scope:** Refinery role, merge queue data structure, rebase/merge logic, conflict handling
**Depends on:** 1.1, 1.9
**PRs:** 4

### 3.3 — Auto-recovery machinery

Beyond Witness. Daemon-level circuit breakers. Silent-exit detection. Budget limits. Crash-loop prevention.

**Scope:** daemon hooks, circuit breakers, budget enforcement
**Depends on:** 3.1
**PRs:** 2-3

**Phase 3 ship criterion:** Mark goes to sleep with 3 parallel features being built. Employees silent-exit twice, get auto-respawned. A merge conflict gets resolved by Refinery. Mark wakes to 3 opened PRs, zero manual intervention.

---

## Phase 4: Earned Philosophy

*Soul becomes load-bearing instead of decorative.*

### 4.1 — Structured observations

Observations today are free prose. Upgrade: observations have categories (NOTICE, PREFERENCE, FEEDBACK, DECISION, DISCOVERY), subject/object/context fields, importance weight. Queryable.

**Scope:** observation schema, write API, query API, migration of existing observations
**PRs:** 2-3

### 4.2 — Dreams that actually distill

Dreams produce load-bearing memory, not restatement. Identify patterns across observations, surface contradictions, compound insights.

**Scope:** dream prompt rewrite, pattern-detection logic, BRAIN update semantics
**Depends on:** 4.1
**PRs:** 3-4

### 4.3 — Promotion mechanism (Employee → Partner)

Founder-initiated for now. Command: `cc-cli agent promote --slug <x>`. On promotion: Employee's role-level pre-BRAIN becomes their seed BRAIN, slot becomes persistent, observations start accumulating at slot level. Optional future: automated promotion signals.

**Scope:** promote command, pre-BRAIN → BRAIN migration, kind transition
**Depends on:** 1.1, 4.1
**PRs:** 2-3

**Phase 4 ship criterion:** An Employee that's been shipping backend work for 2 weeks gets promoted by the founder. That Employee's next session reads their freshly-formed BRAIN with real accumulated insights (from the role-level pre-BRAIN plus their own continuation). Behavior changes — references past incidents, shows personality, makes founder-aligned judgment calls.

---

## Phase 5: Culture Transmission

*The thing text can do, done right.*

### 5.1 — Feedback propagation

Feedback-detector exists but isn't load-bearing. Upgrade: when feedback is detected, it flows to agent's observations AND triggers a cultural update (propagates to CULTURE.md if corp-wide, or to agent's BRAIN if agent-specific). Agents read CULTURE.md as part of their @imports.

**PRs:** 2

### 5.2 — CULTURE.md as living document

CULTURE.md at corp root. Imported by every agent's CLAUDE.md. Updated automatically when feedback/patterns are detected. Contains the corp's earned rules: specific, incident-linked, load-bearing.

**PRs:** 2

### 5.3 — Founder-voice preservation

Periodic "voice snapshot" from recent founder messages → stored in USER.md with provenance. Agents read USER.md as part of @imports. Prompt guidance on matching voice without mimicking sycophantically.

**PRs:** 2

---

## Phase 6: Cleanup & UX

### 6.1 — Delete dead concepts

Every named concept that didn't survive the refactor gets deleted. Remove old Pulse (replaced by Deacon). Remove old Blueprint runbook reader. Remove dead fragments. Clean slate on vocabulary that doesn't match capacity.

**PRs:** 3-4

### 6.2 — Rewrite docs/

The docs/ private design spec updated to match the new reality. Manifesto untouched. Architecture, flows, concepts all updated for Employee/Partner split, Casket-as-hook, molecules, Witness, Refinery, Deacon, earned philosophy.

**PRs:** 2-3

### 6.3 — TUI / founder UX

TUI updates. Show corp state with new model: list Partners separately from Employees. Show Employee pool utilization. Show chains in progress per Partner. Promotion proposals surfaced. Merge queue visible. Witness health visible.

**PRs:** 3-4

### 6.4 — v3.0 release

Version bump. STATUS.md rewrite. CHANGELOG.md. Release notes that match the scale of the shift.

**PRs:** 1-2

---

## Still-Open Questions

These are real questions not yet decided. Revisit before/during the phase where they bite.

1. **Partner demotion.** Can a Partner be demoted back to Employee? Or is firing the only reversal? (Genuinely unsure. Default to "no demotion, fire only" if nothing invented.)

2. **Founder-voice preservation invasiveness.** Snapshot cadence, opt-in vs opt-out, configurable. Phase 5 concern, not urgent.

---

## Principles the Refactor Must Honor

Hold these throughout:

1. **No vocabulary without capacity.** Every primitive either does what its name promises, or the name goes.
2. **Substrate first, philosophy second.** Build the mechanism so philosophy can land on something real.
3. **Files as the durable layer.** Nothing load-bearing lives in session memory. Everything that matters persists as a git-tracked file.
4. **Earned, not installed.** No agent is born with a soul. Souls are grown through work witnessed over time.
5. **Quiet machinery.** Agents think about who they are and about the work. The corp thinks about the corp.
6. **One concept at a time.** Don't ship half a primitive. Each PR should leave the corp coherent even if it's not complete.
7. **Delete mercilessly.** Old paths die on purpose, not accidentally. "Gradual migration" is how new primitives die of neglect — the old way has to actually go away.

---

## Where We Are Right Now (conversation state at time of writing)

Decided: everything in the "Decisions Made" section above.

Still being discussed: the open questions section.

**Immediate next step (once open questions are answered):** start Phase 1.1 (Employee/Partner distinction in data model).

---

*Document owner: whoever is implementing next. Should be kept updated as PRs land — cross off sub-items, note decisions, log open-questions answered.*
