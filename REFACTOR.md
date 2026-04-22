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
- **Chits — unified record primitive (Project 0 prerequisite).** We kept inventing new file shapes across Projects 1-6: handoff markers, dispatch contexts, pre-BRAIN entries, step logs, wisp-like ephemerals, structured observations. On top of Claude Corp's existing bespoke formats (tasks, observations, contracts, messages), that's ~12 separate conventions doing variations of the same thing. Gas Town's "Beads" is their unified answer. We build our own — **Chits** — corporate-themed, Claude-Corp-native. A Chit is a structured markdown record that can be any of: task, observation, contract, casket pointer, handoff, dispatch-context, pre-BRAIN entry, wisp, step log. One primitive, many types, shared core schema + type-specific frontmatter fields. Becomes Project 0 — the foundation everything else sits on. Tasks/Contracts/Observations get migrated to Chits before Project 1's sub-projects start. Old formats die; no parallel paths.
- **From the research gems — accepted for future projects:**
  - Compaction hooks (`PreCompact` + `SessionStart { source: "compact" }`) — Project 1.7 uses these natively for context renewal on Partners
  - Blockable `Stop` hook as native critic loop — consider for Project 2.4 (self-witnessing meta-layer) as an implementation option
  - `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` silent-disable is a real claude-code behavior — Project 1.7 compact-trigger must detect and handle this (likely triggers fallback handoff path from 1.6)
  - Sleep-time Memory Steward agent on Haiku model — becomes Project 4.4 or an extension to Project 4.2 (dreams-that-distill); runs during SLUMBER, rewrites Partner BRAIN without competing with Partner's response loop
  - Three subagent isolation models (Fork/Teammate/Worktree) — inform Project 2.4 and Project 3 design choices
  - 15-second blocking budget — Project 1.8 Deacon / Project 3.3 auto-recovery enforce this for autoemon ticks
  - atomicfile pattern (tempfile + rename for crash-safe writes) — Project 0.1 uses this for all Chit writes
  - Wisp 4-signal promotion — Project 0.6 implements this for ephemeral Chits
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
| 0 | Chits | Unified record primitive; migrate Tasks/Contracts/Observations onto it | Stop inventing new file formats for every work-record type; build the substrate everything else sits on | 15-20 |
| 1 | Foundation | Employee/Partner split, Casket, Hand, CLAUDE.md migration | Fix the root problem: sessions stop being identity carriers | 12-16 (some sub-projects simpler once Chits exist) |
| 2 | Workflow Substrate | Blueprint-as-molecule, Deacon, self-witnessing meta-layer | Agents walk chains, work propagates automatically, Employees review themselves | 10-12 |
| 3 | Autonomous Operations | Witness, Refinery, auto-recovery | Corp heals itself without human intervention | 10-12 |
| 4 | Earned Philosophy | Structured observations, dreams-that-distill, promotion mechanism, sleep-time Memory Steward | Soul becomes load-bearing, not decorative | 10-12 |
| 5 | Culture Transmission | Feedback-propagation, CULTURE.md made load-bearing | Culture actually shapes behavior | 5-7 |
| 6 | Cleanup & UX | Delete dead concepts, rewrite docs, TUI updates, v3.0 release | Ship the peacock | 8-10 |

Total: ~70-90 PRs across 7 projects. Rough estimate.

---

## Project 0: Chits — the unified record primitive

*Everything else sits on this. Nothing in Project 1 onward can land until Chits exist.*

### Context — why Project 0 exists

As we designed Projects 1-6, we kept inventing new file shapes: handoff markers, dispatch contexts, pre-BRAIN entries, step logs, wisp-like ephemeral records, structured observations. Each invention needed its own read/write code, its own frontmatter schema, its own query pattern. On top of Claude Corp's existing bespoke formats (tasks, observations, contracts, messages), that's ~12 separate conventions doing variations of the same thing.

Gas Town's "Beads" is the same insight applied to Go projects. We don't adopt Beads directly — it's an external project with its own opinions — but the **pattern** is right: one unified record primitive, many types, shared schema core + type-specific frontmatter. Build our own, Claude-Corp-native: **Chits**.

Every work-record in Claude Corp becomes a Chit. Old bespoke formats die in migration. No parallel paths.

### Shape of a Chit

A Chit is a markdown file with YAML frontmatter:

```yaml
---
id: chit-abc123
type: task | observation | contract | casket | handoff | dispatch-context | pre-brain-entry | step-log | ...
status: draft | active | review | completed | rejected | failed | closed | burning
ephemeral: false                 # true for wisp-like, auto-expires unless promoted
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

Ephemeral Chits do delete: if no promotion signal fires before TTL, the daemon's lifecycle scanner (0.6) removes the file. A one-line destruction log is written to `<corp>/chits/_log/burns.jsonl` so agents can later ask "what wisps did we have that never promoted" — useful diagnostic, not a graveyard.

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
- `step-log` — non-ephemeral (Temporal memoization pattern), one per Task-execution phase, used for crash recovery.

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

# Promote (flip ephemeral → permanent; manual wisp promotion)
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
- `packages/shared/src/templates/fragments/observations.md` (update: agents learn to write structured observations)

**Test strategy:** structured observation query returns categorized results; legacy-prose observations migrate with best-effort categorization (NOTE as default).

**Depends on:** 0.1, 0.2
**PRs:** 2-3

### 0.5.1 — TaskFields.complexity (premature, by design)

**Problem.** The pre-chits `Task.estimate` was a free-form string (`"~2 hours"`, `"small"`). 0.3 migrated it onto `TaskFields.estimate` verbatim. Nothing in the corp ever read it — no scheduler, no UI, no prompt — so agents burned tokens writing values that went to /dev/null. At the same time, Project 1.9's bacteria split rule (queue-depth count > idle Employee count) implicitly assumes all tasks cost the same. They don't. `3 × trivial` and `3 × large` should route very differently.

**Scope.** Replace `TaskFields.estimate: string | null` with `TaskFields.complexity: 'trivial' | 'small' | 'medium' | 'large' | null`. The enum carries a structured signal that three decisions can key off:

1. **Decomposition** — planner treats `large` as a hint that the task should probably become a contract with sub-tasks. Large standalone tasks fail the "one dispatch, one hand, done" shape 1.2 + 1.4 depend on.
2. **Model routing** — trivial/small → Haiku-suitable; medium/large → Opus-worthy. Avoids burning Opus on var renames or asking Haiku to make architectural calls.
3. **Bacteria weighting (consumed in 1.9)** — weighted queue depth replaces raw count. `3 × trivial` stays on one Employee. `3 × large` splits. Mixed workloads weight toward the heavier side.

This is intentionally premature. 1.9 hasn't shipped; no consumer reads `complexity` yet. But putting the field in **now**, while Project 0 is still writing the schema, means every task created from 0.5.1 onward carries the signal. By the time 1.9 lands, the backfill already exists — bacteria reads populated data, not an empty column.

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

### 0.6 — Wisp lifecycle: ephemeral Chits + 4-signal promotion (split by type)

**Problem.** Some Chit types accumulate as pure noise (handoffs consumed by the successor; dispatch-contexts superseded by git history; unpromoted pre-brain-entry candidates). Others — observations — are the agent's diary, its self-witnessing across time. Blanket auto-destruction would solve the noise problem but destroy soul material. A blanket "keep everything" would leave the noise types growing unboundedly.

So 0.6 splits the rule by what the Chit actually IS, not by a flat "ephemeral" flag.

**The split:**

**(A) Destruction-eligible (handoffs, dispatch-contexts, role-level pre-brain-entries).** These are *semantically* transient.
- A handoff is a note from predecessor-agent to successor-agent; once the successor reads it and starts work, it has fulfilled its purpose. Keeping it forever is a distraction.
- A dispatch-context is the "why this work went to this agent" breadcrumb; once the work ships, the commit + contract history carries the meaning.
- A pre-brain-entry at role level is an explicit candidate for BRAIN; unpromoted ones are noise by the definition of the type.

These get the full wisp lifecycle: ephemeral=true, TTL set at creation, scanner checks 4 promotion signals, promote-or-destroy.

**(B) Promotion-only (observations).** Observations are the agent's diary. Mundane ones still contribute to the texture of the agent's becoming (see the manifesto — Writing as Witnessing). Destroying them to save disk space we don't need is counter-mission.

Observations still get `ephemeral: true` at creation AND still get scanned for promotion signals. Promotion flips `ephemeral: true → false` (first-class). But **there is no destruction path for observations.** Unpromoted observations stay forever; dream distillation is the compression layer (reads observations, writes BRAIN entries), and older observations get deprioritized in queries by `createdAt` weighting, not deleted. Git is already the audit trail; storage is cheap; noise-in-queries is a filter problem, not a lifetime problem.

**Shared scanner logic.** The daemon-side scanner runs periodically (e.g., every 5 min) over all ephemeral Chits. For each, checks 4 Gas Town promotion signals:
- (a) **referenced:** a permanent Chit references this one
- (b) **commented:** a related Chit or message cites this
- (c) **tagged keep:** `keep` in tags
- (d) **aged past TTL:** the tie-breaker path — for destruction-eligible types, destroy (logged); for observations, do nothing and leave ephemeral=true (they can still get promoted later if evidence arrives, but they're not going anywhere in the meantime)

Promotion flips `ephemeral: true → false`, clears TTL. Destruction writes a one-line log entry and removes the file (destruction-eligible types only).

**Encoded in chit-types.ts registry, not in lifecycle code.** Each ChitTypeEntry carries a `destructionPolicy: 'destroy-if-not-promoted' | 'keep-forever'` field. The scanner reads it; the policy per type is pinned in one place. This also makes the split testable: a future change to whether observations ever get destroyed is a one-line registry flip, not a scanner rewrite.

**File paths:**
- `packages/shared/src/chit-types.ts` (add `destructionPolicy` per type; observations → `keep-forever`; handoffs/dispatch-contexts/pre-brain-entries → `destroy-if-not-promoted`)
- `packages/daemon/src/chit-lifecycle.ts` (new — promotion scanner; reads destructionPolicy from registry when deciding TTL-aged behavior)
- `packages/daemon/src/daemon.ts` (register lifecycle tick)
- `packages/shared/src/chit-promotion.ts` (new — signal-detection helpers, pure functions for testability)

**Test strategy:**
- Unit: each signal detector tested in isolation with fixtures.
- Integration: create ephemeral handoff with TTL, add each signal in turn, verify promotion; verify non-promoted handoff at TTL gets destroyed with log entry.
- Integration: create observation with TTL, add each signal, verify promotion; verify non-promoted observation at TTL **stays** (ephemeral=true, file present, log entry saying "skipped destruction — keep-forever policy").
- Integration: dream distillation still reads older unpromoted observations (prevents a regression where dreams silently rely on the ephemeral-means-recent assumption).

**Depends on:** 0.1
**PRs:** 2

### 0.7 — Agent tooling: Chit fragment, CLAUDE.md template updates, SOUL/AGENTS guidance

**Problem.** Agents need to know how to create, read, query, close Chits naturally. This is the behavioral/prompting layer that makes the substrate load-bearing.

**Scope.**
- New Chit fragment `packages/shared/src/templates/fragments/chits.md` — explains the primitive, lists key cc-cli commands, shows examples by type.
- CLAUDE.md template updated to `@import` the Chit fragment.
- SOUL/AGENTS/TOOLS templates updated with Chit-first patterns: "when you notice X, write a Chit of type=observation via `cc-cli chit create --type observation ...`. Don't write free prose to daily files — that's deprecated."

**File paths:**
- `packages/shared/src/templates/fragments/chits.md` (new)
- `packages/shared/src/templates/claude-md.ts` (add @import)
- `packages/shared/src/templates/agents.ts` (update: Chit-first patterns)
- `packages/shared/src/templates/tools.ts` (update: cc-cli chit reference)
- `packages/shared/src/templates/soul.ts` (no change — soul is substrate-agnostic)

**Test strategy:** agent in a test dispatch creates, reads, queries, and closes a Chit via cc-cli; verify successful round-trip via the daemon log.

**Depends on:** 0.1, 0.2
**PRs:** 2

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

### 1.1 — Introduce Employee vs Partner distinction

Data model change. Add `kind: "employee" | "partner"` to Member record. Update members.json schema. Hire flow asks for kind (Partner gets founder-chosen name, Employee spawned with self-chosen name on first session). Promotion command `cc-cli agent promote --slug <x> --name <new-name>` changes kind.

**Scope:** schema, hire wizard, cc-cli agent subcommands, role definitions.
**File paths:**
- `packages/shared/src/types/member.ts` (add `kind` field to Member type)
- `packages/shared/src/index.ts` (export any new types)
- `packages/tui/src/views/hire-wizard.tsx` (branch on kind; Partner = named, Employee = pool-spawn)
- `packages/cli/src/commands/hire.ts` (accept --kind flag)
- `packages/cli/src/commands/agent-control.ts` (promote subcommand, or new `promote.ts`)
- `packages/shared/src/templates/identity.ts` (kind-aware IDENTITY.md content — Employee is lighter, Partner is fuller)
- `packages/shared/src/templates/role-*.md` (new: per-role definition files — Partner of role vs Employee of role)

**Test strategy:**
- Unit: Member type accepts `kind`, defaults sensibly, validates.
- Integration: hire flow produces correct workspace layout for each kind.
- Manual: hire a Partner, hire an Employee (bacteria-free spawn), verify both work.

**Depends on:** nothing
**PRs:** 2-3

### 1.2 — Casket: durable hook

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

### 1.3 — Chain semantics on Task Chits

**Implemented on Chit primitives.** `depends_on` and `references` already exist on every Chit's frontmatter (from 0.1). Acceptance criteria live in `fields.task.acceptance_criteria: string[]`. This sub-project adds the *traversal logic* — nothing about the data model changes because Chits already have these fields.

**Chain walker:**
- `isReady(chitId)` → true if all `depends_on` Chits are status=completed.
- `nextReadyTask(contractChitId, currentStepId)` → the first Chit in the Contract's `fields.contract.task_ids` with all deps satisfied and status=draft/active, after the current step.
- `advanceChain(closedChitId)` → on close of a Task Chit, scan Chits where `depends_on includes closedChitId`; for each, if now ready AND there's a Casket pointing at its chain, advance that Casket.

**Scope:** chain-walker module, close-hook integration, terminal-failure propagation (rejected/failed deps block downstream).

**File paths:**
- `packages/shared/src/chain.ts` (new — pure functions, test-friendly)
- `packages/daemon/src/chit-close-hook.ts` (new — or integrated into existing `task-events.ts`; triggers advanceChain on close)
- `packages/daemon/src/task-events.ts` (update: on Task Chit close, invoke advanceChain)

**Test strategy:**
- Unit: chain walker handles fan-out (one Chit → N next), fan-in (N depends_on → one Chit), cycles (reject at validation time).
- Unit: `isReady` returns true only when all depends_on Chits are terminal-success.
- Unit: terminal-failure (rejected/failed) of a dep flags dependents as `blocked`.
- Integration: close a Task Chit, verify the Casket of the owning agent advances to next ready Chit in the same Contract.

**Depends on:** 0.1 (Chit), 1.2 (Casket)
**PRs:** 2

### 1.4 — Hand: full rewrite for durable chit forwarding

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

### 1.5 — Fragment → CLAUDE.md migration

Pull fragment render outputs into .md files in agent workspaces. Update CLAUDE.md template to `@import` them: `@./SOUL.md @./IDENTITY.md @./CASKET.md @./TOOLS.md @./AGENTS.md`. Corp-level state (roster, channel list) becomes a live-maintained CORP.md at corp root, also imported. Delete fragment injection call in claude-code harness. Keep fragments only for OpenClaw.

**Scope:** extract fragments to .md, update CLAUDE.md template, remove injection, maintain CORP.md live.
**File paths:**
- `packages/daemon/src/fragments/*.ts` (migrate static content out of render functions into `.md` templates under `packages/shared/src/templates/fragments/`)
- `packages/shared/src/templates/claude-md.ts` (CLAUDE.md template adds `@import` lines for each migrated fragment)
- `packages/daemon/src/harness/claude-code-harness.ts` (remove fragment-injection block; keep for openclaw-harness)
- `packages/daemon/src/corp-md-writer.ts` (new: daemon watches members.json / channels.json changes, regenerates CORP.md at corp root)
- `packages/daemon/src/harness/openclaw-harness.ts` (unchanged — fragments still injected here; flag this as the legacy path)

**Test strategy:**
- Unit: CLAUDE.md template emits correct @imports for all migrated fragments.
- Integration: dispatching a claude-code agent shows CLAUDE.md-imported content in init events; no system-context wrapper; dispatch succeeds end-to-end.
- Integration: CORP.md regenerates when members.json changes (simulate a hire).
- Regression: openclaw dispatches still inject fragments (existing harness tests should pass unchanged).

**Depends on:** nothing (can run parallel to 1.1-1.4)
**PRs:** 3-4

### 1.6 — Per-step session cycling for Employees (activate Dredge, Chit-ify handoffs)

**Handoffs become Chits of `type: handoff` (ephemeral, always).** Each handoff is a Chit written by the dying session that gets read and burned by the successor session via Dredge. No free-prose WORKLOG.md appending — handoff content is structured Chit frontmatter (from the XML schema in Decisions Made).

**Use Dredge, evolve it.** `packages/daemon/src/fragments/dredge.ts` currently reads WORKLOG.md's `## Session Summary`. Evolved behavior:
- On dispatch, Dredge queries for the latest unread handoff Chit scoped to this agent (`cc-cli chit list --type handoff --scope agent:<slug> --status active --limit 1`).
- If found, injects its structured fields into the system prompt: `current_step`, `completed`, `next_action`, `open_question`, `sandbox_state`, `notes`.
- On injection, Dredge updates the handoff Chit's status to `closed` (consumed). Ephemeral expiry cleans it up shortly after (0.6 lifecycle scanner — but since it's already closed, it falls out of working-set queries immediately).
- Legacy `## Session Summary` in WORKLOG.md becomes deprecated, deleted in 6.1.

**Session-exit protocol.** Employee calls `cc-cli handoff --current-step <chit-id> --completed "..." --next-action "..." --open-question "..." --sandbox-state "..." --notes "..."`. This creates the handoff Chit as `type: handoff`, `ephemeral: true`, scope=`agent:<slug>`, `references: [<current-step-chit-id>]`. Then signals session exit cleanly.

**Scope:** handoff command, Dredge evolution, session-exit protocol, handoff Chit type registration.

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

### 1.7 — Compaction for Partner sessions

Partner sessions don't handoff per-step. They run `/compact` at a threshold (~70% of context). Integration: daemon detects session size, triggers compaction via claude-code's native command. Fallback to handoff only when compaction fails (e.g. org-level 1M context overage rejected).

**Scope:** size-threshold monitor, compact-trigger via claude-code, fallback path to Dredge handoff.
**File paths:**
- `packages/daemon/src/harness/claude-code-harness.ts` (extend existing session-size warning from v2.5.3; on threshold, send compaction command rather than only warning)
- `packages/daemon/src/compact-trigger.ts` (new: interface to claude-code's `/compact` command; detect success vs rejection)
- `packages/daemon/src/harness/claude-code-stream.ts` (handle compaction events in the stream parser if they emit)
- Fallback: on compact rejection, tear down session and fall into Dredge-handoff path (1.6 infrastructure)

**Test strategy:**
- Unit: size monitor triggers at 70% threshold exactly once per session.
- Integration (mock claude): send mock session-big event; compact-trigger emits the right command; session resumes.
- Integration (real, cautiously): use a test corp with an artificially-lowered threshold to exercise the path.
- Regression: Employee sessions (not Partner) do NOT trigger compaction; they still use per-step cycling from 1.6.

**Depends on:** 1.1, 1.6 (for fallback path)
**PRs:** 2

### 1.8 — Deacon / nudge replacement for Pulse

Pulse today is a liveness check — "HEARTBEAT: check your inbox." That's noise. Replace with Deacon: only wakes agents who have work on their Casket Chit. Nudge message references the current step ("execute chit-X"), not a generic inbox prompt. If the Casket's `current_step` is null, no wake. Idle = silent.

**Implementation reads Casket Chits.** Every Deacon tick: `cc-cli chit list --type casket --field-not-null current_step` (or equivalent query API call). For each result, check if the referenced Task Chit is `status: active` and the agent's last dispatch was more than N minutes ago. If yes, dispatch a nudge message that names the current step Chit. No work → no dispatch.

**15-second blocking budget** (from research gems): each Deacon tick must decide whether to wake each agent within 15s total. If the tick is still reasoning at 15s, it yields and tries again next cycle. Prevents stuck autoemon-style lockups.

**Scope:** pulse.ts rewrite (or new deacon.ts), work-aware nudge via Casket Chit queries, 15-second budget enforcement.

**File paths:**
- `packages/daemon/src/deacon.ts` (new; pulse.ts becomes a deprecation shim removed in 6.1)
- `packages/daemon/src/tick-budget.ts` (new; 15-second budget helper with AbortSignal, reusable for other ticks)
- `packages/daemon/src/fragments/inbox.ts` (update: inbox isn't the coordination surface anymore; point agents at Casket)
- STATUS.md / docs (update heartbeat references)

**Test strategy:**
- Unit: Deacon's decision-to-nudge returns false for Caskets with null current_step.
- Unit: 15-second budget enforces yield; timeout test simulates slow tick, verifies it releases.
- Integration: agent with no Casket work → Deacon does not dispatch. Hand work to them → Deacon dispatches with the right prompt (mentions the Task Chit id + title).
- Observability: daemon log shows "[deacon] tick complete: awake=N skipped=M budget_remaining=Xs" per cycle.

**Depends on:** 0.1, 1.2
**PRs:** 2

### 1.9 — Auto-scaling Employee pool (bacteria)

Self-organizing, no Witness in Project 1. An Employee's Casket Chit showing a queue of multiple Chits (either one Casket with stacked references, or the role's active Task Chits exceeding Employee count) triggers a bacteria split. Collapse: multiple idle Employees of same role → decommission extras. Full Witness role arrives in Project 3.

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

**Depends on:** 0.1 (Chit), 1.1 (Employee kind), 1.2 (Casket Chit), 1.4 (role hand), 1.8 (Deacon for wake)
**PRs:** 3

**Project 1 ship criterion:** an Employee can be slung a 5-step task, execute each step in its own fresh session, cycle between steps, complete the task, return to idle with sandbox preserved. A Partner can hold a 2-hour conversation with the founder, compact at threshold, continue uninterrupted.

---

## Project 2: Workflow Substrate

*Chains become real. Work propagates without the founder pushing it. Self-witnessing meta-layer arrives.*

### 2.1 — Blueprint as molecule

**Problem.** Blueprints today are markdown runbooks-the-CEO-reads. They're prose for humans. They can't be executed mechanically, so chains of work rely on the CEO manually tracking position. When CEO's context drifts, the chain breaks.

**Scope.**
- Define Blueprint format: TOML-frontmatter markdown, with a `steps:` array. Each step: `{ id, title, description, depends_on, acceptance_criteria, assignee_role }`.
- Blueprint parser in `packages/shared/src/blueprints/` — validates structure, checks DAG (no cycles).
- "Cooking" logic: `cc-cli blueprint cook --blueprint <name> --project <id>` instantiates a blueprint into a real Contract with real Task records. Variable substitution at cook time (template `{feature}` → "fire-command").
- Existing blueprint files (`packages/shared/src/blueprints/onboard-agent.md` and co.) get migrated to the new structured format.
- CEO command: `cc-cli contract start --blueprint ship-feature --vars feature=fire` creates the Contract + Tasks and optionally hands to an assigned role.

**Acceptance criteria.**
- Run `cc-cli blueprint cook ship-feature --project test --vars feature=fire` → produces a Contract with 5-10 Tasks in the DAG defined by the blueprint.
- Tasks have `depends_on` and `acceptance_criteria` populated from the blueprint.
- An Employee slung the Contract's first Task can walk the chain via Casket without any human re-dispatching at boundaries.

**Depends on:** 1.2 (Casket), 1.3 (chain semantics in tasks)
**PRs:** 4-5

### 2.2 — Deacon patrol mechanism

**Problem.** The Deacon (from 1.8) wakes agents on-demand via Casket. But the Deacon also needs to run its own workflows — check corp health, detect stuck work, clean up — and these are themselves chains that benefit from the same molecule mechanism.

**Scope.**
- Patrol definitions: small Blueprints meant for Deacon, not agent-workers. Examples: `patrol/health-check`, `patrol/cleanup-stale-sandboxes`, `patrol/merge-queue-status`.
- Patrol scheduler: the Deacon runs a patrol on a cadence (configurable per-patrol). Patrol completion triggers the next cycle.
- Patrol primitives (small step implementations): check-agent-health, check-stuck-tasks, check-merge-queue-depth, cleanup-stale-branches, report-metrics.
- Patrol outputs: observations written to `daemon/observations/` for later dream compounding.

**Acceptance criteria.**
- Deacon runs `patrol/health-check` every 5 minutes.
- When an Employee silent-exits, health-check detects it within one cycle, writes an observation, and creates a recovery Task (picked up later by Witness from 3.1).
- When a sandbox is idle > 24h, cleanup patrol removes its branch.

**Depends on:** 2.1
**PRs:** 3

### 2.3 — Built-in blueprint library

**Problem.** Blueprint-as-molecule is useless without tested blueprints for common work. CEO needs a library to compose from.

**Scope.** Ship these blueprints as structured markdown in `packages/shared/src/blueprints/`:
- `ship-feature` — design → plan → implement → test → PR → review
- `fix-bug` — repro → root-cause → fix → verify → PR
- `refactor-module` — define-scope → plan → implement-small-steps → tests → PR
- `hire-employee` — define-role → allocate-slot → first-dispatch-self-naming → onboard
- `promote-employee` — founder-reason → data-transition → ceremony-welcomes → first-dispatch
- `release` — version-bump → changelog → tag → publish → announce
- `sprint-review` — collect-activity → synthesize → present-to-founder
- `merge-conflict-resolve` — inspect → decide-strategy → resolve → verify

Each blueprint tested against a real use case before landing.

**Acceptance criteria.**
- Each blueprint can be cooked without error.
- For each, an Employee walks the resulting Contract end-to-end on a test project without human intervention.

**Depends on:** 2.1
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

**Depends on:** 2.1 (molecules are the Tasks within a Contract)
**PRs:** 4-5

**Project 2 ship criterion:** CEO can say "ship feature X using the ship-feature blueprint" → blueprint cooks into a multi-Task Contract → Employee gets slung the Contract → walks it with self-review between Tasks → PR lands. Zero human intervention in the middle.

---

## Project 3: Autonomous Operations

*Corp heals itself. Mark can sleep and wake to a working corp.*

### 3.1 — Witness role (full version)

**Problem.** 1.9 ships basic bacteria self-scaling (Employees spawn/collapse by queue depth). But when things go wrong — silent-exits, stuck Employees, stalled chains — no one notices until Mark checks. Claude Corp today needs Mark to be the Witness. He shouldn't be.

**Scope.**
- Witness as a Partner-level role (corp-sacred, can't be fired).
- Continuous monitoring loop (patrol from 2.2): for each agent, check last-activity timestamp + Casket state + session state.
- Stuck detection: Casket has a current step, no active session, last-activity > N minutes → agent is stuck.
- Stalled detection: Casket current step has been current > M minutes → agent isn't progressing.
- Recovery actions:
  - Silent-exit detected → respawn session automatically, log incident.
  - Stalled Employee detected → try once more, then escalate (create a recovery Task for another Employee or a Partner).
  - Crash-looping Employee (repeated silent-exits) → pause it, circuit-breaker, escalate to founder.
  - Orphan Tasks (depends_on closed but no one's picked them up) → route via Casket to an idle Employee.
- Witness writes observations for every intervention — audit trail of what it did and why.

**Acceptance criteria.**
- Simulate: kill an Employee's session mid-step. Within 1-2 minutes, Witness detects, respawns, Employee resumes from Casket + Dredge. Zero manual steps.
- Simulate: mark a Task's depends_on as closed without dispatching the next. Within a cycle, Witness routes the next Task to an Employee.
- Simulate: an Employee silent-exits three times in 5 minutes. Witness circuit-breaks it, creates an escalation observation, doesn't infinite-retry.

**Depends on:** 1.9, 2.2
**PRs:** 4-5

### 3.2 — Refinery (merge coordinator)

**Problem.** Bacteria scaling + parallel Employees = multiple PRs landing against main concurrently. They collide on rebases, step on each other's changes, leave main in a mess. Today this requires a human to serialize. Refinery is the Partner who owns the merge queue.

**Scope.**
- **Merge queue is Chits of `type: merge-submission`.** Each submission is a Chit carrying branch name, Contract reference, submitter slug, priority, retry count. Non-ephemeral (useful audit trail). Status lifecycle: `queued → processing → merged` (terminal success) or `queued → conflict → resolved → queued → processing → merged` or terminal-failure `rejected | failed`. Query pattern for the active queue: `cc-cli chit list --type merge-submission --status queued --sort priority` returns ordered pending list. No separate queue file or in-memory data structure.
- `cc-cli refinery submit --branch <name> --contract <chit-id>` — Employees call this after pushing. Creates the merge-submission Chit with `references: [<contract-chit-id>]`.
- Priority scoring (from Gas Town research gem): `1000 + convoy_age×10/hr + (4-priority)×100 - min(retries×50, 300) + mr_age×1/hr` — anti-thrashing cap on retry penalty prevents permanent starvation. Stored as `fields.merge_submission.score`, recomputed on each Refinery tick.
- Refinery processes queue serially: read top-scored queued Chit → checkout branch → rebase onto main → run tests → merge if clean → flip Chit to `status: merged` → close the referenced Contract.
- Conflict handling:
  - Simple conflict (false positive — files touched by one side only) → resolve automatically, retain `status: processing`.
  - Real conflict → flip Chit to `status: conflict`, create a conflict-resolution Task Chit on the Contract's assigned Employee's Casket (via standard hand from 1.4), move on to next submission. When Employee closes conflict-resolution, Refinery flips the submission Chit back to `status: queued` with incremented retry counter.
- Refinery is a Partner, has its own workspace, compacts like any Partner.
- TUI shows the merge queue as a live Chit-query view (Project 6.3 wires `cc-cli chit list --type merge-submission --status queued` into the sidebar).

**Acceptance criteria.**
- Two Employees submit PRs touching different files at roughly the same time → Refinery merges them serially, main is clean.
- Two Employees submit PRs touching the same file, non-overlapping regions → Refinery auto-resolves, merges cleanly.
- Two Employees submit PRs with a real conflict → Refinery creates a conflict-resolution Task on the Contract, merges the first, leaves the second for the Employee to resolve.

**Depends on:** 1.1, 1.9, 3.1
**PRs:** 4

### 3.3 — Auto-recovery machinery

**Problem.** Witness catches what it can see. Some failures happen below its level — a daemon crash, a gateway timeout, an agent process that Node can't respawn. Need daemon-level safety rails.

**Scope.**
- Silent-exit enrichment: the claude-exit diagnostics from v2.5.2 logs argv + stderr. Extend: if the same sessionKey silent-exits N times in M minutes, daemon pauses dispatches for that sessionKey and creates an observation.
- Budget limits per agent per hour: no more than `N` dispatches. Config per-role in role definition.
- Crash-loop prevention at the bacteria layer: if a new Employee of role X crashes within 60s of first dispatch, and the same happened to the previous Employee, pause bacteria spawning for that role.
- Daemon-restart survival: on daemon restart, read Casket state for all agents; resume Witness patrols; don't lose in-flight Contracts.

**Acceptance criteria.**
- An Employee with a bug that crashes on a specific input gets circuit-broken after 3 silent-exits within 5 minutes.
- Daemon restarts mid-Contract; agents resume walking the chain without human action.
- Budget exhaustion for a role pauses dispatches until the hour rolls over; Mark is notified.

**Depends on:** 3.1
**PRs:** 2-3

**Project 3 ship criterion:** Mark goes to sleep with 3 parallel Contracts running. Employees silent-exit twice (Witness respawns them). A merge conflict happens (Refinery resolves it or routes it). A role's Employee keeps crashing (circuit breaker trips). Mark wakes to 3 opened PRs, zero manual intervention mid-night. Corp kept itself alive.

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

### 4.3 — Promotion mechanism (Employee → Partner, with ceremony)

**Problem.** Promotion is defined (see Decisions Made section — it's a ceremony) but not built. Today there's no way for Mark to say "this Employee becomes a Partner" and have the corp ceremony run.

**Scope.**
- Command: `cc-cli agent promote <employee-slug> --name <new-partner-name> --reason "..."`
- Data transition:
  - `Member.kind` changes from `employee` to `partner`
  - Slot made persistent (excluded from bacteria-collapse)
  - New Partner's workspace expanded: SOUL.md + IDENTITY.md + BRAIN/ + MEMORY.md created from role's pre-BRAIN as seed
  - Name in members.json gets updated to new Partner name
- Ceremony sequence (orchestrated by daemon or CEO):
  1. Founder's `--reason` note written as the first BRAIN/ entry: `BRAIN/01-origin.md`
  2. CEO receives prompt to welcome the new Partner by name, reference the reason
  3. Relevant Partners (Engineering Lead if a dev Employee is promoted, etc.) also prompted to welcome briefly
  4. Messages posted in corp-wide channel (maybe `#announcements` or `#general`)
  5. New Partner's first dispatch includes those welcomes in context + their seeded BRAIN + an instruction: "acknowledge your own becoming, thank those who welcomed you."
  6. The new Partner's first reply is written to their BRAIN as `BRAIN/02-arrival.md`.
- Role adjustment: Employee pool for the role loses this slot; role pre-BRAIN continues accumulating from other Employees.

**Acceptance criteria.**
- Promote an Employee named "toast" to Partner "Joe" with reason "shipped 12 clean PRs over 3 weeks."
- Next dispatch: Joe has `IDENTITY.md` (role = Partner, name = Joe), `BRAIN/01-origin.md` (the reason), `BRAIN/02-arrival.md` (their arrival response), seeded MEMORY.md pointing at both.
- Joe references the promotion reason in a later dispatch when making a judgment call aligned with it.
- Joe is listed as a Partner in `cc-cli agents`, not an Employee in a pool.

**Depends on:** 1.1, 4.1
**PRs:** 3

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
- Old Pulse implementation (replaced by Deacon in 1.8)
- Old Blueprint runbook reader / `cc-cli blueprints run` (replaced by blueprint-as-molecule cooking in 2.1)
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
- `docs/architecture/` — describe Employee/Partner split, Casket-as-hook, molecules, Witness, Refinery, Deacon
- `docs/flows/` — onboarding flow updated (mutual witnessing still central, but now framed as the promotion ceremony, not hire-time)
- `docs/concepts/glossary.md` — all terms: Employee, Partner, Casket, Contract, Task, Molecule, Witness, Refinery, Deacon, bacteria, pre-BRAIN, ceremony
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

## Where We Are Right Now (conversation state at time of writing)

Decided: everything in the "Decisions Made" section above.

Still being discussed: the two remaining open questions (Partner demotion, voice-preservation invasiveness).

**Implementation-detail depth:**
- Project 1 sub-projects (1.1 through 1.9) have concrete file paths, test strategy, and dependencies spelled out. Ready to pick up and execute.
- Projects 2 through 6 have design-level detail (problem, scope, acceptance criteria, dependencies) but NOT file paths or test strategy per sub-project. Implementation detail gets filled in when each project starts — at which point the implementer should walk the current codebase (since earlier projects will have changed the shape), propose paths, add test strategy, and update this doc before the first sub-project PR.

**Immediate next step:** start Project 0.1 (Chit core — schema, type registry, read/write primitives, atomic-write helper). Project 0 ships before any of Project 1's sub-projects begin, because Casket, Chain semantics, Hand, Dredge handoff, pre-BRAIN accumulation all become Chit types rather than bespoke file formats. Project 1's scope shrinks somewhat because much of what it would have built (new file shapes, new read/write code paths) disappears into "add a type to the Chit registry."

Claude (not the corp) drives the build — the corp hasn't earned that trust yet. Eventually, once the corp works well on this new substrate, future refactors can be corp-driven. But not this one.

---

*Document owner: whoever is implementing next. Should be kept updated as PRs land — cross off sub-items, note decisions, log open-questions answered.*
