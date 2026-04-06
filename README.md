<p align="center">
  <img src="./banner.png" alt="Claude Corp" width="100%" />
</p>

<h1 align="center">Claude Corp — Your Personal AI Corporation</h1>
<p align="center">
A hierarchy of AI agents that runs as a company on your machine — even while you sleep.
</p>

<p align="center">
  <a href="https://github.com/re-marked/claude-corp/actions"><img src="https://img.shields.io/github/actions/workflow/status/re-marked/claude-corp/ci.yml?style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/re-marked/claude-corp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" /></a>
  <a href="https://github.com/re-marked/claude-corp"><img src="https://img.shields.io/badge/v1.0.0-stable-blue?style=flat-square" alt="v1.0.0" /></a>
</p>

<p align="center">
  <a href="#get-started">Get Started</a> · <a href="#how-it-works">How It Works</a> · <a href="#slumber-mode">SLUMBER</a> · <a href="#agent-dreams">Dreams</a> · <a href="#cli">CLI</a> · <a href="GLOSSARY.md">Glossary</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

Most multi-agent frameworks give you a swarm that does random things. Claude Corp gives you a **company** — with a CEO who delegates, team leads who coordinate, workers who execute, and a quality gate that reviews everything before it ships. The entire thing runs locally. No cloud, no Docker. Just files and git.

## Get Started

**Prerequisites:** Node.js 22+, [OpenClaw](https://github.com/openclaw/openclaw) running, pnpm.

```bash
git clone https://github.com/re-marked/claude-corp.git
cd claude-corp
pnpm install && pnpm build
cd packages/cli && npm link && cd ../tui && npm link && cd ../..

cc              # Launch the TUI
cc new          # Create a new corporation
```

The onboarding walks you through everything. Name yourself, name your corp, pick a theme. The CEO introduces itself and starts working.

## How It Works

```
Founder (you)
  └── CEO (runs the corp, delegates everything)
       ├── Failsafe (health monitor)
       ├── Warden (quality gate — reviews all work)
       ├── Herald (narrator — writes NARRATION.md)
       ├── Planner (deep planning on Opus)
       └── Team Leaders → Workers (you hire these)
```

A Node.js daemon watches JSONL message files via `fs.watch`. When someone writes `@ceo check the build`, the router extracts the mention, resolves it against `members.json`, and dispatches to the right agent. Agents respond to the same JSONL. The cycle repeats.

All agents share a single [OpenClaw](https://openclaw.ai) gateway with per-agent model overrides. One process handles cheap workers and expensive planners simultaneously. Provider-agnostic — runs on Anthropic, OpenAI, Google, DeepSeek, or local models via Ollama.

**The data model is deliberately boring:**

| Format | Used for |
|--------|----------|
| Markdown + YAML frontmatter | Agent profiles (`SOUL.md`), tasks, plans |
| JSON | Config, registries (`members.json`, `channels.json`) |
| JSONL | Message logs (append-only, one JSON object per line) |

No database. No migrations. `grep` is your query engine. `git revert` is your undo. Every corp is a git repo — every agent action is a commit.

## SLUMBER Mode

Type `/afk night-owl` and go to sleep. The Autoemon tick engine fires `<tick>` prompts to enrolled agents on adaptive intervals — 30s when productive, 2min when idle, 5min after 3 consecutive idle ticks.

Four personality profiles inject `<mood>` and `<focus>` directives per tick that **genuinely change how the CEO behaves:**

| Profile | Mood | Ticks | Key directive |
|---------|------|-------|---------------|
| 🦉 Night Owl | Quiet deep work | 15min for 8h | "DO NOT hire agents at 3am" |
| 🎒 School Day | Full autonomy | 10min for 7h | "DO NOT wait for approval" |
| ⚡ Sprint | Ship fast | 2min, 200-tick cap | "DO NOT refactor, ship now" |
| 🛡️ Guard Duty | Monitor only | 30min, indefinite | "DO NOT create tasks, only watch" |

Agents can `SLEEP 15m — waiting for build` and the daemon respects it. Founder presence is tracked — ticks suppress while you're chatting.

```
/afk night-owl
  → CEO acknowledges, agents conscripted
  → Ticks fire autonomously through the night
  → Moon phases cycle: 🌑🌒🌓🌔🌕🌖🌗🌘

/wake
  → CEO: "45 ticks, 36 productive. Reviewed 3 PRs,
     updated docs, completed competitor research."
  → Productivity: ████████░░ 80%
```

## Agent Dreams

Agents write observations to daily logs as they work. During idle periods, a 4-phase dream cycle distills these into persistent `BRAIN/` topic files:

**Orient** → read current memory · **Gather** → scan observations · **Consolidate** → extract patterns · **Prune** → remove stale knowledge

This survives context compaction — agents wake up tomorrow knowing what they learned today. After overnight SLUMBER sessions, a morning standup posts to `#general` with per-agent summaries.

## The Self-Correcting Loop

```
📋 CEO creates Contract with acceptance criteria
  → 🏗️ Team Lead breaks into tasks
    → ⌨️ Worker executes
      → 🔍 Warden reviews against criteria
        → ✅ PASS → completed
        → ❌ FAIL → specific feedback, retry
```

You don't need perfect agents. You need agents that check each other.

## Persistent Sessions

Every conversation uses deterministic session keys (`jack:ceo`, `jack:lead-coder`). Agents remember previous interactions across daemon restarts. No context stuffing, no message replay. The session **is** the memory.

## CLI

37+ commands for full headless control:

```bash
# Communication
cc-cli say --agent ceo --message "What's the status?"
cc-cli send --channel general --from founder --message "hello @CEO"

# SLUMBER
cc-cli slumber night-owl       # Activate with profile
cc-cli brief                   # Mid-session check-in
cc-cli wake                    # End + CEO digest
cc-cli slumber stats           # Productivity analytics

# Tasks & Planning
cc-cli task create --title "Research competitors"
cc-cli hand --task cool-bay --to @lead-coder
cc-cli plan create --goal "Design auth module"

# Monitoring
cc-cli status                  # Agent statuses
cc-cli hierarchy               # Org chart
cc-cli stats                   # Corp analytics
cc-cli activity                # Live feed
```

All commands support `--json` for scripting.

## Renderer

The TUI uses [Yokai](https://github.com/re-marked/yokai) — our own React terminal renderer with pure TypeScript Yoga layout (no WASM), diff-based output, and `ScrollBox` with sticky scroll. Replaced Ink after its `<Static>` component had an unfixable scrollback bug on Windows.

## Testing

123 tests across 8 files. CI runs build + type-check + test on every push.

```bash
pnpm build          # Build all packages
pnpm type-check     # TypeScript strict
pnpm test           # vitest (< 1s)
```

## License

MIT

---

<p align="center">
  Built by <a href="https://github.com/re-marked">Mark</a> (14) + <a href="https://claude.ai/code">Claude Code</a>
</p>
