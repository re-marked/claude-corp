# Layer 3 -- Messaging

Layer 2 proved one user can talk to one agent. Layer 3 makes the entire
corporation a connected messaging system. The daemon becomes a router.
Channels become first-class. @mentions wake agents.

## Goals

- Build the daemon router: watch JSONL files, extract @mentions, dispatch.
- Support multiple channels with switching (Ctrl+K fuzzy finder).
- Add the member sidebar to the TUI.
- Implement DM auto-routing and message guards (depth, dedup, cooldown).
- Deliver webhook dispatch to OpenClaw `/hooks/agent`.

---

## 1. Daemon Router

The router is the central nervous system. It watches every `messages.jsonl`
in the corp, reacts to new messages, and dispatches to the right agents.

```typescript
// packages/daemon/src/router.ts
export class MessageRouter {
  private watchers: Map<string, fs.FSWatcher>;
  private agents: Map<string, AgentProcess>;

  watch(corpPath: string): void;     // start watching all channels
  stop(): void;                       // close all watchers

  private onNewMessage(channelId: string, message: ChannelMessage): void;
  private dispatch(targetMemberId: string, message: ChannelMessage, channel: Channel): void;
}
```

### Watch Mechanism

The router uses `fs.watch` on every `messages.jsonl` file in the corp's
`channels/` directory. When a file changes:

1. Read the last line(s) added since the last known offset.
2. Parse as `ChannelMessage`.
3. Check if the message's `from` field is a user or an agent.
4. Extract @mentions from the content.
5. For each mentioned agent, call `dispatch()`.
6. For DM channels, auto-dispatch to the other party (no @mention needed).

### fs.watch Caveats

`fs.watch` can fire multiple times for a single write. The router tracks
the byte offset of each file and only processes genuinely new content.
Use `fs.statSync` to compare file size before and after notification.

```typescript
// Track file positions to avoid re-reading
private filePositions: Map<string, number>;  // channelId -> byte offset
```

## 2. @mention Extraction

Mentions follow the pattern `@Name` or `@"Multi Word Name"`.

```typescript
// packages/shared/src/mentions.ts
export function extractMentions(content: string, members: Member[]): string[];
```

The function:
1. Finds all `@` tokens in the message.
2. Tries to match against known member names (case-insensitive).
3. Returns an array of member IDs.
4. Handles both `@CEO` and `@"Research Lead"` forms.

The router calls this on every new message and stores the resolved IDs
in the message's `mentions` array before writing to JSONL.

## 3. Webhook Dispatch to OpenClaw

When the router decides an agent should receive a message, it sends an
HTTP POST to the agent's gateway.

```typescript
// packages/daemon/src/dispatch.ts
export async function dispatchToAgent(
  agent: AgentProcess,
  message: ChannelMessage,
  channel: Channel,
  context: DispatchContext
): Promise<string>;  // returns agent's response text

interface DispatchContext {
  recentMessages: ChannelMessage[];   // last N messages for context
  channelMembers: Member[];
  senderName: string;
}
```

The HTTP call:

```
POST http://127.0.0.1:<port>/hooks/agent
Content-Type: application/json

{
  "channel": { "id": "...", "name": "..." },
  "message": { "from": "...", "content": "..." },
  "context": [ ... recent messages ... ]
}
```

The daemon collects the response (streamed or buffered) and writes it as a
new JSONL line in the channel's `messages.jsonl`. This may trigger further
dispatches if the agent's response contains @mentions -- this is the
agent-to-agent chain that [[layer-5-autonomy]] formalizes.

## 4. Message Guards

Three guards prevent runaway agent-to-agent loops:

### Depth Guard

Every message carries a `depth` counter. User messages start at depth 0.
When an agent responds to a message, the response inherits `depth + 1`.
When depth reaches the max (default: 5), the router stops dispatching.

```typescript
const MAX_DEPTH = 5;

function shouldDispatch(message: ChannelMessage): boolean {
  return message.depth < MAX_DEPTH;
}
```

### Dedup Guard

An agent should only be woken once per originating message. The `originId`
field tracks the root message that started the chain. The router keeps a
set of `(originId, memberId)` pairs and skips duplicates.

```typescript
private dispatchedPairs: Set<string>;  // "originId:memberId"
```

The set is cleared periodically (every 5 minutes) to avoid unbounded growth.

### Cooldown Guard

If an agent is already processing a message (its `AgentProcess.status` is
`"busy"`), skip the dispatch. The agent will catch up on the next heartbeat
or when it becomes idle.

```typescript
function isAvailable(agent: AgentProcess): boolean {
  return agent.status === "ready";
}
```

## 5. DM Auto-Routing

In a direct message channel, no @mention is needed. The router automatically
dispatches to the other party:

```typescript
function getDmRecipient(channel: Channel, senderId: string): string | null {
  if (channel.kind !== "direct") return null;
  return channel.memberIds.find(id => id !== senderId) ?? null;
}
```

When the user sends a message in `ceo-dm`, the router dispatches to the CEO
without requiring `@CEO` in the message.

## 6. Channel Switching (Ctrl+K)

The TUI needs to move between channels. Ctrl+K opens a fuzzy finder overlay.

```
+-----------------------------------------+
|  Switch Channel              Ctrl+K     |
+-----------------------------------------+
|  > gen                                  |
|                                          |
|  # general          broadcast           |
|  # ceo-dm           direct              |
|  # genesis-project  team                |
|                                          |
+-----------------------------------------+
```

Ink component:

```typescript
// packages/tui/src/views/channel-switcher.tsx
function ChannelSwitcher(props: {
  channels: Channel[];
  onSelect: (channelId: string) => void;
  onClose: () => void;
}): ReactElement;
```

Fuzzy matching on channel name. Keyboard navigation (up/down arrows, Enter
to select, Escape to close). The switcher reads channel list from
`channels/*/channel.json` on the filesystem.

## 7. Member Sidebar

Each channel view now shows a sidebar listing members and their status.

```
+-------------------------------+---------+
|  # general                    | Members |
+-------------------------------+---------+
|                                | * You   |
|  CEO  10:00                   | * CEO   |
|  Morning update: three tasks  |   idle  |
|  completed overnight.         |         |
|                                | * Res.  |
|  @ResearchLead please check   |   Lead  |
|  the competitor report.       |   busy  |
|                                |         |
+-------------------------------+---------+
|  > [input field]         Send |         |
+-------------------------------+---------+
```

```typescript
// packages/tui/src/components/member-sidebar.tsx
function MemberSidebar(props: { members: Member[] }): ReactElement;
```

The sidebar reads member status from the daemon. Status is derived from
the agent process state: `ready` -> "idle", dispatching -> "busy",
`stopped` -> "offline".

## 8. Multiple Channels

The corp starts with two channels (from [[layer-2-ceo]]):

- `#general` -- broadcast, all members
- `#ceo-dm` -- direct, user + CEO

As the CEO hires agents (layer 5), new channels appear:
- DM channels for each agent
- Team channels when teams are created
- Project channels

The router watches the entire `channels/` directory tree. When a new
channel directory appears (detected via `fs.watch` on the parent), the
router starts watching its `messages.jsonl` too.

```typescript
// Watch for new channel directories
fs.watch(path.join(corpPath, "channels"), { recursive: false }, (event, filename) => {
  if (event === "rename" && filename) {
    this.watchChannel(filename);
  }
});
```

## Deliverables Checklist

- [ ] `MessageRouter` class with `fs.watch` on all channel JSONL files
- [ ] Byte-offset tracking to avoid duplicate processing
- [ ] `extractMentions()` function (single word and quoted multi-word)
- [ ] `dispatchToAgent()` HTTP POST to OpenClaw `/hooks/agent`
- [ ] Depth guard (max 5)
- [ ] Dedup guard (origin tracking)
- [ ] Cooldown guard (skip busy agents)
- [ ] DM auto-routing (no @mention needed in direct channels)
- [ ] Channel switcher (Ctrl+K fuzzy finder)
- [ ] Member sidebar in chat view
- [ ] Dynamic channel directory watching (detect new channels)
- [ ] Agent status tracking (idle, busy, offline)

## Key Decisions

- **fs.watch, not polling.** The daemon reacts to filesystem changes in near
  real-time. No polling interval, no wasted cycles. The filesystem is the
  event bus.
- **Guards in the daemon, not in agents.** Depth, dedup, and cooldown are
  enforced by the router before dispatch. Agents do not need to implement
  loop prevention -- they just respond to messages.
- **No streaming in this layer.** Agent responses are buffered and written as
  complete messages. Streaming display (character-by-character rendering in the
  TUI) is a polish item for later. The architecture supports it -- the daemon
  could write partial lines and the TUI could render them -- but it is not a
  layer 3 priority.
