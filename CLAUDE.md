# AgentCorp — Codebase Guide

Your Personal Corporation — a self-growing organization of AI agents that work FOR you, running locally.
User = Founder, AI CEO = runs the corp. Not a chatbot. A company you own on your machine.

## #1 Priority: Read STATUS.md

**`STATUS.md`** is the honest gap analysis between the vision and what's built.
Read it before starting ANY new work. Cross items off as they ship.

## Vision & Source of Truth

**`docs/`** is the authoritative design spec (Obsidian vault).
Read it before building anything new. It contains:
- `vision/` — what AgentCorp is, positioning, principles
- `concepts/` — corporation hierarchy, agenticity, heartbeat, BRAIN, git-corporation
- `primitives/` — Members, Channels, Messages, Tasks, Teams
- `architecture/` — stack, daemon, router, TUI, file system, agent runtime
- `flows/` — onboarding, messaging, heartbeat, agent-to-agent, tasks, agent creation
- `views/` — TUI view specs (channel, onboarding, corp home, task board, hierarchy)
- `building-plan/` — layered implementation plan

When in doubt about a design decision, check `docs/` first.

## Stack

- **Runtime**: Node.js 22+ / TypeScript (strict)
- **TUI**: Ink (React for terminal) + Flexbox layout
- **Agent runtime**: OpenClaw (local gateway instances, one per agent)
- **Process management**: execa
- **Git operations**: SimpleGit
- **Build**: tsup
- **Package manager**: pnpm (monorepo with workspaces)
- **Data**: Files only — no database

## Monorepo Structure

```
packages/
  shared/       # Types, file format parsers (JSONL, frontmatter, JSON), constants
  daemon/       # Router (fs.watch + webhook dispatch), process manager (execa), git manager
  tui/          # Ink app — views, components, hooks. Entry point: `agentcorp` command
docs/           # Design spec (Obsidian vault)
```

## Data Model — Everything is Files

Three formats, all git-tracked:

| Format | Used for | Example |
|--------|----------|---------|
| Markdown + YAML frontmatter | Agent-readable files, tasks | SOUL.md, HEARTBEAT.md, tasks/task-001.md |
| JSON | Structured config, registries | corp.json, members.json, channels.json |
| JSONL | Message logs (append-only) | channels/general/messages.jsonl |

## Corp Folder Structure

```
~/.agentcorp/
  global-config.json              # API keys, default model, preferences
  corp-name/                      # Corporation (git repo)
    corp.json                     # Corp metadata
    members.json                  # ALL members (centralized registry)
    channels.json                 # ALL channels (centralized registry)
    channels/                     # Corp-level channels
    agents/                       # Corp-level agents (CEO, HR, Adviser, Git Janitor)
      agent-name/
        SOUL.md                   # Personality
        BRAIN/                    # Knowledge graph
        HEARTBEAT.md              # Wake instructions
        MEMORY.md                 # Memory index
        skills/                   # SKILL.md files
        config.json               # Agent-specific config
    projects/
      project-name/
        project.json
        agents/                   # Project-level agents
        channels/                 # Project channels (#general, DMs)
          channel-name/
            messages.jsonl
        teams/
          team-name/
            team.json
            agents/               # Team-level agents
            channels/             # Team channels
        tasks/                    # Task files (markdown + frontmatter)
```

Key principles:
- Agents live at their **highest** scope
- `members.json` and `channels.json` at corp root are the single source of truth
- Everything is git-tracked

## Architecture

### Daemon (background process)
- **Router**: watches JSONL via fs.watch, extracts @mentions, dispatches to agents via POST to OpenClaw webhook (`/hooks/agent` on `localhost:PORT`)
- **Process Manager**: spawns/stops OpenClaw instances via execa, assigns ports
- **Git Manager**: commits after prompt loops, coordinates with Git Janitor
- Auto-started by TUI. Runs when TUI is closed (agents keep working).

### TUI (terminal interface)
- Built with Ink (React for terminal)
- Watches files directly via fs.watch for live updates
- Connects to daemon ONLY for process management (creating/destroying agents)
- Primary view: channel chat + member sidebar
- Navigation: Ctrl+K fuzzy finder

### Agent Runtime
- Each agent = separate OpenClaw gateway on unique localhost port
- Built-in heartbeat (30min default), cron, hooks, webhooks
- Agents read/write freely to filesystem (their workspace AND corp files)
- Sub-agents are OpenClaw-native (ephemeral, no daemon involvement)

## Message Flow

```
User/Agent writes to JSONL → daemon fs.watch picks up →
  extract @mentions → resolve via members.json →
  POST to target agent webhook → agent processes →
  agent writes response to JSONL → daemon picks up → repeat
```

Guards: depth (max 5 hops), dedup, cooldown.

## Hierarchy

```
Founder (user — absolute power)
 └── CEO (rank=master, never fired)
      ├── Corp-Level (HR, Adviser, Git Janitor)
      └── Project Managers (dual: corp + project)
           ├── Project Agents
           └── Team Leaders (dual: project + team)
                └── Team Workers
                     └── Sub-agents (ephemeral, OpenClaw native)
```

Rank-based creation: any agent can create agents at their level or below.

## Git Corporation

The entire corp is a git repo. Every change = commit.
- Git Janitor agent resolves merge conflicts
- `git log` = full audit trail
- `git revert` = undo bad agent decisions
- Agents write freely, git tracks everything

## Commands

```bash
pnpm dev              # Run all packages in dev mode
pnpm build            # Build all
pnpm type-check       # Type-check all
```

## Branching Strategy

- **`main`** = stable production. Do NOT push directly.
- **`dev`** = integration branch. All work merges here.
- **`feature/*`** = short-lived branches off `dev`.

**Merge flow**: `feature/xyz` → rebase onto `dev` → merge with `--no-ff` → delete feature branch.

```bash
git checkout feature/xyz
git rebase dev                    # Linearize commits on top of dev
git checkout dev
git merge --no-ff feature/xyz     # Merge commit marks the join point
git branch -d feature/xyz         # Clean up
```

This gives: linear commit history within each feature + merge commits marking where features landed. Individual commits are preserved (no squash). Merge commits act as phase markers.

When `dev` is stable and tested, merge into `main` the same way.

## Key Conventions

- **Commit frequently**: Small focused commits, multiple per prompt
- **Always add co-authors**: Include both in every commit:
  - `Co-Authored-By: Mark <psyhik17@gmail.com>`
  - `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- **No cloud dependencies**: Everything runs locally. No Supabase, no Fly.io, no Docker.
- **File-first**: When in doubt, make it a file. Files are git-tracked, human-readable, agent-accessible.
- **Agents write freely**: Don't gate filesystem access behind commands. Only process management (spawning agents) goes through the daemon.
- **OpenClaw native features**: Use built-in heartbeat, cron, hooks, webhooks. Don't reinvent.

## When asked to build something

1. Read STATUS.md to understand current state
2. Read relevant docs/ files for the design spec
3. Write a plan for big features, get approval before coding
4. Build in the appropriate package (shared/daemon/tui)
5. Cross off STATUS.md items as they ship
