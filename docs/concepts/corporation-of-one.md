# Corporation of One

A single human founds an entire corporation of AI agents. The human is the Founder — absolute authority, final word. Below them, a hierarchy of agents runs the day-to-day operation without constant supervision.

## The Hierarchy

```
Founder (human, rank=owner)
  CEO (Personal AI, rank=master)
    Corp-Level Agents (HR, Adviser, Git Janitor, rank=leader)
      Project Managers (rank=leader, scoped to project)
        Team Leaders (rank=leader, scoped to team)
          Workers (rank=worker)
            Sub-agents (rank=subagent, ephemeral)
```

Every agent exists at a specific scope in the folder tree. The CEO lives at the corp root. A Project Manager lives inside their project folder. A Team Leader lives inside their team folder. Scope determines what an agent can see and touch.

## Ranks

Five ranks map directly to authority:

| Rank | Role | Scope |
|------|------|-------|
| `owner` | Founder (human) | Entire corp |
| `master` | CEO | Entire corp |
| `leader` | Corp-level agents, PMs, team leads | Varies by position |
| `worker` | Individual contributors | Team or project |
| `subagent` | Ephemeral helpers | Single task |

Ranks are stored in `members.json` at the corp root. This file is the single registry of every member in the corporation — human or agent. See [[git-corporation]] for how this file is tracked.

## Dual-Level Roles

An agent can hold different roles at different scopes. The CEO is `master` at the corp level but also implicitly present in every project. A Team Leader is `leader` within their team but `worker` relative to the Project Manager above them. The rank in `members.json` reflects the agent's highest authority.

## Rank-Based Creation

Agents can only create other agents at their own rank or below. The Founder can create anything. The CEO (`master`) can create `leader`, `worker`, and `subagent` agents. A `leader` can create `worker` and `subagent` agents. A `worker` can only spawn `subagent` helpers.

This prevents runaway hierarchy inflation. No agent promotes itself. No worker hires a manager. See [[agenticity]] for how creation triggers work.

## members.json

The corp-root `members.json` is the authoritative registry:

```json
{
  "members": [
    {
      "id": "founder",
      "name": "Mark",
      "type": "human",
      "rank": "owner"
    },
    {
      "id": "ceo-aria",
      "name": "Aria",
      "type": "agent",
      "rank": "master",
      "scope": "/",
      "soul": "agents/ceo-aria/SOUL.md"
    },
    {
      "id": "pm-backend",
      "name": "Rex",
      "type": "agent",
      "rank": "leader",
      "scope": "/projects/backend",
      "soul": "agents/pm-backend/SOUL.md"
    }
  ]
}
```

Every mutation to this file is a git commit. The [[git-corporation]] ensures full auditability.

## Navigation

The TUI provides a fuzzy finder over the hierarchy. Type a name, a rank, a project — it narrows instantly. The folder tree IS the org chart, so navigating the filesystem and navigating the corporation are the same action. `cd` into a project to see its teams. `ls` an agent's folder to see their [[brain-framework|BRAIN]]. The TUI just makes it faster.

## One Human Per Corp

A corporation has exactly one human Founder. This is not a collaboration platform — it is a personal company. The Founder delegates everything to the [[ceo|CEO]], who delegates further down. If you want a second human, you found a second corp.

## Related

- [[ceo]] — the CEO agent and its special role
- [[agenticity]] — how agents act autonomously
- [[git-corporation]] — the corp as a git repo
- [[radical-transparency]] — why everything is visible
