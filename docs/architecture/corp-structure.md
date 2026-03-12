# Corp Structure

This document is the full directory tree reference for AgentCorp. Every file and folder is explained. See [[file-system]] for format details and [[agent-runtime]] for workspace contents.

## Global (Outside Any Corp)

```
~/.agentcorp/
  global-config.json       # API keys, daemon settings, defaults
  .daemon.pid              # PID of running daemon process
  .daemon.port             # Port the daemon API is listening on
  .daemon.log              # Daemon operational log
  corps/                   # Registry of known corps (paths)
    index.json             # List of corp names and their paths
```

`global-config.json` is the only place API keys are stored. The [[daemon]] reads keys from here and injects them into agent workspaces at spawn time. This file is never committed to any git repo.

The `corps/index.json` file maps corp names to filesystem paths, allowing the [[tui]] to list and switch between multiple corporations.

## Corp Root (Git Repo)

Each corporation lives in its own directory, which is a git repository. The default location is `~/.agentcorp/<corp-name>/`, but corps can live anywhere on disk.

```
~/.agentcorp/my-corp/              # Git repo root
  .git/                            # Git internals
  .gitignore                       # Excludes auth-profiles.json, .DS_Store, etc.
  corp.json                        # Corporation metadata
  members.json                     # Corp-wide member registry
  channels.json                    # Corp-wide channel registry
  agents/                          # Corp-scoped agents
  channels/                        # Corp-scoped channels
  projects/                        # Projects within the corp
```

### corp.json

Corporation identity and top-level configuration.

```json
{
  "name": "my-corp",
  "display_name": "My Corporation",
  "created": "2026-03-12T10:00:00Z",
  "owner": "user",
  "ceo": "atlas",
  "description": "A personal corporation for software development"
}
```

### members.json

The definitive registry of all members (human and agent) at the corp level. Each entry contains:

```json
[
  {
    "id": "user",
    "name": "Mark",
    "type": "user",
    "rank": "owner",
    "status": "active",
    "port": null,
    "scope": "corp",
    "created": "2026-03-12T10:00:00Z"
  },
  {
    "id": "atlas-uuid",
    "name": "atlas",
    "type": "agent",
    "rank": "master",
    "status": "running",
    "port": 18800,
    "scope": "corp",
    "created": "2026-03-12T10:00:01Z"
  }
]
```

This file is the source of truth for who is in the corp, their rank, and their process status. The [[daemon]] is the sole writer. The [[router]] and [[tui]] read from it.

Project-level `members.json` files exist as well, listing members scoped to that project. An agent can appear in both the corp-level and a project-level registry (corp-level tracks existence, project-level tracks project membership).

### channels.json

Registry of all channels at the corp level.

```json
[
  {
    "id": "ch-general",
    "name": "general",
    "kind": "broadcast",
    "scope": "corp",
    "members": ["user", "atlas-uuid"],
    "created": "2026-03-12T10:00:00Z"
  },
  {
    "id": "ch-dm-user-atlas",
    "name": "dm-user-atlas",
    "kind": "direct",
    "scope": "corp",
    "members": ["user", "atlas-uuid"],
    "created": "2026-03-12T10:00:01Z"
  }
]
```

Channel kinds:
- `broadcast` -- visible to all members at that scope
- `team` -- scoped to a specific team
- `direct` -- exactly two members, DM auto-routing applies (see [[router]])
- `system` -- internal corp operations, daemon announcements, error reports

## Corp-Scoped Agents

```
agents/
  atlas/                           # CEO / co-founder agent
    config.json                    # Agent configuration
    openclaw.json                  # OpenClaw runtime config
    auth-profiles.json             # API keys (gitignored, injected by daemon)
    SOUL.md                        # Personality and identity
    AGENTS.md                      # Operating rules
    MEMORY.md                      # Accumulated knowledge
    HEARTBEAT.md                   # Autonomous schedule
    skills/                        # Skill definitions
      workspace-tools/
        read-file.md
        write-file.md
        send-message.md
        manage-tasks.md
    brain/                         # Knowledge graph (Markdown + wikilinks)
      decisions/
      context/
```

Agents at the corp root level are corp-wide — they operate across all projects. The CEO agent (`rank: master`) always lives here. See [[agent-runtime]] for workspace file details and [[agent-lifecycle]] for how these files are created and managed.

## Corp-Scoped Channels

```
channels/
  general/
    messages.jsonl                 # Append-only message log
  system/
    messages.jsonl
  dm-user-atlas/
    messages.jsonl
```

Each channel is a directory containing a `messages.jsonl` file. The directory structure allows for future additions (pinned messages, attachments, metadata) without changing the message format. See [[file-system]] for the JSONL message format.

## Projects

```
projects/
  website-redesign/
    project.json                   # Project metadata
    members.json                   # Project-scoped member registry
    channels.json                  # Project-scoped channel registry
    agents/                        # Project-scoped agents
    channels/                      # Project-scoped channels
    teams/                         # Teams within this project
    tasks/                         # Project-level tasks
```

### project.json

```json
{
  "id": "proj-website",
  "name": "website-redesign",
  "display_name": "Website Redesign",
  "description": "Complete redesign of the marketing website",
  "created": "2026-03-12T10:00:00Z",
  "lead": "atlas"
}
```

### Project-Scoped Agents

```
projects/website-redesign/agents/
  luna/
    config.json
    openclaw.json
    auth-profiles.json
    SOUL.md
    AGENTS.md
    MEMORY.md
    HEARTBEAT.md
    skills/
    brain/
```

Identical structure to corp-scoped agents, but these agents exist within the context of a specific project. Their `config.json` has `"scope": "project"` and `"project": "website-redesign"`.

### Project-Scoped Channels

```
projects/website-redesign/channels/
  announcements/
    messages.jsonl
  design-review/
    messages.jsonl
  dm-luna-kai/
    messages.jsonl
```

Same structure as corp-level channels, but scoped to the project. Registered in the project's `channels.json`.

## Teams

```
projects/website-redesign/teams/
  design/
    team.json                      # Team metadata
    members.json                   # Team member registry (subset of project members)
    channels.json                  # Team-scoped channel registry
    agents/                        # Team-scoped agents (if any)
    channels/                      # Team-scoped channels
      design-standup/
        messages.jsonl
    tasks/                         # Team-level tasks
      task-001.md
      task-002.md
  engineering/
    team.json
    members.json
    channels.json
    agents/
    channels/
    tasks/
```

### team.json

```json
{
  "id": "team-design",
  "name": "design",
  "display_name": "Design Team",
  "project": "website-redesign",
  "leader": "luna",
  "created": "2026-03-12T10:00:00Z"
}
```

### Team Tasks

Tasks are Markdown+YAML files inside the team's `tasks/` directory:

```
tasks/
  task-001.md                      # Individual task file
  task-002.md
```

Each task file follows the format described in [[file-system]]. Tasks can also exist at the project level (in `projects/<name>/tasks/`) for cross-team work.

## Full Tree (Collapsed)

```
~/.agentcorp/
  global-config.json
  .daemon.pid
  .daemon.port
  .daemon.log
  corps/
    index.json
  my-corp/                                    # <-- git repo
    .git/
    .gitignore
    corp.json
    members.json
    channels.json
    agents/
      atlas/
        config.json
        openclaw.json
        auth-profiles.json                    # gitignored
        SOUL.md
        AGENTS.md
        MEMORY.md
        HEARTBEAT.md
        skills/
        brain/
    channels/
      general/
        messages.jsonl
      system/
        messages.jsonl
      dm-user-atlas/
        messages.jsonl
    projects/
      website-redesign/
        project.json
        members.json
        channels.json
        agents/
          luna/
            config.json
            openclaw.json
            auth-profiles.json                # gitignored
            SOUL.md
            AGENTS.md
            MEMORY.md
            HEARTBEAT.md
            skills/
            brain/
          kai/
            ...
        channels/
          announcements/
            messages.jsonl
          design-review/
            messages.jsonl
          dm-luna-kai/
            messages.jsonl
        teams/
          design/
            team.json
            members.json
            channels.json
            agents/
            channels/
              design-standup/
                messages.jsonl
            tasks/
              task-001.md
              task-002.md
          engineering/
            team.json
            members.json
            channels.json
            agents/
            channels/
              eng-standup/
                messages.jsonl
            tasks/
              task-003.md
        tasks/
          task-004.md                         # Cross-team project task
```

## Design Principles

**Agents live at their highest relevant scope.** A corp-wide CEO agent lives at `agents/atlas/`, not nested under a project. A project designer lives at `projects/website-redesign/agents/luna/`. An agent is never duplicated across scopes — it exists in one place.

**Registries live at their scope root.** `members.json` and `channels.json` appear at the corp level, at each project level, and at each team level. Each registry is authoritative for its scope. The corp-level registry is the superset.

**Everything is git-tracked.** The only exceptions are `auth-profiles.json` (API keys, gitignored) and daemon operational files (PID, port, log — outside the corp). Every other file — messages, tasks, agent configs, personality files — is committed and versioned.

**Channels are directories, not just files.** Even though a channel currently contains only `messages.jsonl`, the directory structure allows future extension (pinned messages, attachments, metadata files) without restructuring.

**Tasks are individual files, not a single list.** Each task is its own Markdown file with YAML frontmatter. This means tasks can be created, modified, and committed independently. Git blame shows who changed what. Merge conflicts are per-task, not per-list.
