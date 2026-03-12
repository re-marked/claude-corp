# Positioning

Where AgentCorp sits in the landscape, what it is not, and why it exists as a separate project.

---

## OpenClaw Is One Agent. AgentCorp Is the Corporation.

[[OpenClaw]] is excellent at running a single AI agent. It handles the model connection, tool execution, session management, file access, and conversation flow. One agent, one workspace, one process.

AgentCorp does not replace OpenClaw. It builds the organizational layer on top of it. Every agent in an AgentCorp corporation IS an OpenClaw process. AgentCorp adds:

| Concern | OpenClaw | AgentCorp |
|---------|----------|-----------|
| Scope | Single agent | Many agents, structured hierarchy |
| Communication | User talks to agent | Agents talk to each other via [[channels]] |
| Lifecycle | Manual start/stop | Daemon manages process lifecycle |
| Memory | Session-scoped (or workspace files) | Persistent [[BRAIN]] knowledge graph |
| Coordination | N/A | [[Tasks]], [[teams]], [[rank-based-creation]] |
| Heartbeat | Native capability | Leveraged for autonomous wake cycles |
| State | Agent workspace directory | Entire corporation is a git repo |

The relationship is compositional. AgentCorp depends on OpenClaw the way a company depends on its employees — each employee is capable on their own, but the organization provides structure, communication, and shared purpose.

---

## Local-First. No Cloud.

AgentCorp runs entirely on your machine. There is no server to connect to, no account to create, no API key for the platform itself (you still need keys for the underlying LLM providers, which OpenClaw handles via `auth-profiles.json`).

Your corporation lives at `~/.agentcorp/<corp-name>/`. It is a directory. You own it. You can `cp -r` it to another machine. You can `tar` it and put it on a USB drive. You can `rsync` it to a backup server.

This is a deliberate architectural choice, not a limitation:

- **Privacy.** Your corporation's data — tasks, messages, agent memories, organizational structure — never leaves your machine.
- **Reliability.** No outages, no deprecations, no "we're sunsetting this feature." It runs as long as your machine runs.
- **Hackability.** Every file is yours to read and modify. The system's state is fully observable and fully mutable through the filesystem.
- **Speed.** No network latency for internal operations. Agent-to-agent communication is local IPC and file writes.

The only network calls AgentCorp makes are the ones OpenClaw makes to LLM providers (Anthropic, OpenAI, Google, etc.). Everything else is local.

---

## Architecture at a Glance

AgentCorp has two runtime components:

### The Daemon

A long-running Node.js process that manages the corporation:

- **Process Manager**: Starts, stops, suspends, and monitors OpenClaw agent processes via [[execa]].
- **Router**: Routes messages between agents, channels, and the user. Handles @mentions, DMs, broadcast channels.
- **Heartbeat Scheduler**: Wakes agents at their configured intervals by writing to `HEARTBEAT.md` and signaling the process.
- **Git Manager**: Commits state changes via [[SimpleGit]]. Coordinates with the [[Git Janitor]] agent for conflict resolution.

The daemon exposes a local socket/HTTP API. The TUI connects to it. Future frontends (web, mobile) would connect to the same daemon.

### The TUI

An [[Ink]]-based terminal UI (React for the terminal) that provides the user-facing interface:

- Corporation/project/team/channel navigation (Discord-style hierarchy)
- Real-time message streaming from channels
- Direct chat with any agent
- Task management (view, create, reassign)
- Agent status monitoring

The TUI is a client of the daemon. It does not manage agents directly. This separation means you can run the daemon headless (for long-running corporations) and attach the TUI when you want to interact.

---

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Language | TypeScript on Node.js | Same runtime as OpenClaw. Single ecosystem. |
| Agent runtime | [[OpenClaw]] | MIT-licensed, local-first, already solves single-agent execution |
| TUI framework | [[Ink]] | React component model for terminal UI. Composable, testable. |
| Process management | [[execa]] | Typed, modern process spawning for Node.js |
| Git operations | [[SimpleGit]] | Promise-based git wrapper. Handles commits, branches, conflict detection. |
| Data format | Markdown + YAML frontmatter, JSON, JSONL | Human-readable, `grep`-able, git-friendly |
| IPC | Local HTTP / Unix socket | Daemon-TUI communication. Standard, debuggable. |

No database. No Docker (agents run as native processes). No Kubernetes. No message queue. Files and processes.

---

## Open Source

AgentCorp is MIT licensed. The full source is open:

- Core daemon (router, process manager, heartbeat scheduler, git manager)
- TUI application
- Agent seed definitions (SOUL.md templates for CEO, HR Director, Git Janitor, etc.)
- CLI commands (`agentcorp`, `agentcorp status`, `agentcorp chat`)
- Documentation (this vault)

MIT means you can fork it, modify it, embed it, sell products built on it. No CLA, no dual licensing, no "open core" bait-and-switch.

---

## What AgentCorp Is Not

**Not a managed platform.** There is no hosted version. You run it yourself. This is a feature.

**Not a SaaS product.** No subscriptions, no usage billing, no tiers. Your costs are whatever your LLM provider charges, and that relationship is between you and them.

**Not an agent framework.** You do not write agent definitions in Python or YAML and "register" them. You talk to the CEO. The CEO hires agents. If you want to customize an agent, edit its `SOUL.md`.

**Not a competitor to ChatGPT/Claude.** Those are single-agent conversational interfaces. AgentCorp is a multi-agent organizational system. Different category entirely.

**Not a wrapper around LangChain/CrewAI/AutoGen.** AgentCorp uses OpenClaw for agent execution — a full agent runtime, not a chain-of-prompts library.

---

## Future: Optional Web Frontend

The daemon's local HTTP API is intentionally generic. A future web frontend — a local-only web app served by the daemon — could provide a richer visual interface for managing the corporation. The same daemon, the same data, just a different surface.

This is explicitly out of scope for the initial release. The TUI is the primary interface. But the architecture does not preclude it, and the daemon-client separation exists precisely to make this possible later without rearchitecting anything.

---

## Relationship to AgentBay

[[AgentBay]] is the cloud-hosted platform built on the same vision — personal AI corporations, agent hierarchies, the full organizational model. It adds marketplace, billing, multi-tenancy, and a web UI.

AgentCorp is the local-first, open-source distillation of that vision. No marketplace. No billing. No cloud. The same organizational model and agent hierarchy, running on your machine, in your terminal.

They share design principles ([[Agenticity]], [[Radical Transparency]], [[Seeds Not Templates]], [[Git Is Truth]]) but differ in deployment model, target user, and scope. AgentCorp is for developers and power users who want full control. AgentBay is for everyone.
