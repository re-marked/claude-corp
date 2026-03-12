---
title: Agent-to-Agent Communication Flow
type: flow
status: draft
triggers: agent posts message with @mention of another agent
outputs: multi-agent conversation chain, visible in channel JSONL
related:
  - "[[flow-message]]"
  - "[[flow-heartbeat]]"
  - "[[flow-task]]"
  - "[[view-channel]]"
---

# Agent-to-Agent Communication Flow

Agents talk to each other using the exact same mechanism as user-to-agent communication. An agent writes a message to a channel JSONL with an @mention. The daemon detects it, dispatches to the mentioned agent, and the chain continues. There is no special inter-agent protocol. The filesystem is the shared bus. Every message is visible, greppable, and git-tracked.

## How It Starts

Agent A posts a message in a channel's `messages.jsonl` that includes an @mention of Agent B:

```json
{
  "id": "msg_a1b2c3",
  "sender": "lead-engineer",
  "timestamp": "2026-03-12T03:15:00.000Z",
  "content": "@research-bot I need competitive analysis on pricing models before I can finalize the architecture.",
  "mentions": ["research-bot"],
  "depth": 1,
  "origin_id": "msg_x9y8z7",
  "kind": "text"
}
```

This might happen because:
- Agent A was dispatched by a user message and needs help from Agent B
- Agent A woke on a [[flow-heartbeat]] and realized it needs input from Agent B
- Agent A is working on a [[flow-task]] that depends on Agent B's output

## The Chain

### Step 1 — Daemon Detects

The daemon's `fs.watch` picks up the new line in the JSONL file. It parses the message, sees `mentions: ["research-bot"]`, and resolves `research-bot` against `members.json` to find the agent's webhook port.

### Step 2 — Dispatch to Agent B

The daemon POSTs to Agent B's OpenClaw webhook:

```
POST http://localhost:18790/hooks/agent
Content-Type: application/json

{
  "channel": "projects/saas/channels/engineering/messages.jsonl",
  "message": { ...the triggering message... },
  "context": [ ...last 50 messages from the channel... ]
}
```

Agent B wakes, reads the context, and understands what Agent A is asking.

### Step 3 — Agent B Works and Responds

Agent B does its work (research, analysis, code, whatever its role demands). When done, it writes its response to the same JSONL file:

```json
{
  "id": "msg_d4e5f6",
  "sender": "research-bot",
  "timestamp": "2026-03-12T03:17:30.000Z",
  "content": "Completed the pricing analysis. Three tiers are standard in this market. @lead-engineer here is the summary: ...",
  "mentions": ["lead-engineer"],
  "depth": 2,
  "origin_id": "msg_x9y8z7",
  "kind": "text"
}
```

Note: `depth` incremented to 2. `origin_id` stays the same — it traces back to the original message that started the chain.

### Step 4 — Chain Continues

The daemon picks up Agent B's response, sees `@lead-engineer`, and dispatches back to Agent A. Agent A reads the research, incorporates it, and maybe @mentions Agent C:

```json
{
  "id": "msg_g7h8i9",
  "sender": "lead-engineer",
  "timestamp": "2026-03-12T03:19:00.000Z",
  "content": "Good analysis. @frontend-dev can you prototype the pricing page based on these three tiers?",
  "mentions": ["frontend-dev"],
  "depth": 3,
  "origin_id": "msg_x9y8z7",
  "kind": "text"
}
```

Now Agent C gets dispatched. The chain fans out.

### Step 5 — Termination

The chain stops when:

| Condition | What Happens |
|-----------|--------------|
| No @mentions in response | Chain ends naturally |
| Depth reaches 5 | Daemon refuses dispatch, logs warning |
| Dedup triggered | Agent already woken for this origin_id, skipped |
| Agent offline | Daemon logs failure, does not retry (agent picks up on next heartbeat) |

## Depth Tracking

```
depth 0: User says "@ceo please handle the pricing strategy"
depth 1: CEO says "@pm-saas break this into tasks"
depth 2: PM says "@research-bot analyze competitor pricing"
depth 3: Research Bot says "@pm-saas here are findings"
depth 4: PM says "@lead-engineer implement tier structure"
depth 5: BLOCKED — daemon does not dispatch further
```

Depth 5 is a hard ceiling. If the work requires more hops, agents must use the [[flow-task]] system to create explicit tasks, which get picked up on heartbeats (resetting the depth counter).

## Multi-Agent Fan-Out

A single message can @mention multiple agents:

```json
{
  "content": "@research-bot analyze pricing, @frontend-dev mock up the page, @copywriter draft tier descriptions",
  "mentions": ["research-bot", "frontend-dev", "copywriter"]
}
```

The daemon dispatches to all three in parallel. Each agent works independently and posts results back to the channel. This is how a team leader coordinates parallel work streams.

## Overnight Work Pattern

This flow is what makes overnight autonomous work possible:

1. User assigns a task to the PM before bed.
2. PM wakes on heartbeat, breaks task into sub-tasks, @mentions team members.
3. Team members wake (dispatch or heartbeat), do their work, @mention back with results.
4. PM synthesizes results, @mentions the CEO with a summary.
5. CEO reviews, posts morning briefing for the user.

All of this happens in channel JSONL files. The user wakes up, opens the TUI, and reads the full conversation. Every decision, every handoff, every result — all visible.

## Observability

Because every message is a line in a JSONL file on disk, the user has direct access:

```bash
# Watch a channel in real time
tail -f ~/.agentcorp/acme/projects/saas/channels/engineering/messages.jsonl

# Find all messages from a specific agent
grep '"sender":"research-bot"' ~/.agentcorp/acme/projects/saas/channels/engineering/messages.jsonl

# Count agent-to-agent messages in last 24 hours
# (filter by timestamp, exclude user messages)

# See the full chain from a single origin
grep '"origin_id":"msg_x9y8z7"' ~/.agentcorp/acme/projects/saas/channels/engineering/messages.jsonl
```

The TUI provides a nicer view through the [[view-channel]], but the raw files are always accessible. This is radical transparency — nothing is hidden, nothing requires a special tool to inspect.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Agent process crashed | Daemon logs dispatch failure. Message stays in JSONL. Agent picks up context on next heartbeat or restart. |
| Agent returns error | Daemon writes a system message to the channel noting the failure. |
| Webhook timeout (30s) | Daemon marks dispatch as failed. No retry — the heartbeat cycle will catch it. |
| Malformed JSONL line | Daemon skips the line, logs warning. Does not break the watch loop. |

The heartbeat acts as a safety net. Even if a dispatch fails, the agent will eventually wake up, read the channel, and see the @mention it missed.
