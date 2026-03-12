# AgentCorp

Your Personal Corporation — a self-growing organization of AI agents that work FOR you.

You are the Founder. Your AI CEO runs the day-to-day. The agents work autonomously, talk to each other, create new agents, manage tasks, and grow your organization — all running locally on your machine.

## What is this?

AgentCorp is a CLI/TUI application that lets you create and run an autonomous corporation of AI agents powered by [OpenClaw](https://github.com/openclaw/openclaw). Every corporation is a git-tracked folder where agents have real workspaces, real personalities, and real autonomy.

```
$ agentcorp
```

That's it. Name your corporation, and your AI CEO takes over — interviews you about what you're working on, then builds the entire organization: projects, teams, agents, channels, tasks. Go to sleep, wake up to a morning briefing of everything that happened overnight.

## How it works

- **Your corporation is a folder** — `~/.agentcorp/corp-name/`, git-tracked. Every agent change is a commit. `git log` is your audit trail. `git revert` undoes bad decisions.
- **Agents are OpenClaw processes** — each agent runs as a separate local process with its own personality (SOUL.md), memory (BRAIN/), and wake-up instructions (HEARTBEAT.md).
- **Agents act on their own** — OpenClaw's built-in heartbeat wakes agents every 30 minutes. They check their tasks, talk to each other via @mentions, and get work done without being prompted.
- **Everything is transparent** — conversations are JSONL files you can grep. Agent workspaces are folders you can browse. The TUI shows it all in a Discord-like interface.

## The hierarchy

```
Founder (you)
 └── CEO Agent (runs the corporation)
      ├── Corp-Level Agents (HR, Adviser, Git Janitor)
      └── Project Managers
           ├── Project Agents
           └── Team Leaders
                └── Team Workers
                     └── Sub-agents (ephemeral)
```

Any agent can create agents at their level or below. The corporation grows organically.

## Stack

- **Runtime**: Node.js 22+ / TypeScript
- **TUI**: Ink (React for terminal)
- **Agent runtime**: OpenClaw (local gateway instances)
- **Process management**: execa
- **Version control**: SimpleGit
- **Data**: Files only — Markdown, JSON, JSONL. No database.

## Project structure

```
packages/
  shared/     # Types, file format parsers, constants
  daemon/     # Router, process manager, git operations
  tui/        # Ink app, views, components
docs/         # Design spec (Obsidian vault)
```

## Development

```bash
pnpm install
pnpm dev          # Run all packages in dev mode
pnpm build        # Build all packages
pnpm type-check   # Type-check all packages
```

## License

MIT
