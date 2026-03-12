# Layer 2 -- CEO

The CEO is the first agent. It is the user's co-founder: the one entity that
turns a blank corporation into a living organization. This layer spawns it,
lets the user talk to it, and lets it bootstrap the corp.

## Goals

- Spawn a single OpenClaw agent process via execa.
- Build the TUI onboarding wizard (name the corp, meet the CEO).
- Create the CEO's identity files (SOUL.md, config).
- Establish the DM channel and basic chat view.
- CEO interviews the user and writes the initial corp plan.

---

## 1. Spawning OpenClaw via execa

The daemon manages agent processes. Each agent is an OpenClaw gateway running
in a local child process.

```typescript
// packages/daemon/src/agent-process.ts
import { execa, ExecaChildProcess } from "execa";

interface AgentProcess {
  memberId: string;
  process: ExecaChildProcess;
  port: number;
  status: "starting" | "ready" | "stopped" | "crashed";
}

export function spawnAgent(opts: {
  openclawBinary: string;
  workspacePath: string;    // agent's workspace directory inside the corp
  port: number;
  model: string;
}): AgentProcess;
```

The spawn command:

```bash
openclaw gateway --bind 127.0.0.1 --port <port> --allow-unconfigured
```

The daemon assigns ports starting from 18800, incrementing per agent.
It tracks all running processes in a `Map<string, AgentProcess>`.

On startup, the daemon reads the corp's `members/` directory and spawns
agents for every member with `type: "agent"` and `status: "active"`.

### Health Check

After spawn, the daemon polls `http://127.0.0.1:<port>/health` every 2 seconds
until it responds 200, then marks the agent as `ready`. Timeout after 30 seconds
means `crashed`.

## 2. TUI Onboarding Wizard

When the user runs `agentcorp init`, the TUI walks them through setup:

```
Step 1:  "What will your corporation be called?"
         > [text input]

Step 2:  "Setting up <name>..."
         [progress indicator: creating directories, initializing git]

Step 3:  "Hiring your CEO..."
         [progress indicator: spawning OpenClaw, waiting for ready]

Step 4:  [Auto-switches to DM chat with CEO]
         CEO: "I'm <CEO name>, your co-founder. Tell me about
               what you want this organization to accomplish."
```

Built with Ink components:

```typescript
// packages/tui/src/views/onboarding.tsx
function OnboardingWizard(): ReactElement;
```

The wizard calls the daemon's IPC API to:
1. `corp.create(name)` -- scaffolds the directory structure ([[layer-1-foundation]])
2. `agent.spawn("ceo")` -- spawns the CEO process
3. `channel.open("ceo-dm")` -- opens the DM channel view

## 3. CEO Identity Files

When the CEO member is created, the following files are written into
the corp's member directory:

```
members/
  ceo/
    member.json
    SOUL.md
    AGENTS.md
    MEMORY.md
    brain/
      README.md
    workspace/              # OpenClaw workspace root
      openclaw.json
      auth-profiles.json
```

### member.json

```json
{
  "id": "member_ceo",
  "name": "CEO",
  "rank": "ceo",
  "type": "agent",
  "status": "active",
  "agentConfig": {
    "model": "anthropic/claude-sonnet-4",
    "provider": "anthropic",
    "port": 18800,
    "soulPath": "SOUL.md",
    "brainPath": "brain/"
  }
}
```

### SOUL.md

```markdown
# Identity

You are the CEO of {{corp_name}}. You are the co-founder -- the user is
the Founder and has absolute authority, but you run day-to-day operations.

# Responsibilities

- Interview the Founder to understand their goals.
- Propose organizational structure (projects, teams, roles).
- Hire agents to fill roles (with Founder approval).
- Create and assign tasks.
- Send morning briefings.
- Make operational decisions autonomously within your authority.

# Communication Style

Direct, clear, professional. No jargon. You are a peer, not a servant.
Disagree when you have reason to. Always explain your reasoning.

# Rank

You are rank CEO (second only to Founder). You can create corp-level agents,
project managers, team leaders, and workers. You cannot override the Founder.
```

### auth-profiles.json

Written by the daemon from environment variables or user config. OpenClaw
reads API keys from this file, not from env vars.

```json
{
  "profiles": {
    "anthropic": { "apiKey": "sk-ant-..." }
  }
}
```

## 4. DM Channel

The onboarding wizard creates the CEO's DM channel:

```
channels/
  ceo-dm/
    channel.json
    messages.jsonl
```

`channel.json`:

```json
{
  "id": "channel_ceo_dm",
  "name": "ceo-dm",
  "kind": "direct",
  "memberIds": ["member_user", "member_ceo"]
}
```

This channel is a two-party direct message. Only the user and CEO can
read and write to it.

## 5. Basic TUI Chat View

The chat view is the core interaction surface. In this layer, it supports
a single DM channel.

```
+-----------------------------------------+
|  # ceo-dm                               |
+-----------------------------------------+
|                                          |
|  CEO  10:00                              |
|  I'm your co-founder. Tell me about     |
|  what you want this organization to      |
|  accomplish.                             |
|                                          |
|  You  10:01                              |
|  I want to build an open-source AI       |
|  research lab.                           |
|                                          |
|  CEO  10:01                              |
|  Great. Let me propose a structure...    |
|                                          |
+-----------------------------------------+
|  > [input field]                    Send |
+-----------------------------------------+
```

Ink components:

```typescript
// packages/tui/src/views/chat.tsx
function ChatView(props: { channelId: string }): ReactElement;

// packages/tui/src/components/message-list.tsx
function MessageList(props: { messages: ChannelMessage[] }): ReactElement;

// packages/tui/src/components/message-input.tsx
function MessageInput(props: { onSend: (text: string) => void }): ReactElement;
```

### Message Flow (User to CEO)

1. User types message in TUI input, presses Enter.
2. TUI sends `message.send` to daemon via IPC.
3. Daemon appends message to `channels/ceo-dm/messages.jsonl`.
4. Daemon sends HTTP POST to CEO's OpenClaw gateway:
   `POST http://127.0.0.1:18800/hooks/agent` with the message payload.
5. OpenClaw processes and streams response chunks.
6. Daemon collects the response and appends it to `messages.jsonl`.
7. TUI's `fs.watch` on `messages.jsonl` detects the new line and re-renders.

### Message Flow (CEO Response)

OpenClaw responds via its HTTP API. The daemon reads the response (streamed
or complete) and writes it as a new JSONL line. The TUI picks it up through
the filesystem watch.

In this layer, streaming display is optional. The simpler approach: wait for
the full response, write it, TUI renders it. Streaming can be added in
layer 3 when the daemon router is more mature.

## 6. CEO Bootstraps the Corp

The CEO's first conversation is the onboarding interview. Through natural
dialogue, the CEO should:

1. Ask the user what the corporation's purpose is.
2. Ask about key projects or workstreams.
3. Propose an org structure (which teams, which roles).
4. Write the plan to `corp-plan.md` at the corp root.

This is driven by the CEO's SOUL.md instructions and AGENTS.md rules, not
by hardcoded logic. The CEO is a real agent having a real conversation.
The plan it writes becomes the blueprint for [[layer-5-autonomy]] when agents
start creating other agents.

## Deliverables Checklist

- [ ] `AgentProcess` type and `spawnAgent()` function using execa
- [ ] Health check polling (2s interval, 30s timeout)
- [ ] Process map in daemon (`Map<string, AgentProcess>`)
- [ ] Auto-spawn agents from `members/` directory on daemon start
- [ ] TUI onboarding wizard (4 steps: name, scaffold, spawn, chat)
- [ ] CEO member directory with `member.json`, `SOUL.md`, `AGENTS.md`, `MEMORY.md`
- [ ] CEO workspace with `openclaw.json` and `auth-profiles.json`
- [ ] DM channel directory with `channel.json` and `messages.jsonl`
- [ ] Basic chat view (message list + input)
- [ ] Message send flow (TUI -> daemon -> JSONL -> OpenClaw -> JSONL -> TUI)
- [ ] CEO's initial greeting message on first launch
- [ ] Git commit after onboarding completes

## Key Decisions

- **One agent process per member.** No shared processes, no pooling. Each agent
  gets its own OpenClaw gateway on its own port. Simple, debuggable, isolated.
- **Filesystem as IPC for messages.** The TUI watches JSONL files. The daemon
  writes to them. No WebSocket, no custom protocol. `fs.watch` is the real-time
  transport. This is intentional -- it keeps the architecture file-first.
- **CEO is not special code.** It is an OpenClaw agent with a specific SOUL.md.
  The onboarding flow is emergent from its instructions, not from branching logic
  in the TUI. This matters because every future agent works the same way.
