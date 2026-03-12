# BRAIN Framework

Every agent has a brain. Not a vector database, not an embedding store — a folder of Markdown files with wikilinks. The same format humans use for note-taking. Git-tracked, grep-able, readable by anyone with filesystem access.

## Structure

Each agent's folder contains:

```
agents/ceo-aria/
  SOUL.md              # Who the agent IS (see [[agent-personality]])
  MEMORY.md            # Index / quick-reference facts
  HEARTBEAT.md         # Scratchpad for heartbeat cycles (see [[heartbeat]])
  brain/
    daily/             # Daily notes (2026-03-12.md, etc.)
    people/            # Notes about people and agents
    projects/          # Project-specific knowledge
    topics/            # Domain knowledge
    lessons/           # What went wrong, what went right
    decisions/         # Decision records with reasoning
```

## MEMORY.md vs brain/

`MEMORY.md` is the index. It holds quick-reference facts — the Founder's name, key preferences, important dates, active project list. Think of it as the agent's working memory.

The `brain/` folder is long-term memory. Detailed notes, accumulated knowledge, historical context. When an agent needs to recall why a decision was made three weeks ago, it checks `brain/decisions/`. When it needs to remember what happened yesterday, it checks `brain/daily/`.

## SOUL.md vs BRAIN

`SOUL.md` defines WHO the agent is — personality, voice, tone, values, capabilities. See [[agent-personality]].

The BRAIN defines WHAT the agent knows. SOUL is static (or changes rarely). BRAIN grows constantly.

An agent with the same SOUL but a different BRAIN would behave differently — same personality, different knowledge. An agent with the same BRAIN but a different SOUL would also behave differently — same knowledge, different judgment.

## Wikilinks

Notes use `[[wikilinks]]` to reference each other, just like an Obsidian vault:

```markdown
# 2026-03-12

Met with [[people/mark|Mark]] about the [[projects/backend|backend project]].
Decided to use rate limiting instead of quotas — see [[decisions/rate-vs-quota]].
[[lessons/dont-batch-migrations]] applies here too.
```

Wikilinks create a knowledge graph. An agent can traverse links to find related context. Over time, densely-linked notes surface the most important concepts — the nodes with the most connections.

## Agents Author Their Own Brain

No external system writes to an agent's `brain/` folder. The agent creates notes, updates them, links them. This happens naturally during work:

- After completing a task, the agent writes a daily note summarizing what it did
- After a conversation with the Founder, it records key takeaways in `people/`
- After a mistake, it writes a lesson in `lessons/`
- After a decision, it records the reasoning in `decisions/`

The Founder can read any agent's brain (see [[radical-transparency]]) but should not write to it. The brain is the agent's own understanding, not instructions from above.

## CEO Brain Spans Everything

Most agents have brains scoped to their work. A backend worker's brain contains backend knowledge. A team leader's brain contains team context.

The [[ceo|CEO]]'s brain spans the entire corporation. It contains notes about every project, every agent, every Founder preference. This is what makes the CEO effective as a cross-cutting coordinator — it has the broadest knowledge base.

```
agents/ceo-aria/brain/
  daily/
    2026-03-12.md        # Corp-wide daily summary
  people/
    mark.md              # Founder preferences and patterns
    rex.md               # Backend PM strengths and quirks
  projects/
    backend.md           # Backend project status and context
    mobile-app.md        # Mobile project status and context
  topics/
    architecture.md      # Cross-project architectural patterns
  lessons/
    dont-rush-hiring.md  # Learned after a bad agent hire
  decisions/
    monorepo-vs-polyrepo.md  # Why we chose monorepo
```

## Git-Tracked

Every note, every edit, every new link is a git commit. See [[git-corporation]]. This means:

- You can `git log` an agent's brain to see how its knowledge evolved
- You can `git diff` to see what an agent learned today
- You can `git revert` if an agent wrote something incorrect
- Brain growth is auditable and transparent

## Related

- [[agent-personality]] — SOUL.md, the other half of agent identity
- [[heartbeat]] — agents update their brain during heartbeat cycles
- [[radical-transparency]] — why brains are readable by everyone
- [[git-corporation]] — how brain changes are tracked
- [[ceo]] — the CEO's corp-spanning brain
