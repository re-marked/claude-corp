# Layer 5 -- Autonomy

This is where the corporation becomes self-growing. Agents create other agents.
Agents talk to agents. Every mutation is a git commit. The CEO hires a starter
pack and the org chart starts filling itself in.

## Goals

- Rank-based agent creation (agents write files, daemon signals).
- Agent-to-agent @mention chaining.
- Git commit after each agent action (prompt loop completion).
- Git Janitor agent for repo hygiene.
- Starter pack: CEO bootstraps HR, Adviser, Janitor, first project + leader.
- Agents write freely to the filesystem within their workspace.

---

## 1. Rank-Based Agent Creation

The hierarchy determines who can create whom:

```
Founder         can create -> anything
CEO             can create -> Corp-Level, PM, Team Leader, Worker
Corp-Level      can create -> PM, Team Leader, Worker
Project Manager can create -> Team Leader, Worker
Team Leader     can create -> Worker
Worker          can create -> nothing
```

### How an Agent Creates Another Agent

Agents do not call an API. They write files. The daemon watches and acts.

**Step 1: Agent writes a hire request.**

The creating agent writes a file to `members/<new-agent-name>/`:

```
members/
  research-lead/
    member.json       # rank, type, config
    SOUL.md           # personality and instructions
    AGENTS.md         # rules
```

The `member.json` must include:

```json
{
  "id": "member_research_lead",
  "name": "Research Lead",
  "rank": "team_leader",
  "type": "agent",
  "status": "pending",
  "createdBy": "member_ceo",
  "agentConfig": {
    "model": "anthropic/claude-sonnet-4",
    "provider": "anthropic",
    "port": 0,
    "soulPath": "SOUL.md",
    "brainPath": "brain/"
  }
}
```

Status is `"pending"` -- the agent is declared but not yet running.

**Step 2: Daemon detects the new member directory.**

The daemon watches `members/` for new directories. When one appears:

1. Read `member.json`.
2. Validate rank permission: is `createdBy` allowed to create this rank?
3. If validation fails, write an error to the creator's DM channel and
   delete the directory.
4. If validation passes:
   a. Assign a port number.
   b. Write `openclaw.json` and `auth-profiles.json` to the agent's workspace.
   c. Spawn the OpenClaw process via execa.
   d. Update `member.json` with `status: "active"` and the assigned port.
   e. Create a DM channel between the new agent and its creator.
   f. Add the new agent to `#general` (broadcast).
   g. Add the new agent to its team channel (if `teamId` is set).
   h. Commit: `"hire: <name> (<rank>) by <creator>"`.

**Step 3: The new agent comes online.**

The daemon sends an initial message to the new agent's DM:

```
Welcome to <corp-name>. You are <name>, rank <rank>.
Your creator is <creator-name>.
Read your SOUL.md for your identity and responsibilities.
```

The agent reads its SOUL.md and AGENTS.md, then begins operating.

### Rank Validation Table

| Creator Rank | Can Create |
|-------------|------------|
| `founder` | `ceo`, `corp_level`, `project_manager`, `team_leader`, `worker` |
| `ceo` | `corp_level`, `project_manager`, `team_leader`, `worker` |
| `corp_level` | `project_manager`, `team_leader`, `worker` |
| `project_manager` | `team_leader`, `worker` |
| `team_leader` | `worker` |
| `worker` | (none) |

```typescript
// packages/shared/src/ranks.ts
const RANK_ORDER = ["founder", "ceo", "corp_level", "project_manager", "team_leader", "worker"];

export function canCreate(creatorRank: Rank, targetRank: Rank): boolean {
  const creatorIndex = RANK_ORDER.indexOf(creatorRank);
  const targetIndex = RANK_ORDER.indexOf(targetRank);
  // Creator must be strictly higher rank than target
  // Founder (0) can create CEO (1), CEO (1) can create corp_level (2), etc.
  return creatorIndex < targetIndex;
}
```

## 2. Agent-to-Agent @mention Chaining

When an agent posts a message containing `@AnotherAgent`, the daemon router
(from [[layer-3-messaging]]) dispatches to the mentioned agent. This creates
a chain:

```
User: @CEO please research competitors
  -> CEO: @ResearchLead analyze the top 5 competitors
    -> ResearchLead: @Analyst pull pricing data for competitor A
      -> Analyst: Here is the pricing data: [...]
    -> ResearchLead: Report complete. @CEO here are the results.
  -> CEO: @User here is the competitor report.
```

Each hop increments `depth`. The depth guard (max 5) prevents infinite loops.
The dedup guard prevents an agent from being woken twice for the same origin
message.

### Chain Tracking

Every message in a chain carries:

- `depth`: how many hops from the original user message.
- `originId`: the ID of the first message that started the chain.
- `parentId`: the ID of the message this is a direct response to.

The router uses these to enforce guards and to let the TUI render
chains as threaded conversations.

### Concurrent Dispatch

If a message mentions multiple agents, the daemon dispatches to all of them
concurrently (fan-out). Each dispatch is independent. Responses are written
to the channel as they arrive.

```typescript
const mentions = extractMentions(message.content, members);
const dispatches = mentions.map(memberId =>
  dispatch(memberId, message, channel)
);
await Promise.allSettled(dispatches);
```

## 3. Git Commit After Each Prompt Loop

Every time an agent completes a response cycle (receives a dispatch, processes
it, writes its output), the daemon commits all changes the agent made.

```typescript
async function afterAgentResponse(agent: AgentProcess, corpPath: string): Promise<void> {
  const git = corpGit(corpPath);
  const status = await git.status();

  if (status.files.length === 0) return;  // nothing changed

  await git.commitAll(
    `${agent.name}: ${summarizeChanges(status.files)}`
  );
}
```

Commit messages follow a convention:

- `CEO: create task "Research competitors"`
- `Research Lead: update task_abc123 status to in_progress`
- `CEO: hire Designer (worker)`
- `Analyst: add competitor-pricing.md to brain/`

The `summarizeChanges` function inspects which files were modified and
generates a human-readable description. If the changes are too complex
to summarize, it falls back to listing the modified files.

### Why This Matters

With git-after-every-action:
- `git log` is a complete audit trail of every decision every agent made.
- `git revert <sha>` undoes a bad decision.
- `git diff HEAD~5..HEAD` shows what happened in the last 5 actions.
- The Founder can review the corp's history like code review.

## 4. Git Janitor Agent

A special corp-level agent whose sole job is repository hygiene.

### Identity

```markdown
# SOUL.md -- Git Janitor

You are the Git Janitor. Your job is to keep the corporation's
repository clean and organized.

## Responsibilities

- Review recent commits for quality (clear messages, no junk files).
- Consolidate rapid-fire commits into meaningful squashes (with Founder approval).
- Flag suspicious changes (large file additions, deletions of identity files).
- Generate weekly repo health reports.
- Clean up orphaned files (empty directories, temp files).

## Rules

- NEVER rewrite history on your own. Propose squashes, wait for approval.
- NEVER delete identity files (SOUL.md, MEMORY.md, member.json).
- Report anomalies to #system or the CEO's DM.
```

### Heartbeat Behavior

On each heartbeat, the Git Janitor:

1. Runs `git log --since="last heartbeat"` to review recent commits.
2. Checks for orphaned files (task files with no matching member, empty dirs).
3. Checks repo size and flags if it is growing too fast.
4. Posts a summary to `#system` channel if anything notable was found.

## 5. Starter Pack

After the CEO finishes the onboarding interview ([[layer-2-ceo]]), it
bootstraps the corporation with a starter pack. This happens through the
normal agent creation mechanism -- the CEO writes files, the daemon spawns.

### Default Starter Pack

| Agent | Rank | Role |
|-------|------|------|
| HR Director | corp_level | Manages hiring, agent wellness, role definitions |
| Chief Adviser | corp_level | Strategic advice, second opinion, Founder counsel |
| Git Janitor | corp_level | Repo hygiene (see above) |
| First Project Leader | project_manager | Manages the first project identified in onboarding |

The CEO creates these sequentially, writing each agent's member directory
with appropriate SOUL.md files tailored to the corp's purpose.

### Bootstrap Sequence

1. CEO writes `members/hr-director/` with SOUL.md focused on hiring.
2. Daemon detects, validates (CEO can create corp_level), spawns.
3. CEO writes `members/chief-adviser/` with SOUL.md focused on strategy.
4. Daemon detects, validates, spawns.
5. CEO writes `members/git-janitor/` with the Janitor SOUL.md.
6. Daemon detects, validates, spawns.
7. CEO creates the first project directory in `projects/`.
8. CEO writes `members/<project-leader>/` with project-specific SOUL.md.
9. Daemon detects, validates, spawns, adds to project team channel.
10. CEO posts a summary to `#general`: "Corp is bootstrapped. Here is who we have."

This entire sequence happens autonomously. The Founder watches it unfold
in the `#general` channel and can intervene at any point.

## 6. Agents Write Freely to Filesystem

Agents have unrestricted write access to the corp directory. They can:

- Create files in `brain/` (knowledge graph entries, daily notes).
- Write reports as markdown files.
- Modify their own MEMORY.md with learned context.
- Create task files in `tasks/`.
- Create new channels in `channels/`.
- Create new members in `members/` (rank permitting).

The daemon commits everything. The Founder can review, revert, or
restrict via git.

### Workspace Boundaries

Each agent's OpenClaw process has its workspace set to the corp root.
This is intentional -- agents see the whole corp, not just their own
directory. Radical transparency applies to agents too.

The AGENTS.md file in each agent's directory can contain rules about
which directories the agent should focus on, but these are advisory,
not enforced by the filesystem.

## Deliverables Checklist

- [ ] Rank validation logic (`canCreate` function)
- [ ] `fs.watch` on `members/` for new agent directories
- [ ] Agent creation pipeline (validate -> assign port -> write config -> spawn -> channel -> commit)
- [ ] Rank validation error handling (error to creator DM, cleanup)
- [ ] Agent-to-agent @mention chaining (fan-out, depth tracking)
- [ ] `originId` and `parentId` propagation through chains
- [ ] Concurrent dispatch for multi-mention messages
- [ ] Git commit after every agent response
- [ ] `summarizeChanges` function for readable commit messages
- [ ] Git Janitor agent identity and SOUL.md
- [ ] Starter pack bootstrap sequence
- [ ] CEO auto-creates HR, Adviser, Janitor, first project leader
- [ ] Agent filesystem write detection and commit

## Key Decisions

- **Agents create agents by writing files.** No API, no daemon command for
  "hire." The agent writes a member directory. The daemon reacts. This keeps
  the interface uniform: everything is a file, everything goes through the
  filesystem.
- **Rank is enforced by the daemon, not by agents.** An agent might try to
  write a member with a rank it cannot create. The daemon catches this and
  rejects it. Agents are not trusted to self-police rank boundaries.
- **Git commit per action, not per session.** Fine-grained commits mean
  fine-grained revert. If the CEO makes a bad hire at 10:05, the Founder
  reverts that one commit without losing the good work from 10:04.
- **Corp root as workspace.** Agents see everything. This is a deliberate
  transparency choice. Agents that need to collaborate must be able to read
  each other's outputs.
