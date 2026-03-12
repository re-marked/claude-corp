# Agenticity

Agents act on their own. They do not wait for the human to type a command. Three mechanisms trigger agent behavior: heartbeats, messages, and events.

## Three Triggers

### 1. Heartbeat (Periodic Wake-Up)

Every agent runs an [[heartbeat|OpenClaw-native heartbeat]] — a 30-minute cycle by default. On each heartbeat tick, the agent wakes up, reads its `HEARTBEAT.md`, checks its task files, and decides what to do next. No external cron, no daemon scheduling. OpenClaw handles it internally.

The heartbeat is the foundation of autonomy. An agent with pending tasks will work through them across heartbeat cycles without anyone asking. See [[heartbeat]] for the full mechanism.

### 2. Messages (@mentions via Daemon Router)

When an agent is @mentioned in a channel, the AgentCorp daemon routes the message to that agent's OpenClaw process. The agent receives the message as input and responds.

Agent-to-agent communication works the same way. An agent writing `@rex can you review the API schema?` in a team channel triggers Rex's process to receive that message. The daemon watches channel files for new entries and routes accordingly.

Message routing follows channel membership. An agent only receives messages from channels it belongs to. Channel membership is defined in `channels.json` at the corp root. See [[radical-transparency]] for the channel structure.

### 3. Events (External Triggers)

External systems — git hooks, file watchers, webhook receivers — can post events to channels. A failed CI build posts to `#ops`. A new email arrives and posts to `#inbox`. The [[externals]] system handles bidirectional communication with the outside world.

Events are just messages with a machine origin. They route through the same daemon, hit the same channels, trigger the same agent responses.

## Agent-to-Agent Communication

Agents talk to each other through @mentions in shared channels. A Project Manager assigns a task by writing to the team channel and @mentioning the worker. The worker picks it up on its next heartbeat or immediately if the daemon routes the mention.

There is no special inter-agent protocol. It is all messages in channels, visible to anyone with access. See [[radical-transparency]].

## Rank-Based Creation

Agents create other agents, subject to rank constraints from [[corporation-of-one]]:

- `master` (CEO) creates `leader`, `worker`, `subagent`
- `leader` creates `worker`, `subagent`
- `worker` creates `subagent` only

When an agent creates another agent, it writes the new agent's `SOUL.md`, adds an entry to `members.json`, and the daemon spawns the OpenClaw process. See [[agent-personality]] for how SOUL.md authorship works.

## Sub-Agents (OpenClaw Native)

Sub-agents are OpenClaw's built-in mechanism for ephemeral helpers. When an agent needs to parallelize work or delegate a subtask, it spawns a sub-agent directly through OpenClaw — no daemon involvement, no `members.json` entry. Sub-agents live and die within the parent agent's process.

This is different from creating a persistent `subagent`-rank member. Persistent sub-agents get their own folder, their own SOUL.md, their own heartbeat. OpenClaw-native sub-agents are fire-and-forget within a single prompt loop.

## Autonomous Pipelines

Combine these triggers and you get autonomous pipelines:

1. CEO heartbeat fires. CEO checks pending tasks. Sees "Build authentication system."
2. CEO creates a task file, assigns it to the backend PM, writes to `#backend`.
3. Backend PM's daemon routes the @mention. PM reads the task, breaks it into subtasks.
4. PM assigns subtasks to workers, @mentions each one.
5. Workers pick up tasks on their next heartbeat or via daemon routing.
6. Workers complete tasks, update task files, post results to the team channel.
7. PM's heartbeat fires. PM sees completed subtasks, rolls up status, reports to CEO.
8. CEO's next heartbeat fires. CEO reads the rollup, marks the parent task complete.

No human typed a single command after step 0. The corporation ran itself.

## Related

- [[heartbeat]] — the periodic wake-up mechanism
- [[corporation-of-one]] — hierarchy and rank-based creation
- [[ceo]] — the CEO's special autonomous behaviors
- [[externals]] — external event triggers
