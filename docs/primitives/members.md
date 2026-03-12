# Members

Unified identity primitive. Every human and every agent in a corporation is a **member** — one entry in `members.json` at the corp root.

```
~/.agentcorp/corp-name/members.json
```

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (ULID) | Unique identifier. Immutable after creation. |
| `displayName` | string | Human-readable name. Used in [[messages]] sender resolution and TUI rendering. |
| `rank` | enum | Hierarchical position: `owner > master > leader > worker > subagent`. See [[#Ranks]]. |
| `status` | enum | Current operational state: `active`, `idle`, `working`, `suspended`, `archived`. |
| `type` | enum | `user` or `agent`. Determines spawn behavior and auth surface. |
| `scope` | enum | Where this member operates: `corp`, `project`, or `team`. |
| `scopeId` | string | ID of the scope target. For corp-scoped members, matches the corp ID. For project/team, matches the relevant ID. |
| `agentDir` | string | Relative path to the agent's workspace directory (agents only). Example: `agents/cleo/`. |
| `port` | number | Local port the agent process listens on (agents only). `null` when stopped. |
| `spawnedBy` | string | Member ID of whoever created this member. The owner has no `spawnedBy`. |
| `createdAt` | ISO 8601 | Timestamp of creation. |

## Ranks

Ranks define hard authority boundaries. The hierarchy is strict:

- **owner** — The human founder. Absolute power. One per corp, always. Cannot be demoted or removed.
- **master** — The Personal AI / co-founder. Runs day-to-day operations. One per corp. Can hire, fire, reassign, create [[teams]], create [[channels]].
- **leader** — Leads a [[teams|team]]. Can assign [[tasks]] within their team, manage team members below them.
- **worker** — Standard agent. Executes tasks, participates in channels, writes to the filesystem.
- **subagent** — Spawned by another agent for a narrow job. Limited scope. Ephemeral by default.

Rank determines what a member *can* do. It does not determine what a member *is*. Social hierarchy — personality, reputation, trust, working relationships — is richer than ranks and lives in each agent's `SOUL.md` and `MEMORY.md` files. Agents know their place not just from their rank field but from their accumulated context about the corporation.

## Constraints

- Exactly one `owner` per corp. Set at `agentcorp init` time. Never changes.
- Exactly one `master` per corp. The co-founder agent, created during initialization.
- `displayName` must be unique within the corp. Used as the `@mention` handle in [[messages]].
- An `archived` member's data remains on disk (agent directory, message history) but they are excluded from all active queries and channel routing.

## Lifecycle

1. **Creation** — `members.json` gets a new entry. For agents, `agentDir` is populated and the workspace directory is scaffolded.
2. **Active operation** — Status cycles between `active`, `idle`, and `working` based on heartbeat and task state.
3. **Suspension** — The owner or master sets status to `suspended`. Agent process is stopped. Member remains in channels but cannot send [[messages]].
4. **Archival** — Soft delete. Member is removed from active rosters. Files persist for auditability. Git tracks the removal.

## File Ownership

Every agent member has a workspace directory at `agents/{name}/` relative to the corp root. This directory is the agent's domain — it reads and writes freely within it. The directory contains:

- `SOUL.md` — Personality, identity, values
- `MEMORY.md` — Accumulated knowledge and facts
- `HEARTBEAT.md` — Instructions read on each wake cycle
- `brain/` — Knowledge graph with wikilinked markdown files

These files are git-tracked. Every agent write is a commit. The owner can inspect, revert, or diff any agent's state at any point.

## Related

- [[channels]] — Members are assigned to channels via `memberIds`
- [[tasks]] — Members are assigned to tasks via `assignedTo`
- [[teams]] — Members belong to teams; leaders are referenced by `leaderMemberId`
- [[messages]] — Members are identified as senders via `senderId`
