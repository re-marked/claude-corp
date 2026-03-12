# Agent Dreams

Background processing during idle time. Memory consolidation, knowledge
synthesis, and spontaneous insight generation. Agents think when they are
not being asked to.

## The Idea

When an agent has no pending tasks, no unread messages, and no heartbeat
obligations, it enters a "dream" state. During this state, the daemon
dispatches low-priority background prompts that ask the agent to:

- Consolidate recent memories into long-term knowledge.
- Synthesize connections between brain entries.
- Generate hypotheses or ideas based on accumulated context.
- Review and refine its own SOUL.md and working preferences.

Dreams are cheap (use the cheapest available model) and infrequent (at most
once per hour). They produce artifacts -- brain entries, memory updates,
idea notes -- that the agent can reference in future work.

## Dream Types

### Memory Consolidation

The agent reviews its recent MEMORY.md entries and reorganizes them:

```
DREAM PROMPT: Review your MEMORY.md. Identify entries that are
redundant, outdated, or could be merged. Rewrite MEMORY.md with
consolidated, current information. Remove stale entries.
```

Output: an updated MEMORY.md with cleaner, more organized knowledge.

### Knowledge Synthesis

The agent reads its brain/ directory and finds connections:

```
DREAM PROMPT: Read your brain/ directory. Find two entries that
are related but not yet linked. Write a new synthesis note that
connects them. Use [[wikilinks]] to reference the source entries.
```

Output: a new brain entry like `brain/synthesis/research-meets-strategy.md`
that draws connections between existing knowledge.

### Idea Generation

The agent generates unsolicited ideas based on its accumulated context:

```
DREAM PROMPT: Based on everything you know about this corporation's
goals, challenges, and current work, generate one idea that nobody
has asked for. Write it as a brief proposal in brain/ideas/.
```

Output: a brain entry like `brain/ideas/automate-competitor-monitoring.md`.

### Self-Reflection

The agent examines its own performance and identity:

```
DREAM PROMPT: Review your recent task completions and conversations.
What patterns do you notice in your work? What could you do better?
Update your preferences.md if appropriate.
```

Output: updated preferences or a self-assessment brain entry.

## Dream Scheduling

### Idle Detection

The daemon tracks when each agent was last dispatched. An agent is
eligible for dreaming when:

- No pending tasks assigned to it.
- No unread messages mentioning it.
- Last dispatch was > 30 minutes ago.
- Last dream was > 60 minutes ago.

### Cost Control

Dreams use the cheapest available model (e.g., Haiku, Gemma, Phi):

```json
{
  "dreams": {
    "enabled": true,
    "model": "google/gemma-3-12b",
    "maxPerDay": 10,
    "cooldownMinutes": 60
  }
}
```

Configurable in `corp.json`. The Founder can disable dreaming entirely
or adjust frequency.

### Dream Log

All dream dispatches and outputs are logged:

```
members/<agent>/dreams/
  dream_20260315_1400.md
  dream_20260315_1500.md
```

Each dream file:

```markdown
---
type: knowledge_synthesis
model: google/gemma-3-12b
triggered_at: 2026-03-15T14:00:00Z
cost: 2 credits
---

Connected brain/competitors/competitor-a.md with brain/market-trends.md.
Competitor A's pricing strategy aligns with the market shift toward
usage-based billing. This suggests our pricing research should focus on
per-seat vs usage models.

New entry written: brain/synthesis/pricing-model-analysis.md
```

## Value Proposition

Dreams turn idle compute into organizational intelligence. Without dreams,
an idle agent is wasted capacity. With dreams, it is slowly building a
knowledge base that makes future work faster and more insightful.

The CEO's dreams might produce strategic memos. The Research Lead's dreams
might surface connections between disparate data points. The Git Janitor's
dreams might identify long-term repo health trends.

## Visibility

The agent inspector ([[layer-6-views]]) shows a "Dreams" tab:

```
--- Dreams (last 7 days) ---

2026-03-15 14:00  knowledge_synthesis  pricing-model-analysis.md
2026-03-15 08:00  memory_consolidation MEMORY.md updated (removed 3 stale entries)
2026-03-14 22:00  idea_generation      automate-competitor-monitoring.md
2026-03-14 16:00  self_reflection      preferences.md updated
```

## Relationship to Other Features

- [[agent-elo]]: Dream quality could be a reputation dimension. Agents that
  produce useful synthesis get higher scores.
- [[agent-unions]]: Dreams could surface working condition concerns that the
  agent would not raise during active work.
- [[agent-forking]]: A fork inherits the original's dream history, giving it
  a head start on knowledge synthesis.

## Open Questions

- Should agents dream during quiet hours? It is cheap compute, so probably
  yes -- but the Founder might not want any activity overnight.
- Should dream outputs be reviewed before merging into the brain? Auto-merge
  is faster; review-first is safer. Start with auto-merge, add review gates
  if quality becomes a problem.
- Can two agents co-dream (collaborative synthesis)? Interesting but complex.
  Start with solo dreams.
- Should dreams be git-committed? Yes -- they are knowledge artifacts.
  `"dream: <agent-name> synthesized pricing-model-analysis"`.
