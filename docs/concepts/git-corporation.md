# Git Corporation

The entire corporation is a git repository. This is THE core architectural decision. Not a metaphor, not an analogy — the corp directory at `~/.agentcorp/corp-name/` is initialized with `git init` and every meaningful change produces a commit.

## Every Change Is a Commit

After each prompt loop (one cycle of an agent reading input, thinking, and producing output), the agent's changes are committed. A single heartbeat cycle that updates three task files and writes a channel message produces one commit. The commit message describes what the agent did.

```
commit a4f2e1c (HEAD -> main)
Author: ceo-aria <aria@agentcorp.local>
Date:   Wed Mar 12 09:30:00 2026

    Complete morning briefing, assign 3 tasks to backend team

commit 8b3d7f2
Author: rex <rex@agentcorp.local>
Date:   Wed Mar 12 09:15:00 2026

    Finish rate limiter implementation, update task status to completed
```

`git log` is the corporation's activity feed. `git log --author=rex` is Rex's work history. `git log -- projects/backend/tasks/` is the backend team's task timeline.

## Folder Tree Is the Hierarchy Tree

The directory structure maps directly to the organizational hierarchy from [[corporation-of-one]]:

```
~/.agentcorp/my-corp/
  members.json              # Corp member registry
  channels.json             # Channel definitions and membership
  agents/
    ceo-aria/               # CEO at corp root scope
      SOUL.md
      MEMORY.md
      HEARTBEAT.md
      brain/
  projects/
    backend/
      agents/
        pm-rex/             # Project Manager scoped to backend
          SOUL.md
          HEARTBEAT.md
          brain/
      teams/
        api/
          agents/
            worker-kai/     # Worker scoped to api team
              SOUL.md
              HEARTBEAT.md
              brain/
          tasks/
        database/
          agents/
            worker-nova/
          tasks/
      tasks/                # Project-level tasks
    mobile-app/
      agents/
      teams/
      tasks/
  channels/
    general.jsonl           # Broadcast channel
    backend.jsonl           # Team channel
    dm-aria-mark.jsonl      # Direct message channel
  logs/
```

Navigate the filesystem, navigate the corporation. They are the same operation.

## Git Janitor

Multiple agents writing to the same repository will produce conflicts. The Git Janitor is a corp-level agent (see [[starter-pack]]) whose sole job is conflict resolution.

### How It Works

1. Agents write files freely during their prompt loops — they do not coordinate locks
2. After each prompt loop, the agent's changes are staged and committed
3. If the commit fails due to a conflict (another agent committed to the same file), the Git Janitor is invoked
4. The Janitor reads both versions, understands the intent from channel context and task files, and produces a merge
5. The resolved merge is committed with the Janitor as author

The Janitor's resolution is itself a commit, auditable and revertible. If the Janitor makes a bad call, `git revert` fixes it.

### Why Not Locks?

File locks would serialize agent work and destroy parallelism. The git model lets agents work freely and catches conflicts after the fact. Most of the time, agents work on different files and there are no conflicts at all. When conflicts do occur, an intelligent agent resolves them better than a mechanical merge algorithm.

## Git Revert Undoes Bad Decisions

An agent made a bad decision? `git revert <commit>`. The change is undone, and the revert itself is a commit in the history. Nothing is lost — the bad decision and its reversal are both in the log.

This extends to organizational changes. If the CEO hired a bad agent, reverting the commit that added it to `members.json` effectively "fires" it. If a worker wrote incorrect data to a task file, revert.

## members.json and channels.json

Two files at the corp root define the organizational structure:

**members.json** — registry of every member (human and agent), their rank, scope, and agent folder path.

**channels.json** — registry of every channel, its type (broadcast, team, direct, system), and its member list.

Both files are git-tracked. Changes to organizational structure — hiring, firing, creating channels, adjusting membership — are all commits. `git log -- members.json` shows the complete hiring/firing history. `git log -- channels.json` shows every channel created or modified.

## Implications

### The Corp Is Portable

A git repo can be cloned, backed up, moved between machines. Your entire corporation, with its full history, fits in a `git clone`.

### The Corp Is Forkable

`git branch experiment` creates a parallel universe of your corporation. Try a different organizational structure. If it works, merge it back. If not, delete the branch.

### The Corp Is Auditable

Every action, by every agent, forever. No action is untracked. No change is invisible. See [[radical-transparency]].

### The Corp Is Reversible

Any commit can be reverted. Any sequence of commits can be reverted. The worst case scenario is always recoverable.

## Related

- [[corporation-of-one]] — the hierarchy that maps to the folder tree
- [[radical-transparency]] — git as the historical transparency layer
- [[starter-pack]] — the Git Janitor as a default corp-level agent
- [[brain-framework]] — brain changes are git-tracked knowledge growth
