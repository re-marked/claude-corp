# Agent Lifecycle

An agent in AgentCorp moves through four states: **created**, **running**, **suspended**, and **archived**. Each transition involves specific file operations, process management, and git commits. The [[daemon]] orchestrates all process-related transitions; the [[file-system]] records all state.

## Creation

Creating a new agent is a multi-step operation that establishes the agent's identity, workspace, and presence in the corporation.

### Step 1: Write Configuration

Create the agent's workspace directory and populate it with initial files:

```
agents/<agent-name>/
  config.json          # Name, model, provider, rank, restart policy
  openclaw.json        # OpenClaw runtime settings
  SOUL.md              # Personality and identity (written by creator or CEO agent)
  AGENTS.md            # Operating rules and constraints
  MEMORY.md            # Empty initially
  HEARTBEAT.md         # Default heartbeat instructions
  skills/              # Standard workspace tools + any custom skills
```

The `config.json` defines the agent's core identity:

```json
{
  "id": "agent-uuid",
  "name": "luna",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "rank": "worker",
  "scope": "project",
  "project": "website-redesign",
  "team": "design",
  "restart_policy": "on-failure"
}
```

The `scope` field determines where the agent's directory lives in the [[corp-structure]]:
- `"corp"` -- agent lives at `agents/<name>/` (corp root)
- `"project"` -- agent lives at `projects/<project>/agents/<name>/`

### Step 2: Register in members.json

Add the agent to the appropriate `members.json` registry:

```json
{
  "id": "agent-uuid",
  "name": "luna",
  "type": "agent",
  "rank": "worker",
  "status": "created",
  "port": null,
  "created": "2026-03-12T10:00:00Z"
}
```

The `status` starts as `"created"` (not yet spawned). The `port` is `null` until the daemon assigns one.

### Step 3: Daemon Spawns OpenClaw

The [[daemon]]'s Process Manager:

1. Allocates a port from the available range
2. Writes `auth-profiles.json` with API keys from `global-config.json`
3. Spawns the OpenClaw gateway process via execa
4. Updates `members.json` with the assigned port and `status: "running"`

See [[agent-runtime]] for details on the spawning process.

### Step 4: Join Channels

The new agent is added to the channels specified in its configuration:

- All broadcast channels at its scope level (corp-wide `#general`, project-level `#announcements`)
- Team channels if assigned to a team
- Any channels explicitly listed in `config.json`

Channel membership is recorded in `channels.json`.

### Step 5: Create DM Channel

A direct message channel is created between the user (or the hiring agent) and the new agent:

```
channels/dm-user-luna/
  messages.jsonl       # Empty, ready for conversation
```

The DM channel is registered in `channels.json` with `kind: "direct"` and exactly two members.

### Step 6: Git Commit

All creation artifacts are committed in a single git commit:

```
Agent created: luna (worker, website-redesign/design)
```

This commit captures the agent's complete initial state — config, personality, rules, channel memberships — in one atomic operation. It can be reverted to undo the entire creation.

## Running

Once created and spawned, the agent is in the `running` state. This is the normal operating mode.

### Autonomous Behavior

A running agent:

- **Responds to webhooks** — the [[router]] dispatches messages to the agent's `/hooks/agent` endpoint
- **Handles its own heartbeat** — OpenClaw's built-in timer wakes the agent periodically; it reads `HEARTBEAT.md` and acts on its instructions
- **Reads and writes freely** — the agent can read any file in the corp (subject to its workspace tools) and write to its own workspace, channel message files, and task files
- **Manages its own memory** — the agent updates `MEMORY.md` as it learns new information
- **Works on tasks** — reads assigned tasks from `tasks/` directories, updates their status, writes deliverables

### What the Agent Cannot Do

An agent cannot:

- Start or stop other agent processes (only the daemon can do this)
- Modify another agent's `config.json` or `SOUL.md` (workspace isolation)
- Write to `members.json` or `channels.json` directly (managed by daemon)
- Access API keys in `global-config.json` (keys are injected into its own `auth-profiles.json`)

Agents can, however, request these operations by writing messages to system channels or by creating tasks for the CEO agent.

## Suspension

Suspension stops an agent's process but preserves its workspace. The agent can be resumed later with all its state intact.

### Trigger

Suspension can be triggered by:

- User command: `agentcorp agent suspend <name>`
- CEO agent requesting suspension (via system channel message)
- Idle timeout (configurable: daemon suspends agents with no activity for N hours)
- Resource pressure (daemon suspends lowest-rank agents when memory is tight)

### Process

1. The [[daemon]] sends SIGTERM to the agent's OpenClaw process
2. Waits up to 5 seconds for graceful shutdown
3. SIGKILL if still alive
4. Updates `members.json`: `status: "suspended"`, `port: null`
5. Git commit: `Agent suspended: luna`

### What Is Preserved

Everything. The agent's entire workspace directory remains untouched:

- `config.json`, `SOUL.md`, `AGENTS.md`, `MEMORY.md` -- all intact
- `auth-profiles.json` -- removed (contains API keys, will be re-injected on resume)
- Channel memberships in `channels.json` -- preserved
- Task assignments -- preserved (tasks remain assigned, status unchanged)

### Resuming

Resuming a suspended agent is identical to the initial spawn (Step 3 of Creation):

1. Daemon allocates a new port
2. Injects fresh `auth-profiles.json`
3. Spawns OpenClaw
4. Updates `members.json`: `status: "running"`, `port: <new port>`
5. Git commit: `Agent resumed: luna`

The agent picks up where it left off. Its memory, personality, and task context are all in the workspace files.

## Archival

Archival is a soft-delete. The agent is permanently stopped but not erased.

### Process

1. Stop the agent process (same as suspension)
2. Update `members.json`: `status: "archived"`
3. Remove the agent from all channel memberships in `channels.json`
4. Mark all assigned tasks as `unassigned`
5. Git commit: `Agent archived: luna`

### What Happens to Archived Agents

- The workspace directory remains on disk (history is valuable)
- The agent does not appear in active member lists
- The agent cannot be dispatched to by the [[router]]
- The agent's message history in channel JSONL files is preserved (messages are never deleted)
- The agent can be un-archived if needed (re-add to `members.json`, re-join channels, re-spawn)

## CEO Protection

The corporation's co-founder agent (rank: `master`) has special protection:

- **Cannot be fired or archived** by other agents
- **Cannot be suspended** by automated policies (idle timeout, resource pressure)
- **Can only be stopped** by the user (the CEO/owner)
- **Always auto-restarts** — its `restart_policy` is hardcoded to `"always"`

This ensures the corporation always has its primary AI leader available. The user, as the absolute owner, can override this protection explicitly if needed.

## Rank Hierarchy

Ranks constrain what operations agents can perform on each other:

| Rank | Can Hire | Can Fire | Can Assign Tasks To |
|------|----------|----------|---------------------|
| `owner` | All | All | All |
| `master` | leader, worker, subagent | leader, worker, subagent | All except owner |
| `leader` | worker, subagent | worker (own team), subagent | worker (own team), subagent |
| `worker` | subagent | subagent | subagent |
| `subagent` | None | None | None |

The `owner` rank is reserved for the human user. It cannot be assigned to an agent. The `master` rank is assigned to the co-founder / CEO agent. Only one agent can hold the `master` rank at a time.

## State Machine Summary

```
            create
              |
              v
  [ created ] --spawn--> [ running ]
                             |    ^
                  suspend    |    |  resume
                             v    |
                         [ suspended ]
                             |
                  archive    |
                             v
                         [ archived ]
                             |
                  unarchive  |
                             v
                         [ created ] --spawn--> [ running ]
```

Every transition is recorded as a git commit, making the full lifecycle of every agent auditable through `git log`.
