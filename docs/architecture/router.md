# Router

The router is the message dispatch system inside the [[daemon]]. It watches channel message files for new content and delivers messages to the appropriate agents via webhook. It is the mechanism by which agents talk to each other and respond to the user.

## Pipeline

Every message flows through the same pipeline:

```
fs.watch detects JSONL append
        |
        v
Read new line(s) from channel file
        |
        v
Parse JSONL line into Message object
        |
        v
Guard checks (depth, dedup, cooldown)
        |
        v
Extract @mentions from content
        |
        v
Resolve mentions via members.json
        |
        v
POST to agent webhook(s)
   localhost:PORT/hooks/agent
```

### Step 1: File Watching

The router uses `fs.watch` to monitor every `messages.jsonl` file across all channels in the corp. The watch is recursive from the corp root — when new channels are created, their message files are automatically picked up.

When `fs.watch` fires, the router reads the file from its last-known offset to the end, extracting only the new lines. It tracks byte offsets per file to avoid re-processing old messages.

### Step 2: Parse

Each JSONL line is parsed into a `Message` object from [[stack|shared types]]:

```typescript
interface Message {
  id: string;
  channel_id: string;
  sender_id: string;
  content: string;
  mentions: string[];
  depth: number;
  origin_id: string;
  timestamp: string;
}
```

The `origin_id` tracks the original message that started a conversation chain. The `depth` counts how many agent-to-agent hops have occurred since the origin.

### Step 3: Guards

Three guards protect against runaway conversations:

**Depth guard (max 5):**
Every message carries a `depth` counter. When an agent responds to a message, the response has `depth + 1`. If depth reaches 5, the router drops the message and logs a warning. This prevents infinite agent-to-agent loops.

**Dedup guard:**
The router maintains a sliding window of recent message IDs (last 1000). If a message ID has already been processed, it is skipped. This handles `fs.watch` double-fire edge cases.

**Cooldown guard:**
Per-agent cooldown of 2 seconds. If agent A was dispatched to less than 2 seconds ago, the message is queued and delivered after the cooldown expires. This prevents agents from overwhelming each other in rapid-fire exchanges.

### Step 4: Mention Extraction

The router scans message content for `@mentions`. Mentions use the format `@agent-name` (matching the `name` field in `members.json`). Extraction is case-insensitive and handles common punctuation boundaries.

### Step 5: Mention Resolution

Each extracted mention is resolved against the corp's `members.json` (and project-level `members.json` if the channel is scoped to a project). Resolution yields:

- The agent's ID
- The agent's current status (running, suspended, archived)
- The agent's webhook port (from the [[daemon]]'s process table)

If a mentioned agent is not running, the router logs a warning and skips delivery to that agent. It does not auto-start agents — that is a policy decision for the user or the CEO agent.

### Step 6: Webhook Dispatch

The router sends an HTTP POST to the agent's OpenClaw webhook endpoint:

```
POST http://localhost:{port}/hooks/agent
Content-Type: application/json

{
  "channel_id": "...",
  "message": { ... },
  "context": {
    "channel_name": "...",
    "sender_name": "...",
    "recent_messages": [ ... ]
  }
}
```

The `context` field includes the last N messages from the channel (default: 20) to give the agent conversational context. The agent's response is written back to the same channel's `messages.jsonl` by OpenClaw's workspace tools, which triggers the router again if the response contains @mentions.

## Two Routing Modes

### DM Auto-Routing

In a direct message channel (a channel with exactly two members), every message is automatically routed to the other member. No @mention is required. The router detects DM channels by checking `channels.json` — if a channel's `kind` is `"direct"`, all messages from one member are dispatched to the other.

This means the user can type freely in a DM channel without prefixing every message with `@agent-name`.

### @Mention Routing

In broadcast, team, and system channels (any channel with more than two members), the router only dispatches to explicitly @mentioned agents. This prevents every message from waking every agent in a busy channel.

If a message has no @mentions and is not in a DM channel, no dispatch occurs. The message is still persisted in the JSONL log — agents can read it during their next [[agent-lifecycle|heartbeat]] — but no webhook fires.

## Fan-Out and Chain Patterns

**Fan-out:** A single message can @mention multiple agents. The router dispatches to each mentioned agent independently. All dispatches happen in parallel (non-blocking). Example: `@designer @developer Let's discuss the new landing page` wakes both agents simultaneously.

**Chain:** Agent A's response mentions Agent B, whose response mentions Agent C. Each hop increments the depth counter. The chain terminates naturally when no response contains a mention, or forcibly at depth 5.

**Fan-out + chain:** These compose naturally. A fan-out at depth 2 can produce multiple chains, each tracking depth independently from the shared origin.

## Error Handling

- **Agent unreachable** (webhook POST fails): The router retries once after 3 seconds. If the retry fails, it logs the failure and moves on. Messages are not re-queued — they remain in the JSONL file and the agent can read them on its next heartbeat.
- **Malformed JSONL line**: Logged and skipped. The router advances its offset past the bad line.
- **fs.watch failure**: If watching a file fails, the router falls back to polling that specific file at 500ms intervals. See [[daemon]] for system-wide `fs.watch` limits.

## State

The router holds minimal in-memory state:

- File byte offsets (per channel message file)
- Recent message ID window (for dedup)
- Per-agent last-dispatch timestamps (for cooldown)

All of this is ephemeral. If the daemon restarts, offsets reset to end-of-file (the router only processes new messages, not history), and dedup/cooldown windows start fresh.
