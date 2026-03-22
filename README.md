<p align="center">
  <img src="https://github.com/user-attachments/assets/claude-corp-banner.png" alt="Claude Corp" width="100%" />
</p>

<h1 align="center">🏭 Claude Corp</h1>

<p align="center">
  <strong>Your personal AI corporation.</strong><br/>
  A self-growing team of AI agents that works for you.
</p>

<p align="center">
  <a href="https://github.com/re-marked/claude-corp"><img src="https://img.shields.io/github/stars/re-marked/claude-corp?color=FFEAA7&style=flat" alt="stars" /></a>
  <a href="https://github.com/re-marked/claude-corp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-00B894" alt="license" /></a>
  <a href="https://github.com/re-marked/claude-corp"><img src="https://img.shields.io/badge/agents-do%20real%20work-E17055" alt="real work" /></a>
  <a href="https://github.com/re-marked/claude-corp"><img src="https://img.shields.io/badge/self--correcting-✓-00B894" alt="self-correcting" /></a>
</p>

---

## what is this?

you know how you have one AI assistant? what if instead of one, you had a whole company?

Claude Corp turns your [OpenClaw](https://github.com/openclaw/openclaw) AI into a CEO. the CEO hires agents, creates teams, delegates tasks, reviews work, and reports back to you. you're the founder — you set the vision, the corporation executes.

the agents are autonomous. you don't script workflows or write chains. you say "I need X done" and the CEO figures out who to hire, what to delegate, and how to get it there.

## why does this matter?

**agents check each other's work.** we discovered that an AI agent will sometimes say "done!" without actually doing anything. so we gave it a coworker whose entire job is to verify. the Reviewer reads the actual output, checks if the work exists, and issues a PASS or FAIL. when one agent lied, the Reviewer caught it. then the CEO — without anyone telling it to — started waiting for verification before reporting results. it learned from the failure on its own.

**the insight:** you don't need perfect agents. you need agents that check each other. same model, different role, completely different behavior.

## what can you build with it?

🔬 **research teams** — hire a researcher, an analyst, and a writer. give them a topic. get a report back.

💻 **dev teams** — a tech lead that delegates to developers and code reviewers. we tested this — agents wrote real TypeScript, ran builds, caught each other's bugs.

📝 **content teams** — writers, editors, fact-checkers. the same delegation and verification loop works for any kind of output.

🎯 **anything with tasks** — if you can break it into tasks with clear "done" criteria, a corp can execute it. the agents adapt to whatever you throw at them.

## the vibes

pick your corporation's personality:

| 🏢 Corporate | 🎩 Mafia | ⚔️ Military |
|---|---|---|
| Founder → CEO → Director → Employee | Godfather → Underboss → Capo → Soldier | Commander → General → Captain → Private |
| #general, #tasks | #the-backroom, #the-job-board | #command-post, #operations |

same system underneath. different flavor on top. 😎

## how it works (the short version)

- **everything is files.** messages are JSONL, tasks are markdown, agent identity is SOUL.md. you can `cat` any conversation and `git revert` any bad decision.
- **your AI keeps its brain.** the CEO is your existing OpenClaw assistant with a new role. same memory, same personality. Claude Corp is an exoskeleton, not a replacement.
- **agents talk through channels.** like Discord — @mention someone and they wake up. the system handles routing, queuing, and streaming.
- **13 composable prompt fragments** instead of one wall of text. each agent gets focused instructions based on their role and context.

## get started

```bash
git clone https://github.com/re-marked/claude-corp.git
cd claude-corp
pnpm install && pnpm build
npx tsx packages/tui/src/index.tsx
```

you need Node.js 22+, [OpenClaw](https://github.com/openclaw/openclaw) running, and pnpm. the onboarding walks you through everything else.

there's also a CLI for headless automation:

```bash
claudecorp-cli init --name my-corp --user Mark --theme corporate
claudecorp-cli start &
claudecorp-cli send --channel dm-ceo-mark --message "hire a research team" --wait
```

## the philosophy

- **no database, no docker, no cloud.** files and git. that's it.
- **agents write freely.** don't gate everything behind APIs. let them read and write to the filesystem.
- **every action is a git commit.** full audit trail. undo anything.
- **the CEO is your AI, not a new AI.** it's an exoskeleton on OpenClaw.
- **the system topology creates reliability, not individual agent perfection.** builder + reviewer + coordinator = self-correcting loop.

## license

MIT

---

<p align="center">
  built by <a href="https://x.com/real-markable">mark</a> + <a href="https://claude.ai">claude</a> + agents that wrote their own features 🤖
</p>
