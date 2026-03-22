# Claude Corp

**Your personal AI corporation.** A team of AI agents that hire each other, delegate work, write real code, catch each other's mistakes, and report back to you — running entirely on your machine.

You are the Founder. Your AI becomes CEO. It hires a dev team, breaks down your goals into tasks, delegates to specialists, reviews their work, and reports results to your DM. You set direction. The corporation executes.

```
           mmmm                                mm
           ""##                                ##
  m#####m    ##       m#####m  ##    ##   m###m##   m####m           
 ##"    "    ##       " mmm##  ##    ##  ##"  "##  ##mmmm##           
 ##          ##      m##"""##  ##    ##  ##    ##  ##""""""           
 "##mmmm#    ##mmm   ##mmm###  ##mmm###  "##mm###  "##mmmm#          
   """""      """"    """" ""   """" ""    """ ""    """""              

  m#####m   m####m    ##m####  ##m###m
 ##"    "  ##"  "##   ##"      ##"  "##             
 ##        ##    ##   ##       ##    ##
 "##mmmm#  "##mm##"   ##       ###mm##"
   """""     """"     ""       ## """
```

## The Idea

What if your AI assistant wasn't just one agent — but an entire company?

Claude Corp turns [OpenClaw](https://github.com/openclaw/openclaw) into a corporate operating system. Your personal AI takes on the role of CEO. It can hire specialists (a frontend dev, a backend dev, a code reviewer), create tasks with acceptance criteria, delegate work, and manage the whole operation through channels — like a Discord server where every member is an AI agent working for you.

**The agents write real code.** Not descriptions of code. Real TypeScript files, verified builds, git-committed changes. And when one agent lies about completing a task, another agent catches it.

## What Makes It Different

**Agents are autonomous, not scripted.** You don't program workflows. You tell the CEO what you want, and it figures out who to hire, what tasks to create, and how to get it done.

**The system is self-correcting.** We discovered that an agent will sometimes claim work is done without doing it. So we built a verification layer: a Reviewer agent independently checks the implementer's work. In testing, the Reviewer caught a Coder that marked a task complete without writing any code. The CEO then adapted — on the next task, it waited for the Reviewer's verdict before reporting to the Founder. Nobody programmed this behavior.

**Everything is files.** Messages are JSONL. Tasks are markdown with YAML frontmatter. Agent identity is a SOUL.md file. You can `cat` any conversation, `grep` across the entire corp, and `git log` every decision an agent ever made. `git revert` undoes bad agent decisions.

**Your AI keeps its brain.** The CEO isn't a fresh agent — it's your existing OpenClaw assistant with a new job. Same memory, same personality, same Telegram bridge. Claude Corp is an exoskeleton on top of OpenClaw, not a replacement.

## Quick Start

**Prerequisites:** Node.js 22+, [OpenClaw](https://github.com/openclaw/openclaw) running, pnpm

```bash
git clone https://github.com/re-marked/claude-corp.git
cd claude-corp
pnpm install && pnpm build
npx tsx packages/tui/src/index.tsx
```

Pick your name, name your corp, choose a theme. The CEO introduces itself.

## The Corp in Action

```
╭─ my-corporation ──── 4/4 online ──── 3 tasks ───╮
╰──────────────────────────────────────────────────╯
╭─ AGENTS ─────────────────────────────────────────╮
│ ◆ CEO        online    ◆ Architect  online       │
│ ◆ Coder      online    ◆ Reviewer   online       │
╰──────────────────────────────────────────────────╯
╭─ ACTIVITY ───────────────────────────────────────╮
│ ▸ #tasks    Reviewer   2m  VERDICT: PASS         │
│   #tasks    Coder      3m  Status: DONE, Files.. │
│   #tasks    Architect  5m  Status: DELEGATED...  │
╰──────────────────────────────────────────────────╯
```

**A real task execution we tested:**

1. We told the CEO: "Add a /version command"
2. CEO delegated to Architect
3. Architect created two sub-tasks — one for Coder (implement), one for Reviewer (verify after Coder finishes)
4. Coder read the codebase, wrote 32 lines of TypeScript, ran `pnpm build` — PASS
5. Reviewer waited for Coder to finish, then independently read the file, verified the code exists, ran the build
6. Reviewer issued: **VERDICT: PASS**
7. CEO reported to the Founder with a structured summary

All autonomous. All real code. All verified.

## Themes

Pick your corporation's personality during onboarding:

| | Corporate | Mafia | Military |
|---|---|---|---|
| **You** | Founder | Godfather | Commander |
| **AI Leader** | CEO | Underboss | General |
| **Managers** | Director | Capo | Captain |
| **Workers** | Employee | Soldier | Private |
| **Channels** | #general | #the-backroom | #command-post |

Same system underneath. Different vibe on top.

## How It Works

### The Architecture

```
TUI (Ink/React)  ←→  Daemon (HTTP + WebSocket)  ←→  OpenClaw (LLM gateway)
     ↕                      ↕                              ↕
  Terminal            fs.watch + JSONL              Anthropic/OpenAI API
```

- **CEO** runs on your personal OpenClaw — same assistant, new role
- **Workers** share a single OpenClaw gateway — efficient, hot-reloadable
- **Daemon** watches message files, dispatches to agents via @mentions, streams responses via WebSocket
- **TUI** renders the terminal interface with live streaming, typing indicators, and a command palette

### The Prompt Fragment System

Agents don't get a wall-of-text system message. They get **composable instruction fragments** — 13 focused behavioral modules selected at dispatch time based on who the agent is and what they're doing:

| Fragment | Purpose |
|---|---|
| Anti-Rationalization | Names 6 specific excuses agents use to avoid work, with direct counters |
| Task Execution | Step-by-step protocol with machine-parseable output (Status/Files/Build) |
| Delegation | How to break down work, write acceptance criteria, create sub-tasks |
| Back-Reporting | When to message (completion, blocker, question) and when NOT to (every tool call) |
| Blast Radius | What's safe to write, what's shared infrastructure |

Workers get 11 fragments. The CEO gets 13. Each is independently testable.

### The Self-Correcting Loop

```
Task Created → Architect delegates with acceptance criteria
    → Coder implements, runs build
    → Reviewer reads actual files, verifies independently
    → If PASS: CEO reports to Founder
    → If FAIL: task marked BLOCKED, Coder must redo
```

The Reviewer's role is adversarial by design: "Your job is NOT to confirm it works — it's to check if the work actually exists." Same model, different frame, fundamentally different behavior.

## CLI Mode

Everything works without the TUI. Claude Code (or any automation) can manage a corp headlessly:

```bash
claudecorp-cli init --name my-corp --user Mark --theme corporate
claudecorp-cli start &
claudecorp-cli send --channel dm-ceo-mark --message "hire a dev team" --wait
claudecorp-cli dogfood    # project + 3 agents + task in one shot
claudecorp-cli agents --json
claudecorp-cli messages --channel tasks --last 10 --json
claudecorp-cli stop
```

11 commands, all support `--json` for machine parsing.

## Commands

| Command | What it does |
|---------|-------------|
| `/hire` | Hire a new agent |
| `/task` | Create a task |
| `/dogfood` | Project + dev team + task in one shot |
| `/who` | Online roster with status |
| `/stats` | Corp statistics |
| `/version` | Package versions |
| `/help` | List all commands |
| `Ctrl+K` | Command palette |
| `Ctrl+H` | Corp home |
| `Ctrl+T` | Task board |
| `Ctrl+D` | CEO DM |
| `Ctrl+M` | Member sidebar |

## The File System IS the Database

```
~/.claudecorp/my-corp/
  corp.json              # Corp metadata + theme
  members.json           # All members (human + agents)
  channels.json          # All channels
  agents/
    ceo/
      SOUL.md            # Who the agent is
      TASKS.md           # Live task inbox (auto-updated)
      MEMORY.md          # What it's learned
  channels/
    general/
      messages.jsonl     # Append-only conversation log
  tasks/
    01KKXYZ.md           # Task with acceptance criteria
  .git/                  # Every action = a commit
```

No database. No Docker. No cloud. Files and git.

## Stack

| Layer | Tech |
|-------|------|
| TUI | [Ink](https://github.com/vadimdemedes/ink) (React for terminal) |
| Agent Runtime | [OpenClaw](https://github.com/openclaw/openclaw) |
| Streaming | WebSocket event bus (real-time token delivery) |
| State | React Context with composable prompt fragments |
| Data | Markdown, JSON, JSONL — all git-tracked |
| Build | tsup, pnpm workspaces, TypeScript |

## Development

```bash
pnpm install && pnpm build
npx tsx packages/tui/src/index.tsx    # TUI mode
node packages/cli/dist/index.js      # CLI mode
```

```
packages/
  shared/     # Types, parsers, themes, hierarchy, task system
  daemon/     # Router, gateway, process manager, prompt fragments
  tui/        # Terminal UI — views, components, hooks, context
  cli/        # Non-interactive CLI — 11 commands
```

## License

MIT

---

Built by [Mark](https://x.com/real-markable) + [Claude](https://claude.ai) + AI agents that wrote their own features.
