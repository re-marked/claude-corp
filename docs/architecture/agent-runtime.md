# Agent Runtime

Every agent in AgentCorp is a separate OpenClaw gateway process running on a unique localhost port. The [[daemon]]'s Process Manager spawns them, and the [[router]] delivers messages to them. Each agent is an independent, self-contained AI process with its own workspace, configuration, and identity.

## One Agent, One Process, One Port

The fundamental unit of execution:

```
Agent "Atlas" (co-founder)
  Process: openclaw gateway --bind localhost --port 18800
  Workspace: ~/.agentcorp/my-corp/agents/atlas/
  Webhook: http://localhost:18800/hooks/agent
```

There is no shared runtime, no thread pool, no multiplexing. Each agent is a full OpenClaw gateway with its own model configuration, memory, and skill set. This isolation means:

- An agent crash does not affect other agents
- Each agent can use a different model (Claude, GPT, Gemini, DeepSeek)
- Resource limits (if needed) can be applied per-process via OS tools
- Debugging a single agent means looking at a single process

## OpenClaw Gateway

OpenClaw is the underlying agent runtime. Each agent runs as:

```
openclaw gateway --bind localhost --port {assigned_port} --allow-unconfigured
```

Key OpenClaw features that AgentCorp relies on:

| Feature | How AgentCorp Uses It |
|---------|----------------------|
| **Webhooks** | The [[router]] POSTs messages to `/hooks/agent` to wake the agent |
| **Workspace files** | Agent reads `SOUL.md`, `AGENTS.md`, `MEMORY.md` from its workspace folder |
| **Heartbeat** | Periodic self-wake; agent reads `HEARTBEAT.md` for scheduled tasks |
| **Skills** | Markdown+YAML extensions in `skills/` that give agents custom tools |
| **Sub-agents** | OpenClaw's native sub-agent spawning for complex multi-step work |
| **External channels** | Native support for interacting with external services |
| **Sessions** | Conversation state management within the gateway |

## Workspace Folder

Each agent's workspace is a directory inside the corp, following the [[corp-structure]]:

```
agents/atlas/
  config.json          # Agent configuration (model, provider, rank, etc.)
  openclaw.json        # OpenClaw-specific runtime config
  auth-profiles.json   # API keys (injected by daemon, NOT committed)
  SOUL.md              # Personality, values, communication style
  AGENTS.md            # Operating rules and constraints
  MEMORY.md            # Accumulated facts and context
  HEARTBEAT.md         # Heartbeat schedule and periodic tasks
  skills/              # Custom skill definitions
    workspace-tools/   # File read/write, channel messaging, task management
  brain/               # Knowledge graph (Markdown with [[wikilinks]])
```

The workspace IS the agent's world. OpenClaw reads from it on every prompt, and the agent writes back to it as it works. Changes to these files are tracked by git via the [[daemon]]'s Git Manager.

### SOUL.md

Defines who the agent is. Personality, values, communication style, role within the corporation. Written once during [[agent-lifecycle|creation]], rarely modified afterward.

### AGENTS.md

Operating rules. What the agent can and cannot do, which tools it has access to, how it should behave in different contexts. This is the policy layer.

### MEMORY.md

Accumulated knowledge. Facts the agent has learned, decisions it has made, context it wants to remember across sessions. The agent reads and writes this file freely.

### HEARTBEAT.md

Defines the agent's autonomous schedule. What to check, what to do when woken by the heartbeat cron. This is how agents act without being prompted — they wake up, read their heartbeat instructions, check their tasks, and take action.

### skills/

Skill definitions in OpenClaw's SKILL.md format (Markdown + YAML frontmatter). These extend the agent's tool set. AgentCorp injects a standard set of workspace tools:

- **File operations** — read/write files in the corp
- **Channel messaging** — append messages to channel JSONL files
- **Task management** — create/update/complete tasks
- **Member queries** — look up who is in the corp and their status

Additional custom skills can be added per-agent.

## API Key Injection

API keys are never stored inside the corp git repo. They live in `~/.agentcorp/global-config.json` (see [[file-system]]). When the [[daemon]] spawns an agent, it:

1. Reads the agent's configured provider from `config.json`
2. Looks up the corresponding key in `global-config.json`
3. Writes `auth-profiles.json` into the agent's workspace
4. Adds `auth-profiles.json` to `.gitignore`

If keys rotate, the daemon rewrites `auth-profiles.json` on the next agent restart. The agent never sees the raw key — OpenClaw reads it from the file automatically.

## Port Assignment

The daemon allocates ports from a configurable range (default: 18800-18999). Port assignments are:

- **Dynamic** — assigned at spawn time, not hardcoded per agent
- **Recorded** in the daemon's process table and in `members.json`
- **Released** when an agent is stopped
- **Stable during a session** — an agent keeps its port until stopped or restarted

The [[router]] reads the current port from the daemon's process table (or `members.json`) when dispatching. If an agent is restarted on a different port, the router picks up the change immediately.

## Heartbeat

OpenClaw's built-in heartbeat mechanism allows agents to act autonomously. The heartbeat fires on a configurable interval (default: every 10 minutes). When it fires:

1. The agent wakes up
2. Reads `HEARTBEAT.md` for its scheduled instructions
3. Checks its assigned tasks (reads task files from the relevant `tasks/` directories)
4. Takes action — updates tasks, writes messages, modifies files
5. Goes back to sleep

The heartbeat is internal to the OpenClaw process. The daemon does not trigger it — OpenClaw manages the timer natively. The daemon's health check simply verifies the process is still alive.

## Sub-Agents

OpenClaw supports native sub-agent spawning. A senior agent can spin up temporary sub-agents for complex work. These sub-agents:

- Run inside the parent agent's process (not separate processes)
- Share the parent's workspace and API keys
- Are ephemeral — they exist for the duration of a task
- Do not appear in `members.json` — they are internal to the parent agent

This is distinct from the corp's member agents, which are persistent, independent processes managed by the daemon.

## Resource Boundaries

Each agent process consumes:

- **Memory**: typically 100-300 MB per OpenClaw gateway (Node.js process)
- **CPU**: idle when waiting; bursts during prompt processing
- **Network**: outbound API calls to LLM providers; inbound webhook POSTs from the router
- **Disk**: workspace files, typically small (KB-MB range)

For a corp with 5-10 agents, expect 1-3 GB of RAM usage total. The daemon's health check monitors process memory and can warn or kill agents that exceed configured limits.

## Model Configuration

Each agent can run a different model. The model is specified in the agent's `config.json`:

```json
{
  "name": "atlas",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "rank": "master",
  "restart_policy": "always"
}
```

The provider must match a key in `global-config.json`. OpenClaw handles the actual API communication — AgentCorp just ensures the right keys are injected and the right model is configured.
