# Crisis Channels

Temporary high-priority rooms for urgent situations. When something breaks,
the org spins up a war room, pulls in the right agents, resolves the issue,
and archives the channel.

## The Idea

Normal channels are persistent. Crisis channels are ephemeral. They exist for
the duration of an incident and are archived when the crisis is resolved.
During a crisis, dispatched agents get elevated priority: faster heartbeats,
shorter cooldowns, and their responses skip the normal queue.

## Triggering a Crisis

### Manual (Founder or CEO)

```
agentcorp crisis "Payment pipeline is down"
```

Or from the TUI: `Ctrl+!` opens the crisis creation dialog.

### Automated (Daemon Detection)

The daemon can detect crisis-worthy situations:
- A critical-priority task has been `failed` twice.
- Multiple agents report errors in the same 5-minute window.
- A heartbeat check finds > 50% of agents unresponsive.
- A webhook receiver reports an external service outage.

When detected, the daemon proposes a crisis to the CEO. The CEO can
confirm or dismiss.

## Crisis Channel Structure

```
channels/
  crisis-20260315-payment-down/
    channel.json
    messages.jsonl
```

`channel.json`:

```json
{
  "id": "channel_crisis_001",
  "name": "crisis-20260315-payment-down",
  "kind": "crisis",
  "status": "active",
  "severity": "critical",
  "createdAt": "2026-03-15T14:30:00Z",
  "summary": "Payment pipeline is down. All transactions failing.",
  "memberIds": ["member_user", "member_ceo", "member_backend_lead", "member_devops"],
  "resolvedAt": null
}
```

## Crisis Behavior

### Elevated Dispatch Priority

Agents in a crisis channel get:
- Heartbeat frequency drops to 2 minutes (from 10).
- Cooldown guard disabled (agent can be dispatched back-to-back).
- Depth guard increased to 10 (allow deeper chains for debugging).

### Auto-Pull Relevant Agents

When a crisis is created, the daemon analyzes the crisis description and
pulls in agents most likely to help:
- Agents assigned to related tasks.
- Agents who recently worked in related channels.
- The Git Janitor (for any repo-related issues).
- The CEO (always).

### Focused Context

Agents dispatched in a crisis channel receive a special context header:

```
CRISIS: Payment pipeline is down.
Severity: CRITICAL
Duration: 45 minutes
Focus: Diagnose and fix. All other tasks are deprioritized.
```

This overrides their normal HEARTBEAT.md priorities.

### Status Updates

Every 10 minutes during an active crisis, the daemon requests a status
update from the lead agent in the channel:

```
CRISIS STATUS REQUEST: What is the current state?
Options: investigating, identified, fixing, monitoring, resolved
```

The response is posted to the channel and to the Founder's external
notification channel (if configured via [[layer-7-externals]]).

## Resolution

When the crisis is resolved:

1. An agent or the Founder posts a resolution message.
2. The daemon sets `resolvedAt` in `channel.json`.
3. All elevated dispatch settings revert to normal.
4. The CEO generates a post-mortem summary from the channel's message history.
5. The post-mortem is posted to `#general` and saved as a brain entry.
6. The crisis channel is archived (remains readable, no new messages).

## Crisis Board

A TUI view showing active and recent crises:

```
+-------------------------------------------------------------+
|  Crises                                       [Esc] back    |
+-------------------------------------------------------------+
|                                                              |
|  ACTIVE                                                     |
|  ! CRITICAL  Payment pipeline down    45 min   3 members    |
|                                                              |
|  RESOLVED (last 7 days)                                     |
|  * HIGH      Deploy failure           2h ago   resolved     |
|  * MEDIUM    API rate limiting        1d ago   resolved      |
|                                                              |
+-------------------------------------------------------------+
|  [Enter] open  [n]ew crisis  [Esc] back                    |
+-------------------------------------------------------------+
```

## Relationship to Other Features

- [[agent-elo]]: Crisis performance is a high-weight reputation event. Agents
  that perform well in crises get significant reputation boosts.
- [[layer-4-tasks]]: Crisis resolution may generate follow-up tasks
  (prevent recurrence, improve monitoring).
- [[layer-7-externals]]: Active crises always send notifications to the
  Founder's external platform, regardless of quiet hours.

## Open Questions

- Should there be a severity escalation ladder (medium -> high -> critical)
  if the crisis is not resolving?
- How many simultaneous crises can the corp handle before agent attention
  is too fragmented? Should there be a limit?
- Should crisis channels have a time limit (auto-escalate to Founder if
  unresolved after N hours)?
