# Channels

Communication primitive. Every conversation in the corporation happens in a channel. Channels are registered in `channels.json` at the corp root and backed by physical folders on the filesystem.

```
~/.agentcorp/corp-name/channels.json   (registry)
~/.agentcorp/corp-name/{scope-path}/channels/{channel-name}/messages.jsonl   (content)
```

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (ULID) | Unique identifier. |
| `name` | string | Human-readable channel name. Prefixed with `#` in the TUI. Example: `general`, `team-frontend`. |
| `kind` | enum | Channel type: `broadcast`, `team`, `direct`, `system`. See [[#Kinds]]. |
| `scope` | enum | Where this channel lives: `corp`, `project`, or `team`. |
| `scopeId` | string | ID of the scope target. |
| `teamId` | string or null | For `team` kind channels, the [[teams]] ID. Null otherwise. |
| `memberIds` | string[] | List of [[members]] IDs with access to this channel. |
| `createdBy` | string | Member ID of the creator. |
| `path` | string | Relative filesystem path from corp root to the channel folder. Example: `projects/website/channels/general/`. |
| `createdAt` | ISO 8601 | Timestamp of creation. |

## Kinds

### broadcast

Visible to all [[members]] within the scope. Every corp has a `#general` broadcast channel created at init time. Every project gets one on creation.

- All members in scope are auto-added to `memberIds`.
- New members joining the scope are auto-added.
- Used for announcements, cross-cutting discussion, and coordination.

### team

Scoped to a [[teams|team]]. Created automatically when a team is created — the channel name mirrors the team name (`#team-{name}`).

- `memberIds` matches the team roster.
- The team leader and all team workers are included.
- The master is always included in every team channel.

### direct

Private conversation between exactly two [[members]]. Created on first DM.

- `memberIds` contains exactly two entries.
- `name` is derived from the two participant names (sorted alphabetically).
- The daemon auto-creates DM channels when a message targets a member not yet in a shared direct channel.

### system

Internal channels for infrastructure events. Not visible in the default TUI view unless debug mode is on.

- `#heartbeat` — Heartbeat cycle logs and wake confirmations.
- `#tasks` — [[tasks]] lifecycle events (created, assigned, completed, failed).
- `#errors` — Agent crashes, spawn failures, timeout events.

## Filesystem Layout

Channels are not just database entries — they are folders. The `path` field points to a real directory:

```
corp-root/
  channels/
    general/
      messages.jsonl
  projects/
    website/
      channels/
        general/
          messages.jsonl
        design-review/
          messages.jsonl
      teams/
        frontend/
          channels/
            team-frontend/
              messages.jsonl
```

Each channel folder contains a `messages.jsonl` file — the append-only log of all [[messages]] in that channel. The folder may also contain files shared within the channel (attachments, artifacts, outputs).

## Auto-Creation

Channels are created automatically at key lifecycle moments:

| Event | Channels created |
|-------|-----------------|
| `agentcorp init` | `#general` (corp broadcast), `#heartbeat` (system), `#tasks` (system), `#errors` (system) |
| Project created | `#general` (project broadcast) |
| [[teams\|Team]] created | `#team-{name}` (team channel) |
| First DM between two [[members]] | Direct channel for the pair |

The master can also create channels manually. Workers cannot create channels unless delegated by their leader.

## Routing

The daemon process watches `channels.json` for structural changes and watches each `messages.jsonl` via `fs.watch` for new [[messages]]. When a message arrives:

1. The daemon reads the last line of the JSONL file.
2. It resolves `@mentions` against `members.json`.
3. If a mentioned member is an agent, the daemon forwards the message to that agent's local port.
4. If the channel is a broadcast and no specific mention exists, all active agents in `memberIds` may respond based on their own judgment.

See [[messages]] for the wire format and write semantics.

## Related

- [[members]] — `memberIds` references member IDs from `members.json`
- [[messages]] — The content inside each channel, stored as JSONL
- [[teams]] — Team channels are auto-created from team definitions
- [[tasks]] — Task events are posted to the `#tasks` system channel
