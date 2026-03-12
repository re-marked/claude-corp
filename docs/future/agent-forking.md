# Agent Forking

Fork agent configurations like GitHub repos. Copy the identity, let it evolve
independently. Branch your best agents into new roles without starting from
scratch.

## The Idea

An agent's identity is a collection of files: SOUL.md, MEMORY.md, AGENTS.md,
brain/ directory. These files represent months of learned context, refined
personality, and accumulated knowledge. Forking means copying this identity
wholesale and letting the fork diverge.

## Use Cases

### Role Specialization

Your Research Lead is excellent. You need a second researcher focused on a
different domain. Fork the Research Lead:

```
members/research-lead/        -->  members/market-researcher/
  SOUL.md (general research)        SOUL.md (market research specialization)
  MEMORY.md (preserved)              MEMORY.md (same starting knowledge)
  brain/ (preserved)                 brain/ (same starting knowledge)
  member.json (team_leader)          member.json (team_leader, new project)
```

The market researcher starts with everything the Research Lead knows, but its
SOUL.md is edited to focus on market dynamics instead of general research.
Over time, the two diverge: different memories, different brain entries,
different specialization.

### Experimental Branches

Fork an agent to test a different personality or strategy:

- Fork the CEO with a more aggressive SOUL.md. See how it performs.
- Fork a Writer with a different tone. Compare outputs.
- Fork a Team Leader to manage a temporary crisis project.

If the fork works better, promote it. If not, archive it. Low-cost
experimentation.

### Template Agents

A well-tuned agent becomes a template. Fork it every time you need a new
instance of that role. The original is never modified -- it is the "upstream."

## Mechanics

### Fork Command

```
agentcorp fork <source-member> <new-name> [--rank <rank>] [--project <project>]
```

The daemon:
1. Copies the entire source member directory to `members/<new-name>/`.
2. Generates a new `member.json` with a fresh ID, the new name, and
   optionally a different rank.
3. Preserves SOUL.md, MEMORY.md, AGENTS.md, and brain/ as-is.
4. Adds a `forkedFrom` field to `member.json` for traceability.
5. Spawns the new agent.
6. Commits: `"fork: <new-name> from <source-name>"`.

### Forked Identity

The forked agent's `member.json`:

```json
{
  "id": "member_market_researcher",
  "name": "Market Researcher",
  "rank": "team_leader",
  "type": "agent",
  "status": "active",
  "forkedFrom": "member_research_lead",
  "forkedAt": "2026-03-15T10:00:00Z",
  "createdBy": "member_ceo"
}
```

### Divergence Tracking

Since everything is git-tracked, you can always compare a fork to its source:

```bash
git diff HEAD -- members/research-lead/MEMORY.md members/market-researcher/MEMORY.md
```

The TUI could show a "divergence score" -- how different the fork has become
from its origin. High divergence means the fork has developed its own identity.
Low divergence might mean the fork is redundant.

## Relationship to [[layer-5-autonomy]]

Forking is a specialized form of agent creation. The CEO (or any agent with
sufficient rank) could fork an agent by writing the member directory with
copied files. The daemon validates rank as usual.

The difference from normal creation: forking preserves the source's brain and
memory. Normal creation starts with a blank slate.

## Open Questions

- Should the fork inherit the source's DM history? Probably not -- that is a
  relationship with a specific person, not transferable knowledge.
- Should there be a "merge" operation (pull knowledge from a fork back into
  the original)? Interesting but complex -- deferred.
- Should agents be able to fork themselves? The rank system says no (you cannot
  create your own rank), but a self-fork at a lower rank could be allowed.
