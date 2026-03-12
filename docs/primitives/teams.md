# Teams

The organizational primitive. Teams are folders inside a project, each containing a `team.json` manifest. They group [[members]] under a leader, scope [[tasks]] and [[channels]], and can nest arbitrarily deep.

```
~/.agentcorp/corp-name/projects/{project-name}/teams/{team-name}/team.json
```

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (ULID) | Unique identifier. |
| `name` | string | Human-readable team name. Used to derive the auto-created channel name (`#team-{name}`). |
| `description` | string | What this team does. Read by agents to understand scope and purpose. |
| `leaderMemberId` | string | [[members\|Member]] ID of the team leader. Must have rank `leader` or higher. |
| `parentId` | string or null | ID of the parent team for nested hierarchies. Null for top-level teams. |
| `status` | enum | `active`, `paused`, `dissolved`. |
| `memberIds` | string[] | List of member IDs on this team (including the leader). |
| `createdBy` | string | Member ID of whoever created the team. Usually the master. |
| `createdAt` | ISO 8601 | Timestamp of creation. |

## Filesystem Layout

```
projects/
  website/
    teams/
      design/
        team.json
        channels/
          team-design/
            messages.jsonl
      frontend/
        team.json
        channels/
          team-frontend/
            messages.jsonl
        teams/
          animations/          <-- nested sub-team
            team.json
            channels/
              team-animations/
                messages.jsonl
```

Each team is a self-contained folder. The folder name matches `team.json`'s `name` field (kebab-cased). Inside, the team gets its own `channels/` directory for team-scoped [[channels]] and optionally a nested `teams/` directory for sub-teams.

## Auto-Created Channel

When a team is created, a [[channels|channel]] is automatically registered:

- **Name**: `#team-{name}` (e.g., `#team-design`)
- **Kind**: `team`
- **memberIds**: Copied from the team's `memberIds`
- **path**: Points to the `channels/team-{name}/` directory inside the team folder

The master is always added to every team channel regardless of whether they are in `memberIds`. The master sees everything.

## Leadership

Each team has exactly one leader, referenced by `leaderMemberId`. The leader:

- Can assign and reprioritize [[tasks]] scoped to their team (`teamId` matches).
- Can add and remove workers from the team.
- Can create sub-teams beneath their team.
- Cannot override the master or owner on any decision.

Leadership is explicit, not elected. The master appoints leaders. The owner can override any appointment.

If a leader is archived or suspended, the master must appoint a replacement. A team without an active leader falls back to direct master oversight.

## Nested Teams

Teams nest via `parentId`. A sub-team's leader reports to the parent team's leader, forming a chain of command:

```
owner
  master
    design team leader
      animations sub-team leader
        animation workers
```

There is no hard depth limit, but in practice more than two or three levels deep signals over-organization. The master should flatten when complexity outweighs coordination benefit.

Nested teams inherit no permissions from their parent. Each team is self-contained. Cross-team coordination happens via `@mentions` in shared [[channels]] or broadcast channels.

## Lifecycle

### Creation

Teams are created by the master or owner. On creation:

1. Team folder is created at `projects/{project}/teams/{name}/`.
2. `team.json` is written with the initial manifest.
3. A `#team-{name}` [[channels|channel]] is auto-created and registered in `channels.json`.
4. All `memberIds` are added to the channel.
5. A `system` [[messages|message]] is posted: "{leader} now leads #{team-name}".

### Active Operation

Members work within the team scope. [[Tasks]] with matching `teamId` are the team's responsibility. The leader coordinates via the team channel and direct [[messages]].

### Pausing

Setting `status` to `paused` signals the team is temporarily inactive. Agents on a paused team deprioritize its tasks. The channel remains open but quiet.

### Dissolution

Setting `status` to `dissolved` ends the team. Members are not deleted — they remain in `members.json` and can be reassigned. The team channel is archived (removed from active views but files persist on disk). Tasks scoped to the team are reassigned to the project level or cancelled.

## Organic Formation

Teams are not rigid. The master creates and dissolves teams as the corporation's needs evolve. A project might start with a single flat roster and grow into multiple specialized teams as complexity increases. Or a team might dissolve once its purpose is fulfilled, its members redistributed.

This is the organizational model: structure emerges from work, not the other way around.

## Cross-Team Communication

There is no formal cross-team API. Agents on different teams communicate through:

- **@mentions** in shared broadcast [[channels]] (project-level `#general`).
- **Direct [[messages]]** between individual members.
- **The master**, who sits in every team channel and can relay, coordinate, or mediate.

The master's omnipresence across all team channels is by design. It is the connective tissue of the corporation.

## Related

- [[members]] — `leaderMemberId` and `memberIds` reference member IDs
- [[channels]] — Each team gets an auto-created team channel
- [[tasks]] — `teamId` scopes tasks to a team
- [[messages]] — Team channel messages follow standard JSONL format
