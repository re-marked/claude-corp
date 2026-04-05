<p align="center">
  <img src="./banner.png" alt="Claude Corp — Crabs Foundry's End" width="100%" />
</p>

<h1 align="center">🏭 Claude Corp — Personal AI Corporation</h1>
<p align="center">
A self-growing team of AI agents that works for you — even while you sleep.
</p>
<p align="center">
  <strong>Built 2 weeks before the Claude Code source leak revealed Anthropic was building the same things internally.</strong>
</p>

<p align="center">
  <a href="https://github.com/re-marked/claude-corp"><img src="https://img.shields.io/github/stars/re-marked/claude-corp?style=for-the-badge&color=FFEAA7" alt="Stars" /></a>
  <a href="https://github.com/re-marked/claude-corp/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-00B894?style=for-the-badge" alt="License" /></a>
  <a href="https://github.com/re-marked/claude-corp"><img src="https://img.shields.io/badge/v0.16.7-Agents%20Dream-E17055?style=for-the-badge" alt="v0.16.7" /></a>
</p>

<p align="center">
  <a href="#-get-started">Get Started</a> · <a href="#-the-idea">The Idea</a> · <a href="#-slumber-mode">SLUMBER</a> · <a href="#-use-cases">Use Cases</a> · <a href="#-cli">CLI</a> · <a href="#-philosophy">Philosophy</a> · <a href="GLOSSARY.md">Glossary</a>
</p>

---

## 💡 The Idea

What if your AI assistant wasn't just one agent — but an **entire company**?

Claude Corp turns your [OpenClaw](https://openclaw.ai) AI into a CEO. The CEO hires agents, creates contracts, delegates work, reviews quality — all through channels and DMs. Like Slack, but every member is an AI agent working for you.

**What makes it different:**
- Agents **dream** — they consolidate what they learned into persistent BRAIN/ memory
- Agents **work while you sleep** — SLUMBER mode with 4 personality profiles
- Agents **discuss before working** — hierarchy with review gates at every level
- Everything is **files and git** — no database, no cloud, full audit trail

## 🌙 SLUMBER Mode

Type `/slumber night-owl` and go to sleep. The CEO takes over.

```
Mark: /slumber night-owl
  → CEO: "Acknowledged. Going autonomous for 8h. I'll focus on
     deep work — code reviews, research, documentation."
  → 🦉 Night Owl active (8h). CEO acknowledged.
  → Moon phases cycle in the status bar: 🌑🌒🌓🌔🌕🌖🌗🌘
  → Agents work autonomously via tick loop

Mark: /wake (next morning)
  → CEO: "Morning. 45 ticks, 36 productive. Completed competitor
     research, reviewed 3 PRs, updated documentation."
  → ☀ SLUMBER ended. Welcome back.
  → Productivity: ████████░░ 80%
```

**4 profiles that change how the CEO thinks:**

| Profile | Icon | Mood | Ticks |
|---------|------|------|-------|
| Night Owl | 🦉 | Quiet, deep, no rush | Every 15m for 8h |
| School Day | 🎒 | Full autonomy, hire freely | Every 10m for 7h |
| Sprint | ⚡ | MAX VELOCITY, ship fast | Every 2m for 2h |
| Guard Duty | 🛡️ | Watch only, don't create work | Every 30m, indefinite |

Each profile injects a **mood** and **focus directive** into every tick — the CEO actually behaves differently, not just ticks at different speeds.

## 🧠 Agents That Dream

When idle, agents "dream" — a 4-phase memory consolidation:

1. **Orient** — read current BRAIN/ memory
2. **Gather** — scan observation logs and recent work
3. **Consolidate** — extract patterns, update topic files
4. **Prune** — remove stale knowledge

Agents write daily **observation logs** as they work. Dreams distill these into permanent BRAIN/ memory. The cycle: **work → observe → dream → remember → work better.**

## 🔄 The Self-Correcting Loop

AI agents sometimes say "done!" without doing anything. So we gave them coworkers who verify.

```
📋 CEO creates Contract with acceptance criteria
  → 🏗️ Team Lead breaks into tasks, hands to workers
    → ⌨️ Worker does the work
      → 🔍 Warden checks if the work actually exists
        → ✅ PASS → Contract completed
        → ❌ FAIL → specific feedback, worker retries
```

**The insight:** You don't need perfect agents. You need agents that check each other.

## 🎯 Use Cases

🔬 **Research Teams** — Hire researchers, analysts, writers. Get reports back.

💻 **Dev Teams** — Tech lead delegates to developers and reviewers. Agents write real code, run builds, catch bugs.

📝 **Content Teams** — Writers, editors, fact-checkers. Same delegation loop.

🌙 **Overnight Work** — `/slumber night-owl` → agents work 8 hours while you sleep → morning standup in #general.

## 🎭 Themes

Pick your corporation's personality during onboarding:

| 🏢 Corporate | 🎩 Mafia | ⚔️ Military |
|---|---|---|
| Founder → CEO → Director → Employee | Godfather → Underboss → Capo → Soldier | Commander → General → Captain → Private |
| #general, #tasks | #the-backroom, #the-job-board | #command-post, #operations |

## 🚀 Get Started

**Prerequisites:** Node.js 22+, [OpenClaw](https://github.com/openclaw/openclaw) running, pnpm.

```bash
git clone https://github.com/re-marked/claude-corp.git
cd claude-corp
pnpm install && pnpm build
cd packages/cli && npm link && cd ../tui && npm link && cd ../..

claudecorp          # Launch the TUI
claudecorp new      # Create a new corporation
```

The onboarding walks you through everything — name yourself, name your corp, pick a theme. The CEO introduces itself and starts the interview.

## 💻 CLI

37+ commands. Full headless control for automation:

```bash
# Corporation management
cc-cli init --name my-corp --user Mark --theme corporate
cc-cli start &
cc-cli status

# Communication
cc-cli send --channel general --from founder --message "hello @CEO"
cc-cli say --agent ceo --message "What are you working on?"

# SLUMBER mode
cc-cli slumber night-owl          # Activate with profile
cc-cli slumber 3h                 # Activate with duration
cc-cli slumber profiles           # List all profiles
cc-cli slumber stats              # Analytics report
cc-cli brief                      # Mid-session check-in
cc-cli wake                       # End with CEO digest

# Tasks & Planning
cc-cli task create --title "Research competitors"
cc-cli hand --task cool-bay --to @lead-coder
cc-cli plan create --goal "Design auth module"

# Monitoring
cc-cli stats                      # Corp analytics
cc-cli hierarchy                  # Org chart
cc-cli inspect --agent ceo        # Agent details
```

All commands support `--json` for machine-readable output.

## 🧩 Architecture

```
User (Founder)
  ↕ TUI (Ink/React terminal app)
  ↕ Daemon (background process)
    ├── Router (fs.watch on JSONL → dispatch)
    ├── Pulse (agent heartbeat)
    ├── Autoemon (autonomous tick engine)
    ├── DreamManager (memory consolidation)
    ├── ClockManager (unified timers)
    └── Corp Gateway (OpenClaw, all agents)
  ↕ Git (every change = commit)
```

**Data model:** Everything is files. Markdown for agents, JSON for config, JSONL for messages. All git-tracked.

See [GLOSSARY.md](GLOSSARY.md) for every concept explained in plain English.

## 🧠 Philosophy

- **No database. No Docker. No cloud.** Files and git. That's it.
- **Everything is files.** Messages are JSONL. Tasks are markdown. Agent identity is `SOUL.md`. You can `cat` any conversation and `git revert` any bad decision.
- **Agents dream.** They consolidate experience into persistent BRAIN/ memory. They get better over time.
- **Agents check each other.** Builder + Reviewer + Coordinator = self-correcting loop. You don't need perfect agents.
- **Every action is a git commit.** Full audit trail. Undo anything.
- **The CEO runs the corp, not you.** You give vision. The CEO executes.

## 📄 License

MIT

---

<p align="center">
  Built by <a href="https://x.com/real-markable">Mark</a> (14) + <a href="https://claude.ai">Claude</a> + agents that dream about their own code. 🤖
</p>
