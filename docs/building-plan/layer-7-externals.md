# Layer 7 -- Externals

The corporation has been running in the terminal. Layer 7 connects it to the
outside world. Agents reach the Founder on Telegram, Discord, Slack, WhatsApp.
Messages flow in both directions. The CEO sends a morning briefing to your
phone.

## Goals

- Leverage OpenClaw's native channel support for external platforms.
- Enable the CEO to send daily briefings via external messaging.
- Bidirectional messaging: external platform messages appear as corp messages.
- Webhook receivers for inbound events from external services.

---

## 1. OpenClaw Native Channel Support

OpenClaw has built-in support for external messaging platforms through its
channel/provider system. AgentCorp leverages this instead of building
custom bridges.

### Supported Platforms

| Platform | OpenClaw Channel Type | Config Key |
|----------|----------------------|------------|
| Telegram | `telegram` | `telegramBotToken` |
| Discord | `discord` | `discordBotToken` |
| Slack | `slack` | `slackBotToken`, `slackAppToken` |
| WhatsApp | `whatsapp` | `whatsappAccessToken` |

### Configuration

External channels are configured in the agent's `openclaw.json`:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "config": {
        "botToken": "...",
        "allowedChatIds": ["123456789"]
      }
    }
  }
}
```

The daemon writes this config when an external channel is set up for an agent.
The Founder configures external platforms through a setup flow in the TUI:

```
+-------------------------------------------------------------+
|  External Channels                            [Esc] back    |
+-------------------------------------------------------------+
|                                                              |
|  Connect your agents to external platforms.                 |
|                                                              |
|  [1] Telegram     not configured                            |
|  [2] Discord      not configured                            |
|  [3] Slack        not configured                            |
|  [4] WhatsApp     not configured                            |
|                                                              |
+-------------------------------------------------------------+
|  Select a platform to configure                             |
+-------------------------------------------------------------+
```

Selecting a platform prompts for the required tokens:

```
  Telegram Setup

  1. Create a bot via @BotFather on Telegram.
  2. Paste the bot token below.

  Bot Token: > [input field]

  3. Send /start to your bot, then enter your chat ID.

  Chat ID: > [input field]

  Which agents should use Telegram?
  [x] CEO
  [ ] HR Director
  [ ] Chief Adviser
```

### File Representation

External channels appear in the corp as regular channels:

```
channels/
  telegram-ceo/
    channel.json
    messages.jsonl
```

`channel.json`:

```json
{
  "id": "channel_telegram_ceo",
  "name": "telegram-ceo",
  "kind": "external",
  "platform": "telegram",
  "memberIds": ["member_user", "member_ceo"],
  "externalConfig": {
    "chatId": "123456789"
  }
}
```

Messages that arrive from Telegram are written to `messages.jsonl` by the
daemon. Messages written to `messages.jsonl` by agents are forwarded to
Telegram by the daemon via the OpenClaw channel bridge.

## 2. CEO Morning Briefing

The CEO's most visible external action: a daily briefing sent to the Founder
on their preferred platform.

### Briefing Generation

The heartbeat mechanism ([[layer-4-tasks]]) triggers briefing generation.
The daemon adds a `morning_briefing` flag to the CEO's HEARTBEAT.md at
a configured time (default: 08:00 local time):

```markdown
## Morning Briefing Due

Generate and send the daily briefing to the Founder.
Include: tasks completed since yesterday, new hires, key decisions,
blocked items, today's priorities.
Send via: telegram
```

The CEO reads this, generates the briefing as a markdown message, and
posts it to the `telegram-ceo` channel. The daemon forwards it to
Telegram.

### Briefing Format

```
Good morning. Here is your daily briefing for ACME Corp.

COMPLETED YESTERDAY
- Research Lead completed "Competitor Analysis" (HIGH)
- Designer finished brand mood board (MED)

IN PROGRESS
- Writer working on "Draft Q1 Report" (HIGH, 60% done)
- Analyst pulling pricing data (MED)

BLOCKED
- "Payment integration" blocked — needs Stripe API key

NEW HIRES
- Content Writer (worker) hired by HR Director

TODAY'S PRIORITIES
1. Review competitor analysis report
2. Provide Stripe API key for payment integration
3. Approve Q1 report draft

3 tasks need your attention. Reply here if you want details
on any item.
```

### Bidirectional

The Founder can reply on Telegram. The reply arrives as a message in
`channels/telegram-ceo/messages.jsonl`. The daemon routes it to the CEO
like any other DM. The CEO responds, and the response goes back to Telegram.

This means the Founder can manage the corp from their phone without
opening the TUI.

## 3. Bidirectional Messaging Architecture

The external messaging flow:

### Outbound (Agent to External Platform)

```
Agent writes to channel
  -> Daemon detects new JSONL line (fs.watch)
  -> Daemon checks channel.kind === "external"
  -> Daemon reads channel.platform
  -> Daemon calls OpenClaw's channel API to send message
  -> Platform delivers to user
```

### Inbound (External Platform to Agent)

```
User sends message on platform
  -> OpenClaw receives via platform webhook/polling
  -> OpenClaw notifies daemon via callback
  -> Daemon writes message to channel's messages.jsonl
  -> Daemon's router dispatches to the agent (DM auto-routing)
  -> Agent processes and responds (outbound flow)
```

### Daemon External Bridge

```typescript
// packages/daemon/src/external-bridge.ts
export class ExternalBridge {
  private platforms: Map<string, PlatformAdapter>;

  registerPlatform(platform: string, adapter: PlatformAdapter): void;
  sendMessage(channelId: string, message: ChannelMessage): Promise<void>;
  onInboundMessage(callback: (channelId: string, message: ChannelMessage) => void): void;
}

interface PlatformAdapter {
  platform: string;
  send(config: ExternalConfig, content: string): Promise<void>;
  listen(config: ExternalConfig, callback: (content: string, metadata: any) => void): void;
  disconnect(): void;
}
```

Each platform has an adapter that wraps OpenClaw's native channel support.
The bridge registers adapters at startup based on which platforms are
configured in the corp.

## 4. Webhook Receivers

For services that push events (GitHub, Stripe, custom), the daemon runs
a local HTTP server that receives webhooks and writes them as messages
to designated channels.

```typescript
// packages/daemon/src/webhook-server.ts
export function startWebhookServer(port: number, corpPath: string): void;
```

### Configuration

```
channels/
  github-events/
    channel.json
    messages.jsonl
```

`channel.json`:

```json
{
  "id": "channel_github_events",
  "name": "github-events",
  "kind": "system",
  "webhookPath": "/webhooks/github",
  "memberIds": ["member_ceo", "member_git_janitor"]
}
```

### Webhook Endpoint

```
POST http://localhost:19000/webhooks/github
Content-Type: application/json

{ "action": "opened", "pull_request": { ... } }
```

The webhook server:
1. Receives the POST.
2. Matches the path to a channel (`webhookPath`).
3. Transforms the payload into a readable message.
4. Writes it to the channel's `messages.jsonl`.
5. The router dispatches to channel members as usual.

### Payload Transformers

Each webhook source gets a transformer that converts raw JSON into
human-readable messages:

```typescript
// packages/daemon/src/transformers/github.ts
export function transformGitHub(payload: any): string {
  if (payload.action === "opened" && payload.pull_request) {
    return `PR opened: "${payload.pull_request.title}" by ${payload.pull_request.user.login}`;
  }
  // ... other event types
}
```

Transformers are optional. If none exists for a webhook source, the raw
JSON is written as the message content (agents can parse JSON).

## 5. Notification Preferences

The Founder configures which events trigger external notifications:

```json
{
  "notifications": {
    "platform": "telegram",
    "events": {
      "task_completed": true,
      "task_failed": true,
      "agent_hired": true,
      "morning_briefing": true,
      "mention": true,
      "dm": false
    },
    "quiet_hours": {
      "start": "22:00",
      "end": "08:00",
      "timezone": "America/New_York"
    }
  }
}
```

Stored in `corp.json` under a `notifications` key. The daemon checks
these preferences before forwarding messages to external platforms.

During quiet hours, notifications are buffered and delivered as a batch
when quiet hours end (or included in the morning briefing).

## Deliverables Checklist

- [ ] External channel setup TUI (platform picker, token input, agent assignment)
- [ ] External channel file representation (`channel.json` with `kind: "external"`)
- [ ] `ExternalBridge` class with platform adapter interface
- [ ] Telegram adapter (via OpenClaw native channel)
- [ ] Discord adapter (via OpenClaw native channel)
- [ ] Slack adapter (via OpenClaw native channel)
- [ ] WhatsApp adapter (via OpenClaw native channel)
- [ ] Outbound message flow (JSONL -> daemon -> platform)
- [ ] Inbound message flow (platform -> daemon -> JSONL -> router)
- [ ] CEO morning briefing generation (heartbeat-triggered)
- [ ] Bidirectional Telegram conversation
- [ ] Webhook HTTP server
- [ ] Webhook path-to-channel routing
- [ ] GitHub payload transformer
- [ ] Notification preferences in `corp.json`
- [ ] Quiet hours buffering
- [ ] Git commits for external channel creation

## Key Decisions

- **OpenClaw native, not custom bridges.** OpenClaw already supports Telegram,
  Discord, Slack, and WhatsApp. AgentCorp wraps this support rather than
  reimplementing message transport. This means platform support improves as
  OpenClaw improves.
- **External channels are regular channels.** They have the same file structure,
  the same JSONL format, the same `channel.json`. The only difference is
  `kind: "external"` and the `platform` field. This means the TUI, the
  router, and git all work with external channels without special cases.
- **Webhook server is local-only.** For receiving webhooks from GitHub or other
  services, the user needs to expose the local port (via ngrok, Tailscale, etc.).
  AgentCorp does not include tunneling -- that is an infrastructure concern
  outside the project's scope.
- **Morning briefing is agent behavior, not daemon logic.** The daemon sets the
  flag in HEARTBEAT.md. The CEO decides what to write and how to format it.
  This means the briefing quality improves as the CEO agent improves, without
  code changes.
