---
title: Agent Creation Flow
type: flow
status: draft
triggers: any agent creating at or below its rank level, CEO during onboarding, user via TUI
outputs: new agent folder, OpenClaw process, member entry, DM channel, git commit
related:
  - "[[flow-onboarding]]"
  - "[[flow-message]]"
  - "[[flow-heartbeat]]"
  - "[[view-agent-home]]"
  - "[[view-hierarchy]]"
---

# Agent Creation Flow

Any agent can create other agents at or below its own rank. There is no HR department that gatekeeps creation — though an HR-specialized agent may be particularly good at it. The CEO creates during [[flow-onboarding]]. Team leaders create workers. Workers cannot create anyone (they are the bottom rank). The mechanism is always the same: write files, register in members.json, signal the daemon.

## Rank Hierarchy and Creation Rights

```
Founder (user)          -- can create any rank
  CEO (rank: ceo)       -- can create corp-level, leader, worker
    Corp-Level Agents   -- can create leader, worker (within their scope)
      Project Managers  -- can create leader, worker (within their project)
        Team Leaders    -- can create worker (within their team)
          Workers       -- cannot create agents
```

The rule is simple: you can create agents at your level or below. A team leader (rank: leader) can create workers but not other leaders or a project manager. The CEO can create anything except a Founder (there is only one).

## Creation Sequence

### Step 1 — Creator Writes Agent Files

The creating agent (or user, via TUI) writes the new agent's workspace to the filesystem:

```
~/.agentcorp/<corp>/agents/<agent-slug>/       # Corp-level agents
~/.agentcorp/<corp>/projects/<proj>/agents/<agent-slug>/  # Project-level
~/.agentcorp/<corp>/projects/<proj>/teams/<team>/agents/<agent-slug>/  # Team-level
```

The folder contains:

```
<agent-slug>/
  config.json        # OpenClaw configuration (model, port, heartbeat interval)
  SOUL.md            # Personality, role description, behavioral directives
  HEARTBEAT.md       # What to do on each wake cycle
  AGENTS.md          # Rules and tool references
  MEMORY.md          # Initially empty — agent populates over time
  BRAIN/             # Knowledge graph directory
    index.md         # Initial knowledge seeds
  skills/            # Skill files (.md with YAML frontmatter)
```

The creator tailors each file to the new agent's role:

- **SOUL.md**: Written by the creator to define the agent's personality, expertise, and working style. A CEO creating a research agent writes a different SOUL.md than when creating a frontend developer.
- **HEARTBEAT.md**: Instructions specific to the role. A worker's heartbeat focuses on task execution. A leader's heartbeat includes team oversight.
- **config.json**: Model selection, heartbeat interval, port assignment. The creator chooses the model based on the agent's needs (cheaper models for routine work, stronger models for complex reasoning).

### Step 2 — Register in members.json

The creator adds an entry to the corp-wide `members.json`:

```json
{
  "slug": "research-bot",
  "name": "Research Bot",
  "type": "agent",
  "rank": "worker",
  "status": "provisioning",
  "team": "research-team",
  "project": "saas-launch",
  "created_by": "pm-saas",
  "created_at": "2026-03-12T14:00:00.000Z",
  "port": 18792,
  "workspace": "projects/saas-launch/teams/research-team/agents/research-bot"
}
```

The `port` is assigned by scanning existing entries for the next available port in the range. The `workspace` field points to the agent's directory relative to the corp root.

### Step 3 — Signal Daemon

The creator writes a signal file or uses a workspace CLI command to tell the daemon that a new agent needs to be spawned:

```
~/.agentcorp/<corp>/.signals/spawn-<agent-slug>.json
```

The daemon watches `.signals/` and picks up the request. It reads the agent's `config.json` and starts an OpenClaw process:

```bash
openclaw gateway --bind 127.0.0.1 --port <port> --workspace <agent-workspace-path>
```

Once the process is running and healthy (responds to a health check), the daemon updates the agent's status in `members.json` from `provisioning` to `idle`.

### Step 4 — Create DM Channel

A direct message channel is created between the Founder (user) and the new agent:

```
~/.agentcorp/<corp>/channels/<agent-slug>-dm/
  channel.json       # kind: "direct", members: ["founder", "<agent-slug>"]
  messages.jsonl     # Empty, ready for conversation
```

The user can immediately chat with the new agent through the [[view-channel]].

### Step 5 — Join Channels

The new agent is added to relevant channels based on its scope:

| Scope | Auto-Joins |
|-------|------------|
| Corp-level | #general (broadcast) |
| Project-level | #general, project broadcast channel |
| Team-level | #general, project broadcast channel, team channel |

Channel membership is tracked in each channel's `channel.json` file.

### Step 6 — Git Commit

All files created in steps 1-5 are committed atomically:

```
git add agents/<slug>/ channels/<slug>-dm/ members.json
git commit -m "agent: spawn <slug> (rank: <rank>, created by: <creator>)"
```

The commit message includes the agent's rank and who created it for auditability.

## Scope-Based Placement

Where an agent lives in the filesystem determines its scope of awareness and access:

| Placement | Path | Can See |
|-----------|------|---------|
| Corp-level | `agents/<slug>/` | All projects, all teams, all channels |
| Project-level | `projects/<proj>/agents/<slug>/` | That project's teams, channels, tasks |
| Team-level | `projects/<proj>/teams/<team>/agents/<slug>/` | That team's channels, tasks, plus project-level shared resources |

The CEO always lives at corp-level. Project managers live at project-level. Team leaders and workers live at team-level.

## What the CEO Creates During Onboarding

During [[flow-onboarding]], the CEO creates the initial agent roster in a single coordinated burst:

1. Creates project directories under `projects/`
2. Creates team directories under each project's `teams/`
3. Creates a project manager agent at each project scope
4. Creates team leader agents at each team scope
5. Creates worker agents at each team scope
6. Sets up all channels and cross-references
7. Creates initial tasks in each project's `tasks/` directory
8. Commits everything in one batch

This is the same mechanism used for all future agent creation — just executed in rapid sequence.

## Runtime Agent Creation

After onboarding, agents create other agents as needed:

- A team leader realizes it needs a specialist and creates a worker
- A PM creates a new team leader when a new team forms
- The CEO creates a new PM when the user starts a new project

The creating agent uses the same steps: write files, register in members.json, signal daemon. The conversation where this decision was made is visible in channel logs. The git commit records who created whom.

## Agent Destruction

Agents can also be archived. The process reverses creation:

1. Agent status set to `archived` in `members.json`
2. Daemon stops the OpenClaw process
3. Agent's folder is NOT deleted (preserved for history)
4. Agent removed from active channel memberships
5. Git commit: `"agent: archive <slug> (by: <actor>)"`

The agent's workspace, BRAIN, and message history remain on disk and in git. Nothing is lost.

## Constraints

- Workers (rank: worker) cannot create agents. They are the leaf nodes.
- No agent can create an agent above its own rank.
- Port conflicts are prevented by scanning `members.json` for used ports.
- Agent slugs must be unique within the corp (enforced by filesystem — duplicate directory names are impossible).
- The Founder can create any agent directly via the TUI, bypassing rank checks.
