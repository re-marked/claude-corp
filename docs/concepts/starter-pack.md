# Starter Pack

When a new corporation is initialized, only one agent spawns: the [[ceo|CEO]]. Everything else is decided through conversation.

## Onboarding Flow

1. **`agentcorp init my-corp`** — creates the directory structure, initializes git, spawns the CEO
2. **CEO introduces itself** — posts to `#general`, greets the Founder
3. **CEO interviews the Founder** — a one-on-one conversation in `#general` or a DM channel:
   - What is this corporation for?
   - What are your first priorities?
   - Do you have existing projects to import?
   - What kind of working style do you prefer?
   - How involved do you want to be day-to-day?
4. **CEO bootstraps the corporation** — based on the Founder's answers, the CEO creates the initial structure

## What the CEO Typically Creates

The CEO decides what to create based on the interview. There is no fixed formula. But a common first-run setup looks like:

### Corp-Level Agents

- **HR Agent** (`rank=leader`) — manages hiring, onboarding new agents, maintaining `members.json` consistency, tracking agent performance
- **Adviser Agent** (`rank=leader`) — provides strategic input to the CEO, researches options, plays devil's advocate on major decisions
- **Git Janitor** (`rank=leader`) — resolves git conflicts when multiple agents modify the same files (see [[git-corporation]])

### First Project

- A project directory under `projects/` based on the Founder's first priority
- A **Project Manager** (`rank=leader`, scoped to the project) with a [[agent-personality|SOUL.md]] tailored to the project's domain
- One or two initial **Workers** (`rank=worker`) if the Founder described concrete tasks

### Channels

- `#general` — corp-wide broadcast (already exists from init)
- `#announcements` — CEO broadcasts
- Project-specific team channel (e.g., `#backend`)
- DM channel between CEO and Founder

## Not a Fixed Set

The word "typically" is doing heavy lifting above. The CEO might create a completely different structure if the Founder's answers warrant it:

- A Founder who says "I just want a research assistant" might get a single worker agent and no projects at all
- A Founder who describes three active projects might get three PMs immediately
- A Founder who says "I do not want agents talking to each other" might get a flat structure with no teams

The CEO exercises judgment. That is the point of having a [[ceo|CEO]] instead of a configuration wizard.

## Templates for Common Roles

While the CEO decides dynamically, it can draw from template definitions for common agent roles. These templates are JSON files that define a starting SOUL.md, default capabilities, and suggested scope:

```json
{
  "role": "git-janitor",
  "default_soul": "Meticulous and calm. Resolves conflicts by understanding intent, not just syntax...",
  "rank": "leader",
  "scope": "/",
  "capabilities": ["git-resolve", "file-read", "file-write"]
}
```

Templates are suggestions, not requirements. The CEO can modify any template before using it, or ignore templates entirely and write a custom SOUL.md from scratch. See [[agent-personality]] for how SOUL authorship works.

## The Founder Can Override Everything

Every decision the CEO makes during bootstrapping is a git commit. See [[git-corporation]]. The Founder can:

- Edit any agent's SOUL.md
- Remove agents from `members.json`
- Restructure projects and teams
- Override channel membership in `channels.json`

The CEO proposes. The Founder disposes. But the default is to let the CEO run — that is the whole point of hiring a co-founder.

## Post-Bootstrap

After the initial setup, the corporation is running. Agents have heartbeats (see [[heartbeat]]). The CEO sends its first morning briefing. Workers start on assigned tasks. The Founder can watch, intervene, or walk away and check back later.

The corporation grows from here through normal [[agenticity]] — agents creating agents, tasks spawning subtasks, teams forming and dissolving as work demands.

## Related

- [[ceo]] — the CEO's role in bootstrapping
- [[corporation-of-one]] — the hierarchy being created
- [[agent-personality]] — how new agents get their SOULs
- [[agenticity]] — how the corporation grows after bootstrap
- [[git-corporation]] — every bootstrap action is a commit
