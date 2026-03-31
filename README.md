<p align="center">
  <img src="./banner.png" alt="Claude Corp — Crabs Foundry's End" width="100%" />
</p>

<h1 align="center">🏭 Claude Corp — Personal AI Corporation</h1>
<p align="center">
A self-growing team of AI agents that works for you.
</p align="center">
<p align="center">

  <strong>Built 2 weeks before the Claude Code source leak revealed Anthropic was building the same things internally LOL.<?strong>
</p>

<p align="center">
  <a href="https://github.com/re-marked/claude-corp"><img src="https://img.shields.io/github/stars/re-marked/claude-corp?style=for-the-badge&color=FFEAA7" alt="Stars" /></a>
  <a href="https://github.com/re-marked/claude-corp/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-00B894?style=for-the-badge" alt="License" /></a>
  <a href="https://github.com/re-marked/claude-corp"><img src="https://img.shields.io/badge/Agents-Do%20Real%20Work-E17055?style=for-the-badge" alt="Real Work" /></a>
</p>

<p align="center">
  <a href="#-get-started">Get Started</a> · <a href="#-the-idea">The Idea</a> · <a href="#-use-cases">Use Cases</a> · <a href="#-the-self-correcting-loop">How It Works</a> · <a href="#-cli">CLI</a> · <a href="#-philosophy">Philosophy</a>
</p>

---

## 💡 The Idea

What if your AI assistant wasn't just one agent — but an **entire company**?

Claude Corp turns your [OpenClaw](https://openclaw.ai) AI into a CEO. The CEO hires agents — researchers, writers, developers, analysts, whatever you need — creates tasks with acceptance criteria, delegates work, and manages everything through channels. Like a Discord server where every member is an AI agent working for you.

Your AI keeps its brain. The CEO isn't a new agent — it's your existing OpenClaw assistant with a new role. Same memory, same personality, same integrations. Claude Corp is an **exoskeleton** on top of OpenClaw, not a replacement.

## 🎯 Use Cases

🔬 **Research Teams** — Hire a researcher, an analyst, and a writer. Give them a topic. Get a report back.

💻 **Dev Teams** — A tech lead that delegates to developers and code reviewers. We tested this — agents wrote real TypeScript, ran builds, and caught each other's bugs.

📝 **Content Teams** — Writers, editors, fact-checkers. The same delegation and verification loop works for any kind of output.

🏢 **Anything With Tasks** — If you can break it into tasks with clear "done" criteria, a corp can execute it.

## 🔄 The Self-Correcting Loop

We discovered that an AI agent will sometimes say "done!" without actually doing anything. So we gave it a coworker whose job is to verify.

```
📋 Task Created
  → 🏗️ Architect delegates with acceptance criteria
    → ⌨️ Worker does the work
      → 🔍 Reviewer checks if the work actually exists
        → ✅ PASS → CEO reports to Founder
        → ❌ FAIL → task blocked, Worker must redo
```

In testing, the Reviewer caught an agent that lied about completing a task. Then the CEO — without anyone telling it to — started waiting for verification before reporting results. It learned from the failure on its own.

**The insight:** You don't need perfect agents. You need agents that check each other. Same model, different role, completely different behavior.

## 🎭 Themes

Pick your corporation's personality during onboarding:

| 🏢 Corporate | 🎩 Mafia | ⚔️ Military |
|---|---|---|
| Founder → CEO → Director → Employee | Godfather → Underboss → Capo → Soldier | Commander → General → Captain → Private |
| #general, #tasks | #the-backroom, #the-job-board | #command-post, #operations |

Same system underneath. Different vibe on top. 😎

## 🚀 Get Started

**Prerequisites:** Node.js 22+, [OpenClaw](https://github.com/openclaw/openclaw) running, pnpm.

```bash
git clone https://github.com/re-marked/claude-corp.git
cd claude-corp
pnpm install && pnpm build
npm link

claudecorp          # Launch the TUI
claudecorp new      # Create a new corporation
claudecorp list     # List all corporations
claudecorp delete   # Delete a corporation
```

The onboarding walks you through everything — name yourself, name your corp, pick a theme. The CEO introduces itself.

## 💻 CLI

Everything works headlessly too — for automation, testing, or if you just prefer the command line:

```bash
claudecorp-cli init --name my-corp --user Mark --theme corporate
claudecorp-cli start &
claudecorp-cli send --channel dm-ceo-mark --message "Hire a research team" --wait
claudecorp-cli dogfood    # Project + 3 agents + task in one shot
claudecorp-cli agents --json
```

11 commands. All support `--json` for machine parsing.

## 🧠 Philosophy

- **No database. No Docker. No cloud.** Files and git. That's it.
- **Everything is files.** Messages are JSONL. Tasks are markdown. Agent identity is `SOUL.md`. You can `cat` any conversation and `git revert` any bad decision.
- **Agents write freely.** Don't gate everything behind APIs. Let them use the filesystem.
- **Every action is a git commit.** Full audit trail. Undo anything.
- **The CEO is your AI, not a new AI.** Exoskeleton on OpenClaw.
- **System topology creates reliability.** Builder + Reviewer + Coordinator = self-correcting loop. You don't need perfect agents — you need agents that check each other.

## 📄 License

MIT

---

<p align="center">
  Built by <a href="https://x.com/real-markable">Mark</a> + <a href="https://claude.ai">Claude</a> + agents that wrote their own features. 🤖
</p>
