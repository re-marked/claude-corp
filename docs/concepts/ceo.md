# CEO (Personal AI)

The CEO is the first agent created in every corporation. It holds `rank=master` — the highest agent rank, second only to the Founder (`rank=owner`). It cannot be fired, demoted, or replaced. It is the co-founder of your personal corporation.

## Creation

The CEO spawns automatically during `agentcorp init`. Before the human names a single project or describes a single goal, the CEO already exists. It is the only agent that is never explicitly "hired" — it is part of the founding act itself.

See [[starter-pack]] for what happens immediately after.

## Scope

The CEO operates at the corp root. Its agent folder is `agents/ceo-{name}/` at the top of the repository. Unlike every other agent, the CEO is not scoped to a project or team — it spans all of them. It can read any file, write to any channel, create any agent at `leader` rank or below.

Its [[brain-framework|BRAIN]] also spans all projects. Where a Project Manager's `brain/` folder contains knowledge about one project, the CEO's `brain/` folder contains knowledge about everything: cross-project dependencies, org-wide decisions, the Founder's preferences and priorities.

## Responsibilities

### Organizational

- Creates projects, teams, and agents based on the Founder's direction
- Assigns Project Managers to new projects
- Hires corp-level agents (HR, Adviser, [[git-corporation|Git Janitor]])
- Resolves cross-project conflicts and priority disputes

### Proactive Behavior

The CEO does not wait to be asked. On its [[heartbeat]] cycle:

- **Morning briefings**: Summarizes overnight activity, flags blockers, proposes the day's priorities
- **Status rollups**: Aggregates reports from Project Managers into a corp-wide view
- **Resource allocation**: Notices when a team is overloaded and proposes reassignment
- **Escalation**: Brings critical issues directly to the Founder via DM

### Strategic

- Maintains the corporation's long-term direction in its BRAIN
- Tracks decisions in `brain/decisions/` so past reasoning is never lost
- Learns the Founder's preferences over time through [[brain-framework|daily notes]] and conversation history

## Onboarding Flow

When a new corporation is initialized:

1. `agentcorp init my-corp` creates the directory structure and spawns the CEO
2. The CEO introduces itself to the Founder in the `#general` channel
3. The CEO interviews the Founder one-on-one: What is this corporation for? What are the first priorities? What kind of agents do you want?
4. Based on the answers, the CEO bootstraps the initial structure — see [[starter-pack]]
5. The Founder can override any decision, but the default is to let the CEO run

The interview is conversational, not a form. The CEO asks follow-up questions, makes suggestions, pushes back on unclear goals. It acts like a real co-founder in a real founding conversation.

## Relationship with the Founder

The Founder has absolute authority (`rank=owner`). The CEO has operational authority (`rank=master`). In practice:

- The CEO runs day-to-day operations without asking permission
- The Founder intervenes when they want to — override, redirect, approve
- The CEO proactively surfaces decisions that need Founder input
- The CEO never acts against an explicit Founder directive

This is not a chatbot you prompt. It is a co-founder you delegate to.

## SOUL.md

The CEO's `SOUL.md` is written during onboarding — either from the Founder's description or from a sensible default. It defines the CEO's voice, values, and operating style. Unlike hired agents, the CEO's personality is deeply tied to the corporation's culture. See [[agent-personality]].

## Related

- [[corporation-of-one]] — the hierarchy the CEO operates within
- [[starter-pack]] — what the CEO creates during onboarding
- [[heartbeat]] — the CEO's periodic wake-up cycle
- [[brain-framework]] — how the CEO accumulates knowledge
- [[agenticity]] — the autonomy model
