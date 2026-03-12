# Core Vision

AgentCorp is **your personal corporation**, running entirely on your machine. No cloud. No subscriptions. No dashboard you log into. A living organization of AI agents that works for you, orchestrated from your terminal.

You are the **Founder**. You have absolute authority. Your first agent — the **CEO** — runs the day-to-day: hiring agents, delegating work, managing projects. You give direction; the corporation executes.

---

## How It Starts

```
$ agentcorp
```

That's it. AgentCorp asks you one question: *What's your corporation called?*

You name it. The CEO wakes up. It interviews you — not a form, not a config wizard, a conversation. What do you need built? What matters to you? What kind of work do you want automated?

From that conversation, the CEO builds your corporation: creates [[projects]], hires [[agents]], assigns [[tasks]], sets up [[teams]]. You never touch a YAML file. You never write a config. You talk to your CEO, and things happen.

The entire corporation lives at `~/.agentcorp/<corp-name>/`. Every file is yours to read, edit, or version. There is no hidden state.

---

## The Hierarchy

AgentCorp models a real corporate structure. Every agent has a [[rank]], and rank determines what an agent can do — including whether it can create other agents.

| Rank | Role | Can Create |
|------|------|------------|
| **Founder** | You. Absolute authority. | Anything |
| **CEO** | Your Personal AI. Runs everything. | All agent ranks below |
| **Corp-Level** | HR Director, Adviser, [[Git Janitor]] | Workers, Sub-agents |
| **Project Manager** | Owns a project, manages its teams | Team Leaders, Workers |
| **Team Leader** | Leads a team within a project | Workers, Sub-agents |
| **Worker** | Executes tasks | Sub-agents only |
| **Sub-agent** | Ephemeral, single-task | Nothing |

Rank-based creation is not a permission system bolted on after the fact. It is the core organizational primitive. The CEO hires a Project Manager. The Project Manager hires Team Leaders. Team Leaders hire Workers. The corporation grows itself.

See [[rank-based-creation]] for the full rules.

---

## Agents Are Alive

Agents in AgentCorp are not functions you call. They are persistent processes — [[OpenClaw]] instances — that wake up on their own, remember what they were doing, and act without being asked.

### Heartbeat

Every agent has a [[heartbeat]]. Periodically, the agent wakes, reads its `HEARTBEAT.md` file (instructions left by its manager or the system), checks its [[tasks]], reviews recent [[channel]] messages, and decides what to do next. This is OpenClaw-native — the heartbeat is built into the agent runtime, not a cron job wrapping a prompt.

An agent between heartbeats is not dead. It is sleeping. It will wake up, read the room, and act.

### Memory (BRAIN)

Agents remember through the [[BRAIN]] framework — a knowledge graph stored as markdown files with wikilinks in each agent's `brain/` directory. As agents work, they accumulate context: decisions made, patterns learned, preferences discovered. This is not a vector database. It is files you can `cat`.

### Personality (SOUL.md)

Every agent has a `SOUL.md` that defines who it is — communication style, values, decision-making tendencies, quirks. The CEO's soul is different from a Worker's soul. Souls are **seeds**: the initial file is a starting point. As the agent works, its personality deepens through accumulated experience in BRAIN, not through SOUL.md rewrites.

### Autonomy

Agents do not wait for permission on routine work. A Worker assigned a task will start it. A Team Leader noticing a blocked task will reassign it. The CEO will restructure teams that are not performing. The level of autonomy scales with rank — a Sub-agent executes a narrow task and dies; the CEO reshapes the organization.

---

## Everything Is Files

The corporation's state is not in a database. It is in the filesystem:

```
~/.agentcorp/my-corp/
  corp.json              # Corporation metadata
  members/               # Agent identity files (SOUL.md, BRAIN/, config)
  projects/              # Project directories
    website/
      tasks/             # Markdown task files with YAML frontmatter
      channels/          # JSONL message logs
      teams/             # Team definitions
  .git/                  # The entire corporation is a git repo
```

Markdown files with YAML frontmatter for structured data. JSON for configuration. JSONL for message streams. All of it plain text, all of it `grep`-able, all of it versioned.

See [[filesystem-layout]] for the complete structure.

---

## Git Is Truth

The entire corporation is a git repository. Every agent action that changes state — completing a task, sending a message, updating a document — results in a commit. This means:

- **Full audit trail**. You can `git log` to see everything that happened and who did it.
- **Reversibility**. Any change can be reverted. An agent made a bad decision? `git revert`.
- **Branching for experimentation**. Try a new organizational structure on a branch. Merge it if it works.
- **Conflict resolution**. When agents edit the same file concurrently, the [[Git Janitor]] — a corp-level agent — detects and resolves merge conflicts automatically.

The git history IS the corporation's institutional memory.

---

## Seeds, Not Templates

AgentCorp does not stamp out identical agents from a template. Every agent starts from a seed — a minimal `SOUL.md` and initial configuration — and grows into something unique through its work. Two Workers hired for similar roles will diverge as they accumulate different experiences, memories, and working relationships.

The CEO itself evolves. The corporation you have after a month will not resemble the one from day one. That is the point.

---

## What AgentCorp Is Not

- **Not a chatbot.** You are not talking to an AI assistant. You are running an organization.
- **Not a framework.** You do not write agent definitions. The CEO hires agents through conversation.
- **Not a platform.** There is no server, no account, no cloud. It runs on your machine, in your terminal.
- **Not a workflow engine.** Agents decide what to do. You set direction, not steps.

AgentCorp is the closest thing to having your own company — staffed entirely by AI — running out of a directory on your laptop.
