---
title: Onboarding Flow
type: flow
status: draft
triggers: agentcorp CLI invoked with no existing corp
outputs: fully bootstrapped corporation with CEO, projects, teams, agents, channels, tasks
related:
  - "[[view-onboarding]]"
  - "[[flow-agent-creation]]"
  - "[[flow-message]]"
---

# Onboarding Flow

The onboarding flow IS the product demo. There are no setup wizards, no config files to edit, no forms to fill. The user runs `agentcorp`, talks to their CEO, and the CEO builds everything.

## Entry Condition

User runs `agentcorp` from any terminal. The daemon checks `~/.agentcorp/` for existing corporations. If none exist, the onboarding flow begins.

## Sequence

### 1. TUI Wizard (One Input)

The [[view-onboarding]] renders a minimal Ink prompt:

```
Name your corporation: _
```

That is the only input the user provides. The name becomes the directory name at `~/.agentcorp/<corp-name>/`.

### 2. Corporation Scaffold

The daemon creates the corp directory structure:

```
~/.agentcorp/<corp-name>/
  config.json              # Corp-level config (name, created_at, founder)
  members.json             # Corp-wide member registry
  .git/                    # Initialized immediately — everything is tracked
  agents/
    ceo/
      config.json          # OpenClaw config
      SOUL.md              # CEO personality and directives
      HEARTBEAT.md         # Wake-up instructions
      BRAIN/               # Knowledge graph
      skills/              # Skill files
  channels/
    ceo-dm/
      messages.jsonl       # DM channel between Founder and CEO
      channel.json         # Channel metadata
```

The `members.json` is seeded with two entries: the Founder (rank: founder, type: user) and the CEO (rank: ceo, type: agent).

A git commit is created: `"corp: initialize <corp-name>"`.

### 3. CEO Spawn

The daemon spawns an OpenClaw process for the CEO agent, reading config from `agents/ceo/config.json`. The CEO's SOUL.md contains directives that make it a corporation builder — it knows how to ask the right questions and how to translate answers into structure.

The [[view-onboarding]] shows a brief spinning indicator while the process starts, then transitions directly to the DM [[view-channel]] with the CEO.

### 4. CEO Conversation

The CEO opens with a question, not a greeting:

> What are you working on right now?

From there, the CEO asks questions one at a time. Each question builds on the previous answer. The CEO never dumps a list of questions. Examples of the progression:

- "What are you working on right now?"
- "Who else is involved, or is this solo?"
- "What is the most urgent thing that needs to happen this week?"
- "Are there any recurring tasks — things that need to happen every day or every week?"

The CEO gathers enough context in 3-5 questions. The conversation uses the standard [[flow-message]] pipeline — messages append to `channels/ceo-dm/messages.jsonl`, the daemon dispatches via webhook, the CEO responds through the same JSONL.

### 5. CEO Bootstraps Everything At Once

After gathering context, the CEO executes a single coordinated bootstrap. It does not ask permission for each step. It announces what it is doing and does it:

> Based on what you have told me, I am setting up your corporation. Here is what I am creating:
>
> **Projects**: SaaS Launch, Content Pipeline
> **Teams**: Engineering (under SaaS Launch), Marketing (under Content Pipeline)
> **Agents**: A project manager for each project, a team leader for each team, two workers per team
> **Channels**: #general (broadcast), one channel per team, DMs for each agent
> **Tasks**: Initial tasks based on your priorities

The CEO uses the [[flow-agent-creation]] to spawn each agent. Each agent gets:
- A folder under the appropriate scope (`projects/<name>/agents/<agent>/` or `projects/<name>/teams/<team>/agents/<agent>/`)
- A SOUL.md tailored to their role
- An entry in `members.json`
- A DM channel
- Membership in relevant team/broadcast channels

All of this is committed to git as a single atomic commit: `"bootstrap: CEO sets up initial structure"`.

### 6. User Lands in Their Corporation

After bootstrap completes, the TUI transitions to the [[view-corp-home]]. The user can see their projects, agents, and channels. They can navigate into any channel to see the CEO's bootstrap messages, or jump into a DM with any agent.

The corporation is alive. Agents begin their [[flow-heartbeat]] cycles. The user is the Founder.

## What the CEO Creates

The CEO follows a hierarchy when bootstrapping:

| Level | What | Created By |
|-------|------|------------|
| Corporation | Already exists from step 2 | Wizard |
| CEO | Already exists from step 2 | Wizard |
| Projects | One per distinct initiative the user described | CEO |
| Project Managers | One per project (rank: leader) | CEO |
| Teams | Grouped by function within each project | CEO |
| Team Leaders | One per team (rank: leader) | CEO |
| Workers | 1-3 per team based on scope | CEO |
| Channels | #general (broadcast), per-team, DMs for all agents | CEO |
| Tasks | Initial tasks derived from user's priorities | CEO |

The CEO is the ONLY agent spawned by the system. Every other agent is created by the CEO through the standard [[flow-agent-creation]]. This means the user sees the exact same mechanism that will be used for all future agent creation.

## Error Handling

- If the corp directory already exists: skip wizard, resume with existing corp.
- If the CEO process fails to spawn: retry once, then show error with path to logs.
- If the user exits during conversation: state is saved in the JSONL. Next `agentcorp` launch resumes the DM.

## Git Trail

Every step produces a commit. Running `git log` in the corp directory after onboarding shows the full creation story:

```
abc1234 bootstrap: CEO sets up initial structure
def5678 agent: spawn ceo
9012345 corp: initialize acme-corp
```
