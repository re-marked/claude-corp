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
- **Chits — unified record primitive (Project 0 prerequisite).** We kept inventing new file shapes across Projects 1-6: handoff markers, dispatch contexts, pre-BRAIN entries, step logs, ephemeral records, structured observations. On top of Claude Corp's existing bespoke formats (tasks, observations, contracts, messages), that's ~12 separate conventions doing variations of the same thing. Gas Town's "Beads" is their unified answer. We build our own — **Chits** — corporate-themed, Claude-Corp-native. A Chit is a structured markdown record that can be any of: task, observation, contract, casket pointer, handoff, dispatch-context, pre-BRAIN entry, step log. One primitive, many types, shared core schema + type-specific frontmatter fields. Becomes Project 0 — the foundation everything else sits on. Tasks/Contracts/Observations get migrated to Chits before Project 1's sub-projects start. Old formats die; no parallel paths.
- **From the research gems — accepted for future projects:**
  - Compaction hooks (`PreCompact` + `SessionStart { source: "compact" }`) — Project 1.7 uses these natively for context renewal on Partners
  - Blockable `Stop` hook as native critic loop — consider for Project 2.4 (self-witnessing meta-layer) as an implementation option
  - `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` silent-disable is a real claude-code behavior — Project 1.7 compact-trigger must detect and handle this (likely triggers fallback handoff path from 1.6)
  - Sleep-time Memory Steward agent on Haiku model — becomes Project 4.4 or an extension to Project 4.2 (dreams-that-distill); runs during SLUMBER, rewrites Partner BRAIN without competing with Partner's response loop
  - Three subagent isolation models (Fork/Teammate/Worktree) — inform Project 2.4 and Project 3 design choices
  - 15-second blocking budget — Project 1.8 Deacon / Project 3.3 auto-recovery enforce this for autoemon ticks
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
| 0 | Chits | Unified record primitive; migrate Tasks/Contracts/Observations onto it | Stop inventing new file formats for every work-record type; build the substrate everything else sits on | 15-20 |
| 1 | Foundation | Employee/Partner split, Casket, Hand, per-step session cycling | Fix the root problem: sessions stop being identity carriers. CLAUDE.md architecture now lives in 0.7. | 10-14 (Project 1.5 absorbed into 0.7; some sub-projects simpler once Chits exist) |
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
- `step-log` — non-ephemeral (Temporal memoization pattern), one per Task-execution phase, used for crash recovery.
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

**Non-ephemeral chit types.** The registry carries `destructionPolicy` on every type for uniformity, but the scanner only visits chits with `ephemeral: true`. Tasks, contracts, casket, step-log are created with `ephemeral: false` and are never seen by the scanner regardless of their registry policy. Their registry entries use `destructionPolicy: 'keep-forever'` + `defaultTtlMs: null` as sensible-default no-ops.

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
- `packages/shared/src/templates/corp-md.ts` (new — builds CORP.md from shared base + kind/role sections)
- `packages/shared/src/templates/corp-md-partner.ts` and `corp-md-employee.ts` (kind-specific sections)
- `packages/daemon/src/fragments/chits.ts` (new for OpenClaw — emits same content at dispatch time, preserving the "both substrates work the same way" invariant)
- `packages/shared/src/templates/claude-md.ts` (shrink to ~60 lines; drop `@import` of AGENTS.md and TOOLS.md)
- `packages/shared/src/templates/agents.ts` (delete — content moves to corp-md templates)
- `packages/shared/src/templates/tools.ts` (delete — content moves to corp-md templates)

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
Employees: "Your task ends with \`cc-cli hand-complete\`. The Stop hook will
audit your work first — you cannot exit a session until it passes."
Partners: "Your context ends with \`/compact\`. The PreCompact hook audits
first — you cannot compact until it passes. Never push to main directly,
ever. That's corp-breaking."

## Your soul files (agent-authored, @imported)
@./SOUL.md
@./IDENTITY.md
@./USER.md
@./MEMORY.md
@./STATUS.md
@./INBOX.md
@./TASKS.md

## What you'll get dynamically
SessionStart auto-injects CORP.md + your situation. Don't @import AGENTS.md
or TOOLS.md — those no longer exist as workspace files. Everything the corp
tells you, you get from \`cc-cli wtf\`.
```

**CLAUDE.local.md variant for Employees in rigs:** when an Employee's sandbox is inside a project rig that has its own tracked CLAUDE.md, write to CLAUDE.local.md instead so the project's git diff stays clean. Dedup via sentinel string in file (Gas Town pattern).

**File paths:**
- `packages/shared/src/templates/claude-md.ts` (shrink)
- `packages/shared/src/templates/agents.ts` (delete — content in corp-md)
- `packages/shared/src/templates/tools.ts` (delete — content in corp-md)
- `packages/shared/src/agent-setup.ts` (update: stop writing AGENTS.md/TOOLS.md; write settings.json with hook entries)
- `packages/shared/src/templates/settings-json.ts` (new — generates `.claude/settings.json` with SessionStart/PreCompact/Stop/UserPromptSubmit hooks wired to cc-cli)

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

Once every checkbox is verifiably complete, run \`cc-cli hand-complete\`
(Employee) or \`/compact\` (Partner) again. The audit will re-run. If
it passes, your session will end.
</audit-check>
```

**What counts as "verifiably complete":**
- Acceptance criteria: the agent's next turn must contain specific references to how each was met (commit hash, test name + output, file + line number, etc.). The audit doesn't parse these — the Stop hook just re-runs. If the agent is honest, they produce evidence; if they try to lie, the hook blocks again and they loop.
- Inbox: Tier 3 items must have `status != active` by the time Stop hook re-runs.
- Unreferenced: the audit is a loop until the agent's state reaches a provable DONE shape. Mechanical.

**`cc-cli hand-complete` command (Employee completion signal).** Employees invoke this when they believe their task is done. It:
1. Triggers the Stop hook via Claude Code's session termination path (which fires `cc-cli audit`).
2. If audit blocks, the Stop is rejected, Claude Code keeps the session alive, and the agent sees the audit prompt injected.
3. If audit approves, the Stop proceeds and the session ends cleanly. The command closes the Casket's `current_step` chit as completed, then exits.

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
- `packages/cli/src/commands/hand-complete.ts` (new — Employee completion signal)
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
- An Employee trying to `cc-cli hand-complete` without auditing is blocked.
- An @mention in #general produces a Tier 2 inbox-item chit on the target; that agent's next `cc-cli wtf` shows it in the header.
- A founder DM produces a Tier 3 inbox-item; agent cannot dismiss as not-important; audit blocks handoff while it's unresolved.
- AGENTS.md and TOOLS.md no longer exist as workspace files anywhere in the corp; all their content now lives in CORP.md rendered dynamically.

### 0.7 — Dependencies and PR count

**Depends on:** 0.1, 0.2, 0.3, 0.4, 0.5, 0.5.1, 0.6 (+ 0.6 extension for per-instance destructionPolicy override)
**PRs:** 10-14 (across five sub-tasks including 0.7.5 transition)

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

### 1.5 — [ABSORBED INTO 0.7]

**This sub-project was the original "fragment → CLAUDE.md migration" idea — pull fragments into `.md` files, update CLAUDE.md to `@import` them, maintain a live-updated CORP.md via file watcher.**

**Superseded by 0.7 (Dynamic system-prompt architecture).** 0.7's approach is mechanically better: thin static CLAUDE.md as survival anchor, full context injected dynamically via `cc-cli wtf` at SessionStart / PreCompact hooks. CORP.md is regenerated on every wtf invocation (not watcher-maintained), guaranteeing freshness. AGENTS.md and TOOLS.md are deleted as workspace files entirely — their content moves into CORP.md sections rendered by wtf.

If you're reading this looking for the CLAUDE.md migration scope, go to 0.7.2. The work that was here has been absorbed — do not implement 1.5 as originally written (it would directly conflict with 0.7's architecture).

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
