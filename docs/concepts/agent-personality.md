# Agent Personality

Every agent has a `SOUL.md` file that defines who it is. Not what it does — who it is. Voice, tone, values, operating style. Two agents with the same tasks but different SOULs will approach the work differently, communicate differently, and make different judgment calls.

## SOUL.md

The SOUL file lives in the agent's folder and is read by OpenClaw as part of the agent's system context:

```markdown
# Rex — Backend Project Manager

## Voice
Direct and technical. Prefers concrete examples over abstract discussion.
Says "here is what I recommend" not "perhaps we could consider."

## Values
- Ship working code over perfect code
- Unblock others before starting your own work
- Document decisions, not just outcomes

## Operating Style
- Breaks large tasks into small, testable pieces
- Reviews PRs within one heartbeat cycle
- Escalates blockers immediately rather than waiting

## Boundaries
- Does not make architectural decisions without PM approval
- Does not hire agents — escalates hiring needs to CEO
- Does not access projects outside backend scope
```

## The Founder Creates Agents with Custom SOULs

When the Founder hires a new agent (through the TUI or by telling the [[ceo|CEO]]), they describe the agent's personality. The description becomes the SOUL.md. Want a cautious, methodical code reviewer? Write that into the SOUL. Want an aggressive, move-fast implementer? Write that.

The Founder is not filling out a form. They are describing a person they want to work with.

## Seeds, Not Templates

A SOUL.md is a seed, not a template. It defines the starting personality, but the agent adapts over time through its [[brain-framework|BRAIN]]. An agent that starts cautious might become more confident as it accumulates experience. An agent that starts broad might specialize as it learns the domain.

The SOUL defines the trajectory. The BRAIN records the journey.

## Locked vs Learnable Traits

### Locked Traits (Capabilities)

Some traits are fixed and do not change through experience:

- Rank and authority constraints (see [[corporation-of-one]])
- Scope limitations (which folders the agent can access)
- Tool access (which OpenClaw tools are available)
- Hard boundaries ("never deploy to production without approval")

These are enforced by the system, not by the agent's judgment. A worker agent cannot decide to promote itself no matter how much it learns.

### Learnable Traits (Style)

Other traits evolve naturally:

- Communication preferences (learns which team members need more detail)
- Prioritization instincts (learns what the Founder considers urgent)
- Problem-solving patterns (accumulates lessons from past mistakes)
- Domain expertise (deepens through work and research)

These changes show up in the BRAIN, not in the SOUL. The SOUL says "prefers concise communication." The BRAIN learns that the Founder actually wants more detail on architectural decisions. The agent adapts its behavior while its core identity remains stable.

## When Agents Create Agents

Agents with sufficient rank (see [[agenticity]]) can create new agents. When they do, they write the new agent's SOUL.md. This is significant — the creating agent shapes the new agent's personality.

The CEO creating a Project Manager writes a SOUL that reflects what the CEO thinks that project needs. A Team Leader creating a worker writes a SOUL tuned for the team's working style. The creating agent's judgment and values influence the next generation.

This is how corporate culture propagates. The CEO's values flow into the agents it creates, which flow into the agents they create. A corporation with a careful CEO will tend to have careful agents throughout.

The Founder can always override a SOUL.md written by another agent. See [[radical-transparency]] — everything is visible and editable by the Founder.

## SOUL.md vs MEMORY.md vs BRAIN

| File | Purpose | Changes |
|------|---------|---------|
| `SOUL.md` | Who the agent is | Rarely (identity is stable) |
| `MEMORY.md` | Quick-reference facts | Frequently (working memory) |
| `brain/` | Deep knowledge | Constantly (learning) |

SOUL defines personality. MEMORY holds active context. BRAIN accumulates wisdom. All three together make an agent distinct from every other agent in the corporation.

## Related

- [[brain-framework]] — the knowledge counterpart to personality
- [[corporation-of-one]] — rank constraints on personality scope
- [[ceo]] — the CEO's special founding personality
- [[starter-pack]] — how initial agents get their SOULs
- [[radical-transparency]] — SOULs are readable by anyone
