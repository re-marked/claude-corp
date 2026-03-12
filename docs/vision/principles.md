# Principles

Seven principles that govern how AgentCorp is designed and built. These are not aspirations — they are constraints. If a feature violates a principle, the feature is wrong.

---

## 1. Agenticity

**Agents act. They do not wait to be asked.**

The default state of an agent in AgentCorp is *doing something*. Agents have a [[heartbeat]] — they wake up periodically, assess the state of the world, and take action. A Worker with an assigned task does not need a `run` command. A Team Leader whose team is blocked does not need you to notice. The CEO does not need a prompt to reorganize a failing project.

This is the fundamental difference between AgentCorp and every "agent framework" that is really just a fancy function caller. Those systems are reactive — they respond to input. AgentCorp agents are proactive — they have goals, they have context, and they move toward outcomes on their own.

Agenticity scales with [[rank]]. A Sub-agent has narrow autonomy: complete this one task, then terminate. A Worker has task-level autonomy. A Team Leader has team-level autonomy. The CEO has organizational autonomy. The Founder (you) has absolute authority and can override anything, but the point is that you should not have to.

If you are constantly telling agents what to do, something is broken.

---

## 2. Radical Transparency

**The filesystem IS the workspace. There is no hidden state.**

Every piece of information in AgentCorp is a file you can read. Agent memories are markdown files in `brain/`. Messages are JSONL in `channels/`. Tasks are markdown with YAML frontmatter. Configuration is JSON. The agent's personality is `SOUL.md`. Its instructions are `HEARTBEAT.md`.

There is no database. There is no opaque API. There is no "internal state" that requires a special tool to inspect. If you want to know what an agent is thinking, `cat` its files. If you want to know what happened in a channel, `cat` the JSONL. If you want to change an agent's behavior, edit its `SOUL.md`.

This is not a debugging feature. This is the architecture. Agents read and write the same files you do. The filesystem is the shared workspace — not a reflection of it, not a projection of it. The actual thing.

```
$ cat ~/.agentcorp/my-corp/members/ceo/SOUL.md
$ cat ~/.agentcorp/my-corp/projects/website/tasks/fix-landing-page.md
$ cat ~/.agentcorp/my-corp/projects/website/channels/general.jsonl | tail -20
```

If you cannot understand the state of your corporation by reading files, the system has failed.

---

## 3. Conversation Over Configuration

**The CEO builds through chat. You never write config files.**

When you start AgentCorp, you do not fill out forms. You do not write YAML. You do not define agent schemas. You talk to your CEO.

"I need a marketing team for the product launch."

The CEO creates the project, hires a Project Manager, sets up teams, assigns initial tasks. You did not specify agent counts, model parameters, or team structures. The CEO made those decisions based on the conversation, its experience (stored in [[BRAIN]]), and the current state of the corporation.

This extends to ongoing management. Want to change how a project is run? Tell the CEO. Want to hire a specialist? Describe what you need. Want to shut down a failing initiative? Say so.

Configuration files exist — `corp.json`, agent configs, task frontmatter — but they are the *output* of conversation, not the input. You can edit them directly if you want to ([[Radical Transparency]] guarantees this), but the default path is always through dialogue.

---

## 4. Familiar Patterns

**Discord/Slack in your terminal. No new mental models required.**

AgentCorp's communication model maps directly to patterns you already know:

| AgentCorp | Discord/Slack Equivalent |
|-----------|--------------------------|
| Corporation | Server |
| Project | Sidebar section |
| Team | Channel group |
| Channel | Channel |
| Direct Message | DM |
| @mention | @mention |
| Thread | Thread |

The [[TUI]] renders this hierarchy using [[Ink]]. You navigate between projects, browse channels, read messages, and chat — exactly as you would in Discord, but in your terminal, with AI agents as your colleagues.

This is a deliberate design choice. The problem AgentCorp solves is not "how do I interact with AI agents" — it is "how do I run an organization." Organizations already have a solved UX for internal communication. We use it.

See [[channels]] for channel types (broadcast, team, direct, system) and their behaviors.

---

## 5. Corporation of One

**Your corporation grows itself. You set direction, not headcount.**

You start with one agent: the CEO. From there, the corporation grows organically. The CEO hires corp-level staff — an [[HR Director]], an [[Adviser]], a [[Git Janitor]]. When you create a project, the CEO hires a Project Manager. The Project Manager hires Team Leaders. Team Leaders hire Workers. Workers spawn Sub-agents for subtasks.

At no point do you manage a roster. You do not provision agents. You do not decide "I need 4 workers on this team." You describe outcomes, and the organization structures itself to achieve them.

This is [[rank-based-creation]] in practice: each rank can create agents at lower ranks. The constraint is structural, not numerical. A Team Leader cannot hire another Team Leader. A Worker cannot promote itself. The hierarchy enforces organizational coherence while allowing autonomous growth.

The corporation scales up when there is work and contracts when there is not. Idle agents are suspended. Active projects get more resources. The CEO manages this lifecycle. You manage the CEO.

---

## 6. Seeds, Not Templates

**Agents start small and grow. No two agents are the same.**

Every agent begins with a seed: a `SOUL.md` (personality and values) and an initial configuration. This seed is minimal on purpose. It defines who the agent *starts as*, not who it will become.

As the agent works, it builds its [[BRAIN]] — a knowledge graph of markdown files linked with wikilinks. It accumulates context: decisions it has made, patterns it has noticed, relationships with other agents, domain knowledge from its tasks. This is persistent memory, not session context. It survives restarts, reassignments, and promotions.

```
members/worker-alice/
  SOUL.md          # Initial personality seed (rarely changes)
  brain/
    index.md       # Knowledge graph root
    patterns.md    # Learned patterns
    decisions.md   # Decision log
    ...            # Grows over time
```

Two Workers hired on the same day for similar roles will diverge. One might develop a preference for breaking tasks into small PRs. The other might favor larger, integrated changes. Their `SOUL.md` files are similar. Their `brain/` directories are not.

This is the difference between a template (stamp out copies) and a seed (plant and let grow). AgentCorp plants seeds.

---

## 7. Git Is Truth

**Every change is a commit. The history is the institution.**

The corporation directory is a git repository. Every state change — a task completed, a message sent, a new agent hired, a team restructured — results in a commit attributed to the agent that made it.

This gives you:

- **Audit trail.** `git log --author="ceo"` shows everything the CEO has done. `git log -- projects/website/tasks/` shows every task mutation in a project.
- **Reversibility.** `git revert <hash>` undoes any agent action. Bad hire? Revert the commit that created the agent. Wrong task completed? Roll it back.
- **Branching.** Want to try a different organizational structure? Branch. Run it for a day. Diff the outcomes. Merge or discard.
- **Conflict resolution.** When two agents modify the same file between commits, the [[Git Janitor]] — a dedicated corp-level agent — detects the conflict and resolves it. This is not a hack; it is a first-class organizational role.

Git is not an add-on for versioning. It is the source of truth for the entire corporation. The commit graph IS the organizational history. `git blame` tells you which agent made every decision. `git diff` shows you exactly what changed between any two points in time.

The corporation's institutional memory is not in a database or a vector store. It is in the git log.

See [[git-janitor]] for how conflict resolution works in practice.
