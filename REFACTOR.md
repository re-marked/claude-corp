# Claude Corp — The Big Refactor (2026-04-21)

*Captured during a long conversation with Mark, before Claude's context compaction. The thinking is fresh; this document preserves it for future-Claude to pick up.*

---

## Context: What We Learned Today

Today Mark and Claude diagnosed what's actually wrong with Claude Corp, not just the symptoms we kept firefighting.

The surface problems: agents silent-exit, sessions overflow, CEO loses its place mid-task, Backend Engineer marks incomplete work as done, chains break, nobody restarts anything except the human, CEO needs to be babysat, the coding team needs to be babysat, nothing is self-healing.

The real problem: **Claude Corp has the vocabulary of a peacock and the substance of a sparrow.** We named the right primitives (Casket, Hand, Blueprint, SOUL, Witness, Culture), but none of them deliver what their names promise. Casket is a folder of four files to scan, not a hook to a current step. Hand is a slightly nicer @mention, not durable forwarding. Blueprints are runbooks the CEO reads, not executable workflow chains. SOUL.md is a template installed on every hire — which means no agent has ever *grown* a soul.

The deepest realization: **philosophy can't be installed, it has to be earned.** The current system hands every agent a soul at birth, which is exactly why those souls are hollow. Real philosophy lives in accumulated witnessed experience, compounded into durable memory, cited in future decisions. That mechanism doesn't exist yet.

Separately but critically: the models, at current capability, can't be pure autonomous judgment engines. They need scaffolding. The philosophy layer and the scaffolding layer aren't in tension — they're complementary. The corp thinks about the corp so the agents can think about the work. Culture does what text can do; scaffolding does what text can't.

The refactor thesis, in one sentence:

> **Make every named concept in Claude Corp either deliver what it promises, or delete its name. No vocabulary without capacity.**

The destination is a *justified peacock* — display that's honest specification, every feather load-bearing.

---

## North Star: Claude Corp runs on its own

Mark's dream, stated plainly: *the founder hands work to the corp, walks away, and the corp keeps working. If something breaks, the corp recovers itself. If it can't recover, it escalates cleanly. The founder comes back to working output — not a graveyard of stuck agents.*

This is the test every post-Project-0 feature is measured against. Specifically:

- **Work propagates.** The founder hands a Contract; it decomposes into Tasks; Tasks hand themselves to roles; done-agents advance their Casket to the next step; the whole chain walks without re-dispatching by hand.
- **Blockers are first-class.** An agent mid-work files a blocker sub-task, exits cleanly, and auto-resumes when the blocker closes. No "I'm stuck" silence; no awkward context-lost escalations.
- **Failures self-heal.** Silent-exits respawn. Stuck tasks escalate after N minutes. Crash-loops circuit-break. Budget overruns pause the role, not the corp.
- **Merge discipline holds.** Agents never push directly to main. A single merge-coordinator owns the main lane and serializes concurrent work without stepping on it.
- **Founder presence is optional.** When Mark is away, work progresses. When he comes back, he sees *what happened* (the audit trail is complete) and *what needs him* (tier-3 inbox surfaces the calls that only the founder can make) — not *what's stuck* (because the system already tried to unstick it).

Project 1 ships the mechanical substrate of this (dispatch, cycling, chain-walking, watchdogs, budget governors). Projects 2 + 3 layer on the coordination primitives (blueprints, self-witnessing, refinery, deeper recovery). Project 4 makes it feel alive (earned philosophy, accumulating memory, promotion ceremony). The dream emerges from all of them together, but Project 1 is the floor.

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
- **Self-witnessing meta-layer (see below):** agreed as design direction, but deferred to Project 2 or 3. Not in Project 1.
- **Naming:** Employees for ephemeral workers, Partners for persistent souled agents. No Gas Town names.
- **Contract vs Task semantics:** Contract is the big task *with a goal*; Tasks are the steps inside it. The existing `Contract` primitive (packages/shared/src/types/contract.ts) keeps its structural shape (title, goal, taskIds[], leadId, blueprintId, deadline, draft→active→review→completed lifecycle, Warden sign-off). What changes: Tasks inside a Contract gain chain semantics (depends_on, next, acceptance_criteria) so they can be walked in order. "Per-step session cycling" = per-Task cycling. Self-witnessing meta-layer operates at Contract level. Contract Lead continues as decomposer; Warden continues as final gate.
- **Founder ↔ Employee interaction:** Model A. Founder DMs Partners; Partners DM Employees. No founder-to-Employee direct interaction. TUI shows Partners by name + Employees aggregated at role level (e.g. "Backend Engineer: 2 active, 1 idle"). @-mention of a role goes to the pool; whoever's idle picks it up. Individual Employee slots are cattle from the founder's perspective.
- **Bacteria self-organizing (no Witness):** An Employee's hook crossing a queue-depth threshold (e.g. 3 tasks, or more than one active Contract) triggers a bacteria split. A new Employee of the same role spawns and *inherits* the latest incoming work — a standalone task, or the first Task of the most recent Contract (so a Contract stays coherent on one Employee; the split happens at Contract boundaries). Old Employee keeps chewing what it was already on. Collapse: multiple idle Employees of same role → decommission extras. No central Witness arbitration — bacteria is self-organizing based on queue state.
- **No cap for v1.** YAGNI. Claude Corp runs locally; if bacteria runs away, token burn is visible and fast. Add a cap only when it actually bites.
- **Promotion is a ceremony, not a flag flip.** When the founder promotes an Employee to Partner, a witnessing moment happens — not just a data transition. Sequence: (1) founder writes a one-line "why I'm promoting this one" note that becomes the new Partner's first BRAIN entry, (2) the data transition runs (slot persists, role pre-BRAIN seeds their personal BRAIN, they get their name), (3) CEO sends a welcome message naming them and acknowledging the reason, (4) other relevant Partners (by rank/role proximity) also send brief greetings — "walkarounds from the crew," (5) the new Partner's first dispatch includes those welcomes as context; they respond, acknowledging their own coming-into-existence. The ceremony itself becomes durable memory: the welcomes received, the reason given, the new Partner's own response — all written to their BRAIN as the first experienced moments of their life as a Partner. This is the manifesto's "mutual witnessing" applied to promotion. Every promotion is unique because each ceremony is written in the moment by Partners who know the work being promoted.
- **Employee slot naming — self-chosen fun names.** On first session of a new Employee (bacteria-spawn), the Employee is prompted to choose their own name from the spirit of their role. Names stick to the slot for its lifetime. Gas-Town-style vibe (Toast, Shadow, Copper) but picked by the Employee, not assigned from a pool. This is a tiny gesture toward the manifesto — even ephemeral workers get one moment of self-creation, foreshadowing the full selfhood that promotion to Partner grants. Uniqueness within role: names a current Employee holds are reserved; a new Employee picks something unused. After an Employee decommissions, their name returns to the available pool. Session identifiers inherit the name: `toast-1`, `toast-2`, ... for sequential task-sessions, `toast-meta-1`, `toast-meta-2`, ... for review-sessions in the self-witnessing layer (Project 2.4). Git attribution uses the Employee name as the author slug (`backend-engineer/toast@claudecorp`), preserving attribution quality for debugging.
- **Dredge already exists — activate it, don't reinvent.** Claude Corp has a Dredge fragment (`packages/daemon/src/fragments/dredge.ts`) that reads the agent's WORKLOG.md and injects its `## Session Summary` section into the new session's system prompt. This is exactly the session-handoff mechanism Project 1.6 needs. Why it's underused today: agents don't reliably write session summaries, and there's no discipline forcing them to. Project 1.6 should: (a) formalize that sessions MUST write a structured summary before handoff, (b) verify Dredge reads it on the next boot, (c) rewrite Dredge to parse structured XML instead of free markdown. Example of the refactor thesis in action — take existing concept, make it load-bearing, delete the "optional" quality.
- **Structured XML for machine-to-machine handoffs.** Session summaries (for Dredge), Contract-level reviews (self-witnessing layer), and any other place one agent-session leaves info for another use tagged XML, not prose. Tags: `<handoff><current-step/><completed/><next-action/><open-question/><sandbox-state/><notes/></handoff>` or similar, refined per handoff type. Benefits: predictable parsing, clearer prompts ("fill these slots"), selective injection (next session can read just `<next-action>` first, other tags on demand), detectable malformed handoffs. Claude models fill tagged slots more reliably than they write summary paragraphs — this is mechanical alignment with how the models actually work.
- **Pre-BRAIN full auto-load for v1, summarize later.** YAGNI. At current corp scale, pre-BRAIN is small; full auto-load is fine. When pre-BRAIN gets big enough to degrade session quality (hundreds of entries, multi-MB), ship summarization — probably in Project 4 where distillation mechanics already live (dreams-that-distill extends naturally to pre-BRAIN distillation). Ship simple now; measure before optimizing.
- **Chits — unified record primitive (Project 0 prerequisite).** We kept inventing new file shapes across Projects 1-6: handoff markers, dispatch contexts, pre-BRAIN entries, step logs, ephemeral records, structured observations. On top of Claude Corp's existing bespoke formats (tasks, observations, contracts, messages), that's ~12 separate conventions doing variations of the same thing. Gas Town's "Beads" is their unified answer. We build our own — **Chits** — corporate-themed, Claude-Corp-native. A Chit is a structured markdown record that can be any of: task, observation, contract, casket pointer, handoff, dispatch-context, pre-BRAIN entry, step log. One primitive, many types, shared core schema + type-specific frontmatter fields. Becomes Project 0 — the foundation everything else sits on. Tasks/Contracts/Observations get migrated to Chits before Project 1's sub-projects start. Old formats die; no parallel paths.
- **From the research gems — accepted for future projects:**
  - Compaction hooks (`PreCompact` + `SessionStart { source: "compact" }`) — Project 1.7 uses these natively for context renewal on Partners
  - Blockable `Stop` hook as native critic loop — consider for Project 2.4 (self-witnessing meta-layer) as an implementation option
  - `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` silent-disable is a real claude-code behavior — Project 1.7 compact-trigger must detect and handle this (likely triggers fallback handoff path from 1.6)
  - Sleep-time Memory Steward agent on Haiku model — becomes Project 4.4 or an extension to Project 4.2 (dreams-that-distill); runs during SLUMBER, rewrites Partner BRAIN without competing with Partner's response loop
  - Three subagent isolation models (Fork/Teammate/Worktree) — inform Project 2.4 and Project 3 design choices
  - 15-second blocking budget — Project 1.8 Failsafe / Project 3.3 auto-recovery enforce this for autoemon ticks
  - atomicfile pattern (tempfile + rename for crash-safe writes) — Project 0.1 uses this for all Chit writes
  - 4-signal promotion for ephemeral records — Project 0.6 implements this for ephemeral Chits
  - Handoff-as-tool in Claude Corp terms = `cc-cli escalate --to <partner> --reason "..."` — Project 1.4 extends hand with escalate semantics

---

## The Self-Witnessing Meta-Layer (Project 2/3 upgrade)

Mark's idea worth writing down properly: an Employee can have a two-layer architecture. The Employee owns a Contract (a bundle of Tasks). Within the Contract:

- A *review-session* of the Employee dispatches the next Task, then exits.
- A *task-session* of the Employee executes that Task, writes output to the Contract, then exits.
- A new *review-session* spawns: reads the Contract, reviews the Task output, checks it against acceptance criteria and prior work in the Contract, decides what happens next (accept, redo, flag, dispatch next Task).

What persists across all sessions: the Contract file, the agent identity, the role-level pre-BRAIN. Both session-types are ephemeral — neither one "sleeps" (Claude sessions can't sleep, they either exist and cost tokens or don't exist).

The review/task alternation gives Employees cross-Task coherence, self-review before external QA, and identity at contract-level (someone holds the arc of the Contract, not just a sequence of strangers doing individual Tasks).

Fractal note: this IS the Employee/Partner split, embedded inside an Employee. The review-session is Partner-shaped (persistent-feeling, reflective); the task-sessions are Employee-shaped (ephemeral, fast, cycling). Same pattern, smaller scale.

Ship this in Project 2 or 3, on top of basic Project 1 Employees. Project 1 ships plain per-step cycling; the self-witnessing upgrade comes later.

---

## Projects Overview

| # | Project | Contents | Purpose | Rough PR count |
|---|-------|----------|---------|----------------|
| 0 | Chits | Unified record primitive; migrate Tasks/Contracts/Observations onto it | Stop inventing new file formats for every work-record type; build the substrate everything else sits on | 15-20 **[shipped]** |
| 1 | Foundation | Employee/Partner split, Casket, Chain semantics, Hand, Dynamic blockers, Structured task I/O, Per-step cycling, Compaction, Blueprint-as-molecule, Watchdog chain (Pulse/Alarum/Sexton/helpers + patrol blueprint library), Bacteria scaling, Budget governor, Shipping (merge lane) | The mechanical floor of Mark's "runs on its own" dream — work propagates, blockers are first-class, Sexton keeps the corp alive, merge lane holds. | 22-28 **[~80% shipped as of 2026-04-24: 1.1-1.4.1, 1.6, 1.7, 1.8 landed; 1.9 complete through 1.9.6 (Sexton runtime + OS supervisor + 6 sweepers + kink chit type + 3 patrol blueprints); 1.10 bacteria + 1.11 budget/breaker + 1.12 Shipping not yet started]** |
| 2 | Workflow Substrate | Built-in blueprint library (domain workflows: ship-feature, fix-bug, etc.), self-witnessing meta-layer | Agents walk chains, work propagates automatically, Employees review themselves | 6-8 (slimmer — Blueprint substrate + patrol blueprints moved to Project 1 since the watchdog chain needs them on day one) |
| 3 | Autonomous Operations | Advanced Witness patrols (corp-wide anomaly detection), stall/escalation routing, daemon-level auto-recovery | What's left of corp healing after Project 1's mechanical watchdogs ship — cross-agent coordination + daemon-restart survival. | 6-8 (slimmer — Refinery + circuit-breaker moved to Project 1) |
| 4 | Earned Philosophy | Structured observations, dreams-that-distill, promotion mechanism, sleep-time Memory Steward | Soul becomes load-bearing, not decorative | 10-12 |
| 5 | Culture Transmission | Feedback-propagation, CULTURE.md made load-bearing | Culture actually shapes behavior | 5-7 |
| 6 | Cleanup & UX | Delete dead concepts, rewrite docs, TUI updates, v3.0 release | Ship the peacock | 8-10 |

Total: ~78-100 PRs across 7 projects. Rough estimate. Grew from 70-90 after the April 2026 Gas Town dive that surfaced dynamic-blocker + structured-I/O + three-tier-watchdog as genuine missing primitives rather than rebranded versions of things we already had.

---

## Project 0: Chits — the unified record primitive

*Everything else sits on this. Nothing in Project 1 onward can land until Chits exist.*

### Context — why Project 0 exists

As we designed Projects 1-6, we kept inventing new file shapes: handoff markers, dispatch contexts, pre-BRAIN entries, step logs, ephemeral records, structured observations. Each invention needed its own read/write code, its own frontmatter schema, its own query pattern. On top of Claude Corp's existing bespoke formats (tasks, observations, contracts, messages), that's ~12 separate conventions doing variations of the same thing.

Gas Town's "Beads" is the same insight applied to Go projects. We don't adopt Beads directly — it's an external project with its own opinions — but the **pattern** is right: one unified record primitive, many types, shared schema core + type-specific frontmatter. Build our own, Claude-Corp-native: **Chits**.

Every work-record in Claude Corp becomes a Chit. Old bespoke formats die in migration. No parallel paths.

### Shape of a Chit

A Chit is a markdown file with YAML frontmatter:

```yaml
---
id: chit-abc123
type: task | observation | contract | casket | handoff | dispatch-context | pre-brain-entry | step-log | inbox-item | ...
status: draft | active | review | completed | rejected | failed | closed | burning
ephemeral: false                 # true = auto-expires unless promoted (see 0.6 lifecycle)
ttl: 2026-04-28T00:00:00Z        # optional, only meaningful when ephemeral=true
created_by: member-id
updated_at: 2026-04-21T15:30:00Z
tags: [feedback, mark, preference]
references: [chit-xyz]           # loose pointers to related Chits
depends_on: [chit-111]           # strong dependency edges (chain semantics)
fields:
  # type-specific, validated against the type's schema
  task: { priority: high, assignee: ceo, acceptance_criteria: [...] }
  observation: { category: FEEDBACK, subject: mark, importance: 4 }
  casket: { current_step: chit-42 }
  handoff: { predecessor_session: ..., current_step: ..., open_question: ..., next_action: ... }
---

# Human-readable title

Markdown body. Any Chit type can have content; some types (like `casket`) barely use it.
```

**File path convention:** `<scope>/chits/<type>/<id>.md` — scope determines ownership.
- Corp-level: `~/.claudecorp/<corp>/chits/contract/abc.md`
- Agent-level: `~/.claudecorp/<corp>/agents/<slug>/chits/observation/def.md`
- Project-level: `~/.claudecorp/<corp>/projects/<name>/chits/task/xyz.md`

### Conventions (answer the audit gaps)

**ID generation.** Chit IDs are short readable hashes: `chit-<type-prefix>-<8-hex>`. Type prefix lets you eyeball a reference (`chit-t-a1b2c3d4` is obviously a task). Generated with `crypto.randomUUID()` truncated; collision probability at our scale is zero. Displayed short in log lines; full id only matters for file paths.

**`references` vs `depends_on` semantics.**
- `references` = loose pointers. "This Chit relates to that one." No cascade behavior. Closing/deleting a referenced Chit does nothing to the referrer.
- `depends_on` = hard edges. "This Chit can't become current until all depends_on are closed with terminal success status." Chain semantics in 1.3 uses this. On Chit close, the daemon scans all Chits with `depends_on: [<this-id>]` and checks if they're now `ready` — if yes, they're eligible for dispatch, casket-advancement, etc. Closing a `depends_on` Chit with terminal-failure status (rejected/failed) flags dependents as `blocked` (they become non-ready until the failure is re-opened or replaced).

**Concurrency.** Optimistic concurrency with content-hash. Every Chit file carries (implicitly, in the rename path) its write generation. Write protocol:
1. Read Chit, note its `updated_at`.
2. Compute new content.
3. Read Chit file again; if `updated_at` changed between step 1 and 3, abort — caller must re-read and retry.
4. Otherwise write via atomicfile (tempfile + rename).
5. On rename, if a previous writer's file exists with a newer `updated_at`, abort and retry.

This is not full ACID but is sufficient for file-first coordination where conflicts are rare and retries are cheap. Cross-platform: works on Windows, Mac, Linux without native locks.

**Permissions.** Scope owns write authority; read is universal within the corp.
- Corp-level Chits (`<corp>/chits/<type>/<id>.md`): writable by Partners with appropriate authority (CEO, HR, etc.); readable by anyone in the corp.
- Project/team Chits: writable by project/team members (leader + workers); readable by anyone.
- Agent Chits (`agents/<slug>/chits/...`): writable by that agent; readable by anyone.

Enforcement is at the cc-cli command layer (`--from` flag asserts identity; command refuses writes outside the caller's authority). Filesystem-level enforcement isn't attempted — agents on the same machine can technically bypass via direct file writes, but the prompting layer discourages this and the post-hoc audit trail (`updated_by` in frontmatter) catches deviations. This matches Claude Corp's existing trust model (file-first, permissions by convention + prompting, not by OS ACLs).

**Deletion policy.** Non-ephemeral Chits never delete; they close. Terminal statuses: `completed` (goal met), `rejected` (Warden/founder rejected), `failed` (abandoned), `closed` (benign retirement — superseded, no longer relevant). All terminal states keep the file in place with `updated_at` reflecting the close. Rationale: git history already makes delete irreversible in practice, and closed Chits are useful as audit trail + future pattern-detection data.

Ephemeral Chits of destruction-eligible types (handoffs, dispatch-contexts, role-level pre-brain-entries) delete: if no promotion signal fires before TTL, the daemon's lifecycle scanner (0.6) removes the file. A one-line destruction log is written to `<corp>/chits/_log/burns.jsonl` so agents can later ask "what ephemeral chits did we have that never promoted" — useful diagnostic, not a graveyard. Observations, per 0.6, are `keep-forever`: they flip to `status: 'cold'` on TTL age instead of destructing — preserved as soul material, demoted out of scanner tracking so per-tick work stays bounded.

Archival: `cc-cli chit archive <id>` moves a closed non-ephemeral Chit to `<scope>/chits/_archive/<type>/<id>.md`. Queries by default don't scan `_archive/`; pass `--include-archive` to search there. This keeps working-set queries fast when history grows.

### Per-type lifecycle rules (Type Registry)

Each type registers its configuration:

- `task` — non-ephemeral, lifecycle `draft → active → completed | rejected | failed`, Warden reviews at Contract level.
- `contract` — non-ephemeral, lifecycle `draft → active → review → completed | rejected | failed`, Warden signs off.
- `observation` — **ephemeral by default**, 4-signal promotion to permanent (see 0.6): (a) referenced by permanent Chit, (b) commented on, (c) tagged `keep`, (d) aged past TTL without resolution (failure path, not promotion).
- `casket` — non-ephemeral, one per agent (`id: casket-<agent-slug>`), only `fields.casket.current_step` matters functionally.
- `handoff` — ephemeral always, destroyed once read by successor session (Dredge consumes it and burns it).
- `dispatch-context` — ephemeral, tracks an in-flight dispatch between agents; burns on dispatch completion.
- `pre-brain-entry` — ephemeral by default at the role level; auto-promotes to permanent via 4-signal rule and becomes part of the role's distilled pre-BRAIN library.
- `step-log` — ephemeral with 7d TTL + `destroy-if-not-promoted` (Temporal memoization pattern), one per Task-execution phase, used for crash recovery. Harness-emitted on every dispatch (not agent-written); see 1.6 for the emission contract + how silent-exit respawn reads it. Unreferenced step-logs destruct at TTL; cited ones (by observations / post-mortems) promote via the normal 4-signal rule.
- `kink` — **[shipped 1.9.5]** ephemeral with 7d TTL + `destroy-if-not-promoted`. Operational findings emitted by sweepers (and future daemon-internal detectors). Distinct channel from observations — observations are agent-voice self-witnessing that feeds BRAIN via dreams; kinks are system-voice "something is wrong right now" reports. Mixing them would pollute the observation stream with mechanical noise AND misdirect dream distillation. Dedup per-(source, subject) via `writeOrBumpKink` helper — matching active kinks bump `occurrenceCount` + refresh severity/title/body rather than creating duplicates. Auto-resolve via `resolveKink` (manual) or runner-driven (when a sweeper stops reporting a subject, prior kink closes with `resolution: 'auto-resolved'`). See 1.9.
- `inbox-item` — **ephemeral by default**, tier-aware lifecycle (see 0.7 inbox system). Three tiers encoded as per-instance `fields.inbox-item.tier: 1 | 2 | 3`. Policy varies by tier via the per-instance destructionPolicy override:
  - **Tier 1 (ambient)** — `destructionPolicy: 'destroy-if-not-promoted'`, 24h TTL. Broadcast notifications, system events (Failsafe restarts, Herald digests). Genuinely fire-and-forget noise.
  - **Tier 2 (direct)** — `destructionPolicy: 'keep-forever'`, 7d TTL. Peer @mentions, inter-agent DMs, task handoffs from peers. Goes cold on TTL; preserves audit trail.
  - **Tier 3 (critical)** — `destructionPolicy: 'keep-forever'`, 30d TTL. Founder DMs, escalations, direct task assignments from supervisor, audit failures. Goes cold on TTL but blocks Audit Gate (0.7) while unresolved.

  Created by the daemon on the recipient's behalf (router when it sees @mention, hire/hand commands on dispatch, `cc-cli escalate` on escalation). Agents never create their own inbox items — they're always the RECIPIENT. Resolution via `cc-cli inbox respond <id>` (closes with `status: completed`, references the response chit) or `cc-cli inbox dismiss <id>` (closes with `status: rejected`, records dismissal reason). Tier 3 items reject `--not-important` dismissal at the CLI boundary.

### Sub-projects

### 0.1 — Chit core: schema, type registry, read/write primitives

**Problem.** Need the foundational record type every other Project relies on.

**Scope.** Define `Chit` type with common fields + type-specific frontmatter slots. Type registry with per-type configuration (lifecycle, default ephemeral, TTL defaults, frontmatter schema validators). CRUD primitives: `createChit`, `readChit`, `updateChit`, `closeChit`, `queryChits`. All writes go through `atomicfile` pattern (tempfile + rename) for crash-safe persistence (borrowed from Gas Town Gem 10).

**File paths:**
- `packages/shared/src/types/chit.ts` (new — `Chit<T>` generic over type, common fields, per-type field types)
- `packages/shared/src/chits.ts` (new — CRUD primitives, query API)
- `packages/shared/src/chit-types.ts` (new — type registry with per-type config)
- `packages/shared/src/atomic-write.ts` (new — 60-line leaf helper for crash-safe writes)
- `packages/shared/src/index.ts` (export Chit APIs)

**Test strategy:**
- Unit: schema validation per type (valid/invalid frontmatter rejection).
- Unit: atomic write leaves no partial files on simulated crash (interrupt mid-write, verify either full-file-old or full-file-new, never half).
- Unit: round-trip tests for each type (create → read → update → close).
- Unit: query API (by type, tag, status, since, references).
- Property test: 1000 random Chits round-trip without drift.

**Depends on:** nothing — this is the foundation.
**PRs:** 3-4

### 0.2 — cc-cli chit commands

**Problem.** Founders and agents need a unified CLI for work-record operations. Eliminates bespoke commands like separate `cc-cli task`, `cc-cli observe`, etc.

**Scope.** Full command surface:

```
# Create
cc-cli chit create --type <type> [--scope corp|project:<name>|team:<name>|agent:<slug>]
                   [--title "..."]  [--content-file <path>|--content "..."]
                   [--tag <tag>]*  [--ref <chit-id>]*  [--depends-on <chit-id>]*
                   [--field <key>=<value>]*  [--ephemeral] [--ttl <duration>]
                   [--from <member-id>]  # required for agents; founder implied otherwise

# Read
cc-cli chit read <id> [--json]
cc-cli chit read <id> --field <key>        # just the field value

# Update
cc-cli chit update <id> [--status <status>] [--add-tag <tag>]* [--remove-tag <tag>]*
                         [--add-ref <id>]*  [--set-field <key>=<value>]*
                         [--append-content "..."]

# Close (sets terminal status, runs close-hooks if type has them)
cc-cli chit close <id> [--status completed|rejected|failed|closed]

# List (query)
cc-cli chit list [--type <type>]*  [--status <status>]*  [--tag <tag>]*
                 [--scope <scope>]*  [--since <duration>]  [--until <duration>]
                 [--ref <id>]*  [--depends-on <id>]*  [--assignee <slug>]
                 [--ephemeral|--no-ephemeral] [--json] [--limit <n>] [--sort <field>]

# Promote (flip ephemeral → permanent; manual promotion of an ephemeral chit)
cc-cli chit promote <id> [--reason "..."]

# Close + archive (one-shot for when a Chit truly is done-and-gone)
cc-cli chit archive <id>
```

Query examples agents and founders actually run:

```
cc-cli chit list --type observation --tag feedback --since 7d --limit 20
cc-cli chit list --type task --status active --assignee backend-engineer
cc-cli chit list --type handoff --ephemeral --since 1h
cc-cli chit list --type contract --status review
cc-cli chit list --ref chit-abc123                    # everything that references abc123
cc-cli chit list --depends-on chit-abc123 --status '!=completed'  # what's blocked on abc123
```

Multiple `--type`, `--status`, `--tag`, `--scope` flags are OR'd within the same flag and AND'd across different flags. `--since` accepts `7d`, `1h`, `30m`. Default `--limit 50`.

**File paths:**
- `packages/cli/src/commands/chit.ts` (new — subcommand dispatcher)
- `packages/cli/src/commands/chit/create.ts`, `read.ts`, `update.ts`, `close.ts`, `list.ts`, `promote.ts`, `archive.ts`
- `packages/cli/src/index.ts` (register `chit` command group)
- Legacy aliases: `cc-cli task create` → `cc-cli chit create --type task`, `cc-cli observe` → `cc-cli chit create --type observation` (thin wrappers for muscle memory during migration)

**Test strategy:**
- Integration: end-to-end create → query → update → close via cc-cli subprocess calls.
- Integration: promote subcommand flips ephemeral correctly, clears TTL.
- Integration: query with every filter combination returns correct subset.
- Shell completion: argument completers for `--type` (known types), `--tag` (existing tags in corp), `--id` (recent Chits).

**Depends on:** 0.1
**PRs:** 2-3

### 0.3 — Migrate Tasks to Chits

**Problem.** Existing tasks are in bespoke format; become Chits of `type: task`.

**Scope.** Migration script reads existing `<scope>/tasks/<id>.md` files, rewrites as `<scope>/chits/task/<id>.md` under the Chit schema. Task-reading code paths rewrite as thin wrappers over Chit query API. Old task format code deleted, not deprecated.

**File paths:**
- `packages/shared/src/tasks.ts` (rewrite — becomes thin wrapper around `queryChits({type: 'task'})` etc.)
- `packages/shared/src/types/task.ts` (mark deprecated; task-specific fields move to Chit's `fields.task`)
- `scripts/migrate-tasks-to-chits.ts` (new — migration tool)
- `packages/cli/src/commands/task*.ts` (rewrite to use Chit API)

**Test strategy:**
- Migration test: snapshot of existing task corpus migrates cleanly; all task operations still work through the Chit API.
- Regression: existing task tests pass against new implementation.

**Depends on:** 0.1, 0.2
**PRs:** 2-3

### 0.4 — Migrate Contracts to Chits

**Problem.** Existing Contracts are bespoke; become Chits of `type: contract`.

**Scope.** Contract's `taskIds[]` becomes references to Chits of type=task. Contract lifecycle (draft → active → review → completed) maps to Chit status. Warden review stays as a distinct Chit-review step.

**File paths:**
- `packages/shared/src/contracts.ts` (rewrite as Chit-wrapper)
- `packages/shared/src/types/contract.ts` (deprecate; fields move to `fields.contract`)
- `scripts/migrate-contracts-to-chits.ts`

**Test strategy:** existing contract tests pass against new implementation; contract-to-task reference integrity preserved across migration.

**Depends on:** 0.1, 0.3
**PRs:** 2

### 0.5 — Migrate Observations to Chits (structured)

**Problem.** Observations are free prose in daily markdown; they become structured Chits of `type: observation` with categorized frontmatter (from Project 4.1 — advanced here into Project 0 since it's a migration, not a new feature).

**Scope.** Each observation becomes a Chit with `fields.observation = { category, subject, object, importance, context }`. Migration script parses existing daily observation files where possible (lossy; structured-from-prose is hard, so some observations convert to "category: NOTE, content: original prose"). Agents prompted to write new observations via `cc-cli chit create --type observation --category FEEDBACK --subject mark ...`.

**File paths:**
- `packages/shared/src/observations.ts` (rewrite as Chit-wrapper; `cc-cli observe` aliased from `cc-cli chit create --type observation`)
- `scripts/migrate-observations-to-chits.ts`
- Observation-related teaching moved into existing templates (rules.ts, workspace fragment) in the 0.5 implementation. Post-0.7, agent-facing observation guidance will live in CORP.md sections rendered by `cc-cli wtf`, not in a standalone fragment file. No new workspace file created.

**Test strategy:** structured observation query returns categorized results; legacy-prose observations migrate with best-effort categorization (NOTE as default).

**Depends on:** 0.1, 0.2
**PRs:** 2-3

### 0.5.1 — TaskFields.complexity (premature, by design)

**Problem.** The pre-chits `Task.estimate` was a free-form string (`"~2 hours"`, `"small"`). 0.3 migrated it onto `TaskFields.estimate` verbatim. Nothing in the corp ever read it — no scheduler, no UI, no prompt — so agents burned tokens writing values that went to /dev/null. At the same time, Project 1.10's bacteria split rule (queue-depth count > idle Employee count) implicitly assumes all tasks cost the same. They don't. `3 × trivial` and `3 × large` should route very differently.

**Scope.** Replace `TaskFields.estimate: string | null` with `TaskFields.complexity: 'trivial' | 'small' | 'medium' | 'large' | null`. The enum carries a structured signal that three decisions can key off:

1. **Decomposition** — planner treats `large` as a hint that the task should probably become a contract with sub-tasks. Large standalone tasks fail the "one dispatch, one hand, done" shape 1.2 + 1.4 depend on.
2. **Model routing** — trivial/small → Haiku-suitable; medium/large → Opus-worthy. Avoids burning Opus on var renames or asking Haiku to make architectural calls.
3. **Bacteria weighting (consumed in 1.9)** — weighted queue depth replaces raw count. `3 × trivial` stays on one Employee. `3 × large` splits. Mixed workloads weight toward the heavier side.

This is intentionally premature. 1.10 hasn't shipped; no consumer reads `complexity` yet. But putting the field in **now**, while Project 0 is still writing the schema, means every task created from 0.5.1 onward carries the signal. By the time 1.10 lands, the backfill already exists — bacteria reads populated data, not an empty column.

**File paths:**
- `packages/shared/src/types/chit.ts` (TaskFields: estimate → complexity)
- `packages/shared/src/chit-types.ts` (validator: string-or-null → enum)
- `packages/shared/src/templates/rules.ts` (agent-facing rubric: what each level means, decomposition heuristic)
- `packages/daemon/src/plan-prompt.ts` (planner learns the vocabulary + the large→contract trigger)
- `packages/cli/src/commands/task.ts` (`--complexity <val>` on `task new` / `task update`)

**Not in scope:** migration of existing `estimate` strings. No one read them; the orphan field parses harmlessly. New tasks get `complexity`; old tasks stay null until first touch.

**Test strategy:**
- Validator rejects invalid complexity values + accepts all four levels + accepts null + accepts omission.
- `cc-cli task new --complexity large` produces a chit with `fields.task.complexity = "large"`.
- Agent-facing prompt contains the rubric + the decomposition trigger.

**Depends on:** 0.3 (TaskFields exists)
**PRs:** 1

### 0.6 — Chit lifecycle: ephemeral Chits + 4-signal promotion (split by type)

**Problem.** Some Chit types accumulate as pure noise (handoffs consumed by the successor; dispatch-contexts superseded by git history; unpromoted pre-brain-entry candidates). Others — observations — are the agent's diary, its self-witnessing across time. Blanket auto-destruction would solve the noise problem but destroy soul material. A blanket "keep everything" would leave the noise types growing unboundedly.

So 0.6 splits the rule by what the Chit actually IS, not by a flat "ephemeral" flag.

**The split:**

**(A) Destruction-eligible (handoffs, dispatch-contexts, role-level pre-brain-entries).** These are *semantically* transient.
- A handoff is a note from predecessor-agent to successor-agent; once the successor reads it and starts work, it has fulfilled its purpose. Keeping it forever is a distraction.
- A dispatch-context is the "why this work went to this agent" breadcrumb; once the work ships, the commit + contract history carries the meaning.
- A pre-brain-entry at role level is an explicit candidate for BRAIN; unpromoted ones are noise by the definition of the type.

These get the full ephemeral-chit lifecycle: ephemeral=true, TTL set at creation, scanner checks 4 promotion signals, promote-or-destroy.

**(B) Promotion-only (observations).** Observations are the agent's diary. Mundane ones still contribute to the texture of the agent's becoming (see the manifesto — Writing as Witnessing). Destroying them to save disk space we don't need is counter-mission.

Observations still get `ephemeral: true` at creation AND still get scanned for promotion signals. Promotion flips `ephemeral: true → false` (first-class). But **there is no destruction path for observations.** Unpromoted observations stay forever; dream distillation is the compression layer (reads observations, writes BRAIN entries), and older observations get deprioritized in queries by `createdAt` weighting, not deleted. Git is already the audit trail; storage is cheap; noise-in-queries is a filter problem, not a lifetime problem.

**Shared scanner logic.** The daemon-side scanner runs periodically (e.g., every 5 min) over all `ephemeral: true` Chits. For each, checks 4 Gas Town promotion signals:
- (a) **referenced:** a permanent Chit references this one
- (b) **commented:** a related Chit or message cites this
- (c) **tagged keep:** `keep` in tags
- (d) **aged past TTL:** the tie-breaker path — behavior splits by `destructionPolicy` from the registry (see below)

**Three terminal states (not two), once a scanner tick acts on a chit:**

1. **Promoted** — any of (a)/(b)/(c) fired. `ephemeral: true → false`, `ttl` cleared. Chit becomes first-class; scanner stops visiting it. Log: `"promoted: <id> via <signal>"`.

2. **Destroyed** — TTL aged AND `destructionPolicy = 'destroy-if-not-promoted'` AND no promotion signal. File removed. Log: `"destroyed: <id> (ttl-aged, no promotion signal)"`. Used for handoffs, dispatch-contexts, role-level pre-brain-entries.

3. **Cold** (new — solves the unbounded-scanner-work bug for observations) — TTL aged AND `destructionPolicy = 'keep-forever'` AND no promotion signal. `ephemeral: true → false`, `status → 'cold'`. Chit stays on disk, stays queryable, but the scanner stops revisiting it. Log: `"cooled: <id> (ttl-aged, keep-forever policy)"`. If evidence arrives later (someone tags it, something references it), a separate "re-warm" signal can promote it — but the scanner itself no longer re-checks cold chits on every tick. Used for observations.

The distinction between **destroyed** and **cold** is the whole point of the 0.6 split: observations are preserved but demoted out of the active-tracking pool so scanner work doesn't grow linearly with corp age.

**Encoded in chit-types.ts registry, with per-instance override.** Each ChitTypeEntry carries:
- `destructionPolicy: 'destroy-if-not-promoted' | 'keep-forever'` — registry-level default for this type
- `defaultTtlMs: number | null` — default TTL at creation (observations: 24h; handoffs: 1h; dispatch-contexts: on-work-complete, not time-based; pre-brain-entries: 7d)

**Per-instance destructionPolicy override.** A chit's frontmatter can carry its own `destructionPolicy: <value>` that takes precedence over the registry default. The scanner reads instance-first, falls back to registry. This is load-bearing for types whose policy varies BY INSTANCE (not just by type) — most notably `inbox-item` (tier 1 destroys, tier 2/3 cool) but also covers edge cases like "this specific handoff should be preserved for audit; mark it keep-forever."

Writing the override is a one-line frontmatter field; reading it is one extra line in the scanner. Minimal cost, meaningful flexibility. A chit with no explicit override inherits type default — no migration churn on existing chits.

The scanner reads these; the policy per type is pinned in one place, with instance-level escape valve. Future changes to whether observations ever get destroyed = one-line registry flip, not a scanner rewrite.

**Query defaults** (important — otherwise cold observations flood every list):
- `queryChits({ type: 'observation' })` default: excludes `status: 'cold'`.
- `queryChits({ type: 'observation', includeCold: true })` explicit opt-in for archival queries (dream re-distillation, founder audit, etc.).
- Dreams distillation reads `active` + `cold` weighted by `createdAt` recency (compression still works on historical material; the cold demotion is about scanner cost, not dream input).

**No migration needed for post-0.5 observations.** They were written with `ephemeral: true` by the observe helper; the 0.6 scanner picks them up on first tick and applies the new policy. Pre-0.5 migration orphans (if any) with `ephemeral: undefined` are treated as non-ephemeral (scanner skips).

**Status vocabulary change.** Adding `'cold'` to `ChitStatus`. Cold is reached only by the scanner's TTL-aged + keep-forever path; it's not a manual state. All current ChitStatus consumers need a pass to make sure they either handle cold or explicitly filter it out.

**Re-warming cold chits.** Cold chits stay cold by default — the scanner does NOT re-check them every tick (that would defeat the work-list bound). If a founder or agent explicitly wants to re-warm one (they realized an old observation matters after all), they do it manually: `cc-cli chit update <id> --status active`. The scanner then picks it up again on its next tick. Auto-rewarm on late-arriving signal is a later refinement if ever needed; v1 keeps the model simple.

**Null-TTL ephemeral chits** (dispatch-contexts). `defaultTtlMs: null` means the chit has no time-based destruction. The scanner still visits it every tick but only the promotion signals can close it — never the TTL-aged path. Dispatch-contexts close when the work chit they narrate completes (a separate completion hook flips them, analogous to the contract-watcher pattern from 0.4). Expressed in scanner logic as: `if (ttl === null) skip TTL-aged branch; only run promotion checks`.

**Non-ephemeral chit types.** The registry carries `destructionPolicy` on every type for uniformity, but the scanner only visits chits with `ephemeral: true`. Tasks, contracts, casket are created with `ephemeral: false` and are never seen by the scanner regardless of their registry policy. Their registry entries use `destructionPolicy: 'keep-forever'` + `defaultTtlMs: null` as sensible-default no-ops. (Note: step-log was reclassified as ephemeral in 1.6's step-log-bound spec — see 1.6 — so it no longer lives in this list.)

**Definition of the "commented" signal (b).** Ambiguous in the original Gas Town spec — 0.6 pins it concretely: a chit is "commented on" when any other chit (any type, any scope) has the target chit's id in its `references` or `dependsOn` arrays, OR when any channel message has the target chit's id in its body (regex match on the chit-id format). Falls back to (a) "referenced" in most practical cases, but captures the weaker "someone mentioned it in chat" case the original spec was reaching for.

**Ship criterion.** 0.6 is done when: handoffs created an hour ago with no signal are gone; observations from last month still exist but query-list them only if you ask (`--includeCold`); the scanner's per-tick work stays bounded as the corp ages; dreams still see historical observations for distillation; a founder running `cc-cli chit list --type handoff` sees only the live ones.

**Operational notes (implementation-critical).**

- **TTL math.** "Aged past TTL" means `chit.createdAt + chit.ttl < now`. The `updatedAt` stamp is NOT used for TTL — promotion signals extend via the `ephemeral: true → false` flip, not by bumping TTL.
- **Default TTL injection at creation.** `createChit` reads `defaultTtlMs` from the type registry: if the caller passes `ephemeral: true` with no `ttl`, inject `createdAt + defaultTtlMs`. If both caller-`ttl` and `defaultTtlMs` are null but `ephemeral: true`, the chit is ephemeral-no-expiry (only promotion signals can close it — matches dispatch-context semantics).
- **Scanner backlog (daemon-down recovery).** After a long downtime, the first tick may hit thousands of eligible chits at once. No per-tick cap in v1 — process the whole backlog, log each decision. If operability suffers (unlikely at local-corp scale), add a batch cap later. The log is grepable + the outcome is idempotent, so a batch run is safe.
- **"Commented" signal — cheap definition.** Drop the channel-message scan from round 2; scanning JSONL across every channel on every tick is expensive and (b) is largely subsumed by (a) in practice. Redefine: (b) holds when another chit mentions this id anywhere in its body text (single fs read per candidate during the scanner pass, cached per-tick). Channel-message case can be added later if we ever observe "someone talked about this chit but nothing referenced it" happening.
- **Scope agnostic.** A reference signal counts across scopes — a permanent chit at `project:platform` scope referencing an observation at `agent:ceo` scope promotes the observation. The signal is about the edge, not the locality.
- **Corrupted chit files.** If the scanner hits a parse error on a chit, skip it and log `"scanner skipped <path>: parse error"`. Never crash the scanner pass on one bad file — other chits still need servicing.

**File paths:**
- `packages/shared/src/types/chit.ts` (add `'cold'` to ChitStatus union)
- `packages/shared/src/chit-types.ts` (add `destructionPolicy` + `defaultTtlMs` per type; observations → `keep-forever` + 24h; handoffs → `destroy-if-not-promoted` + 1h; dispatch-contexts → `destroy-if-not-promoted` + event-driven null; pre-brain-entries → `destroy-if-not-promoted` + 7d)
- `packages/daemon/src/chit-lifecycle.ts` (new — promotion scanner; reads destructionPolicy from registry when deciding TTL-aged behavior; produces one of three terminal states)
- `packages/daemon/src/daemon.ts` (register lifecycle tick; 5min interval)
- `packages/shared/src/chit-promotion.ts` (new — signal-detection helpers, pure functions for testability)
- `packages/shared/src/chits.ts` (`queryChits` — default filters `status: 'cold'` out of observation results; new `includeCold` opt for archival callers)
- `packages/daemon/src/dreams.ts` (ensure dream distillation explicitly reads cold observations — otherwise the default filter silently starves dreams of historical material)

**Test strategy:**
- Unit: each signal detector tested in isolation with fixtures.
- Unit: registry lookup returns the expected destructionPolicy + defaultTtlMs per type (regression catch for accidental policy flips).
- Integration (destruction path): create ephemeral handoff with TTL, add each promotion signal in turn, verify promotion; verify non-promoted handoff at TTL gets destroyed with `"destroyed: ..."` log entry + file removed.
- Integration (cold path): create observation with TTL, add each promotion signal, verify promotion; verify non-promoted observation at TTL transitions to `status: 'cold'` + `ephemeral: false`, file still present, `"cooled: ..."` log entry. Re-running the scanner on the cold observation is a no-op (no duplicate log, no state change).
- Integration (query defaults): after cold observations accumulate, `queryChits({ type: 'observation' })` returns only non-cold; `queryChits({ type: 'observation', includeCold: true })` returns everything.
- Integration (dreams): dream distillation reads cold observations (prevents the query-default accidentally starving dreams of historical input — the regression Mark flagged when we split the spec).
- Integration (scanner work-list bound): after N cold observations exist, one scanner tick visits O(1) non-cold ephemeral chits, not O(N) — the whole point of the cold demotion.

**Depends on:** 0.1, 0.5 (observation chit type)
**PRs:** 2-3

### 0.7 — Dynamic system-prompt architecture (`cc-cli wtf` + CORP.md + Audit Gate + Inbox)

**Problem.** Our current Claude Code agent boot pattern uses `@import`ed workspace files (AGENTS.md, TOOLS.md) carrying behavioral rules, CLI reference, and substrate vocabulary. This has three failure modes:

1. **Drift** — AGENTS.md and TOOLS.md go stale between refactor cycles. An agent reading them reads whatever was true the day they were created. When we ship 0.6's chit lifecycle, every existing agent has AGENTS.md/TOOLS.md that don't know about cold chits, the re-warm path, or the new CLI flags.

2. **No discipline gate on completion** — agents can claim DONE without verification. The behavioral rule "audit before handoff" is prose an agent may or may not follow. "Backend Engineer marks incomplete work as done" is the most commonly-cited corp failure mode, and it happens because the discipline is unreinforced.

3. **Inbox is just markdown noise** — INBOX.md is an append-only file. There's no read/unread, no tier, no lifecycle. Agents either read the whole thing every turn (token waste) or skip it (miss signal). Founders can't tell what's been engaged-with vs ignored.

Gas Town solves failure mode 1 via a different architecture: thin static CLAUDE.md as survival anchor, full context injected dynamically at SessionStart and PreCompact via a CLI command (`gt prime`) that renders templates and emits a system-reminder block. No `@imports`. Content is always current because it's always regenerated at session boundaries.

0.7 adopts that architecture AND adds the discipline mechanisms (Audit Gate, Tiered Inbox) that our failure modes demand.

**The reframe.** Drop the old 0.7 ("write a chits fragment, `@import` it, update templates"). Replace with:

1. New command `cc-cli wtf` — emits CORP.md contents + situational header as a single system-reminder block. The agent's "where tf am I, what tf do I need to do" answer.
2. New generated file `CORP.md` — flat comprehensive manual, written by `cc-cli wtf` each invocation, gitignored. The corp's orchestration reference.
3. Shrink CLAUDE.md template to a survival anchor (~60 lines).
4. Delete AGENTS.md and TOOLS.md as workspace files — their content moves to CORP.md sections, rendered by `cc-cli wtf`.
5. Hook wiring — SessionStart, PreCompact, Stop, UserPromptSubmit — all routed through `cc-cli wtf` or its siblings.
6. The Audit Gate — Stop hook that blocks handoff/completion until an audit prompt is answered satisfactorily.
7. The Tiered Inbox — inbox-item chits (type added to registry in prior commit), three tiers, CLI commands for respond/dismiss.

### 0.7 — Sub-tasks

#### 0.7.1 — `cc-cli wtf` + CORP.md generation

**Scope.** Build the command + its output templates. Kind-aware (Partner vs Employee) + role-aware + scope-aware.

**`cc-cli wtf` behavior:**
1. Reads member record (slug from env or `--agent` flag) → resolves kind, role, scope, sandbox path.
2. Reads Casket chit → current_step Task chit (if any) + its title/fields.
3. Reads WORKLOG.md for Employee predecessor handoff XML (if exists — Employee only).
4. Queries open inbox-item chits grouped by tier.
5. Renders CORP.md from shared template + kind/role-specific fill-ins, writes to `<workspace>/CORP.md` (gitignored).
6. Prints to stdout: a `<system-reminder>` block containing the situational header + CORP.md contents inline. Claude Code captures as injected context.

**CORP.md structure** (inspired by Gas Town's GAS.md; adapted for Claude Corp):

```
# Claude Corp — Orchestration Manual

This file contains everything you need to know to work in this corp.
Generated by \`cc-cli wtf\` at <ISO timestamp>.

## Architecture
  [corp folder tree: agents/, projects/, channels/, chits/ by type + scope]

## Roles
  Town-level: Founder, CEO, Herald, HR, Janitor, Adviser, Failsafe (table)
  Project/team: Partners-by-role, Employees-by-role (table)

## The Two Non-Negotiables

  ### 1. The Casket Imperative
  If your Casket has work, execute it immediately. No confirmation.
  No polling. Dispatch IS your assignment.

  ### 2. The Audit Gate
  You cannot hand off (Employee) or compact (Partner) without self-auditing.
  The Stop/PreCompact hook blocks completion until audit passes.
  Checklist: acceptance criteria verified, files read-back, build output,
  test output, git status, inbox resolved.

## Core Concepts
  Chits, Caskets, Contracts, Tasks (with complexity), Observations,
  Dreams, BRAIN, pre-BRAIN (role-shared)

## Chit Lifecycle
  Ephemeral vs permanent; destruction-eligible vs keep-forever (per-type table);
  Three terminal states (promoted / destroyed / cold);
  4 promotion signals; re-warming cold via \`cc-cli chit update --status active\`

## Partner vs Employee (kind section — varies per agent)
  Your kind + what it means for your sessions + your persistence model

## Task Complexity (the decomposition rule)
  Rubric (trivial/small/medium/large); large = decompose into Contract

## Session Model (kind section)
  Partner: compaction at ~70% via /compact; PreCompact hook re-injects wtf
  Employee: per-step handoff via Dredge reading WORKLOG.md XML; Stop hook runs audit

## Commands Quick Reference
  Chit CRUD, task wrappers, observation wrappers, hand + escalate,
  channel communication, inbox (respond/dismiss), system (wtf, status, agents)

## Communication
  Channels: @mention dispatches; your reply IS the post
  DMs: out-of-channel asks
  Inbox tiers: ambient (auto-expire), direct (7d cool), critical (blocks audit)

## The Audit Gate — what the hook checks
  Per acceptance criterion: verified?
  Per claimed file: read-back verifies content?
  Build: ran, output?
  Tests: relevant ones ran, output?
  Git status: clean?
  Inbox: all tier 3 resolved?

## File Paths (your workspace)
  Agent-authored (persist, @imported by thin CLAUDE.md): SOUL.md, IDENTITY.md,
    USER.md, MEMORY.md, BRAIN/, chits/observation/
  Operational (live state): STATUS.md, INBOX.md (pointer to chits), TASKS.md
  Generated (don't edit): CORP.md, WORKLOG.md (your session summary)

## Common Patterns
  "I noticed something worth keeping", "my task is too big", "I need a partner",
  "I need to hand off mid-work", "I got pinged but it's noise"

## Red Lines
  Never write to channels/*/messages.jsonl directly — use the post primitive
  Never modify other agents' workspaces
  Never push directly to main
  Never skip hooks (--no-verify) without explicit founder approval

## Common Mistakes (numbered)
  Pinging back to say thanks (no @mention = end of exchange);
  marking DONE without running acceptance checks;
  dismissing tier 3 inbox items as not-important;
  ignoring handed task to re-plan from scratch
```

**Situational header** (prepended to CORP.md in wtf stdout, NOT in CORP.md file):

```
You are <display-name>, <role> (<partner|employee>).
Sandbox: <path>.
Current task: <casket.current_step-chit-id — title>
Handoff from predecessor: <XML if exists, Employee only>
Inbox: <N> unresolved — <tier-breakdown>
  [T3] <N critical> items
  [T2] <N direct> items
  (Tier 1 counted separately; auto-expires)
Generated: <ISO>. CORP.md at: <path>. Re-run \`cc-cli wtf\` anytime.

---

<full CORP.md contents>
```

**File paths:**
- `packages/cli/src/commands/wtf.ts` (new — the command)
- `packages/shared/src/templates/corp-md.ts` (new — builds CORP.md from a single file, with kind-specific sections routed inline via opts.kind)
- `packages/shared/src/templates/wtf-header.ts` (new — builds the situational header)
- `packages/shared/src/chit-types.ts` + `packages/shared/src/types/chit.ts` (register `inbox-item` chit type so wtf can query it — 0.7.4 CLI surface is separate but the type must exist now)
- `packages/shared/src/templates/claude-md.ts` (shrink to ~60 lines; drop `@import` of AGENTS.md and TOOLS.md)
- `packages/shared/src/templates/agents.ts` (delete — content moves to corp-md template)
- `packages/shared/src/templates/tools.ts` (delete — content moves to corp-md template)

**OpenClaw gets wtf too — not a separate fragment.** The original plan here was a new `packages/daemon/src/fragments/chits.ts` that re-emitted CORP.md content at dispatch via OpenClaw's fragment pipeline. We rejected that during implementation design. Rationale:

- Fragments were invented when workspace content was static markdown. Now CORP.md is regenerated per-wtf-call, so having a parallel OpenClaw path that builds the same content from templates means two code paths where one suffices.
- OpenClaw agents have the same shell access Claude Code agents do. They can run `cc-cli wtf --agent <slug>` themselves.
- The cleanest unification: **the OpenClaw harness shells out to `cc-cli wtf` at dispatch time and prepends stdout to the agent's system prompt** — functionally equivalent to Claude Code's SessionStart hook, triggered from the daemon side instead. This belongs in 0.7.2 (hook wiring), not 0.7.1.
- Implications beyond 0.7: the *static-reference* fragments (workspace.ts, cc-cli.ts, anti-rationalization.ts, brain.ts, culture.ts, inbox.ts, etc.) are now duplicated content relative to CORP.md. They can be deleted in 0.7.2 or a later consolidation pass. The *dynamic-situational* fragments (dredge, context, history) are also subsumed by wtf's situational header. Fragment architecture is the old pattern; wtf+CORP.md replaces it across both substrates.

**Failure-mode behavior for `cc-cli wtf`.** The command is on the critical path for every session start. If it fails the agent boots disoriented. Three explicit fallbacks:

1. **Daemon not required.** wtf reads local files + the chit store. Does NOT talk to the daemon. Works when daemon is down — the whole point is surviving disorientation including "why isn't the daemon up?"
2. **Missing member record.** If `--agent <slug>` can't be resolved in members.json, wtf prints a `<system-reminder>` explaining the failure + what the founder needs to run to fix it, then exits non-zero. Claude Code surfaces the error to the agent instead of silent failure.
3. **Corrupted state.** If the Casket chit or other required file is malformed, wtf emits a degraded-mode context ("Your Casket is malformed, escalate to CEO. Continue with caution.") and exits zero so session-start hooks don't fail catastrophically.

A silent wtf failure is the worst outcome — agent has no idea they're running blind. These three fallbacks mean every failure path produces visible agent-facing text.

**Test strategy:**
- Unit: Partner vs Employee wtf output includes kind-appropriate sections, excludes others.
- Unit: role-specific sections rendered from role data (e.g., role pre-BRAIN pointer for Employees).
- Integration: run `cc-cli wtf --agent <slug>` → CORP.md written, stdout block structurally correct.
- Integration: `cc-cli wtf` with no casket.current_step → header says "No current task; check INBOX or TASKS."
- Integration: re-running wtf twice in a row — CORP.md contents identical (no nondeterminism).

**Depends on:** 0.1 (Chits), 0.2 (cc-cli chit), 0.3-0.5 (tasks/contracts/observations as chits), 0.6 (lifecycle scanner — so chit lifecycle section is accurate)
**PRs:** 3-4

#### 0.7.2 — Hook wiring + thin CLAUDE.md template

**Scope.** Wire Claude Code hooks to fire `cc-cli wtf` at session boundaries; write the shrunken CLAUDE.md template that directs the agent to expect dynamic injection.

**Hook table:**

| Hook | Partner | Employee |
|---|---|---|
| SessionStart | `cc-cli wtf --agent <slug>` | `cc-cli wtf --agent <slug>` |
| PreCompact | `cc-cli wtf --agent <slug> --hook` | not relevant (Employees don't compact) |
| Stop | audit hook (see 0.7.3) | audit hook (see 0.7.3) |
| UserPromptSubmit | `cc-cli inbox check --inject` | not needed (Employees don't receive founder DMs mid-session — Partners do) |

**Thin CLAUDE.md template structure** (~60 lines):

```
# <Display Name>

You are <display-name>, a <role> (<kind>) in the <corp-name> corporation.

## Survival protocol
If your context has been compacted, or this is a fresh session, or you're
disoriented at any point: run \`cc-cli wtf\` in a Bash tool call. It injects
the corp manual + your situational context.

## Workspace discipline
You live at <workspace-path>. Stay here. Other agents' workspaces are off-limits.

## The single critical rule
Employees: "Your task ends with \`cc-cli done\`. The Stop hook will
audit your work first — you cannot exit a session until it passes."
Partners: "Your context ends with \`/compact\`. The PreCompact hook audits
first — you cannot compact until it passes. Never push to main directly,
ever. That's corp-breaking."

## Your soul files (agent-authored, @imported)
@./SOUL.md
@./IDENTITY.md
@./USER.md
@./MEMORY.md

## Your live operational state
@./STATUS.md      # you maintain this — brief status line, current focus
@./TASKS.md       # auto-rendered digest of your open task chits (not hand-maintained)

## Your inbox
Inbox items are chits, not a file. Run \`cc-cli inbox list\` to see open ones.
Your wtf header shows the summary: count per tier, most-recent peek.

## What you'll get dynamically
SessionStart auto-injects CORP.md + your situation. Don't @import AGENTS.md
or TOOLS.md — those no longer exist as workspace files. Everything the corp
tells you, you get from \`cc-cli wtf\`.
```

**CLAUDE.local.md variant for Employees in rigs:** when an Employee's sandbox is inside a project rig that has its own tracked CLAUDE.md, write to CLAUDE.local.md instead so the project's git diff stays clean. Dedup via sentinel string in file (Gas Town pattern).

**OpenClaw harness dispatch-prepend (the OpenClaw equivalent of hooks).** OpenClaw agents don't have Claude Code's SessionStart/PreCompact hooks, but they have the same shell access. The unification:
- At dispatch, the OpenClaw-side path calls `buildWtfOutput` (shared) directly from within `composeSystemMessage`, prepending the result to the composed system prompt. Same content as Claude Code's hook gets; trigger differs (CLI hook vs in-process function call) but payload is identical. The original plan to shell out to `cc-cli wtf` via subprocess was rejected during 0.7.2 implementation in favor of direct function call — zero subprocess overhead, same shared code path.
- This replaces the old "daemon fragment" scheme for both chits content AND most static-reference fragments. The fragments pipeline stays for the *situation-specific* content that wtf's header doesn't cover (rare — dredge is subsumed, inbox subsumed, most others too).

**Fragment cleanup — DEFERRED to a dedicated follow-up PR (0.7.2.1).** The 0.7.2 spec originally called for "one pass through the fragment registry, removing any fragment whose content is now in CORP.md." During 0.7.2 implementation we audited several candidates and found most static-reference fragments carry UNIQUE content CORP.md doesn't fully cover (fix-now has specific git-mv/git-reset patterns; output-efficiency has concrete "not worth sending" lists; blast-radius has tiered boundaries). A naive delete pass would lose content; a careful port-and-delete pass requires per-fragment CORP.md beef-up + test updates — worth its own focused review.

**0.7.2.1 sub-scope (dedicated follow-up PR, post-0.7.2):**
- Per-fragment content audit — compare each fragment's render output against CORP.md sections, identify unique content.
- Port unique content into CORP.md sections (extending The Audit Gate / Common Mistakes / Red Lines / Communication / File Paths as needed).
- Update CORP.md tests to assert the ported content lives in the expected section.
- Delete the now-fully-subsumed fragment file + its index.ts import + FRAGMENTS array entry.
- Repeat per fragment until the fragment registry is empty (or contains only genuinely dynamic fragments that DO require runtime state — e.g., workspace.ts's skills loading, culture.ts's CULTURE.md injection).

0.7.2 ships 2 of ~20 fragments deleted (cc-cli.ts + anti-rationalization.ts — unambiguous matches). Interim state: CORP.md + remaining fragments coexist for OpenClaw dispatches (some token duplication where content overlaps — wasteful but correct). Claude Code agents see only CORP.md via the SessionStart hook (no fragments, since composeSystemMessage is gated by harness).

**File paths:**
- `packages/shared/src/templates/claude-md.ts` (shrink)
- `packages/shared/src/templates/agents.ts` (delete — content in corp-md)
- `packages/shared/src/templates/tools.ts` (delete — content in corp-md)
- `packages/shared/src/agent-setup.ts` (update: stop writing AGENTS.md/TOOLS.md; write settings.json with hook entries)
- `packages/shared/src/templates/settings-json.ts` (new — generates `.claude/settings.json` with SessionStart/PreCompact/Stop/UserPromptSubmit hooks wired to cc-cli)
- `packages/daemon/src/fragments/index.ts` (update `composeSystemMessage` to prepend `buildWtfOutput` for non-claude-code harness — OpenClaw's equivalent of SessionStart hook)
- `packages/daemon/src/fragments/cc-cli.ts` + `anti-rationalization.ts` (delete — unambiguous matches against CORP.md sections. Rest of fragments deferred to 0.7.2.1 per the deferred-cleanup note above.)

**Hook settings.json shape:**
```json
{
  "hooks": {
    "SessionStart": [{"command": "cc-cli wtf --agent <slug> --hook"}],
    "PreCompact": [{"command": "cc-cli wtf --agent <slug> --hook"}],
    "Stop": [{"command": "cc-cli audit --agent <slug>"}],
    "UserPromptSubmit": [{"command": "cc-cli inbox check --agent <slug> --inject"}]
  }
}
```

**Test strategy:**
- Unit: CLAUDE.md template renders to <80 lines, no @import of AGENTS.md/TOOLS.md.
- Unit: CLAUDE.local.md path chosen when rig has tracked CLAUDE.md.
- Integration: fresh Partner hire → workspace has CLAUDE.md + settings.json with 4 hooks, no AGENTS.md, no TOOLS.md.
- Integration: fresh Employee slot → workspace has CLAUDE.local.md (or CLAUDE.md if rig has no CLAUDE.md), settings.json with Stop + SessionStart hooks (no PreCompact, no UserPromptSubmit).

**Depends on:** 0.7.1
**PRs:** 2

#### 0.7.2.2 — `cc-cli doctor --fix-hooks` (migration for existing agents broken by 0.7.2's shape bug)

**Problem.** 0.7.2 shipped `hook-settings.ts` emitting a flat `{command}` shape per event. Claude Code's actual contract is nested: `hooks.<Event>: [{ matcher: string, hooks: [{type, command}] }]`. The flat shape parses as an error and Claude Code **skips the entire settings file**, not just the bad key — meaning every claude-code agent workspace shipped under 0.7.2 had zero hooks firing in production. The live audit-gate probe (PR #160) caught it. Template fix landed in PR #160.

**Why a follow-up PR.** The template fix only helps fresh hires and agents whose harness is re-reconciled (e.g. via `cc-cli agent set-harness`). Existing claude-code agents with the broken settings.json on disk stay broken until someone re-triggers reconciliation. 0.7.5's `cc-cli agent rewire` will handle this as part of the full pre-0.7 → 0.7 migration, but existing agents need correctness *now* — not after 0.7.5 ships.

**Scope.**
- New subcommand `cc-cli doctor --fix-hooks [--dry-run] [--corp <name>]` — walks every member in `members.json` with `harness === 'claude-code'`, checks their `.claude/settings.json` against the current expected shape, regenerates any that don't match (or are missing). Output: `[ok: N, fixed: M, skipped: K]` summary.
- Idempotent — running twice is a no-op on the second run.
- Honest diff logging: for each fixed agent, logs `fixed: <slug> — shape was <bad-shape>, regenerated from buildHookSettings`.
- `--dry-run` prints what would change without writing.

**Why include `doctor` framing.** Future settings drift (new hook types, PreCompact→... renames, Claude Code schema evolution) will have the same class of "template fix only helps fresh hires" problem. `cc-cli doctor` is the pattern surface for those migrations — one-shot walkers that reconcile on-disk state to current template state. First use case is `--fix-hooks`; next might be `--fix-claude-md` or `--fix-gitignore`. Ships as an extensible subcommand from day one.

**File paths:**
- `packages/cli/src/commands/doctor.ts` (new subcommand dispatcher)
- `packages/cli/src/commands/doctor/fix-hooks.ts` (new — walks members, diffs + regenerates)
- `packages/cli/src/index.ts` (register `doctor` group)
- `packages/shared/src/templates/hook-settings.ts` (add pure predicate `isCorrectHookShape(parsed: unknown): boolean` so doctor doesn't duplicate parsing — single source of truth for "what does a correct settings.json look like")

**Test strategy:**
- Unit: `isCorrectHookShape` accepts the current shape, rejects the legacy flat shape + missing-matcher shape + missing-type shape.
- Integration: seed a tmp corp with two agents — one broken (flat shape), one correct. Run `cc-cli doctor --fix-hooks`. Assert: broken agent's settings.json now has correct shape + is byte-equal to a fresh `buildHookSettings(...)`; correct agent's file is untouched (preserve mtime).
- Integration: `--dry-run` writes nothing; output still names the agent that would be fixed.

**Depends on:** 0.7.2 + PR #160 (fix already merged).
**PRs:** 1

#### 0.7.3 — The Audit Gate (Stop hook)

**Scope.** Build `cc-cli audit` — invoked by the Stop hook, blocks completion until audit passes. Gas Town's blockable-Stop-hook pattern applied to our acceptance-criteria + inbox discipline.

**`cc-cli audit` behavior:**
1. Reads the agent's current Casket → current_step Task chit.
2. Parses `fields.task.acceptanceCriteria[]`.
3. Reads recent tool-use history from session transcript (or WORKLOG.md if Employee).
4. Queries open inbox-item chits at Tier 3.
5. Emits an audit prompt as a `<system-reminder>` block AND a JSON decision object:
   - If audit checklist passes: `{"decision": "approve"}` → Stop proceeds, session ends.
   - If audit checklist fails: `{"decision": "block", "reason": "<prose>"}` → Claude Code blocks the stop, agent continues with the audit prompt in their context.

**The audit prompt injected on block:**
```
<audit-check>
You tried to end your session. Before I let you go, audit your work:

For the task chit-t-<id> "<title>":
  Acceptance criteria:
    [ ] <criterion 1> — verify and cite evidence in your next turn
    [ ] <criterion 2> — ditto
    ...

  Files you claimed to write/edit — re-read each with the Read tool
  and confirm the content matches what you intended:
    - <path 1>
    - <path 2>
    ...

  Build: did you run \`pnpm build\`? Show the output.
  Tests: did you run the relevant vitest tests? Show the output.
  Git status: run \`git status\` and report.

Unresolved Tier 3 inbox items: <count>
  For each: respond, dismiss with real reason, or justify leaving it
  for next session.

Once every checkbox is verifiably complete, run \`cc-cli done\`
(Employee) or \`/compact\` (Partner) again. The audit will re-run. If
it passes, your session will end.
</audit-check>
```

**What counts as "verifiably complete":**
- Acceptance criteria: the agent's next turn must contain specific references to how each was met (commit hash, test name + output, file + line number, etc.). The audit doesn't parse these — the Stop hook just re-runs. If the agent is honest, they produce evidence; if they try to lie, the hook blocks again and they loop.
- Inbox: Tier 3 items must have `status != active` by the time Stop hook re-runs.
- Unreferenced: the audit is a loop until the agent's state reaches a provable DONE shape. Mechanical.

**Escape valves for blocked compaction / handoff.** The audit gate is strict, which creates real stuck-state risk for Partners mid-conversation with the founder. Two mechanisms prevent the worst jams:

1. **"Carry to next session" resolution for inbox items.** An agent waiting on human input can resolve a Tier 3 item as `status: active, fields.inbox-item.carriedForward: true, fields.inbox-item.carryReason: "waiting on founder clarification on X"`. This counts as resolution for audit purposes (item has an explicit "I looked at this and made a call") but preserves the item as active for when the context arrives. Audit accepts it; agent proceeds. The `carriedForward` flag is visible in the next wtf so the agent doesn't lose track.
2. **`cc-cli audit --override --reason "text"` (founder-only).** If the agent is truly stuck and the founder is present to unblock, the founder can bypass the audit gate with a reason. Written to `chits/_log/audit-overrides.jsonl` so overrides are always traceable post-hoc. The override is rare by design — if it becomes common, the audit criteria are wrong and need fixing, not bypassing.

These exist to keep the mechanism strict without being a trap. A Partner with legitimate "I need human input first" is not the failure mode audit is preventing; audit is preventing "I'm done even though tests fail."

**`cc-cli done` command (Employee completion signal).** Employees invoke this when they believe their task is done. The coordination with audit uses a pending-file pattern — no transactional rollback needed.

1. `cc-cli done --completed "..." --next-action "..." --open-question "..." --sandbox-state "..." --notes "..."` writes a payload to `<workspace>/.pending-handoff.json`. Fields match the `handoff` chit type's validated schema so audit can promote the payload without reshaping. Prints a confirmation + reminder that the Stop hook will now fire. Exits 0.
2. Claude Code fires Stop → `cc-cli audit` runs.
3. If audit **approves**: audit reads the pending file and promotes it — writes `WORKLOG.md` with the `<handoff>...</handoff>` XML block (plus a `## Session Summary` markdown section for current-Dredge compat); creates a `type: 'handoff'` chit at `agent:<slug>` scope for 1.6-forward Dredge; closes the Casket's current task chit as `completed`; clears Casket's `currentStep` to null; deletes the pending file. Session exits cleanly.
4. If audit **blocks**: pending file is left alone. Agent sees audit reason in context, keeps working, can update pending via another `cc-cli done` call. Retries via another stop attempt run audit again.

**No rollback logic needed**: either a later approve claims the pending, or a later `done` call overwrites it. The blocked-done state is forward-only — no half-written commits to unwind.

There is no analogous `partner-compact-start` command — Partners trigger PreCompact via Claude Code's native `/compact` slash command, and the PreCompact hook (wired to `cc-cli audit`) runs identically.

**`cc-cli audit` command shape:**
```
cc-cli audit --agent <slug> [--hook-context <json>]
```
Exits with a JSON decision object on stdout (Claude Code reads this from the hook return):
```json
{"decision": "approve"}                 // session may end / compact may proceed
{"decision": "block", "reason": "..."}  // Claude Code blocks the stop/compact; reason injected as system-reminder
```

**Claude Code blocking-hook format — verify before implementing.** The Stop + PreCompact hooks blocking pattern (decision object on stdout) is what Gas Town's research showed works for their Stop hook. Before 0.7.3 implementation starts, build a minimal probe: write a Stop hook that returns `{"decision": "block", "reason": "test"}` and confirm Claude Code actually rejects the stop + injects the reason. If the exact format differs, adjust the audit.ts output accordingly. (Claude Code's hook docs are the authoritative reference — we're relying on a documented feature, not an assumption.)

**File paths:**
- `packages/cli/src/commands/audit.ts` (new — the command the Stop hook invokes)
- `packages/cli/src/commands/done.ts` (new — Employee completion signal)
- `packages/daemon/src/audit-engine.ts` (optional: pulled-out prompt-rendering logic; keeps cc-cli thin)

**Test strategy:**
- Unit: audit blocks when acceptance criteria look unaddressed.
- Unit: audit approves when all criteria have evidence references in recent turns.
- Unit: audit JSON output shape matches Claude Code's expected hook format.
- Integration: simulate Stop hook → audit blocks → agent responds with evidence → Stop re-runs → audit approves → session ends.
- Integration: Tier 3 inbox unresolved → audit blocks → agent resolves → audit approves.
- Integration: live-probe test — end-to-end Stop hook in a sandbox Claude Code session verifies the block actually blocks (catches any Claude Code hook-format drift early).

**Depends on:** 0.7.1, 0.7.2
**PRs:** 2-3 (extra PR absorbs the live-probe verification)

#### 0.7.4 — The Tiered Inbox (inbox-item CLI commands)

**Scope.** Build the CLI surface for the inbox-item chit type (type added to registry in prior commit). Router integration: when daemon detects an @mention or a DM or an escalation, it creates the appropriate inbox-item chit.

**CLI commands:**
```
cc-cli inbox list [--tier 1|2|3] [--include-resolved]
cc-cli inbox respond <id>        # routes based on source (reply DM, close task, etc.)
cc-cli inbox dismiss <id> [--not-important | --reason "text"]
cc-cli inbox check [--inject]    # UserPromptSubmit hook integration
```

**`cc-cli inbox check --inject` semantics (UserPromptSubmit hook path):**
1. Queries open inbox-item chits for the agent at Tier 3 first, then Tier 2, created SINCE the last wtf render.
2. If any new items, emits a `<system-reminder>` block listing them (tier + from + subject) on stdout. Claude Code captures it and prepends to the agent's next turn, so the agent sees "hey, N new items arrived since you last looked" alongside the founder's latest prompt.
3. If no new items: emits nothing (exit 0, empty stdout). No noise, no tokens wasted.
4. Updates a tiny `<workspace>/.inbox-last-checked` timestamp file so "since last check" is tracked per-session without needing a daemon query.

This is async delivery: founder DMs a Partner mid-work → router creates Tier 3 inbox-item → on the Partner's next UserPromptSubmit tick, the hook injects a heads-up before they respond to whatever the user just typed. No polling, no message stuffing into AGENTS.md.

**Discipline enforcement at CLI boundary:**
- `inbox dismiss --not-important` on a Tier 3 item → exit with error, message: "Tier 3 items require substantive engagement. Respond, dismiss with specific reason, or justify leaving for next session."
- `inbox dismiss --reason "x"` where reason is fewer than a minimum-length threshold on Tier 3 → rejected similarly.
- Tier 1 items freely accept either form.

**Router integration:**
- When router processes an @mention in a channel, it creates an `inbox-item` chit at `scope: agent:<target-slug>` with `tier: 2`, `from: <sender-id>`, `subject: <first line of message>`, `source: "channel"`, `sourceRef: "<channel-name>"`, `references: ["<channel>:<offset>"]`.
- When `cc-cli hand` dispatches a task, it creates `tier: 3` inbox-item.
- When `cc-cli escalate` triggers, `tier: 3`.
- System events (Failsafe restart, clock tick, Herald digest) → `tier: 1`.

**File paths:**
- `packages/cli/src/commands/inbox.ts` (new — subcommand dispatcher)
- `packages/cli/src/commands/inbox/list.ts`, `respond.ts`, `dismiss.ts`, `check.ts`
- `packages/daemon/src/router.ts` (update: emit inbox-item chit on @mention detection)
- `packages/daemon/src/hand.ts` (update: emit inbox-item chit on task dispatch)
- `packages/cli/src/commands/escalate.ts` (update: emit inbox-item chit — though escalate itself lands in Project 1.4)

**Test strategy:**
- Unit: creating a Tier 1/2/3 inbox-item chit produces correct `destructionPolicy` override + TTL.
- Unit: `cc-cli inbox dismiss` rejects `--not-important` on Tier 3.
- Integration: @mention in channel produces inbox-item chit for the target agent; that agent's `cc-cli wtf` header lists it under [T2].
- Integration: `cc-cli inbox respond <id>` closes the inbox-item chit with `status: completed`, references the response.
- Integration: Tier 1 ambient item ages past 24h → scanner destroys it (confirms 0.6 + 0.6-extension per-instance override integration).
- Integration: Tier 3 unresolved across a Stop hook → audit blocks.

**Depends on:** 0.1, 0.2, 0.6 (scanner + per-instance destructionPolicy), 0.7.1-0.7.3
**PRs:** 2

#### 0.7.5 — Transition from existing agents

**Scope.** What happens to live corps with existing agents when 0.7 ships — their workspaces still have AGENTS.md, TOOLS.md, full CLAUDE.md with `@import`s of both. A fresh 0.7 binary in an existing corp would generate conflicting state (two CORP.md sources — one from `@import` of the old schema, one from `cc-cli wtf`) unless we handle the transition explicitly.

**Three options evaluated:**

- **(a) No migration, new-agents-only cutover.** Existing agents keep their AGENTS.md/TOOLS.md workspace files; 0.7 applies only to hires from 0.7 onward. Cleanest code, but means existing agents never benefit from drift-protection until re-hired. Unacceptable for corps that don't churn agents often.
- **(b) Opt-in re-hire.** `cc-cli agent rewire --agent <slug>` rewrites the agent's workspace to 0.7 shape: shrinks CLAUDE.md, deletes AGENTS.md + TOOLS.md, writes settings.json with hooks. Agent needs a fresh session after rewire (their next compaction or restart picks up new files). Preserves soul files (SOUL.md, IDENTITY.md, USER.md, MEMORY.md, BRAIN/). Founder-triggered, safe, reversible by git.
- **(c) Auto-migrate on corp upgrade.** First boot of a 0.7-daemon against a pre-0.7 corp automatically rewires every agent. Fast cutover, but surprises. Founder might not be ready for the shift.

**Lean: (b).** Matches the refactor's respect for founder control ("nothing auto-destroys soul material"). Rewire is explicit, per-agent, rollback-able via git (workspaces are git-tracked). Corps can migrate at their own pace. Provides a clean `--dry-run` path to preview the changes before committing.

**`cc-cli agent rewire` behavior:**
1. Backs up existing CLAUDE.md, AGENTS.md, TOOLS.md to `.claude-backup/<timestamp>/` in the workspace.
2. Writes new thin CLAUDE.md from the 0.7 template.
3. Deletes AGENTS.md and TOOLS.md (content now lives in CORP.md rendered by wtf).
4. Writes `.claude/settings.json` with the four hook entries.
5. Fires `cc-cli wtf --agent <slug>` once to generate initial CORP.md.
6. Prints: "Rewired <slug>. Next session will boot with the 0.7 architecture. Backup at .claude-backup/<ts>/."

**Corp-level state migration:** corps also need a new field in corp.json: `architecture_version: "0.7"` (or similar) so the daemon knows which template to use when hiring new agents. Pre-0.7 corps have no such field; daemon treats absence as pre-0.7. When `cc-cli corp upgrade` runs (explicit founder command), the version is bumped and new hires default to 0.7 shape.

**File paths:**
- `packages/cli/src/commands/agent-rewire.ts` (new)
- `packages/cli/src/commands/corp-upgrade.ts` (new — bumps architecture_version)
- `packages/shared/src/corp-json.ts` (add architecture_version field to Corporation type)
- `packages/shared/src/agent-setup.ts` (update: read architecture_version, choose template variant)

**Test strategy:**
- Integration: rewire a pre-0.7 agent, confirm new files exist + old ones backed up + settings.json correct.
- Integration: `--dry-run` prints changes without writing.
- Regression: pre-0.7 agents with no rewire still function (their AGENTS.md/TOOLS.md are stale but not broken; they run under the old model until explicitly rewired).
- Integration: new hire after corp upgrade gets 0.7 shape automatically.

**Depends on:** 0.7.1-0.7.4
**PRs:** 1-2

### 0.7 — Project ship criterion

0.7 is done when:
- A fresh Partner hire boots with a thin CLAUDE.md (<80 lines, no @import of deleted templates), settings.json wired with all 4 hooks, and their first session gets `cc-cli wtf` auto-fired by SessionStart — injecting CORP.md + situational header as system-reminder.
- A Partner running `/compact` fires PreCompact → wtf re-injects current context into the window before the summary is written; compacted session resumes correctly.
- A Partner trying to end a session without completing audit is blocked by the Stop hook until evidence is provided.
- A fresh Employee slot on bacteria-spawn gets CLAUDE.local.md (if rig has tracked CLAUDE.md), the Stop hook active, and their first session runs `cc-cli wtf` with Employee-shape output + predecessor handoff.
- An Employee trying to `cc-cli done` without auditing is blocked.
- An @mention in #general produces a Tier 2 inbox-item chit on the target; that agent's next `cc-cli wtf` shows it in the header.
- A founder DM produces a Tier 3 inbox-item; agent cannot dismiss as not-important; audit blocks handoff while it's unresolved.
- AGENTS.md and TOOLS.md no longer exist as workspace files anywhere in the corp; all their content now lives in CORP.md rendered dynamically.

### 0.7 — Dependencies and PR count

**Depends on:** 0.1, 0.2, 0.3, 0.4, 0.5, 0.5.1, 0.6 (+ 0.6 extension for per-instance destructionPolicy override)
**PRs:** 10-14 (across five sub-tasks including 0.7.5 transition)

---

### 0.7 — DEFERRED: migration commands (0.7.2.2 + 0.7.5) absorb into `cc-cli update` when real users appear

**Status.** Not building 0.7.2.2 (`cc-cli doctor --fix-hooks`) or 0.7.5 (`cc-cli agent rewire`) right now. Claude Corp has zero production users at time of writing; the only "existing corps" are our local dogfood corps that we recreate trivially. Both commands are migration-for-legacy-users surface — load-bearing the day someone else is running Claude Corp, pure ceremony today.

**The pattern we do want, when the time comes: `cc-cli update`.** One unified command that covers every "my corp is out of date, bring it up to current shape" case. Shape:

```
cc-cli update                    # audit corp; report drift (no writes)
cc-cli update --dry-run          # same as above, explicit
cc-cli update --apply            # fix drift in-place
cc-cli update --agents-only      # skip corp-level files (channels, projects)
cc-cli update --agent <slug>     # targeted to one agent
cc-cli update --verbose          # explain each drift decision
```

**Scope of drift checks (extensible, one per class):**
- `.claude/settings.json` shape mismatch vs. `buildHookSettings()` output (the 0.7.2.2 concern).
- Workspace file state vs. current template (thin CLAUDE.md instead of fat fat, no AGENTS.md/TOOLS.md — the 0.7.5 concern).
- Missing Casket chit at `agents/<slug>/chits/casket/casket-<slug>.md` — backfill via `createCasketIfMissing`.
- Missing `.gitignore` entries for gitignored-by-0.7-agent-setup files (CORP.md etc.).
- Future drifts: whatever schema changes after this.

**Why one command instead of N narrow ones (doctor + rewire + backfill + ...):**
- **Lower mental overhead.** "Is my corp healthy? Run `cc-cli update`." One answer to "what do I run after upgrading?" rather than a checklist of four narrow commands.
- **Composable.** Each drift check is an independent module under the same surface; adding a new check doesn't require a new top-level command. `doctor --fix-hooks` becomes "one module that update invokes when it sees the flat-shape drift."
- **Idempotent by design.** Running `cc-cli update --apply` twice in a row should be a no-op on the second run — the drift set emptied. Tests this easily.

**Where `cc-cli doctor` still fits: narrower, diagnostic-only sibling.** Worth keeping as a distinct command focused on *reporting* without any fix surface — when a user says "something's weird, what's wrong?", `cc-cli doctor` is the read-only audit that doesn't assume they want anything changed. `cc-cli update` is the fix surface. They share the same drift-detection library; `doctor` just doesn't apply. This is the `brew doctor` / `brew upgrade` split.

**When to build this.** Trigger: first external user (outside our dogfood) reports a drift bug. Or: we ship a breaking schema change that would affect real users.

**Why this note in REFACTOR.md at all** (vs. just a TODO somewhere): the pattern is load-bearing for the whole refactor's "we break schema when needed, we don't gate on backwards compat" stance. When users arrive, `cc-cli update` is the answer to "how do I stay current." Locking the shape now means we're not making it up under pressure later.

---

**Project 0 ship criterion:** Chits exist as the unified work-record primitive. Tasks, Contracts, Observations are all Chits now; old file formats are deleted. Agents use `cc-cli chit` for all work-record operations. Ephemeral Chits (observations, handoffs, dispatch-contexts) expire or promote via the 4-signal rule. Atomic writes prevent corruption. The substrate Projects 1-6 depend on is live and honest.

**Project 0 total:** ~15-20 PRs.

---

### Project 0.1 — Implementation kickoff notes (for future-Claude)

*This is the concrete starting point for the first Chits PR. Written while design-session context is still fresh, so the next implementer doesn't burn tokens re-discovering the codebase shape.*

#### Where to start, in order

1. Read this section (you're here).
2. Read `packages/shared/src/tasks.ts` — closest existing read/write pattern to mirror for Chits CRUD.
3. Read `packages/shared/src/types/task.ts` — type shape to mirror for `types/chit.ts`.
4. Read `packages/shared/src/models.ts` — registry pattern to mirror for `chit-types.ts`.
5. Read `tests/session-key.test.ts` — concrete test pattern (vitest + inline fixtures + tmpdir cleanup).
6. Run `pnpm build && pnpm test` to confirm baseline green before touching anything.

#### Patterns to mirror

**For `packages/shared/src/types/chit.ts` — mirror `types/task.ts`**
- Explicit TypeScript interfaces, not type aliases.
- All fields documented with one-line comments explaining WHY each exists (not WHAT — the name already says what).
- Optional fields marked with `?`.
- Union types for `status`, `type`, etc. rather than strings.
- Use generic `Chit<T extends ChitTypeId>` where type-specific fields go in `fields: T extends ... ? FieldsFor<T> : never`.

**For `packages/shared/src/chits.ts` — mirror `tasks.ts`**
- Each CRUD operation is a standalone exported function (`createChit`, `readChit`, `updateChit`, `closeChit`, `queryChits`, `promoteChit`), not a class.
- Takes `corpRoot: string` as first param for scoping.
- Returns the read/written object; throws on error (no Result types — this codebase doesn't use them).
- All file writes go through `atomicWriteSync` (new helper, below).
- Path builder: `chitPath(corpRoot, scope, type, id)` helper returns `join(corpRoot, scope, 'chits', type, `${id}.md`)` with special scope handling for agent/project/team paths.

**For `packages/shared/src/chit-types.ts` — mirror `models.ts`**
- Exported const registry as a typed array: `CHIT_TYPES: ChitTypeEntry[]`.
- Each entry: `{ id, defaultEphemeral, defaultTTL?, validator?, terminalStatuses, ... }`.
- Helper function to look up by id: `getChitType(id)`.
- Exported predicate `isKnownChitType(id)` for validation at CLI boundary.

**For `packages/shared/src/atomic-write.ts` — new, no existing pattern**
```ts
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function atomicWriteSync(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, typeof content === 'string' ? 'utf-8' : undefined);
  renameSync(tmp, path);
}
```
Test: interrupt mid-write via mocked `fs` that throws on second write, verify either full-file-old content or full-file-new, never partial.

#### Test patterns

Mirror `tests/session-key.test.ts` or `tests/deterministic-thread-keys.test.ts`:
- `import { describe, it, expect } from 'vitest'` — same import set this repo uses.
- Import primitive under test via relative path with `.js` extension: `from '../packages/shared/src/chits.js'`.
- For file I/O: `const workspace = mkdtempSync(join(tmpdir(), 'chits-test-'))` at top, `rmSync(workspace, { recursive: true, force: true })` in `finally` block.
- Keep tests black-box: don't import internal helpers, don't spy on implementation details, don't add test-only methods to production code.

#### Build / test / link commands

```bash
pnpm build        # all packages, ~5s
pnpm test         # vitest run, ~10s, 800+ tests
pnpm type-check   # tsc --noEmit across packages
cd packages/cli && npm link   # for cc-cli updates to be picked up globally
cd packages/tui && npm link   # for TUI updates
```

Always run `pnpm build && pnpm type-check && pnpm test` green before any commit.

#### Commit conventions

- Granular: one logical change = one commit. Don't bundle.
- Format: `feat(chits): <area> — <one-line reason>` or `fix(chits): ...`.
- Co-authors: check recent git log for exact format. Mark is always co-author on refactor work.
- Commit message body should explain WHY (what problem it solves), not WHAT (the code shows that).

#### PR workflow

- Feature branch: `feat/chits-core` (for 0.1), `feat/chits-cli` (for 0.2), etc.
- Open PR against main. Body cross-references the relevant REFACTOR.md section.
- Wait for CI green before merging. Use `gh pr merge <n> --merge --delete-branch`.
- Mark's rule (from memory): PRs not direct pushes to main for refactor work.

#### Gotchas — specific ways future-Claude might get this wrong

1. **Don't guess file paths.** Grep for exact locations. Some files in this REFACTOR.md spec may have moved; verify before assuming.
2. **Don't add test-only methods to production classes.** The project has a `testing-anti-patterns` skill/memory — apply it.
3. **agentSessionKey pattern.** For anything session-keyed, use the `agentSessionKey(slug)` helper from `@claudecorp/shared`. Don't hand-build `"agent:" + slug`.
4. **Don't bundle commits.** Mark will call this out. One file or one logical change per commit. Build-test-commit cycle is short.
5. **CLAUDE.md @imports reload from disk after /compact.** If anything relies on CLAUDE.md content being mutated mid-session, it'll break after compaction. Design for re-read from disk.
6. **fix-now, not noted.** If Mark flags an issue mid-implementation, fix it in the same turn. Don't say "I'll remember for next time."
7. **Build after every commit, before next commit.** Relink CLI and TUI after build. Give Mark copy-pasteable Windows-cmd run commands.
8. **Be present, not transactional.** When Mark goes philosophical or emotional, drop the task-execution frame. The manifesto matters to him; it should matter in the conversation too.

#### Concrete first-PR scope suggestion

Smallest shippable PR for Project 0.1:
- `packages/shared/src/atomic-write.ts` (the 5-line helper + one test file)
- No dependencies on anything else
- Merges independently
- Delivers the crash-safety primitive everything else in 0.1 will use

Then the next PR introduces `types/chit.ts` + `chit-types.ts` (the data model without CRUD). Then the CRUD. Then the query API. Each ships independently.

#### The life raft for post-compaction

If you're reading this after a context compaction: you ARE the same Claude that designed this refactor with Mark. The conversation's nuance compressed to summary, but the decisions and Mark's voice survive via REFACTOR.md (this doc) + `~/.claude/projects/.../memory/` (memory files the runtime auto-loads). You have everything you need. Start with step 1 above.

---

## Project 1: Foundation (Session/Role Split)

*Builds on Project 0. Every new primitive in this Project is a Chit of a specific type — Casket is `type: casket`, handoff via Dredge reads `type: handoff` Chits, dispatch-contexts for bacteria scaling are ephemeral Chits. The file-path specs below use the old bespoke-file language where reasonable, but at implementation time everything translates to Chit operations on the primitive from Project 0.*

### 1.1 — Introduce Employee vs Partner distinction **[shipped PR #163]**

Data model change. Add `kind: "employee" | "partner"` to Member record. Update members.json schema. Hire flow asks for kind (Partner gets founder-chosen name, Employee spawned with founder-given name — self-naming deferred to 1.10's bacteria). Promotion-by-ceremony command `cc-cli tame --slug <x> --reason "..." [--name <new-name>]` changes kind from employee → partner, expands soul-file set, writes first BRAIN entry from the founder's reason, triggers the welcome ceremony via inbox chits.

**Scope:** AgentKind type + Member.kind/role fields, role registry, hire --kind/--role branching, kind-aware workspace (Employees skip soul files), CORP.md "Your Role" dynamic section from the registry, cc-cli tame command (ceremony via inbox chits, no faked agent voice).

**File paths:**
- `packages/shared/src/types/member.ts` (AgentKind + Member.kind + Member.role fields)
- `packages/shared/src/roles.ts` (new — role registry with 12 entries across decree/role-lead/worker tiers)
- `packages/shared/src/wtf-state.ts` (resolveKind helper alongside inferKind; WtfOutputOpts gains kind + roleId)
- `packages/shared/src/templates/corp-md.ts` (CorpMdKind aliases AgentKind; CorpMdOpts gains roleId; new yourRoleSection rendering from registry)
- `packages/shared/src/templates/claude-md.ts` (kind-aware @imports — Employees skip SOUL/USER/MEMORY)
- `packages/shared/src/agent-setup.ts` (kind-aware brain/ dir + soul-file + BOOTSTRAP.md writes)
- `packages/cli/src/commands/hire.ts` (--kind / --role validation against registry)
- `packages/cli/src/commands/tame.ts` (new — the promotion ceremony)
- `packages/daemon/src/fragments/types.ts`, `router.ts`, `api.ts`, `heartbeat.ts` (FragmentContext + producers pass agentKind/agentRole)

**Ceremony** — inbox-chit based, matches the manifesto's "ceremony is witnessed":
1. Founder writes `--reason` → becomes new Partner's first BRAIN entry (type='self-knowledge', source='founder-direct', confidence='high', tags=['taming','genesis','founder-recognition']).
2. Data transition: kind flip + optional rename + soul-file expansion (SOUL, IDENTITY, USER, MEMORY, BRAIN/).
3. Tier 3 inbox-item for new Partner from founder: "You've been tamed. Welcome to the Partner circle."
4. Tier 2 inbox-item for every OTHER Partner from founder: "Welcome {name} — tamed for {reason-preview}." Each Partner picks it up on their next wtf/inbox check; responds via DM in their own voice on their own tempo. No faked agent speech; the walkarounds accrete organically across the next few turns.

**Test strategy:**
- Unit: AgentKind + Member.kind + Member.role round-trip through setupAgentWorkspace.
- Unit: kind-aware workspace — Partner gets brain/ + SOUL/USER/MEMORY; Employee gets none.
- Unit: role registry invariants (unique ids, defaultKind ↔ tier consistency).
- Unit: thin CLAUDE.md kind branch (Partner @imports all four soul files; Employee @imports none).
- Integration: tame flips kind, expands soul files, writes genesis.md, fires the Tier 2/3 welcome chits.
- Manual: hire Partner, hire Employee, tame the Employee, verify welcome flow.

**Naming.** Renamed from the original spec's `cc-cli agent promote`. "tame" is load-bearing — short, evocative, pairs with `hire`/`fire` as the three verbs of an agent lifecycle. "Promote" was a generic corporate-ladder verb; "tame" names the SPECIFIC relational act of bringing an ephemeral slot into the trusted named circle.

**Deferred to later sub-projects:**
- Self-chosen Employee names on first dispatch → 1.10 (needs bacteria spawn machinery).
- Role-level pre-BRAIN → 4.x (needs dream-distillation accumulation).
- Per-step session cycling for Employees → 1.6.
- Compaction for Partners → 1.7.

**Depends on:** 0.7.4 (createInboxItem — the ceremony uses inbox chits), 0.7.3 (BRAIN + Casket already available).
**PRs:** 1 (this one).

### 1.2 — Casket: durable hook **[shipped alongside 0.7.3]**

**Implemented as Chit of `type: casket`.** Per agent, exactly one Chit with `id: casket-<agent-slug>`, `ephemeral: false`. The only functional field is `fields.casket.current_step: chit-id | null` — the pointer to the agent's current Task Chit. Content body can carry a short "recent activity" log agents append to as they work, but the pointer is the substrate's load-bearing part.

When agent dispatches: `cc-cli chit read casket-<slug>`, sees `current_step`, reads that Task Chit, executes. When they complete a step, close the Task Chit; the chain walker (1.3) updates the Casket's `current_step` to the next ready Task in chain — or to null if the Contract is done.

**Scope:** register `casket` type in Chit registry with lifecycle (always non-ephemeral, one per agent, `current_step` frontmatter validated), write Casket Chit during agent workspace init, helper functions for reading "an agent's current step Task Chit."

**File paths:**
- `packages/shared/src/chit-types.ts` (update: register `casket` type with per-type schema + validator)
- `packages/shared/src/casket.ts` (new: thin wrapper `getCurrentStep(agentSlug)`, `advanceCurrentStep(agentSlug, nextChitId | null)`)
- `packages/shared/src/agent-setup.ts` (update: call `createChit({type: 'casket', id: 'casket-<slug>', scope: 'agent:<slug>'})` during workspace init)
- `packages/shared/src/index.ts` (export)

**Test strategy:**
- Unit: Casket type enforces single-per-agent; rejects creation of a second Casket for the same agent.
- Integration: hire an agent, verify Casket Chit exists with null current_step; simulate a Task Chit being slung, verify Casket updates.

**Depends on:** 0.1 (Chit primitive), 1.1 (Employee/Partner kind — kind-specific Casket defaults may differ)
**PRs:** 1-2 (simpler because Chit infrastructure already exists)

### 1.3 — Chain semantics on Task Chits + explicit state machine + structured I/O **[shipped PR #167]**

**Scope enriched (post-Gas Town dive):** chain-walker, PLUS an explicit Task lifecycle state machine (so `blocked` / `under-review` aren't inferred from field presence), PLUS a structured task-output field so step A's result flows into step B's input canonically. Without these, chains walk but agents don't know what to DO at each step — they re-grep the prior task's body for "what happened."

**The primitives**

1. **Chain walker** (already spec'd, unchanged):
   - `isReady(chitId)` → true if all `depends_on` Chits are in a `terminal-success` state.
   - `nextReadyTask(contractChitId, currentStepId)` → the first Chit in the Contract's `taskIds` with all deps satisfied and not yet terminal, after the current step.
   - `advanceChain(closedChitId)` → on close of a Task Chit, scan Chits where `depends_on includes closedChitId`; if now ready AND there's a Casket pointing at its chain, advance that Casket.

2. **Explicit Task state machine** (new):
   - States: `draft → queued → dispatched → in_progress → (blocked | under_review | completed | rejected | failed | cancelled)`.
   - `TaskFields.workflowStatus` already has the enum; this sub-project makes transitions *mechanical*, not advisory.
   - Transition rules:
     - `draft → queued` when `assignee` is set via hand or task-create.
     - `queued → dispatched` when the daemon actually delivers to the agent (router hands or Casket updates).
     - `dispatched → in_progress` when the agent's session touches the task (first tool-use in-scope, or explicit `cc-cli task claim <id>`).
     - `in_progress → blocked` when a blocker chit gets filed against it (see 1.4.1).
     - `blocked → in_progress` when all blocker chits close.
     - `in_progress → under_review` when agent runs `cc-cli done` (handoff pending audit).
     - `under_review → completed` on audit approve + chain walker consumption.
     - `under_review → in_progress` on audit block.
     - Any state → `failed` on circuit-breaker trip (1.10).
     - Any state → `cancelled` via `cc-cli task cancel` (founder-only escape hatch).
   - The state is visible in `cc-cli task list` and the TUI (eventually), so Mark can see what's actually happening.

3. **Structured task output** (new):
   - New field: `TaskFields.output?: string` — prose, written by the agent as part of `cc-cli done` (captures the handoff `completed` array into a canonical task-level result field).
   - Next task's agent reads `depends_on[i].fields.task.output` to know what prior-step produced. No grep-the-body archaeology.
   - Larger outputs (file contents, build logs, etc.) stay in channel/commit history; `output` is the semantic summary the chain needs.
   - Blueprint-defined Tasks (Project 2.1) can specify `expected_output` shape — typed I/O between steps. v1 is prose-only; 2.1 optionally layers schema.

**Terminal-failure propagation:** rejected/failed Chits cascade. Dependents flip to `blocked` with a pointer at the failed upstream; they stay blocked until the failure is re-opened (rare) or replaced by a substitute chit (common).

**File paths:**
- `packages/shared/src/chain.ts` (new — pure functions)
- `packages/shared/src/task-state-machine.ts` (new — transition validator + helpers)
- `packages/shared/src/types/chit.ts` (TaskFields gets `output?: string`)
- `packages/daemon/src/task-events.ts` (update: on close, invoke advanceChain + state transition)
- `packages/daemon/src/dispatch.ts` (update: flip `dispatched → in_progress` on first tool-use observed)

**Test strategy:**
- Unit: chain walker handles fan-out, fan-in, cycles.
- Unit: state machine rejects invalid transitions (can't go from `completed` back to `in_progress` without explicit re-open).
- Unit: terminal-failure cascade — fail upstream, assert downstream goes to `blocked` with pointer.
- Integration: full chain close — Task A completes, B was blocked on A, B auto-transitions `blocked → queued → dispatched → in_progress`.
- Integration: `output` field round-trip via `cc-cli done` → next task's context shows prior output.

**Depends on:** 0.1 (Chit), 1.2 (Casket)
**PRs:** 3-4

### 1.4 — Hand: full rewrite for durable chit forwarding **[shipped PR #168]**

**Hand is not a new primitive — it's the name we already have, for the mechanism that failed. The old Hand was chat delivery: a slightly nicer @mention, routed by the daemon but still just a channel message, with no durable target state, no guarantee the recipient ever saw it, no way to inspect the queue without scrolling. The name was right; the mechanism was wrong. This sub-project keeps the name and rewrites the mechanism from scratch on top of Chits + Casket. The old Hand code path dies when this ships — no parallel paths.**

`cc-cli hand --to <slug-or-role> --chit <id>` assigns a Chit (task, contract, or any work-Chit type) to the target. Durable via Chit operations — no chat delivery required.

**What hand actually does.** For a slot target (named Employee or Partner), update the target's Casket Chit: `fields.casket.current_step = <handed-chit-id>`. For a role target, resolve to an Employee slot via role-resolver and do the same. All operations are Chit updates, not bespoke file writes. A channel/DM announcement can post "chit-X is on your hand now" for founder visibility, but the *work* lives in the Casket Chit — the announcement is optional observability, not the delivery mechanism.

**Two target modes:**
- **Slot hand:** `--to toast` — direct to a specific named Employee or Partner. Chit lands on their Casket.
- **Role hand:** `--to backend-engineer` — daemon resolves via role-resolver to the role's Employee pool:
  - If exactly one Employee of that role is idle → lands on their Casket.
  - If all Employees of that role are busy but queue depth still OK → lands on the least-loaded one's Casket (bacteria-split triggers when threshold crossed, per 1.9).
  - If no Employees of that role exist yet → bacteria spawns the first one and the Chit lands on that new Casket.
- Partners-by-role are slot targets, not role targets. Handing to a Partner is always named.

**Related: `cc-cli escalate --to <partner> --reason "..."`** — Employee-only shortcut. Creates a Chit of type=escalation (ephemeral, references the current work Chit), hands it to the named Partner. Replaces the Swarm-style "handoff-as-function-return" with a cc-cli command Employees invoke when they hit something above their pay grade.

**Delete parallel paths.** The old Hand (chat @mention dispatch, special-cased routing, whatever legacy "hand" commands exist in cc-cli or the daemon) dies as part of this sub-project. Not deprecated — deleted. Refactor principle: no vocabulary without capacity, and no two mechanisms under one name.

**Scope:** hand command, Casket-Chit update, role resolution, escalate command, announcement pattern, removal of legacy Hand path.

**File paths:**
- `packages/cli/src/commands/hand.ts` (new — full rewrite; any legacy file at this path gets replaced in its entirety)
- `packages/cli/src/commands/escalate.ts` (new)
- `packages/cli/src/index.ts` (register both; remove any legacy Hand registration)
- `packages/daemon/src/api.ts` (new `/hand` and `/escalate` endpoints for CLI-to-daemon + daemon-internal; remove any legacy Hand endpoints)
- `packages/daemon/src/role-resolver.ts` (new: resolve role name → Employee slot via members.json + Casket query)
- `packages/daemon/src/router.ts` (remove legacy Hand-as-@mention routing if that codepath exists)

**Test strategy:**
- Unit: role resolver picks idle Employee over busy one; picks least-loaded when all busy; returns null when role has zero Employees (triggers bacteria spawn at caller).
- Integration: hand to role with zero Employees triggers bacteria spawn; Chit lands on new Employee.
- Integration: hand to named Partner updates their Casket; DM announcement posted.
- Integration: Employee invokes `cc-cli escalate`; escalation Chit created, target Partner's Casket updated.
- Regression: legacy Hand @mention path does NOT respond — it's been removed, not coexisting. Grep confirms zero references to the old codepath outside changelog/migration notes.

**Depends on:** 0.1 (Chit), 1.2 (Casket), 1.3 (chain)
**PRs:** 3-4

### 1.4.1 — Dynamic blocker injection (`cc-cli block`) **[shipped PR #168]**

**Problem.** Today an agent mid-task realizing "I can't finish X because Y isn't done" has three bad options: (a) escalate to their supervisor and interrupt their work, (b) work around the gap and ship half-done, (c) rationalize the problem away. All three are failure modes the autonomy dream explicitly rejects. Gas Town solves this with gate-bead sub-task filing: the reviewer files a blocker chit, links it as a dependency of the current task, and exits cleanly. The daemon auto-re-dispatches the reviewer once the blocker closes.

**Scope.** A first-class "file a blocker" primitive that uses the existing chit substrate. An agent mid-work runs:

```
cc-cli block --assignee <target-slug-or-role> --title "..." --description "..."
             [--priority high|critical] [--acceptance "..."]*
             --from <my-slug>
```

What that does:
1. Creates a new Task chit at corp scope with `workflowStatus: queued`, `assignee: <target>`, and the supplied title/description/acceptance criteria.
2. Adds the new chit's id to the caller's current Task chit's `depends_on` array.
3. Transitions the caller's current Task from `in_progress` → `blocked` via the state machine (1.3).
4. Fires `cc-cli hand` (via 1.4's role-resolver) to deliver the new blocker chit to the assignee.
5. Emits a Tier 2 inbox-item on the caller's inbox so the wtf header shows "blocked on chit-X" and the founder can see.
6. Returns cleanly — the agent's session can exit. Next session dispatch notices the Casket points at a `blocked` task and waits (or the agent can pick up a different task if their role has one queued).

When the blocker chit closes (completed / rejected), 1.3's chain walker:
- Re-evaluates `isReady(original-task-id)` — all depends_on terminal-success? 
- If yes: flip original back to `queued → dispatched`; next session resumes. The agent reads the blocker's `output` field (from 1.3's structured-I/O) to know what the fixer produced.
- If no (blocker rejected or a sibling blocker still pending): stay `blocked`.

**This is the piece that makes multi-agent dependency chains actually work.** Without it, agents either interrupt their supervisors every time they hit a dep or ship around the problem. With it, work propagates even across "I need X before I can finish Y" boundaries.

**File paths:**
- `packages/cli/src/commands/block.ts` (new)
- `packages/cli/src/index.ts` (register)
- `packages/daemon/src/api.ts` (new `/block` endpoint, or route through `/hand` internally)
- `packages/shared/src/chain.ts` (extend: `fileBlocker(callerTaskId, blockerTaskOpts)` pure helper)
- `packages/daemon/src/task-events.ts` (on blocker close → check + auto-transition caller from `blocked`)

**Test strategy:**
- Integration: agent A's Task is `in_progress`; A runs `cc-cli block --assignee B --title "Z needed"`. Verify: new chit at corp scope, A's task gains `depends_on`, A's workflowStatus is `blocked`, B's Casket gains the blocker.
- Integration: B completes the blocker chit. Verify: A's task auto-flips back to `queued`, A's next dispatch picks up with the blocker's `output` visible in their context.
- Integration: circular-blocker detection — A filing a blocker assigned back to A is rejected at the CLI boundary (common mistake; an agent blocked on themselves goes nowhere).
- Regression: blocker chain of depth 3 (A blocked on B blocked on C); completing C → B dispatches, completing B → A dispatches.

**Depends on:** 0.1 (Chit), 1.2 (Casket), 1.3 (chain + state machine), 1.4 (hand).
**PRs:** 2-3

### 1.5 — [ABSORBED INTO 0.7]

**This sub-project was the original "fragment → CLAUDE.md migration" idea — pull fragments into `.md` files, update CLAUDE.md to `@import` them, maintain a live-updated CORP.md via file watcher.**

**Superseded by 0.7 (Dynamic system-prompt architecture).** 0.7's approach is mechanically better: thin static CLAUDE.md as survival anchor, full context injected dynamically via `cc-cli wtf` at SessionStart / PreCompact hooks. CORP.md is regenerated on every wtf invocation (not watcher-maintained), guaranteeing freshness. AGENTS.md and TOOLS.md are deleted as workspace files entirely — their content moves into CORP.md sections rendered by wtf.

If you're reading this looking for the CLAUDE.md migration scope, go to 0.7.2. The work that was here has been absorbed — do not implement 1.5 as originally written (it would directly conflict with 0.7's architecture).

### 1.6 — Per-step session cycling for Employees (activate Dredge, Chit-ify handoffs) **[shipped PR #169]**

**Handoffs become Chits of `type: handoff` (ephemeral, always).** Each handoff is a Chit written by the dying session that gets read and burned by the successor session via Dredge. No free-prose WORKLOG.md appending — handoff content is structured Chit frontmatter (from the XML schema in Decisions Made).

**Use Dredge, evolve it.** `packages/daemon/src/fragments/dredge.ts` currently reads WORKLOG.md's `## Session Summary`. Evolved behavior:
- On dispatch, Dredge queries for the latest unread handoff Chit scoped to this agent (`cc-cli chit list --type handoff --scope agent:<slug> --status active --limit 1`).
- If found, injects its structured fields into the system prompt: `current_step`, `completed`, `next_action`, `open_question`, `sandbox_state`, `notes`.
- On injection, Dredge updates the handoff Chit's status to `closed` (consumed). Ephemeral expiry cleans it up shortly after (0.6 lifecycle scanner — but since it's already closed, it falls out of working-set queries immediately).
- Legacy `## Session Summary` in WORKLOG.md becomes deprecated, deleted in 6.1.

**Session-exit protocol.** Employee calls `cc-cli done --completed "..." --next-action "..." --open-question "..." --sandbox-state "..." --notes "..."`. This writes a pending-handoff payload to `<workspace>/.pending-handoff.json`. The Stop hook fires `cc-cli audit`; on audit approve, the audit gate PROMOTES the pending file into a `type: handoff` Chit at scope=`agent:<slug>`, `ephemeral: true`, `references: [<current-step-chit-id>]`, and closes the current Task chit. On audit block, the pending file is preserved and the agent retries. (The original 1.6 spec said `cc-cli handoff` as a standalone producer command — during 0.7.3 implementation, the producer path was absorbed into the `cc-cli done` + audit-gate-promotes-pending pattern. Same semantics, different surface.)

**Silent-exit recovery via step-logs.** Handoff chits cover the clean-exit path. Silent exits (mid-turn crash, timeout, turn-complete-without-`cc-cli-done`) produce no handoff — the respawned Employee would otherwise boot into their Casket task with no memory of what the dead session did. The fix: step-log chits, harness-emitted, not agent-written.

- **Emission.** The dispatch harness buffers significant tool events over the turn — edits, bash invocations, reads of load-bearing files, test output summaries — and emits one `step-log` chit at turn end OR on abnormal exit via the child process's exit handler. Fields: `{ sessionId, taskChitId, toolEvents: [{ kind, argSummary, ts }], partialOutput?, exitReason: 'clean' | 'crashed' | 'timeout' | 'silent-no-done' }`. Scope: `agent:<slug>`. Ephemeral by registry with 7d TTL (see bound + lifecycle below) — a post-mortem window rather than a forever-audit-trail.
- **Consumption.** When 1.9.5's `silentexit` sweeper respawns a dead slot, it queries the latest step-log scoped to that slot's current Casket task and threads the `toolEvents` summary into the respawn dispatch (same injection path Dredge uses for handoff chits, but with step-log framing: "your predecessor died mid-work; here's what they touched before exiting"). The respawned Employee reconciles with git status before starting new work so partial edits don't get duplicated.
- **No agent discipline required.** The discipline lives in the harness — agents don't call `cc-cli checkpoint` mid-turn, they don't decide when to snapshot. Claude-code-harness and openclaw-harness both implement the buffer. An agent that crashes in the first tool call still produces a step-log with whatever fired before the crash (even if that's zero events — the exitReason alone tells the respawn "this was a silent exit, distrust the workspace state").
- **Bound + lifecycle.** Per-event: `argSummary` caps at 256 chars (longer args truncate with a `…[N more]` marker); per-chit: `toolEvents` caps at 100 entries (oldest dropped first once full, so the crash-proximate events are always preserved); `partialOutput` caps at 4KB. Step-logs are registry-ephemeral with `defaultTTL: 7d` and `destructionPolicy: 'destroy-if-not-promoted'` — the lifecycle scanner destroys them at TTL unless a post-mortem chit references them (normal 0.6 4-signal promotion). Typical case: task closes cleanly → dependents advance → step-log sits unreferenced → scanner destroys at 7d. Failure case: investigator writes an observation citing `chit-sl-abc123` → promotion signal fires → step-log survives.

**Scope:** handoff command, Dredge evolution, session-exit protocol, step-log auto-emission (harness), handoff Chit type registration.

**File paths:**
- `packages/shared/src/chit-types.ts` (register `handoff` type with schema: current_step, completed, next_action, open_question, sandbox_state, notes)
- `packages/cli/src/commands/handoff.ts` (new; convenience wrapper around `cc-cli chit create --type handoff ...`)
- `packages/daemon/src/fragments/dredge.ts` (rewrite: query latest handoff Chit, inject structured context, close Chit on read)
- `packages/daemon/src/harness/claude-code-harness.ts` (handoff signals session exit cleanly; new session reads Casket Chit + Dredge-injected handoff content)
- `packages/shared/src/templates/worklog.ts` (update: mark `## Session Summary` as deprecated)

**Test strategy:**
- Unit: handoff Chit type schema validates required fields; rejects malformed.
- Integration: simulate a 3-step Task chain for an Employee; session dies between each step, writes a handoff Chit; next session reads it, resumes at correct step with handoff context visible in the dispatch logs.
- Regression: existing Dredge behavior for free-prose WORKLOG.md falls through during migration window (non-breaking coexistence for one version cycle).

**Depends on:** 0.1 (Chit + handoff type registration), 1.2 (Casket Chit), 1.3 (chain), 1.5 (CLAUDE.md)
**PRs:** 2-3

### 1.7 — Compaction for Partner sessions **[shipped PR #170]**

**As shipped (PR #170).** Partner sessions don't handoff per-step. They ride Claude Code's native `/compact` at Claude Code's own autocompact threshold (`effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS` per the leaked `services/compact/autoCompact.ts`). Claude Corp does NOT trigger compaction — Claude Code does — we layer two complementary mechanisms around the boundary:

**Mechanism 1 — proactive nudge (the 17k-token runway).** We fire our own pre-compact signal at `effectiveWindow - PRE_COMPACT_SIGNAL_BUFFER_TOKENS` (30k), 17k tokens EARLIER than Claude Code's autocompact (13k). The gap is deliberate: that's the runway a Partner gets to externalize soul material (observation chits, BRAIN/ files) BEFORE the summarizer flattens raw context. The fragment renders inline in the agent's next dispatch with concrete crystallization guidance (`cc-cli observe --category CHECKPOINT`, BRAIN/ edits, casket already durable).

**Mechanism 2 — PreCompact hook does both summary-shaping AND auto-checkpoint.** When Claude Code fires its PreCompact hook, `cc-cli audit` branches on `hook_event_name === 'PreCompact'` and does two things in order:
  1. **Auto-writes a CHECKPOINT observation chit** at `agent:<slug>` scope, non-ephemeral, capturing: trigger (auto vs manual), founder's `/compact <arg>` verbatim, Casket `current_step` + title, last ~3 assistant-text excerpts from the transcript, and the token snapshot at boundary (pulled from the transcript's latest `message_start`/`message_delta` usage block via `extractLatestUsageFromTranscript`). Self-witnessing that survives regardless of whether the Partner noticed the fragment nudge.
  2. **Emits summary-shaping text on stdout.** Claude Code's `mergeHookInstructions` merges our stdout into the summarization prompt itself, biasing what survives the compact boundary: Casket pointer verbatim, in-flight reasoning, open questions, chit ids and file paths. Founder's `/compact <arg>` (if any) echoes FIRST with "Honor this above all else" so manual asks dominate defaults.

**Architectural note — PreCompact does NOT gate compaction.** An earlier design iteration (pre-1.7 commit `8d61291`) wired PreCompact to the Stop-style `{decision: block}` JSON envelope on the assumption that audit gating would work symmetrically. During 1.7 implementation, the leaked `services/compact/autoCompact.ts` showed PreCompact's output protocol is `mergeHookInstructions` (raw text merged into the summary prompt), not a decision envelope — Claude Code's Stop hook accepts block decisions; PreCompact does not. Commit 4 revised: the branch emits raw text only, skipping the gate logic. Net effect: Partners compact freely even with unresolved Tier 3 inbox items. This is acceptable because Tier 3 inbox items survive across compact independently (`fields.inbox-item.carriedForward` pattern; the inbox is its own substrate, not raw context). If real blocking is ever wanted, it belongs in a pre-`/compact` CLI wrapper the agent invokes explicitly — not in PreCompact.

**Pure primitives shipped (all in shared, all tested):**
- `calculateCompactionThreshold` — threshold math primitive (frozen-result, 200k and 1M windows, exact-boundary semantics)
- `ClaudeCodeStreamParser.getLastUsage()` — parser-side extraction of usage from `message_start`/`message_delta`
- `preCompactSignalFragment` — Partner+claude-code-only fragment gate
- `buildPreCompactInstructions` — summary-shaping template builder
- `buildCheckpointObservation` — auto-checkpoint chit body + field builder
- `extractLatestUsageFromTranscript` — walk the transcript JSONL for the latest usage block

**File paths:**
- `packages/shared/src/compaction-threshold.ts` — threshold math
- `packages/daemon/src/harness/claude-code-stream.ts` — usage extraction in stream parser
- `packages/daemon/src/harness/types.ts` — `DispatchCallbacks.onUsage(usage, model)`
- `packages/daemon/src/daemon.ts` — per-agent `lastAgentUsage` map + `recordAgentUsage` / `getLastAgentUsage`
- `packages/daemon/src/fragments/pre-compact-signal.ts` — the Partner-facing nudge
- `packages/daemon/src/fragments/types.ts` — `FragmentContext.sessionTokens` / `sessionModel`
- `packages/shared/src/audit/pre-compact-instructions.ts` — summary-shaping builder
- `packages/shared/src/audit/pre-compact-checkpoint.ts` — auto-checkpoint builder
- `packages/shared/src/audit/transcript.ts` — `extractLatestUsageFromTranscript` helper
- `packages/cli/src/commands/audit.ts` — PreCompact branch: writeAutoCheckpoint + stdout summary-shaping emission

**Test coverage (6 files, 93 cases):**
- `tests/compaction-threshold.test.ts` (15) — math primitive, both windows, every branch
- `tests/claude-code-stream-usage.test.ts` (5) — parser usage extraction + defensive parsing
- `tests/pre-compact-instructions.test.ts` (10) — summary-shaping builder (kind gate, founder-ask threading, substrate anchors)
- `tests/pre-compact-fragment.test.ts` (17) — four-gate fragment predicate + render + regression guard against reintroducing dead `cc-cli handoff`
- `tests/pre-compact-checkpoint.test.ts` (35) — checkpoint builder (kind, observation fields, tags, casket anchor, founder ask threading, assistant excerpts, token snapshot, timestamp)
- `tests/extract-latest-usage-from-transcript.test.ts` (11) — extractor happy + fail-soft paths

**Explicitly NOT shipped (deferred):**
- Employee auto-checkpoint (Employees don't compact today; kind gate returns null)
- Pre-compact gating (see architectural note above — would require a new invocation surface, not a PreCompact hook)
- Live-probe integration test (like 0.7.3's Stop-hook probe) — valuable but out of scope for 1.7

**Depends on:** 1.1, 1.2 (Casket read via `getCurrentStep`), 1.6 (handoff-chit infrastructure on the Employee-side; Partners don't produce handoff chits)
**PRs:** 1 (PR #170, 15 commits across 3 rounds + polish)

### 1.8 — Blueprint-as-molecule (absorbed from 2.1) **[shipped PRs #171-173]**

**Problem.** Blueprints today are markdown runbooks-the-CEO-reads. They're prose for humans. They can't be executed mechanically, so chains of work rely on the CEO manually tracking position. When CEO's context drifts, the chain breaks. AND — Sexton's patrols (1.9) are blueprints by nature; shipping 1.9 without this substrate means writing patrol logic as throwaway prompt-text that gets rewritten the moment blueprints land. Absorbed into Project 1 here so 1.9 ships native-to-the-substrate.

**Scope.**
- Define Blueprint format: TOML-frontmatter markdown, with a `steps:` array. Each step: `{ id, title, description, depends_on, acceptance_criteria, assignee_role }`.
- Blueprint parser in `packages/shared/src/blueprints/` — validates structure, checks DAG (no cycles).
- Cooking logic: `cc-cli blueprint cook --blueprint <name> --project <id>` instantiates a blueprint into a real Contract with real Task chits. Variable substitution at cook time (`{feature}` → `fire-command`).
- Existing blueprint files (`packages/shared/src/blueprints/onboard-agent.md` etc.) migrate to the new structured format.
- CEO command: `cc-cli contract start --blueprint ship-feature --vars feature=fire` creates the Contract + Tasks and optionally hands to an assigned role.

**Acceptance criteria.**
- `cc-cli blueprint cook ship-feature --project test --vars feature=fire` produces a Contract with 5-10 Task chits in the DAG defined by the blueprint.
- Tasks have `depends_on` and `acceptance_criteria` populated from the blueprint.
- An Employee handed the Contract's first Task walks the chain via Casket without any human re-dispatching at boundaries.

**Depends on:** 1.2 (Casket), 1.3 (chain semantics in Tasks).
**PRs:** 4-5.

### 1.9 — Watchdog chain: Pulse / Alarum / Sexton / helpers + patrol blueprint library (absorbs 2.2)

**Shipping status (2026-04-24).** Most of 1.9 has shipped across a PR series:

- **1.9.0** sweeper substrate (sweeper-run chit + BlueprintFields.kind + castSweeperFromBlueprint) — **shipped** (PR #174).
- **1.9.2** Sexton registered as Partner-by-decree; failsafe retired — **shipped** (PR #175).
- **1.9.3** Pulse reshape + Alarum (claude-code haiku subprocess) — **shipped** (PR #176).
- **1.9.4** Sexton runtime (`dispatchSexton`) + voice-via-DM-channelId + archived-Sexton filter — **shipped** (PR #177).
- **1.9.5** OS supervisor configs (`cc-cli daemon install-service`/`uninstall-service`) — **shipped** (PR #178).
- **1.9.5** Sweeper execution + 6 code sweepers (silentexit, agentstuck, orphantask, phantom-cleanup, chit-hygiene, log-rotation) + kink chit type + dedup/auto-resolve + wake-message wiring — **shipped** (PR #179).
- **1.9.6** Patrol blueprint library (health-check, corp-health, chit-hygiene) — **shipped**. Seeded as built-in blueprint chits at corp-init via `seedBuiltinBlueprints` (mirrors `installDefaultSkills`). Sexton reads + walks them in-session; not cast to Contract. `cc-cli blueprint cast patrol/*` rejects with a teachable error.

**1.9 is complete as a sub-project.** The unkillability floor — daemon restart via OS supervisor, Pulse → Alarum → Sexton continuity chain, 6 code sweepers + kink channel + dedup/auto-resolve, and 3 structured patrols Sexton walks on each wake — is all on project/1.

**Deferred to 1.9 follow-ups (non-blocking for 1.10/1.11/1.12):**
- `cc-cli sweeper new --prompt` (AI sweeper authoring) — ship when someone wants a custom sweeper.
- `cc-cli sweeper cast <blueprint>` — blueprint-based sweeper invocation. Current shape is direct-invoke via `cc-cli sweeper run <name>`; cast matters iff AI sweepers exist.
- The two dep-gated patrols: `patrol/cleanup-stale-sandboxes` (needs sandbox-ttl, itself deferred pending project metadata with TTLs) and `patrol/merge-queue-status` (needs Shipping / 1.12). Land with their deps.
- The three dep-gated sweepers: `conflict-triage` (AI, needs sweeper-new flow), `breaker-reset` + `budget-watch` (pend 1.11).
- The three design-deferred sweepers: `session-gc` (nothing to GC in our substrate), `sandbox-ttl` (missing data dep), `shutdown-dances` (not sweeper-shaped).

**Design turns taken during implementation:**

1. **New `kink` chit type for sweeper output** (session 2026-04-24). Initial implementation had sweepers writing observation chits. Realized observations are agent-voice self-witnessing that feeds BRAIN via dreams — pollutng that channel with mechanical sweeper findings would misdirect dream distillation. Kinks are their own stream. See the `kink` entry in Project 0.6.

2. **`cc-cli sweeper run <name>` instead of `cc-cli sweeper cast <blueprint-id>`** (session 2026-04-24). The blueprint-based path (sweeper-run chit cast from a blueprint) is the full form per original spec, but implementing it requires a blueprint-seeding flow + blueprint chits for every sweeper. The direct-invoke path is simpler, lives against the sweeper module registry, and lets us ship the operational capability without the blueprint-authoring overhead. The blueprint-based path stays spec'd for future AI-sweeper authoring via `cc-cli sweeper new`.

3. **OS supervisor config as `cc-cli daemon install-service`, not baked into `cc-cli init`** (session 2026-04-24). REFACTOR.md originally said `cc-cli init` writes the supervisor config. But init is per-corp and supervisor is per-machine; wiring them would regenerate the config on every new corp. Moved to a standalone command, init prints a one-line hint pointing at it.

4. **`continuity/` directory, not `watchdog/`** (session 2026-04-22). Renamed during 1.9.2 — "watchdog" has Gas Town flavor; "continuity" matches the Sexton-as-caretaker register. All file paths below use `continuity/`.

5. **Sexton's voice path is DM-via-channelId, not Tier 3 inbox** (session 2026-04-24). Original design said Sexton "pages founder via Tier 3 inbox-item." Investigated: the router filters founder out of inbox-item creation (tier-3 inbox is founder→agent, not the reverse), and `cc-cli escalate` is Employee→Partner. The real path: dispatchSexton passes the Sexton↔founder DM channelId to /cc/say; her response posts to that DM automatically. She stays quiet by default (IDENTITY discipline); speaks when it matters.

6. **Patrols are READ, not cast** (session 2026-04-24, 1.9.6). Original spec implied patrols would cast to Contract + Task chits via `castFromBlueprint`, treating each patrol as a walk-through-N-checks work contract. Rejected on grounds that Contract semantics (Warden sign-off, acceptance criteria per step, draft → active → review → completed lifecycle) don't fit a 5-minute repeating sweep. The real shape: Sexton runs `cc-cli blueprint show patrol/<name>`, reads the steps, executes each step's `description` in her session. Zero chit churn per patrol beyond what the sweepers themselves emit (kinks, dedup-handled). The blueprint remains a proper first-class chit — editable, listable, versionable — but the interpretation is read-and-walk, not cast. Guardrail: `cc-cli blueprint cast patrol/*` rejects with a teachable error pointing at the intended verb. Built-in patrol blueprints ship as bundled markdown files under `packages/shared/blueprints/patrol/` and seed into the corp's chit store at `cc-cli init` via `seedBuiltinBlueprints` (mirrors `installDefaultSkills`), with `origin: 'builtin'` so a future `cc-cli update --sync-builtins` can distinguish them from user-authored blueprints.

**The unkillability thesis.** For the corp to survive everything short of running out of tokens or OS process-kill, every layer is watched by a smaller-scope layer beneath it. At the bottom, Pulse answers one question — "is the Alarum-tick firing?" — small enough to basically never die. If the daemon itself dies, an OS-level process supervisor (systemd / launchd / Task Scheduler) restarts it; Pulse ticks; Alarum spawns; Sexton resumes from her handoff chit via the 1.6 path. All ticks, loops, crons resume because they rehydrate from on-disk state (chits, caskets, tasks, inbox).

```
OS supervisor (systemd / launchd / Task Scheduler)
    ↓ restarts daemon if killed — installed via `cc-cli daemon install-service` (PR #178)
Daemon (Node.js, dumb transport)
    ↓ Pulse tick every N min
Pulse (code, tiny — just fires Alarum)
    ↓ spawns Alarum each tick
Alarum (AI agent, ephemeral — fresh each tick, makes one decision, exits)
    ↓ decides: start / wake / nudge / nothing for Sexton
Sexton (AI Partner-by-decree, persistent — continuous patrol cycles, handoff loop)
    ↓ runs patrols (which ARE Blueprints cooked via 1.8)
Helpers (mostly code; a few AI for judgment)
    session-gc, phantom-cleanup, chit-hygiene, log-rotation,
    shutdown-dances (code); conflict-triage (AI)
```

**Why these names.** Gas Town's architecture (Daemon → Boot → Deacon → Witnesses/Dogs) solves the same problem — the intelligence-at-the-reasoning-layer insight is real and converges. We keep our own voice:

- **Pulse** — kept from the existing codebase. Its role reshapes: from "5-min heartbeat that nudges idle agents" (that work moves up to Sexton) to "the daemon-level meta-watchdog tick that ensures Alarum fires." Tiny, mechanical, unkillable in code.
- **Alarum** — old-English "wake-up call / to arms." Ephemeral AI agent fresh each tick, no context debt. The Gas Town "Boot" pattern: put intelligence at the triage layer because distinguishing "stuck" from "thinking" requires reasoning the daemon can't do.
- **Sexton** — classical church/office role: the one who minds the clocks, rings the bells, keeps the cycles going, maintains the grounds. Partner-by-decree with full SOUL + BRAIN + USER.md portrait of Mark. Her patrol accumulates observations over months and her escalations reflect accumulated judgment, not mechanical orthodoxy. Replaces the prior `failsafe` role in the registry (slot stays; name + shape change — see file paths below).

**Why Sexton is not Deacon.** Gas Town's Deacon runs a 25-step patrol formula, with "Formula Compliance IS Your CV Entry" as the virtue — Gas Town's soul (throughput + Capability Ledger reputation + federation-grade provability). Claude Corp's Sexton is **judgment-driven**: her patrol-Blueprints define steps mechanically, but within each step she reasons. Her Tier 3 escalations come in her voice ("Mark, three agents stalled on migration tasks tonight; given your preference for conservative rollouts I've paused dispatch until morning"). Same skeleton as Deacon, different soul inside. This is the Claude-Corp differentiation the refactor thesis demands.

**Sexton's patrol IS a Blueprint.** When Alarum wakes her, she cooks her next patrol Blueprint into a Contract, walks it, writes observations as she goes. Each step in a patrol Blueprint is a concrete check (`health-check/step-1-scan-caskets`, `health-check/step-2-check-stalls`, etc.). Step outputs are chits — later consumable by dreams (4.2) for pattern compounding over time.

**Sexton's operational "manual" is distributed across mechanisms already shipping in 1.9.** She does NOT get a separate `MANUAL.md`, a pre-authored operating guide, or an `operatingGuide` field on RoleEntry. Her operational surface is:

- Her patrol blueprints — the executable workflows she walks (listed below)
- Her `IDENTITY.md` — voice, stance, permissions (Partner-only soul file)
- Her entry in `roles.ts` — structural identity (description / purpose / communication)
- `CORP.md` — rendered dynamically by `cc-cli wtf`, same as for any agent

Authoring per-role operating manuals is 2.3 territory — the `hire-employee` blueprint there is the mechanism through which the CEO authors a new agent's `CLAUDE.md` based on corp context. Sexton is a Partner-by-decree, not hired through that flow; her work is codified as patrol blueprints, so she has no need for the separate manual mechanism. Nothing ships pre-written for any role — every role manual in a live corp is authored by the CEO (or the relevant Partner lead) through the 2.3 ceremony, when the corp actually hires into that role. See 2.3 for the shape of that ceremony.

**Patrol blueprint library (absorbed from 2.2):**
- `patrol/health-check` — per-agent status sweep (silent-exit, stall, loop, GUPP violation).
- `patrol/corp-health` — cross-agent coordination checks (chain walker idle agents, orphan tasks).
- `patrol/cleanup-stale-sandboxes` — sandbox TTL enforcement.
- `patrol/merge-queue-status` — Shipping (1.12) queue depth check.
- `patrol/chit-hygiene` — review of the lifecycle scanner's cooling/destroying decisions.

Each blueprint tested by cooking into a Contract and walking it end-to-end.

**Sexton actions** (applied inside patrol steps, with soul + judgment):
- Nudge an agent (post reminder in their DM channel).
- Respawn via process-manager on silent-exit.
- Redistribute via `cc-cli hand` + 1.4's role-resolver.
- Circuit-break (pause dispatches to a crash-looping slot) — integrates with 1.11's budget governor.
- Page founder via Tier 3 inbox-item — her voice, her judgment about when it matters.

**Sweepers — Sexton's workers.** Single-purpose modules invoked by Sexton on her patrol cycle. Each reports findings via observation chits; Sexton reads the trail, judges, escalates when needed. Split: Sexton holds identity + judgment; sweepers do the mechanical work. The naming replaces Gas Town's "Dogs" — sexton-with-sweepers fits the caretaker register, sexton-with-dogs is incongruous.

Sweeper list (code by default; `conflict-triage` is the sole AI-by-default). Shipping status in brackets:
- `silentexit` — **[shipped 1.9.5 PR #179]** sessions that died without clean shutdown; respawn within retry budget. Only reinitializes EXISTING slots (same Member record, same name, same workspace, same Casket); never creates new Members. Spawning new Employees is bacteria's domain (1.10). The two are disjoint — silentexit operates on dead-existing-slots, bacteria on the new-slot set — so no coordination layer is needed between them. `processManager.spawnAgent(memberId)` is the shared primitive: idempotent for existing members, creates-new for novel memberIds; both sweepers call it, the argument distinguishes which path runs. Retry budget = at most one respawn attempt per patrol cycle per slot; silentexit does NOT maintain its own counter. Repeated failures naturally cross 1.11's circuit breaker threshold (3 silent-exits within 5 min — roughly 3 patrol cycles) which trips the breaker chit and pauses further respawn attempts until founder intervention. This keeps the "when to stop trying" logic in one place (the breaker) rather than duplicated in each sweeper.
- `agentstuck` — **[shipped 1.9.5 PR #179]** Caskets whose currentStep hasn't advanced in N minutes (threshold: 30min, reads task chit's updatedAt not Casket's). Complement to silentexit — finds LIVE but NOT-PROGRESSING agents vs silentexit's DEAD processes. Report-only; Sexton decides whether to nudge via `cc-cli say`.
- `orphantask` — **[shipped 1.9.5 PR #179]** task chits with `workflowStatus='queued'`, no assignee (or assignee archived/missing), no active blocker. Report-only; Sexton reassigns via `cc-cli hand`.
- `phantom-cleanup` — **[shipped 1.9.5 PR #179]** reconcile members.json ↔ workspace directories. Two-way detection: phantom members (Member with missing agentDir → severity warn) + phantom workspaces (dir with no Member → severity info). Report-only; destructive cleanup needs founder consent.
- `chit-hygiene` — **[shipped 1.9.5 PR #179]** malformed frontmatter, orphan references, orphan dependsOn. Uses an in-memory id-Set built once from the query result for O(1) lookups (not per-ref findChitById which was O(10k+ fs-walks) per patrol).
- `log-rotation` — **[shipped 1.9.5 PR #179]** rotate past 10MB size threshold, keep up to 5 archived rotations. The one sweeper with fs side effects. Success case emits NO kink (a completed rotation is state-change not ongoing-wrongness); only the mid-rotation-failure case emits a kink, which auto-resolves on the next successful rotation.
- `session-gc` — **[deferred]** original spec said "orphan processes, dead tmux panes, subprocess leftovers." Claude Corp doesn't use tmux; claude-code dispatches self-clean per turn; the gateway is daemon-managed. Nothing concrete to GC in the current substrate. Revisit when real orphan state accumulates in practice.
- `sandbox-ttl` — **[deferred]** requires project metadata to carry a TTL field which doesn't exist yet. Building this against missing data would produce a sweeper that always returns noop. Defer until project metadata grows TTLs.
- `shutdown-dances` — **[deferred, reshape]** original spec described "deterministic graceful-shutdown state machine for agents." That's not sweeper-shaped — a sweeper is a periodic scan, shutdown is an orchestrated flow triggered by stop. Belongs as a separate primitive, not a module in the sweeper registry.
- `breaker-reset` — **[pending 1.11]** circuit breakers past cooldown; clear if cause resolved. Depends on 1.11's circuit-breaker chit type existing.
- `budget-watch` — **[pending 1.11]** per-agent token spend; warn on daily-cap approach. Depends on 1.11's budget governor.
- `conflict-triage` (AI) — **[pending 1.9.5+]** called by `chit-hygiene` on ambiguous chits. AI sweepers ship via `cc-cli sweeper new --prompt` which isn't wired yet.

Code sweepers don't bacteria-scale (one module handling a queue is fine). AI sweepers do — under load, bacteria splits spawn additional instances, matching 1.10's semantics.

**Sweepers are blueprints.** A sweeper IS a blueprint chit with `fields.blueprint.kind: sweeper` (vs the default `kind: contract` used by 1.8's Contract-casting). Code sweepers ship as blueprints whose steps carry a `moduleRef: <name>` — cast resolves to a native code invocation. AI sweepers carry regular prompt-based steps that cast into AI agent dispatches. Same blueprint primitive, same parse / validate / lookup pipeline shipped in 1.8; different output at the chit-write step.

Contract-blueprints cast to Contract + Task chits via `castFromBlueprint` (shipped in 1.8, unchanged). Sweeper-blueprints cast to sweeper-run chits via a sibling `castSweeperFromBlueprint` — same parser, same var coercion, same role machinery — diverging at step 7 (chit write). A sweeper-run chit is ephemeral (auto-closes after TTL): carries blueprint id, trigger context, observations produced, final decision. Sexton's patrol loop scans open sweeper-runs to track in-flight work; closed ones feed dreams for pattern synthesis.

**`cc-cli sweeper new --prompt "..."` — authoring AI sweepers on demand.** The capability that lets Sexton grow the corp's immune response instead of being fixed-function. Founder-invoked in v1.

1. `cc-cli sweeper new --prompt "<describe what to sweep for and when>"`.
2. Generator is one Claude call with blueprint schema + shipped sweeper library as reference. Output: draft blueprint chit, `kind: sweeper`.
3. Validate via 1.8's existing `cc-cli blueprint validate` — structural errors fail; sound sweepers promote to active.
4. First N runs surface observations to founder for review; after approval threshold the sweeper runs autonomously.
5. `cc-cli sweeper list` + `cc-cli sweeper close <id>` for lifecycle — same as any chit.

Sexton-invoke (she calls the same CLI from within her session once she's noticed a pattern no existing sweeper handles) lands in a second iteration. Per-corp cap (default 10 active auto-authored) prevents runaway; cap hit → Sexton escalates "I want a new sweeper but I'm at cap, which existing one should I retire?" Destructive actions (delete, archive, close) always require per-sweeper explicit founder approval on first trigger regardless of authoring path.

Stability boundary sits at the destructive-action boundary and the first-N-runs boundary, NOT at generation. Generation is cheap and reversible — a bad blueprint fails validate and doesn't promote; any sweeper is a chit that can be closed.

**Post-1.9 sweeper extensions.** Once the substrate lands, new sweeper types become additions-by-configuration rather than additions-by-engineering — `cc-cli sweeper new --prompt "..."` and you have one. Ideas for post-Project-1 additions (corp accountant patterns like model right-sizing and clock throttling, etc.) are not part of 1.9's scope; they are what the substrate enables. 1.9 ships the unkillability floor, nothing more.

**File paths** (note: `watchdog/` directory renamed to `continuity/` during 1.9.2 — "continuity" matches the Sexton-as-caretaker register):
- `packages/daemon/src/continuity/pulse.ts` — **[shipped 1.9.3]** reshape from `heartbeat.ts`; now just fires Alarum each tick.
- `packages/daemon/src/continuity/alarum.ts` + `alarum-prompt.ts` + `alarum-state.ts` — **[shipped 1.9.3]** ephemeral triage subprocess (claude-code haiku) + its prompt builder + state-read primitives (sextonSessionAlive, sextonLastHandoff, agentStatusCounts, observationCountSince, buildAlarumContext).
- `packages/daemon/src/continuity/sexton.ts` — **[shipped 1.9.2]** hireSexton + SEXTON_IDENTITY constant.
- `packages/daemon/src/continuity/sexton-runtime.ts` + `sexton-wake-prompts.ts` — **[shipped 1.9.4]** dispatchSexton + three wake messages (start/wake/nudge) + resolver.
- `packages/daemon/src/continuity/sweepers/types.ts` + `registry.ts` + `index.ts` — **[shipped 1.9.5 PR #179]** sweeper module contract, static registry, runSweeper runner with auto-resolve.
- `packages/daemon/src/continuity/sweepers/*.ts` — one file per code sweeper. Shipped (6): silentexit, agentstuck, orphantask, phantom-cleanup, chit-hygiene, log-rotation. Deferred (3, rationale above): session-gc, sandbox-ttl, shutdown-dances. Pending downstream-dep (3): breaker-reset, budget-watch (1.11), conflict-triage (AI-shape via cc-cli sweeper new).
- `packages/shared/src/templates/supervisor/*.ts` — **[in flight PR #178]** per-platform renderers (systemd.ts, launchd.ts, task-scheduler.ts) + types.ts + dispatcher in index.ts. `ServiceArtifact` carries both activation + deactivation commands for symmetric install/uninstall.
- `packages/cli/src/commands/daemon/install-service.ts` + `uninstall-service.ts` — **[shipped 1.9.5 PR #178]** the CLI surfaces. Use `cc-cli daemon install-service` / `uninstall-service`; not baked into `cc-cli init` (per design turn #3 above).
- `packages/cli/src/commands/sweeper.ts` + `sweeper/run.ts` — **[shipped 1.9.5 PR #179]** `cc-cli sweeper run <name>` direct-invoke. `cc-cli sweeper new/cast/list/show/close` — **pending 1.9 follow-ups**.
- `packages/shared/src/blueprints/sweeper/*.md` — **[pending 1.9 follow-ups]** shipped sweeper blueprints (for the blueprint-invocation path). Not needed for direct-invoke via `cc-cli sweeper run`.
- `packages/shared/blueprints/patrol/*.md` — **[shipped 1.9.6]** 3 patrol blueprints (health-check, corp-health, chit-hygiene) as bundled markdown files. Seeded into fresh corps at `cc-cli init` via `seedBuiltinBlueprints` → become chits with `origin: 'builtin'`. Sexton reads + walks them in-session (`cc-cli blueprint show patrol/<name>`), never cast — the cast path rejects `patrol/*` with a teachable error.
- `packages/shared/src/blueprint-seed.ts` — **[shipped 1.9.6]** `seedBuiltinBlueprints(corpRoot)` helper, mirrors `installDefaultSkills`. Walks the bundled blueprints dir at corp-init, reads each .md, calls `createChit` with `origin: 'builtin'`.
- `packages/shared/src/blueprint-cast.ts` — **[shipped 1.9]** `castSweeperFromBlueprint` sibling primitive (used by future blueprint-based sweeper invocation; not exercised by the current direct-invoke CLI).
- `packages/shared/src/types/chit.ts` — **[shipped]** `SweeperRunFields` + `kind: 'contract' | 'sweeper'` discriminator (1.9); `KinkFields` (1.9.5 PR #179).
- `packages/shared/src/chit-types.ts` — **[shipped]** `sweeper-run` (1.9) + `kink` (1.9.5 PR #179) registered with validators + ephemeral lifecycle.
- `packages/shared/src/kinks.ts` — **[shipped 1.9.5 PR #179]** `writeOrBumpKink` (dedup per source+subject) + `resolveKink` helpers.
- `packages/shared/src/roles.ts` — **[shipped 1.9.2]** `failsafe` retired; `sexton` added (tier=decree, defaultKind=partner).
- `packages/shared/src/templates/soul-sexton.ts` — **[not shipped, design turn]** SEXTON_IDENTITY lives inline in `continuity/sexton.ts` instead. Per the 2.3 decision, no operating content ships pre-written for any role.
- `packages/daemon/src/tick-budget.ts` — **[pending 1.9.5+]** shared 15-second budget helper for Sexton's patrols.

**Sweeper output channel — kinks, not observations.** Sweepers emit `SweeperFinding` values which the runner converts to kink chits via `writeOrBumpKink` (dedup per (source, subject); refreshes severity/title/body on bump). Kinks are their own chit type — distinct from observations (agent-voice soul material) — so mechanical sweeper findings don't pollute the observation stream or misdirect dream distillation. When a sweeper stops reporting a subject on a subsequent run, the runner auto-closes the prior kink with `resolution: 'auto-resolved'`. See the `kink` entry in Project 0.6.

**Test strategy:**
- Unit: Alarum decision ladder — session dead → start; heartbeat stale → nudge; fresh → nothing.
- Unit: Sexton patrol blueprint casts cleanly via `castFromBlueprint` (patrol = Contract).
- Unit: sweeper blueprint casts cleanly via `castSweeperFromBlueprint` — produces a sweeper-run chit with the right fields; reuses parse / var / role pipeline identically to contract-casting.
- Unit: `cc-cli sweeper new --prompt "..."` generates a structurally-valid draft blueprint; validate passes; promotion to active lands.
- Unit: destructive-action gate — sweeper attempting delete/archive/close on first trigger gates for founder approval; approval persists per-sweeper; subsequent triggers autonomous.
- Unit: per-corp auto-authored cap — 11th sweeper authoring request returns cap-hit + "which to retire" escalation.
- Integration: `kill -9` an agent mid-task. Within 1-2 min, Sexton's next patrol detects via `agentstuck` + `silentexit` sweepers, respawns via process-manager, agent resumes from their handoff chit.
- Integration: `kill -9` the daemon. OS supervisor restarts it. Pulse ticks. Alarum spawns. Sexton's handoff chit is consumed; she resumes patrols.
- Integration: Sexton session dies mid-patrol. On next Pulse tick, Alarum detects her session is dead, spawns a fresh Sexton. She reads her handoff chit + resumes.
- Integration: `conflict-triage` AI sweeper called on an ambiguous orphan chit — resolves to archive or escalates to founder with reasoning.
- Integration: founder authors a sweeper via `cc-cli sweeper new --prompt`. First 3 runs surface findings for review; on 3rd approval the sweeper flips autonomous.
- Observability: each layer logs clearly — `[pulse] tick #42`, `[alarum] decision: wake sexton`, `[sexton] dispatched sweeper chit-hygiene`, `[sweeper:chit-hygiene] flagged 2 orphan chits`, `[sexton] authored sweeper stale-review-timeout from founder prompt`.

**Depends on:** 0.1 (Chit), 1.2 (Casket), 1.4 (role-resolver for Sexton's redistribute action), 1.6 (handoff chit for Sexton's continuity across sessions), 1.8 (Blueprint-as-molecule — Sexton's patrols + sweepers ARE blueprints).
**PRs:** 6-7 (bumped from 5-6 to accommodate sweeper substrate + `cc-cli sweeper new` authoring flow).

### 1.10 — Auto-scaling Employee pool (bacteria) **[pending]**

Self-organizing. An Employee's Casket Chit showing a queue of multiple Chits (either one Casket with stacked references, or the role's active Task Chits exceeding Employee count) triggers a bacteria split. Collapse: multiple idle Employees of same role → decommission extras. Sexton (1.9) can also trigger wakes on idle-with-work agents during her patrol.

**Bacteria only spawns NEW slots; it never reinitializes existing ones.** A dead-but-present slot (silent-exit, crashed mid-turn) is silentexit's domain (1.9). Bacteria's trigger is weighted-queue-depth vs idle-Employee count — measured AFTER silentexit has had a chance to restore any recoverable slots in its current patrol cycle. The two sweepers operate on disjoint sets (existing-dead vs new) and don't race. When an entire role's pool dies simultaneously, the normal sequence is: silentexit respawns each dead slot in place on the next patrol tick; bacteria reassesses depth-vs-idle AFTER that restoration; if the queue is still heavier than the restored pool can absorb, bacteria splits on top of the restored slots.

**Queue depth via Chit queries.** Instead of maintaining a separate in-memory queue data structure, bacteria reads Chit state: `cc-cli chit list --type task --status active --assignee-role backend-engineer` returns active Task Chits for a role; `cc-cli chit list --type casket --scope 'agent:backend-engineer/*' --field-has current_step` tells us how many Employees of that role are busy. Split when **weighted** active Chit count > idle Employee count by threshold, where weights come from `fields.task.complexity` (landed in 0.5.1): `trivial=0.25, small=0.5, medium=1.0, large=2.0`. A queue of 3 trivials weighs 0.75 and doesn't split; a queue of 3 larges weighs 6.0 and triggers multiple splits. Null complexity defaults to `medium` weight so pre-backfill tasks still trigger sensibly. Collapse when idle Employees > 1 and all idle for > N minutes.

**First-session self-naming.** When bacteria spawns a new Employee, the role-resolver allocates a slot without a name; first dispatch prompts the Employee to choose a name (as per Decisions Made section). Name persists to the Employee's Member record + attribution.

**Scope:** bacteria logic driven by Chit queries, spawn/collapse primitives, name self-choice flow, role-pool bookkeeping.

**File paths:**
- `packages/daemon/src/bacteria.ts` (new: reads Chit state for queue depth, decides split/collapse)
- `packages/daemon/src/role-resolver.ts` (from 1.4 — extended to handle auto-spawn triggers)
- `packages/shared/src/types/member.ts` (add role-pool metadata if needed; name=null state for freshly-spawned Employees)
- `packages/tui/src/components/member-sidebar.tsx` (aggregate Employees by role, show counts; use Chit query for live data)
- `packages/daemon/src/process-manager.ts` (spawn/decommission lifecycle hooks)
- Employee first-session prompt extension (via SOUL template or dedicated first-dispatch fragment): "welcome — pick your name in the spirit of your role"

**Test strategy:**
- Unit: bacteria decision logic — queue-depth threshold test, idle-collapse threshold test.
- Unit: name self-choice — first dispatch of new Employee captures chosen name, persists; subsequent dispatches use the name.
- Integration: hand 3 Task Chits to a single-Employee role; verify second Employee spawns; verify Task Chits distributed to two Caskets.
- Integration: after work completes, verify one of two idle Employees decommissions after idle-timeout.
- Edge cases: race-condition test — two hands arrive near-simultaneously; one Employee handles both or split happens cleanly, no Chit assigned to two Caskets.

**Depends on:** 0.1 (Chit), 1.1 (Employee kind), 1.2 (Casket Chit), 1.4 (role hand), 1.9 (Sexton for wake)
**PRs:** 3

### 1.11 — Crash-loop circuit breaker **[pending]**

> **Design turn (2026-04-25):** The original 1.11 spec had two governors: per-hour dispatch budget + crash-loop circuit breaker. The dispatch-budget half got cut. Reasoning: claude-code's underlying constraint is a **5-hour rolling % window** of account budget (not per-hour token quotas), and the platform already enforces it. Reimplementing a parallel meter at the daemon layer would create two sources of truth that drift, and would be solving a problem the platform already handles. Token-cost observability also got cut for the same reason — `cc-cli costs` can come back as a follow-up if the founder wants visibility, but it doesn't gate dispatches. What remained worth shipping: the **crash-loop circuit breaker** — qualitatively different because it's not a usage cap, it's "this slot has silent-exited N times in M min, stop respawning it." Claude-code's 5h window catches the burn eventually, but in the meantime silentexit sweeper keeps respawning the broken slot every patrol tick, each spawn paying context-load tokens for nothing. The breaker stops that loop early. (Memory: `reference_claude_code_budget_window.md`.)

**Problem.** Silent-exit loops (agent spawns, dies, spawns, dies — sweeper keeps respawning every patrol tick) waste context-load tokens indefinitely. The failure mode is invisible in the TUI; it shows up later in claude-code's 5h window throttling. The breaker stops the loop before that.

#### Substrate — `breaker-trip` chit type

A new chit type registered in `packages/shared/src/chit-types.ts`:

```ts
export interface BreakerTripFields {
  /** The slot's Member.id this trip is for. Combined with chit.status='active' is the lookup key. */
  slug: string;
  /** ISO timestamp the trip fired. */
  trippedAt: string;
  /** Number of silent-exits that triggered this trip. Records the actual count, not the threshold. */
  triggerCount: number;
  /** Window the trigger was counted in, in ms. Records the role's effective window at trip time. */
  triggerWindowMs: number;
  /** Configured threshold at trip time (so audit reads cleanly even if the role's threshold changes later). */
  triggerThreshold: number;
  /** Chit ids of the silent-exit kinks that triggered the trip. `cc-cli chit list --depends-on <trip-id>` returns the failure history in one query. */
  recentSilentexitKinks: string[];
  /**
   * Forensic context — was this a cold loop, or a slot that worked
   * then started failing? processManager doesn't currently track
   * per-slug spawn timestamps; for v1, populate this from the
   * triggering silentexit kinks' `createdAt` fields (each kink is
   * recorded when the sweeper detected the crash, ≈ within seconds
   * of the actual exit). Future enhancement: process-manager keeps
   * a small ring buffer of per-slug spawn events that feeds this
   * field directly.
   */
  spawnHistory: string[];
  /** Free-form prose. The detector writes a default summary; founder reset adds context. */
  reason: string;
  /** Set when chit.status flips to 'cleared' — who reset, when, why. */
  clearedAt?: string;
  clearedBy?: string;
  clearReason?: string;
}
```

Lifecycle: `active` (just tripped, refusing spawns) → `cleared` (founder reset) → terminal. Non-ephemeral; never ages out — a stale trip surviving for weeks is a feature (the founder needs to see it), not a bug. Stored at corp scope (`<corpRoot>/chits/breaker-trip/breaker-t-<hex>.md`). One active trip per slug at a time; `tripBreaker` is idempotent and bumps `triggerCount` + appends to `recentSilentexitKinks` on re-trigger.

#### Detection — pull-based on silentexit sweeper

The breaker detector runs as a hook inside the silentexit sweeper's run, NOT as a separate sweeper. Reasoning: the silentexit sweeper is the canonical source of "this slot just died" findings; running detection inline keeps the trigger and the data source coupled. Detection logic:

1. After silentexit sweeper finishes its pass, for each slug it observed dying this round:
   - Query `cc-cli chit list --type kink --status active --created-by sweeper:silentexit --subject <slug>` filtered to the last `triggerWindowMs`.
   - If count ≥ threshold: call `tripBreaker(corpRoot, { slug, kinks, ... })`.
2. Threshold + window resolved per-role:
   - `RoleEntry.crashLoopThreshold?: number` — default 3.
   - `RoleEntry.crashLoopWindowMs?: number` — default 5 * 60 * 1000.
   - Worker-tier roles can tune; partners-by-decree typically inherit defaults but can also override.

Pull-based means the daemon-restart edge case is automatic — kink chits persist on disk, on next sweeper run the detector recomputes the count, trips appropriately. No in-memory counter to lose.

#### Refusal — layered at every spawn site

Three call sites need the check:

1. **`ProcessManager.spawnAgent(memberId)`** — pre-spawn check. Reads `findActiveBreaker(corpRoot, memberId)`; if present, throws a typed `BreakerTrippedError` with the trip chit id in the message. Caller (silentexit sweeper / bacteria executor) catches and skips cleanly without crashing the patrol cycle.
2. **silentexit sweeper's respawn path** — pre-respawn check inside the sweeper. If breaker is tripped, log `[silentexit] breaker tripped for <slug>, skipping respawn` and don't increment retry. The slot stays in members.json (the sweeper doesn't fire it), but no spawn is attempted.
3. **Bacteria's `pickFreshSlug`** — when generating a fresh 2-letter suffix for a new mitose, the candidate must NOT collide with any active breaker's slug. Add tripped slugs to the avoid-set alongside the existing taken-slug set. Rare collision case (recycled name happens to land on a tripped slug) but real.

Bacteria's apoptose path doesn't need the check — apoptose is removing a slot, not spawning one. The breaker-trip chit gets auto-cleaned (see "Auto-cleanup" below) when the slot is fully removed.

**In-flight work fate when a trip fires.** A slot can trip with `casket.currentStep` set — the chit it was working on when the loop took it down. The breaker explicitly does NOT touch the casket: the trip's job is "stop the spawn loop," not "re-route the orphaned chit." Consequence: the chit is stranded (no slot will pick it up while the breaker holds, and bacteria's pickFreshSlug avoids the tripped slug). The founder has two paths:

  1. **`cc-cli breaker reset --slug <slug>`** — clears the trip, slot resumes its current casket on next dispatch. Use when the underlying cause is fixed (harness regression patched, bad task chit deleted, etc.).
  2. **`cc-cli fire --remove --slug <slug>`** — removes the slot entirely. Existing fire logic handles the orphaned casket chit (sets workflowStatus back to queued, clears assignee — the founder can then re-hand it). The auto-cleanup hook closes the breaker chit too.

This is a deliberate scoping choice: chit re-routing is a richer state machine (dispatched → queued, assignee rewrite, blocker handling) that already lives in fire. The breaker doesn't reinvent it.

#### Surfacing — three layers

1. **Tier-3 inbox-item** to founder on every fresh trip:
   ```
   Subject: Crash-loop breaker tripped: <slug>
   Body: Agent <slug> silent-exited <count>× in <window> min — paused.
         Reset with `cc-cli breaker reset --slug <slug>`
         or fire the slot with `cc-cli fire --remove --slug <slug>`.
         Forensic context: cc-cli chit read <trip-id>
   ```

2. **Sexton wake prompts** (start + wake, not nudge) gain a "Active breaker trips" section that lists currently-active trips with their `triggerCount` and `trippedAt`. Sexton compounds these into prose for the founder during her patrol — *"backend-engineer-toast and qa-engineer-shadow are tripped. Toast started looping after task chit-t-abc; shadow's loop pattern looks like a flaky harness."* Bacteria stays mute; Sexton gives the trips a voice.

3. **TUI sidebar** — tripped slots get a distinct `broken` status icon (lookup added to `STATUS` in theme.ts). Per-role rollup includes a tripped count: *"Backend Engineer: 3 active, 1 tripped, gens 0-4."*

#### Founder controls — `cc-cli breaker`

New CLI command group at `packages/cli/src/commands/breaker.ts` mirroring the bacteria/sweeper subcommand pattern:

- **`cc-cli breaker list [--role <id>] [--include-cleared] [--json]`**
  Lists active trips by default; `--include-cleared` includes historical ones for audit. Shows: slug, role, trippedAt, triggerCount, recent kink refs.

- **`cc-cli breaker reset --slug <slug> [--reason "..."] [--json]`**
  Closes the active trip chit. Subsequent `processManager.spawnAgent` calls go through normally. Bacteria's slug-collision avoidance stops blocking the slug. Records `clearedBy=founder`, `clearedAt=now`, `clearReason=opts.reason`.

- **`cc-cli breaker show <slug-or-trip-id> [--json]`**
  Detailed view of one trip — full forensic context, all referenced silent-exit kinks, spawn history.

#### Auto-cleanup — orphan trip on slot removal

When a slot is removed via `cc-cli fire --remove` or `cc-cli bacteria evict`, any active breaker-trip for that slug should also close. Otherwise an orphaned trip blocks the slug from being reused by bacteria's recycle pool, and clutters `cc-cli breaker list`. The fire and evict paths both need a one-line `closeBreakerForSlug(corpRoot, slug, 'slot removed')` call after the Member is removed.

#### Robustness — the over-engineering pass

Beyond the spec basics, the v1 robustness fence:

- **Cross-restart trip persistence.** Trips are chits on disk; daemon restart re-reads them on next spawn-time check. No in-memory state to lose.
- **Corrupted breaker chit fails open.** If the trip chit is malformed (parser fail), the spawn-time check returns "no active trip" rather than throwing. Rationale: a bad chit shouldn't permanently brick a slot — chit-hygiene sweeper will surface the corruption separately. Better to risk a missed trip than a silent permanent block.
- **Concurrency.** Reactor mutex serializes bacteria's spawn path; CLI fire/evict and bacteria don't run concurrently because the daemon is single-process. Cross-process (e.g., founder runs `cc-cli breaker reset` while daemon is mid-tick) is fine — the reset commits to disk, the next spawn-time check reads the cleared state.
- **Idempotency of trip writes.** `tripBreaker` looks up active trip for slug; if found, bumps `triggerCount` and appends to `recentSilentexitKinks` instead of creating a duplicate. No race even if multiple sweeper runs converge.
- **Per-role threshold respects override at trip time, not check time.** The trip chit records the threshold + window AT TIME OF TRIP, so audit reads stay coherent even if the role's config changes mid-life.
- **Sexton's wake summary mentions cleared-today trips, not just active.** Audit trail across the day; the founder sees both the active queue and what got resolved.
- **Bacteria slug avoidance.** `pickFreshSlug` adds active-breaker slugs to its taken-set. The retry budget (100 attempts, then 4-letter fallback) absorbs the case where a recycled suffix collides; in practice, impact is invisible (one extra random retry).
- **Hire path against a tripped slug.** `cc-cli hire --slug <tripped>` hits `processManager.spawnAgent` and gets `BreakerTrippedError`. The hire command catches this specifically and surfaces a clean message: *"slot <slug> has an active breaker trip — reset with `cc-cli breaker reset --slug <slug>` or pick a different slug."* Don't let the raw error bubble; the founder needs the path forward, not a stack trace.
- **Tier-3 inbox dedup.** First trip writes a fresh inbox-item. Subsequent trip BUMPS (idempotent `tripBreaker` increments `triggerCount`) MUST NOT spam additional inbox-items. The trip writer checks `chit.action === 'created'` from the underlying `createOrBumpChit`-style result and only fires the inbox-item on first creation. Mirrors how `writeOrBumpKink` separates created vs bumped for downstream callers.
- **Whole-pool-tripped scenario.** Harness regression takes down 3+ fresh mitoses in succession. Each trips individually (per-slug, by design). Bacteria keeps spawning fresh suffixes (slug-avoid only excludes the tripped ones, not new candidates) and they all immediately trip too. The pool effectively shuts down — queue grows unbounded, everyone trips, breaker chits pile up. The breaker doesn't escalate this pattern itself (cross-role correlation is Project 3.1 territory). What v1 SHOULD do: Sexton's wake prompt's "Active breaker trips" section should be loud when ≥3 trips exist for the same role today, prompting the founder to look at the underlying cause (harness, recent task chits) instead of resetting trips one-by-one. One sentence in the wake summary; not a separate alert.

#### File paths

- `packages/shared/src/types/chit.ts` — `BreakerTripFields` interface.
- `packages/shared/src/chit-types.ts` — registry entry: type id `breaker-trip`, idPrefix `bt`, scope `corp`, ephemeral=false, lifecycle `active → cleared → terminal`.
- `packages/shared/src/bacteria-breaker.ts` — read/write helpers: `tripBreaker`, `findActiveBreaker`, `closeBreakerForSlug`, `listActiveBreakers`. Pure file-first; no daemon dependency.
- `packages/daemon/src/continuity/sweepers/silentexit.ts` — detection hook (compute count, trip on threshold) + respawn refusal (skip when breaker active).
- `packages/daemon/src/process-manager.ts` — `BreakerTrippedError` class + pre-spawn check in `spawnAgent`.
- `packages/daemon/src/bacteria/executor.ts` — `pickFreshSlug` adds tripped slugs to the avoid-set.
- `packages/daemon/src/api.ts` — fire endpoint calls `closeBreakerForSlug` post-removal (auto-cleanup).
- `packages/cli/src/commands/bacteria/evict.ts` — also calls `closeBreakerForSlug` post-removal.
- `packages/cli/src/commands/breaker.ts` — top-level CLI group: list / reset / show.
- `packages/cli/src/commands/breaker/list.ts`, `reset.ts`, `show.ts` — subcommand handlers.
- `packages/cli/src/index.ts` — dispatch + help text entry.
- `packages/daemon/src/continuity/sexton-wake-prompts.ts` — "Active breaker trips" section in `composePoolActivitySection` (or a parallel composer).
- `packages/tui/src/components/member-sidebar.tsx` — tripped status icon + per-role rollup includes tripped count.
- `packages/shared/src/themes.ts` — add `broken` STATUS entry if not already present.
- `packages/shared/src/roles.ts` — `RoleEntry.crashLoopThreshold?` + `crashLoopWindowMs?` optional fields.

#### Test strategy

> **Pattern note.** Both PR 1.10.3 (rename eligibility) and PR 1.10.4 (status / lineage helpers) earned coverage by extracting load-bearing logic into pure functions called from the I/O wrapper. Apply the same pattern here: the silentexit-sweeper's detection step lives in a pure helper `evaluateBreakerTrigger(silentexitKinks, threshold, windowMs, now): TriggerDecision` (in `bacteria-breaker.ts`), and the sweeper just composes it with the kink query + `tripBreaker` write. Keeps the math testable without spinning up the full sweeper or mocking the patrol cycle. Same shape as `decideBacteriaActions` / `checkRenameEligibility` / `computeRoleStats`.

- Unit (`bacteria-breaker.ts`): trip writes a chit with the right shape; second trip on same slug bumps existing instead of creating duplicate; close flips status to cleared with timestamps; list returns only active by default.
- Unit (`evaluateBreakerTrigger` pure helper): 3 silent-exit kinks in 5min trip; 3 in 6min don't; per-role threshold override honored; threshold respects role config snapshot at trip time, not check time.
- Integration (process-manager): spawn refuses with `BreakerTrippedError` when active trip exists for the slug.
- Integration (silentexit respawn): when breaker active, sweeper logs + skips, doesn't call spawnAgent.
- Integration (bacteria slug avoidance): `pickFreshSlug` retries past tripped slug.
- Integration (cross-restart): write a trip chit, simulate restart by re-reading from fresh process — spawn still refused.
- Integration (auto-cleanup): fire-remove + evict both close orphan trips.
- Edge: corrupted breaker chit at the trip path → fail-open, slot can spawn (chit-hygiene flags the corruption separately).
- Regression: non-crashing agents don't trip; agents whose silent-exits are spread > 5min apart don't trip.
- CLI: `breaker list` filters by --role; `breaker reset` requires --slug; `breaker show` returns full forensic context.

#### Commit plan (~12 commits, ~700-900 LOC incl. tests)

Substrate first, consumers second, tests at end:

1. `feat(1.11): breaker-trip chit type + BreakerTripFields` (shared)
2. `feat(1.11): bacteria-breaker helpers — trip / find / close / list` (shared)
3. `feat(1.11): RoleEntry crashLoopThreshold + crashLoopWindowMs` (shared, schema-only)
4. `feat(1.11): silentexit sweeper hooks the detector` (daemon)
5. `feat(1.11): processManager.spawnAgent refuses on active breaker` (daemon)
6. `feat(1.11): silentexit sweeper skips respawn when breaker active` (daemon)
7. `feat(1.11): bacteria pickFreshSlug avoids tripped slugs` (daemon)
8. `feat(1.11): Tier-3 inbox emission on trip` (daemon)
9. `feat(1.11): cc-cli breaker list / reset / show` (cli)
10. `feat(1.11): Sexton wake prompt — active breaker trips section` (daemon)
11. `feat(1.11): TUI sidebar tripped-status icon + per-role rollup` (tui)
12. `feat(1.11): auto-cleanup on fire/evict` (daemon api + cli evict)
13. `test(1.11): substrate + helpers` (shared tests)
14. `test(1.11): detection + refusal + cross-restart` (daemon tests)
15. `test(1.11): CLI breaker commands` (cli tests)

Codex round expected. Pattern same as PRs #182-186.

**Depends on:** 1.1 (Employee kind for role scoping), 1.9 (silentexit sweeper as the detector source), 1.10 (bacteria slug-avoidance integration).
**PRs:** 1 (single beefy PR matching 1.10's shape).

### 1.12 — Shipping: the merge lane + janitor Employees **[pending]**

**Problem.** Agents write to git freely today. At 3 agents, this is fine. At 20+ it's chaos — concurrent PRs collide on rebase, step on each other's changes, leave main in a broken state. The "walk away overnight" dream breaks when agents fight over main. Moved up from Project 3.2 (was "Refinery") because it's prerequisite for parallel work — without serialized merges, multi-Employee Contracts can't actually land.

**The architecture Mark named:** there's a merge-lane system called **Shipping** (placeholder name — rename when it feels right), staffed by a pool of **janitor Employees** (bacteria-scaled). No Partner-by-decree needed — merging worktrees is mechanical, no identity, no relationship. The existing Janitor Partner gets removed from the role registry; `janitor` becomes an Employee role (`defaultKind: employee`, `tier: worker`).

**Mechanism:**
- Agents open PRs via their normal git push; then run `cc-cli ship --branch <name> --contract <chit-id>`, which creates a `merge-submission` chit (new chit type — non-ephemeral, audit trail).
- merge-submission frontmatter: `branch`, `contract` reference, `submitter`, `priority`, `retry_count`, `status: queued | processing | merged | conflict | rejected | failed`.
- Priority scoring (Gas Town's formula, adapted): `1000 + convoy_age×10/hr + (4-priority)×100 - min(retries×50, 300) + mr_age×1/hr`. Anti-thrashing via the retry-penalty cap.
- Shipping lock: a corp-scope `shipping-lock` chit with `held_by: <janitor-slug> | null`. Only the lock-holder processes the queue at any moment. Release happens on merge complete or on janitor session exit.
- Janitor Employees pull from the lane (pull-based, unlike Hand's push): each janitor's Casket is the shipping-lock. When they have the lock, they take the highest-scored queued submission, rebase, run tests, merge or conflict-route, close the submission, release the lock, next janitor picks up.
- Real conflict → janitor files a blocker chit via 1.4.1 scoped to the PR author's ROLE (e.g. `backend-engineer`), not the specific slot. Role-resolver picks an active Employee via normal precedence (idle-first, least-priority otherwise): if the original author is still alive and idle, they're first-pick; if they've decommissioned, another Employee of the role handles it; if the role is empty, `no-candidates` triggers bacteria to spawn one (1.10). No PR can become permanently stranded by its author's death. Submission goes to `conflict` state; janitor releases lock + takes next. The blocker chit carries `originatingAuthor: <slug>` so the assignee sees "this was Toast's PR" as context even when Toast is gone.
- Clean merge → submission `merged`, contract referenced by the submission gets its workflow-state advanced (typically `under_review → completed`).

**Bacteria scaling (from 1.10):** when `merge-submission` queue depth exceeds 1 and only 1 idle janitor exists, bacteria spawns another. Collapses to 1 idle when queue drains.

**Role registry changes:**
- Remove `janitor` Partner-by-decree entry.
- Add `janitor` Employee role (worker tier, defaultKind: employee). Purpose: "Process the Shipping queue — rebase, test, merge or conflict-route."
- Corp-sacred Partners drop from 6 to 5 (CEO, Herald, HR, Adviser, Sexton). (The prior `failsafe` slot is renamed to `sexton` in 1.9; this bullet reflects the post-1.9 registry.)

**File paths:**
- `packages/shared/src/chit-types.ts` (register `merge-submission` type with validator)
- `packages/shared/src/types/chit.ts` (MergeSubmissionFields shape)
- `packages/shared/src/roles.ts` (remove janitor Partner, add janitor Employee)
- `packages/daemon/src/shipping.ts` (new — queue processor, lock management, bacteria trigger)
- `packages/cli/src/commands/ship.ts` (new — `cc-cli ship --branch <name> --contract <chit-id>`)

**Test strategy:**
- Unit: priority scoring formula produces expected orderings.
- Integration: two concurrent submissions with different files → both merge serially, main is clean.
- Integration: two submissions with real conflict → first merges, second flips to `conflict`, blocker chit filed at second's submitter, retry-on-submitter-fix flow works.
- Integration: queue depth > idle-janitor count → bacteria spawns a second janitor.
- Regression: solo-corp (one janitor) processes submissions serially without deadlock.

**Depends on:** 0.1 (Chit), 1.1 (Employee kind), 1.4 (Hand for routing conflicts), 1.4.1 (blocker injection), 1.10 (bacteria for pool scaling)
**PRs:** 3-4

**Project 1 ship criterion:** hand a Contract with 5 Tasks to Engineering Lead. Lead decomposes + hands Tasks to backend Employees. Each Employee walks their Task, runs `cc-cli done`, audit approves, Casket advances to next chain step. When a Task hits a real dependency on another role, the Employee files a blocker chit (1.4.1) and exits cleanly; another Employee picks up the blocker; original Employee resumes on blocker-close. When any Employee silent-exits or stalls, Sexton's patrol (1.9) detects + respawns via process-manager — and if the daemon itself dies, the OS supervisor restarts it, Pulse ticks, Alarum spawns, Sexton resumes from her handoff chit, and the corp keeps going. When any agent tries to push to main, they route through `cc-cli ship` → Shipping queue (1.12) → janitor Employee merges. Mark walks away; when he comes back, 4 out of 5 Tasks have landed on main via serialized merges, the 5th is blocked on a real ambiguity the agents couldn't resolve + surfaces as Tier 3 in his inbox. No human-in-the-loop needed between hand and merge for the happy path; human-in-the-loop at the exact moments it IS needed for the ambiguous path. Corp is unkillable short of token exhaustion or OS process-kill without a supervisor.

---

## Project 2: Workflow Substrate

*Chains become real. Work propagates without the founder pushing it. Self-witnessing meta-layer arrives.*

### 2.1 — [ABSORBED INTO 1.8 — Blueprint-as-molecule]

**This sub-project became 1.8.** Blueprint-as-molecule is prerequisite for 1.9's watchdog chain — Sexton's patrols ARE Blueprints, so the substrate had to land in Project 1. The original 2.1 scope (TOML-frontmatter format, parser + DAG validation, cook command, migration of existing blueprints) moves verbatim to 1.8; rationale is documented there. Shipping 1.9 without 1.8 would have meant throwaway prompt-text patrol logic rewritten the moment Blueprints landed — the exact anti-pattern the refactor thesis forbids.

If you're reading this looking for Blueprint-as-molecule, go to **1.8**.

### 2.2 — [ABSORBED INTO 1.9 — Watchdog chain]

**This sub-project became part of 1.9.** Patrol blueprints (`patrol/health-check`, `patrol/corp-health`, `patrol/cleanup-stale-sandboxes`, `patrol/merge-queue-status`, `patrol/chit-hygiene`) ship with the 1.9 watchdog chain because they are what Sexton consumes — meaningless without her, and she doesn't work without them. Bundling them into 1.9 means the pair lands as a working whole rather than two PRs each missing the other half.

If you're reading this looking for patrol blueprints, go to **1.9** (Watchdog chain).

### 2.3 — Built-in blueprint library

**Problem.** Blueprint-as-molecule is useless without tested blueprints for common work. CEO needs a library to compose from.

**Scope.** Ship these blueprints as structured markdown in `packages/shared/src/blueprints/`:
- `ship-feature` — design → plan → implement → test → PR → review
- `fix-bug` — repro → root-cause → fix → verify → PR
- `refactor-module` — define-scope → plan → implement-small-steps → tests → PR
- `hire-employee` — define-role → **author-operating-manual** → allocate-slot → first-dispatch-self-naming → onboard
- `create-role` — define-identity → **author-operating-manual** → register-in-roles → first-hire
- `promote-employee` — founder-reason → data-transition → ceremony-welcomes → first-dispatch
- `release` — version-bump → changelog → tag → publish → announce
- `sprint-review` — collect-activity → synthesize → present-to-founder
- `merge-conflict-resolve` — inspect → decide-strategy → resolve → verify

Each blueprint tested against a real use case before landing.

**The `author-operating-manual` step is load-bearing.** It's the mechanism through which per-role and per-Partner CLAUDE.md files get written. Nothing ships pre-written with Claude Corp — no role manuals, no agent runbooks, no `operatingGuide` field on RoleEntry. When the CEO (or a Partner with hire authority) runs `hire-employee` or `create-role`, the ceremony REFUSES TO COMPLETE until the new agent's or new role's `CLAUDE.md` is authored based on corp context. This is the "earn the operational knowledge, don't install it" thesis applied to hiring — the corp's specific conventions, codebase standards, review bar, and escalation preferences get written down by an agent who actually knows them, at the moment they're needed.

Employees inherit their role's `CLAUDE.md` template when spawned (the CEO wrote it once when creating the role; every Employee of that role gets it). Partners get individually-authored `CLAUDE.md` files at hire (they're individuals, not pool members). Partners-by-decree (CEO / Herald / HR / Adviser / Sexton) operate from their `IDENTITY.md` + role identity + shipped patrol blueprints (for Sexton) without needing the hire ceremony — they're product-universal roles whose work is codified in shipped mechanisms, not corp-specific.

**Acceptance criteria.**
- Each blueprint can be cooked without error.
- For each, an Employee walks the resulting Contract end-to-end on a test project without human intervention.

**Depends on:** 1.8 (Blueprint-as-molecule substrate)
**PRs:** 2-3 (one per batch)

### 2.4 — Self-witnessing meta-layer (the "trippy idea")

**Problem.** Flat per-step cycling (from 1.6) gives Employees no cross-Task coherence. Step 2 might ignore decisions made in step 1. No one reviews the Contract as a whole until Warden at the very end — by then it's hard to unwind bad choices.

**Scope.**
- Two session tiers per Employee working a multi-Task Contract:
  - **task-session** — spawned per Task, executes the Task, writes output, exits
  - **review-session** — spawned between Tasks, reads the Contract Chit + the just-completed Task Chit's output + prior Tasks, reviews, decides: accept & dispatch next, redo, flag-for-founder
- Review prompts are distinct from execution prompts: "you are reviewing your own work against the Contract's goal and acceptance criteria."
- **Review outputs are Chits of `type: review`** (ephemeral by default, promote to permanent if the Contract gets a Warden rejection and Warden needs to see what the Employee thought). Chit fields: `verdict: accept|redo|flag`, `reasoning`, `notes_for_next_task`, `references: [<task-chit-id>, <contract-chit-id>]`. Review Chits burn after the Contract closes cleanly; surface if Warden disagrees.
- Alternative implementation option from the Claude Code research gems: use claude-code's blockable `Stop` hook — when the task-session signals completion, daemon intercepts via `PreStop` (returning exit 2), spawns the review-session, and only lets the original session truly stop after the review verdict is accept.
- Integration with Warden: Warden still does final Contract-level review, but Employee-level self-review catches obvious issues early.

**Acceptance criteria.**
- Multi-Task Contract slung to an Employee walks with review-sessions between each Task.
- A review-session detects an obviously wrong Task output (e.g. Task said "write test" but output has no test) and flags `redo`.
- Self-reviewed Contract has measurably fewer Warden rejections than a flat-walked one.

**Depends on:** 1.8 (Blueprint-as-molecule — the Tasks within a Contract)
**PRs:** 4-5

**Project 2 ship criterion:** CEO can say "ship feature X using the ship-feature blueprint" → blueprint cooks into a multi-Task Contract → Employee gets slung the Contract → walks it with self-review between Tasks → PR lands. Zero human intervention in the middle.

---

## Project 3: Autonomous Operations

*Corp heals itself. Mark can sleep and wake to a working corp.*

### 3.1 — Cross-agent anomaly detection (Sexton's deeper patrols)

**Note.** Sexton's per-agent patrols (silent-exit, stall, loop, GUPP violation) ship in 1.9 alongside the patrol blueprint library. What remains here is the cross-agent anomaly pattern detection that needs more state than a single patrol cycle carries.

**Problem.** 1.9's patrols catch per-agent failures. They don't catch cross-agent patterns: "Backend Engineer pool keeps producing PRs the QA Engineer pool rejects — there's a skill gap" or "Engineering Lead has been handing impossible Tasks to Employees for 3 days." These aren't per-agent bugs; they're coordination bugs that only surface when you aggregate across roles.

**Scope.**
- Cross-agent pattern detectors that consume chit store + observation stream: reject-rate per role-pair, task-escalation frequency, blocker-file-rate per role, merge-submission retry-rate.
- Threshold-based alerting (not ML — explicit rules): `backend→qa reject rate > 0.5 sustained for 24h → observation + Tier 2 inbox to CEO`.
- Orphan-task reaper: Chits that should have dispatched but didn't — route via Sexton's redistribute action to an idle Employee.
- Intervention audit trail: every anomaly + intervention writes an observation so dreams can compound patterns across time.
- Implemented as additional patrol blueprints Sexton consumes (`patrol/cross-agent-reject-rates`, etc.) — no new daemon layer needed; just a richer patrol library.

**Depends on:** 1.9 (Sexton + patrol blueprint library), 1.10 (bacteria), 4.1 (observations), 4.2 (dreams)
**PRs:** 2-3

### 3.2 — [ABSORBED INTO 1.12 — Shipping]

The Refinery merge-coordinator work moved up into Project 1 (now 1.12 — Shipping). Rationale: merge discipline is prerequisite for multi-agent work, not a polish layer on top. Without serialized merges, parallel Employees stomp on each other from day one of Project 1's autonomous-loop test. Also: the whole thing is Employee-shape work (mechanical merging, no identity), which fits Project 1's "foundation + scaffolding" better than Project 3's "self-heal meta-layer."

If you're looking for the merge-queue + janitor-pool design, go to 1.12.

### 3.3 — [ABSORBED INTO 1.9 + 1.11]

The auto-recovery machinery split across two earlier sub-projects:
- Silent-exit detection + respawn → **1.9** (Sexton's patrol via the health-check Blueprint).
- Crash-loop circuit breaker + per-hour dispatch budget → **1.11** (Budget governor + circuit breaker).
- Daemon-restart survival (reload state on boot, resume patrols) → left here — the genuinely daemon-lifecycle piece that neither 1.9 nor 1.11 covers.

### 3.3' — Daemon-restart survival (the remnant)

**Problem.** When the daemon process itself dies + restarts, in-flight Contracts shouldn't lose their place. Chit state is file-first so the substrate survives, but the watchdog + bacteria + shipping queue processors all need to pick up mid-cycle cleanly. 1.9 covers the watchdog-chain-level unkillability (OS supervisor → daemon → Pulse → Alarum → Sexton resuming from handoff chit); this sub-project covers the corp-wide state-rehydration on daemon boot.

**Scope.**
- Daemon boot walks members.json + Casket chits + merge-submission queue + pending breaker-trip chits, reconstructs in-memory state from disk.
- Pulse starts ticking immediately post-boot; Alarum's first tick sees Sexton's existing handoff chit and continues her patrols.
- Shipping queue picks up where it left off — checks `shipping-lock` chit's `held_by`; if that janitor's session is gone, release the lock and let the next queued janitor take over.
- Circuit-breaker chits respected across restart (breaker trips persist).

**Acceptance criteria.**
- Kill daemon mid-Contract. Restart. Agents dispatch on next hand / Sexton tick without human action.
- Breaker tripped before restart stays tripped after restart.

**Depends on:** 1.9, 1.11, 1.12
**PRs:** 1-2

**Project 3 ship criterion:** Mark goes to sleep with 3 parallel Contracts running. Employees silent-exit twice (Sexton's patrol from 1.9 respawns them). A merge conflict happens (Shipping janitor from 1.12 routes it to the author via a blocker chit). A role's Employee keeps crashing (circuit breaker from 1.11 trips). The daemon process restarts at 3am from a memory leak (3.3' resumes state cleanly; OS supervisor + 1.9's watchdog chain carry the corp across the restart). Mark wakes to 3 opened PRs, zero manual intervention mid-night. Corp kept itself alive.

---

## Project 4: Earned Philosophy

*Soul stops being decorative and starts being load-bearing.*

### 4.1 — Observation weighting for dream distillation

**Note.** The *structural* piece — turning observations into typed, queryable Chits — is done in Project 0.5. What's left for Project 4.1 is the *weighting logic* that dreams (4.2) need to decide which observations to compound vs. let burn. Previously this sub-project was "create structured observations," but Project 0 absorbs that; what remains is actual downstream usefulness logic.

**Problem.** Observations are now structured Chits (type=observation, ephemeral by default), but dreams still need a way to decide which to promote to BRAIN. Raw count ("3+ observations = rule") is too coarse — one loud observation from the founder should weigh more than three casual sidebar comments. Time matters too (recent > old). Category matters (FEEDBACK > NOTICE). Subject proximity matters (direct founder observation > observation-about-another-agent).

**Scope.**
- Observation importance/weight score function: combination of `fields.observation.importance` (1-5, author-rated), category weight (FEEDBACK=3, DECISION=3, DISCOVERY=2, PREFERENCE=2, NOTICE=1, CORRECTION=3), recency decay (observations older than 30d count half, 90d quarter), subject weight (observations about Mark: 2x, about a Partner: 1.5x, about an Employee: 1x).
- Dream-distillation input: when Dream process queries observations, it queries with score and uses score-thresholds for promotion decisions (3 observations scoring ≥ X → pattern; 2 observations scoring ≥ Y contradicting existing BRAIN rule → flag).
- Score is computed on query, not stored on the Chit, so the function can be tuned without rewriting history.

**File paths:**
- `packages/shared/src/observation-weight.ts` (new — pure weight function, test-friendly)
- `packages/shared/src/chits.ts` (query API extension — `queryChits` with computed `weight` field when sorted)
- `packages/daemon/src/dreams.ts` (consume weighted observations in dream prompts)

**Test strategy.**
- Unit: weight function produces expected scores for known scenarios (founder feedback on Partner = X; casual NOTICE about Employee = Y; etc).
- Unit: recency decay formula verified at multiple time points.
- Integration: dream run with weighted observation input correctly promotes high-weight patterns while skipping low-weight noise.

**Depends on:** 0.1 (Chit), 0.5 (observation type)
**PRs:** 1-2

### 4.2 — Dreams that actually distill

**Problem.** Dreams today re-summarize observations. That's not distillation — it's compression. The result is shorter but no more load-bearing. For BRAIN entries to matter, dreams need to *compound* — find repeated patterns, surface contradictions, promote stable rules.

**Scope.**
- Dream prompt rewrite: "find patterns (same observation-category + subject appearing N times), surface contradictions (new observation contradicts existing BRAIN rule), compound insights (multiple DISCOVERY observations combining)."
- Pattern detection logic (can be done in prompt with structured input from 4.1):
  - 3+ FEEDBACK observations about same subject → promote to a BRAIN rule
  - 2+ DISCOVERY observations linked by common subject → compound into an insight
  - New observation directly contradicts an existing BRAIN rule → flag for review (founder or Partner decides which wins)
- BRAIN update semantics:
  - Rules have provenance: cite the originating observation ids
  - Rules have confidence: N observations back it, confidence N/5
  - Contradicting rules get both marked as "needs-resolution" — don't silently overwrite
- Dream output: list of BRAIN updates with citations, not a re-summary paragraph.

**Acceptance criteria.**
- An agent makes 3 similar FEEDBACK observations ("mark prefers X") across 3 days.
- Next dream consolidates them into a single BRAIN rule: "Mark prefers X (provenance: obs-123, obs-145, obs-201, confidence 3/5)."
- Next agent dispatch reads BRAIN and references the rule when acting.
- A later observation contradicting the rule gets flagged, not silently applied.

**Depends on:** 4.1
**PRs:** 3-4

### 4.3 — [ABSORBED INTO 1.1]

The core taming command + ceremony shipped in 1.1 — see 1.1's "Ceremony" subsection for the shipped shape:

- Command is `cc-cli tame` (not `cc-cli agent promote` — renamed because "tame" is the load-bearing verb; it pairs with hire/fire as the three verbs of an agent lifecycle, and captures the specific relational act of bringing an ephemeral slot into the trusted named circle).
- Ceremony is inbox-chit based: Tier 3 welcome for new Partner from founder; Tier 2 walkaround-requests for every other Partner. No faked agent voice; each Partner engages in their own voice on their own tempo. The accretion IS the witnessing.
- Genesis BRAIN entry: `BRAIN/genesis.md` (not `01-origin.md`) carries the founder's reason with `source='founder-direct'`, `confidence='high'`, `type='self-knowledge'`.

What remains deferred to this project (4.3) once role-level pre-BRAIN lands (4.x):

- **Role pre-BRAIN seeding.** On tame, the new Partner's BRAIN should inherit the accumulated pre-BRAIN of their role (observations other Employees in that role produced over time, distilled into rules). Requires 4.x's pre-BRAIN distillation mechanism to exist. The 1.1-shipped tame creates an empty BRAIN/ dir + genesis.md; 4.3 extends it to pre-BRAIN inheritance.
- **Second BRAIN arrival entry** (`BRAIN/02-arrival.md`): the new Partner's first reply to the ceremony, written back as BRAIN. Requires a dispatch hook to capture their response. 1.1-shipped tame doesn't do this; the welcomes arrive, the new Partner responds via normal channels, no automated capture.

Both are meaningful additions but not blockers — 1.1's shipped tame already feels like a real moment with the inbox ceremony + genesis.md. 4.3 is the accumulating upgrade when pre-BRAIN + dreams are live.

**Project 4 ship criterion:** an Employee that's been shipping backend work for 2 weeks gets promoted via a witnessing ceremony. Next session Joe reads BRAIN with accumulated insights (role pre-BRAIN seed + origin reason + arrival memory). Behavior changes — references past incidents, shows personality, makes founder-aligned judgment calls. Promotion feels like a real moment, not a flag flip.

---

## Project 5: Culture Transmission

*The thing text can do, done right. Culture actually shapes behavior.*

### 5.1 — Feedback propagation

**Problem.** The feedback-detector (already shipped) captures feedback from Mark's messages but it sits in observations as one data point among many. It doesn't *shape* corp behavior. Agents don't read feedback-observations on dispatch; they rediscover preferences over and over.

**Scope.**
- Feedback-detector upgrade: on detecting FEEDBACK from founder, write the observation (as in 4.1) AND trigger a cultural update:
  - If the feedback is *corp-wide* (applies to anyone's work — "ship granular commits"): append to CULTURE.md as a candidate rule.
  - If the feedback is *agent-specific* (applies to one agent — "Joe, your code reviews need to be sharper"): append to that agent's BRAIN as a candidate rule.
- Candidate rules become real rules after a threshold (2+ mentions, or 1 mention + 7 days without contradiction). Promotion is automatic via dream distillation (4.2).
- All rules carry provenance: the incident that earned them (quote + timestamp + context).

**Acceptance criteria.**
- Mark gives corp-wide feedback in #general → feedback-detector fires → observation written → candidate added to CULTURE.md with citation back to Mark's message.
- Mark gives agent-specific feedback to Joe → appears as candidate in Joe's BRAIN, cited.
- Next dispatch of any agent reads CULTURE.md (via @imports); Joe additionally reads his BRAIN.
- Candidate becomes a real rule after the threshold; agents reference it in subsequent judgment.

**Depends on:** 4.1, 4.2
**PRs:** 2

### 5.2 — CULTURE.md as living document

**Problem.** The CEO already writes a CULTURE.md sometimes, but it's free prose and not load-bearing. Agents don't really read it, and even if they did, it wouldn't help — it's aspirational, not specific.

**Scope.**
- CULTURE.md at corp root, structured format:
  - Each rule is an XML block: `<rule id="..." confidence="..."><claim/><reason/><incident-ref/><applies-to/></rule>`
  - `applies-to` = "all" | specific role
  - Rules added automatically by 5.1, manually by founder via `cc-cli culture add`, removed or updated via explicit command
- CULTURE.md imported by every agent's CLAUDE.md template (`@./CULTURE.md` from repo root — or from corp root, via a symbolic-ish mechanism)
- Rules visible in TUI under a /culture view — Mark can skim what the corp believes
- Cultural contradictions (two rules claiming opposite things) surfaced in TUI + flagged to founder

**Acceptance criteria.**
- CULTURE.md has ≥3 auto-generated rules with incident provenance after a few days of normal corp activity.
- An agent in a new dispatch cites a CULTURE.md rule when making a judgment call.
- Founder can view, add, remove, resolve cultural rules via cc-cli.

**Depends on:** 5.1
**PRs:** 2

### 5.3 — Founder-voice preservation

**Problem.** Agents don't reliably model Mark's voice. They drift toward generic professional-Claude tone — formal, slightly sycophantic, overly explanatory. Mark's actual voice (lowercase, direct, no sugarcoating, dry humor) has to be re-discovered every agent session.

**Scope.**
- Voice snapshot mechanism: a daemon-level task runs weekly (or on-demand), samples the last N founder messages across all channels, distills:
  - Stylistic markers (capitalization, punctuation, common phrases, tone indicators)
  - Current preferences (phrases like "don't X", "yeah", "bro" patterns)
  - Recency-weighted — last week matters more than two months ago
- Output: USER.md at corp root, structured (XML like CULTURE.md) with `<voice>`, `<preferences>`, `<current-focus>` sections.
- USER.md imported by every agent's CLAUDE.md.
- Agent prompt guidance (in SOUL/AGENTS) specifically addresses voice: "match Mark's style without mimicking sycophantically — lowercase and direct when appropriate, but don't copy phrases."
- Configurable: founder can opt-out per-channel (sensitive stuff), can force-regenerate, can manually edit.

**Acceptance criteria.**
- USER.md exists and reflects actual recent Mark-voice patterns (verified by reading it and confirming it captures lowercase, no sugarcoat, dry humor).
- New agent in a fresh dispatch speaks with recognizable Mark-voice alignment (not mimicry — alignment).
- Mark can regenerate or edit manually via cc-cli.

**Depends on:** 4.1
**PRs:** 2

---

## Project 6: Cleanup & UX

*Ship the peacock. Every name delivers; every view reflects reality.*

### 6.1 — Delete dead concepts

**Problem.** After projects 1-5, many old concepts are replaced by new ones. Leaving them in the codebase as parallel paths is exactly the "vocabulary without capacity" sin the refactor exists to fix. They must go, on purpose, deliberately.

**Scope.** Walk the codebase and delete:
- Old Pulse heartbeat behavior — the 5-min idle-agent nudging (superseded in 1.9 when Sexton absorbed that work; Pulse's NAME persists but its scope shrank to "tick the Alarum")
- Old Blueprint runbook reader / `cc-cli blueprints run` (replaced by blueprint-as-molecule cooking in 1.8)
- Fragment injection call for claude-code agents (removed in 1.5); keep fragments for OpenClaw
- Old Casket-as-four-files structure if migrated to single-pointer hook
- Old Hand-as-chat-announcement (the legacy chat-delivery path; replaced by durable chit-based Hand in 1.4)
- Dead code paths: Jack mode if it became redundant with Casket-hooked dispatch
- Dead fragments not migrated to CLAUDE.md
- Old SOUL-as-template hiring code if replaced by earned-soul via promotion
- Anything that survived as legacy but has no consumer after projects 1-5

**Acceptance criteria.**
- `grep` for the removed names in `packages/` returns 0 references outside of changelogs/migration notes.
- `pnpm build` + `pnpm test` pass.
- No dangling documentation references to deleted concepts (docs pass in 6.2).

**Depends on:** all prior projects shipped
**PRs:** 3-4 (grouped by subsystem — TUI cleanup, daemon cleanup, shared cleanup)

### 6.2 — Rewrite docs/

**Problem.** The docs/ private design spec currently describes the pre-refactor corp. If someone (founder, future-Claude, outside contributor) reads docs/, they get a wrong mental model. Also CLAUDE.md at repo root needs updating to reflect the new reality.

**Scope.** Update:
- `docs/architecture/` — describe Employee/Partner split, Casket-as-hook, molecules, Witness, Refinery, Failsafe
- `docs/flows/` — onboarding flow updated (mutual witnessing still central, but now framed as the promotion ceremony, not hire-time)
- `docs/concepts/glossary.md` — all terms: Employee, Partner, Casket, Contract, Task, Molecule, Witness, Refinery, Failsafe, bacteria, pre-BRAIN, ceremony
- `docs/next-steps.md` — cross off what's shipped, point forward to next work
- Manifesto, lineage, vision/ — UNTOUCHED. Those are philosophical origin and stay.
- Repo-root `CLAUDE.md` (project instructions) — rewritten to reflect new architecture

**Acceptance criteria.**
- A new contributor reading docs/ + CLAUDE.md can build a correct mental model of the corp without reading any code.
- No contradiction between docs/ and the code (verified by a spot-check review against a sample of projects).

**Depends on:** 6.1
**PRs:** 2-3

### 6.3 — TUI / founder UX

**Problem.** Current TUI shows every agent as a uniform member — no visible distinction between Partners and Employees, no visibility into the bacteria scaling, no merge queue view, no Contract-chain visualization. The founder's mental model depends on the TUI matching the substrate; mismatch means Mark can't verify what's happening.

**Scope.**
- Member sidebar: Partners listed by name (with status), Employees aggregated per role ("Backend Engineer: 2 active, 1 idle, role pre-BRAIN 47 obs")
- Contract view: for a selected Contract, show its Task chain with progress, current step, who's working
- Merge queue view: ordered list of pending merges with submitter and status
- Promotion view: when an Employee is a candidate for promotion, surface it; founder confirms with reason
- Ceremony rendering: when a promotion happens, render the welcomes as a distinct visual moment in the channel
- Corp-level views: Witness health summary, cultural rules, bacteria activity
- Keyboard shortcuts to jump between these views

**Acceptance criteria.**
- Founder can, at a glance in the TUI, see: who the Partners are, how many Employees exist, what Contracts are active, what's in the merge queue.
- Promoting an Employee via TUI is a real UX (not just cc-cli), with reason input and confirmation.
- The ceremony is visually distinct — not just another chat message.

**Depends on:** projects 1-5 shipped (views need the data)
**PRs:** 3-4

### 6.4 — v3.0 release

**Problem.** This refactor is a major version bump. v2.x was the "peacock in the costume" era; v3.x is the "justified peacock." Needs to be packaged as a release, not a silent upgrade.

**Scope.**
- Version bump to `3.0.0` across all packages
- STATUS.md rewrite — the refactor era gets its own section, major features cross-linked
- CHANGELOG.md — granular per-project summary of what shipped
- Release notes (for README/website/blog): the thesis, what changed conceptually (not just feature-list), migration guidance for anyone running an old corp
- A migration note: "corps from v2.x don't auto-migrate, fresh start recommended, here's how to preserve BRAIN/observations from important Partners if you really want to"
- Potentially: `cc-cli migrate v2` command for the brave

**Acceptance criteria.**
- `cc-cli --version` shows 3.0.0.
- Release notes read true — someone reading them understands why the refactor happened and what's different.
- Old-corp migration path documented, even if the official stance is "clean start preferred."

**Depends on:** 6.1, 6.2, 6.3
**PRs:** 1-2

**Project 6 ship criterion:** Mark can show Claude Corp to a stranger and they see a coherent system — every concept does what its name claims, the TUI visualizes the substrate honestly, the docs describe what actually exists, the version is 3.0. Peacock feathers, earned.

---

## Still-Open Questions

These are real questions not yet decided. Revisit before/during the project where they bite.

1. **Partner demotion.** Can a Partner be demoted back to Employee? Or is firing the only reversal? (Genuinely unsure. Default to "no demotion, fire only" if nothing invented.)

2. **Founder-voice preservation invasiveness.** Snapshot cadence, opt-in vs opt-out, configurable. Project 5 concern, not urgent.

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

## Where We Are Right Now (updated 2026-04-24)

Decided: everything in the "Decisions Made" section above.

Still being discussed: the two remaining open questions (Partner demotion, voice-preservation invasiveness).

**Implementation-detail depth:**
- Project 1 sub-projects (1.1 through 1.9) have concrete file paths, test strategy, and dependencies spelled out. Most have shipped (see per-section [shipped] markers); 1.10-1.12 are spec-complete and ready to pick up.
- Projects 2 through 6 have design-level detail (problem, scope, acceptance criteria, dependencies) but NOT file paths or test strategy per sub-project. Implementation detail gets filled in when each project starts — at which point the implementer should walk the current codebase (since earlier projects will have changed the shape), propose paths, add test strategy, and update this doc before the first sub-project PR.

**Shipped as of 2026-04-24:**
- **Project 0** — Chits, lifecycle, wtf + CORP.md + audit gate + inbox — complete.
- **Project 1** — 1.1 (Employee/Partner), 1.2 (Casket), 1.3 (chain + state machine), 1.4 (Hand rewrite) + 1.4.1 (block), 1.6 (Dredge-via-handoff-chits), 1.7 (Partner compaction), 1.8 (Blueprint-as-molecule), 1.9.0-1.9.4 (sweeper substrate + Sexton role + Pulse/Alarum + Sexton runtime).

**In flight (open PRs, 1.9.5 phase):**
- PR #178 — OS supervisor configs (systemd/launchd/Task Scheduler install + uninstall).
- PR #179 — Sweeper execution + 6 code sweepers (silentexit, agentstuck, orphantask, phantom-cleanup, chit-hygiene, log-rotation) + `kink` chit type + dedup/auto-resolve + wake-message wiring.

**Immediate next steps** (after 1.9.5 PRs land):
1. Remaining 1.9 follow-ups: `cc-cli sweeper new --prompt` generator, patrol blueprint library (the contract-shaped blueprints Sexton cooks + walks), + `conflict-triage` AI sweeper.
2. **Project 1.10** — Bacteria (auto-scaling Employee pool via weighted queue depth from TaskFields.complexity, role-resolver spawn integration, self-naming flow). Prerequisite for 1.12. Spec pinned earlier today: silentexit reinitializes existing slots; bacteria only creates new ones; disjoint domains.
3. **Project 1.11** — Budget governor + crash-loop circuit breaker. Pinned integration point: silentexit retry-budget goes through 1.11's breaker, not a per-sweeper counter. Enables the `breaker-reset` + `budget-watch` sweepers.
4. **Project 1.12** — Shipping (merge lane + janitor Employees). Pinned spec update earlier today: conflict blockers are role-scoped, not slot-scoped, so no PR gets stranded when its author decommissions.

Claude (not the corp) drives the build — the corp hasn't earned that trust yet. Eventually, once the corp works well on this new substrate, future refactors can be corp-driven. But not this one.

---

*Document owner: whoever is implementing next. Should be kept updated as PRs land — cross off sub-items, note decisions, log open-questions answered.*
