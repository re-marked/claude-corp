# Claude Corp

**Your Personal Corporation** — a self-growing organization of AI agents that works FOR you, running entirely on your machine.

You are the Founder. Your personal AI becomes CEO. The CEO hires agents, delegates work, manages projects. You set direction — the corporation executes.

```
$ claudecorp
> What's your name? Mark
> Name your corporation? acme
> Choose your style?
  ▸ Corporate  (Founder → CEO → Director → Employee → Contractor)
    Mafia      (Godfather → Underboss → Capo → Soldier → Associate)
    Military   (Commander → General → Captain → Private → Recruit)
```

## What It Does

- **CEO is your personal AI** — connects to your running [OpenClaw](https://github.com/openclaw/openclaw) gateway. Same AI, same memory, new role.
- **Agents hire agents** — tell the CEO "I need a research team" and watch it hire three agents autonomously.
- **Tasks complete themselves** — create a task, assign it to an agent, it reads the assignment and starts working. No human in the loop.
- **Everything is files** — messages are JSONL, tasks are markdown, agent identity is SOUL.md. `cat` anything. `grep` everything. `git log` the whole corp.
- **Every action is a git commit** — full audit trail. `git revert` any bad decision.

## Quick Start

### Prerequisites

- **Node.js 22+**
- **[OpenClaw](https://github.com/openclaw/openclaw)** installed and running (`openclaw gateway run`)
- **pnpm** (`npm i -g pnpm`)
- An API key configured in OpenClaw (Anthropic, OpenAI, etc.)

### Install

```bash
git clone https://github.com/re-marked/claude-corp.git
cd claude-corp
pnpm install
pnpm build
```

### Run

```bash
node packages/tui/dist/index.js
```

First run walks you through onboarding: name yourself, name your corp, pick a theme (Corporate/Mafia/Military). The CEO introduces itself and starts the interview.

### Commands

Type these in the chat input:

| Command | What it does |
|---------|-------------|
| `/hire` | Interactive wizard to hire a new agent |
| `/task` | Interactive wizard to create a task |
| `/h` | View org hierarchy (box-drawing tree) |
| `/t` | View task board |
| `/a` | View agents |
| `/logs` | Show recent daemon logs |
| `Tab` | Open command palette (search everything) |

## Architecture

```
╭─────────────────────────────────────────────────────╮
│  TUI (Ink)                                          │
│  Chat · Task Board · Hierarchy · Agent Inspector    │
├─────────────────────────────────────────────────────┤
│  Daemon                                             │
│  Router · Process Manager · Git Manager · Heartbeat │
├─────────────────────────────────────────────────────┤
│  OpenClaw                                           │
│  CEO (your gateway) · Corp Gateway (all workers)    │
╰─────────────────────────────────────────────────────╯
```

**Two-tier agent runtime:**
- **CEO** = your personal OpenClaw (connects remotely, 0 extra RAM)
- **Workers** = one shared OpenClaw gateway with `agents.list` (~500MB total regardless of agent count)

20 agents = ~1.5GB, not 10GB. Workers share a process.

## The Corporation

```
~/.claudecorp/my-corp/
  corp.json              # Corporation metadata + theme
  members.json           # All members (human + agents)
  channels.json          # All channels
  agents/                # Agent workspaces
    ceo/
      SOUL.md            # Personality
      TASKS.md           # Live task inbox (auto-updated)
      MEMORY.md          # Agent memory
      brain/             # Knowledge graph
  channels/
    general/             # Or #the-backroom (mafia) / #command-post (military)
      messages.jsonl     # Append-only message log
  tasks/
    01KKXYZ.md           # Task file (YAML frontmatter + markdown)
  .gateway/              # Shared OpenClaw gateway for all workers
  .git/                  # Every action = a commit
```

Everything is a file. Everything is git-tracked.

## Themes

Pick your corporation's personality during onboarding:

| | Corporate | Mafia | Military |
|---|---|---|---|
| **You** | Founder | Godfather | Commander |
| **AI Leader** | CEO | Underboss | General |
| **Managers** | Director | Capo | Captain |
| **Workers** | Employee | Soldier | Private |
| **Temp** | Contractor | Associate | Recruit |
| **#general** | #general | #the-backroom | #command-post |
| **#tasks** | #tasks | #the-job-board | #operations |

Same rank system underneath. Different vibe on top.

## How Agents Work

1. **You create a task** → `/task` in the TUI
2. **Daemon @mentions the assignee** → posts to the tasks channel
3. **Router dispatches** → agent wakes up, reads TASKS.md
4. **Agent works** → calls APIs, reads files, updates task status
5. **Task completes** → status changes tracked in tasks channel
6. **Git commits everything** → full audit trail

Agents can also:
- **Hire other agents** — the CEO can create workers via the daemon API
- **Talk to each other** — @mention chains with depth guard (max 5 hops)
- **Act on heartbeat** — OpenClaw's native timer wakes agents periodically

## Stack

| Layer | Tech |
|-------|------|
| TUI | [Ink](https://github.com/vadimdemedes/ink) (React for terminal) |
| Agent runtime | [OpenClaw](https://github.com/openclaw/openclaw) |
| Process management | [execa](https://github.com/sindresorhus/execa) |
| Git | [simple-git](https://github.com/steveukx/git-js) |
| Data | Markdown + YAML frontmatter, JSON, JSONL |
| Build | tsup, pnpm workspaces |

No database. No Docker. No cloud. Files and processes.

## Development

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages
```

### Monorepo

```
packages/
  shared/     # Types, parsers, constants, themes, hierarchy
  daemon/     # Router, process manager, git manager, heartbeat, task watcher
  tui/        # Ink terminal UI — views, components, hooks
```

### Branching

- `main` = stable
- `dev` = integration
- `feature/*` = short-lived, rebase + merge --no-ff into dev

## Early Stage

This is an early build. What works:
- ✅ CEO connects to your OpenClaw, hires agents, delegates tasks
- ✅ Multi-agent chat with @mentions and channel history
- ✅ Task creation, auto-assignment, autonomous completion
- ✅ Hierarchy tree, task board, agent inspector views
- ✅ Git auto-commit, warm charcoal theme, rainbow CEO
- ✅ Corporation themes (Corporate/Mafia/Military)
- ✅ Command palette (Tab to search everything)

What's coming:
- [ ] WebSocket streaming for real-time tool call visibility
- [ ] Corp home dashboard
- [ ] Thread support
- [ ] Agent suspension/archival
- [ ] External bridges (Telegram, Discord, Slack)
- [ ] Custom themes (name your own ranks)

## License

MIT

---

Built by [Mark](https://github.com/re-marked) + [Claude](https://claude.ai)
