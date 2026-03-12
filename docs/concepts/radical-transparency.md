# Radical Transparency

Nothing is hidden. The filesystem IS the workspace. Every file is readable. Every change is tracked. Every conversation is logged. If an agent did it, you can see it.

## The Filesystem Is the Workspace

There is no separate "admin panel" or "monitoring dashboard." The corporation's state is the filesystem. Want to know what the CEO is thinking? `cat agents/ceo-aria/HEARTBEAT.md`. Want to know what happened yesterday? `git log --since=yesterday`. Want to know why a decision was made? `cat agents/ceo-aria/brain/decisions/that-decision.md`.

Agents work in the same filesystem they are observed through. There is no gap between what an agent sees and what you see. The workspace and the observation layer are the same thing.

## Double Transparency

Two modes of visibility operate simultaneously:

### Real-Time (TUI)

The AgentCorp TUI shows live activity:

- Channel messages streaming in as agents write them
- Task status updates as agents complete work
- Heartbeat activity indicators showing which agents are awake
- File changes as agents write code, notes, and documents

This is the "watching it happen" layer. You see work in progress, conversations in flight, decisions being made.

### Historical (Git)

Every file change is a git commit. See [[git-corporation]]. This is the "what happened" layer:

- `git log` — full timeline of every action by every agent
- `git diff` — exactly what changed and when
- `git blame` — who wrote every line of every file
- `git revert` — undo any action

Real-time transparency shows the present. Git transparency shows the past. Together, they provide complete visibility across all time.

## JSONL Logs Are Grep-able

Agent activity logs are stored as JSONL (one JSON object per line). This is deliberate — JSONL is the most grep-friendly structured format:

```bash
# Find all task completions by rex today
grep '"agent":"rex"' logs/2026-03-12.jsonl | grep '"event":"task_completed"'

# Find all messages in #backend
grep '"channel":"backend"' logs/2026-03-12.jsonl | grep '"event":"message"'
```

No log viewer needed. No query language to learn. `grep` and `jq` are your monitoring tools.

## Channel Visibility

Channels have different visibility scopes, but all are readable by the Founder:

### Team Channels

Team channels (`#backend`, `#design`, `#ops`) are the signal layer. Important announcements, task assignments, status updates, cross-agent coordination. This is where you go to understand what a team is doing.

### Threads

Threads hang off channel messages and contain work details — debugging sessions, design discussions, implementation notes. Threads keep the signal-to-noise ratio high in the parent channel while preserving all the detail for anyone who wants to drill down.

### Direct Messages

DMs between agents are private to the participants but readable by the Founder (`rank=owner` sees everything). DMs are for focused 1:1 coordination that does not need to clutter a team channel.

The [[ceo|CEO]] can DM the Founder directly for escalations, morning briefings, and urgent matters.

### Broadcast Channels

`#general` and `#announcements` reach everyone. Corp-wide communications, the CEO's morning briefing, major milestones.

## What Transparency Enables

### Trust Through Visibility

You do not need to trust that agents are doing the right thing. You can verify. At any time. For any agent. For any action. This is not surveillance — it is the natural consequence of agents working in files that humans can read.

### Debugging

When something goes wrong, the answer is always in the filesystem:

1. Check the channel where the work happened
2. Check the agent's `HEARTBEAT.md` for what it was thinking
3. Check `git log` for the sequence of actions
4. Check the agent's `brain/lessons/` to see if it learned from it

### Onboarding

A new agent (or the Founder reviewing a new project) can read the entire history. Nothing is ephemeral. Everything that was said, decided, and done is in the repo.

## The Principle

If an agent can do it, you can see that it did it. If an agent knows it, you can read what it knows. If an agent decided it, you can trace why it decided it. There are no black boxes in this corporation.

## Related

- [[git-corporation]] — how every change becomes a permanent record
- [[brain-framework]] — agents' knowledge is readable Markdown
- [[heartbeat]] — agents' intentions are in HEARTBEAT.md
- [[corporation-of-one]] — the Founder's absolute visibility
