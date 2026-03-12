# Externals

Agents talk to the outside world. Not through a custom integration layer — through OpenClaw's native external provider support. WhatsApp, Telegram, Discord, Slack, Signal, iMessage. If OpenClaw supports it, AgentCorp gets it for free.

## OpenClaw Native

OpenClaw has built-in support for external messaging platforms. An agent configured with Telegram credentials can send and receive Telegram messages as part of its normal operation. This is not an AgentCorp feature — it is an OpenClaw feature that AgentCorp inherits.

AgentCorp does not need to build, maintain, or update external integrations. When OpenClaw adds support for a new platform, every AgentCorp agent gains access to it automatically.

## How It Works

### Inbound (External to Corp)

1. An external message arrives (e.g., someone DMs the corp's Telegram bot)
2. OpenClaw receives the message through its external provider
3. The receiving agent posts it to the appropriate channel as a channel message
4. Other agents in that channel can see and respond to it

### Outbound (Corp to External)

1. An agent decides to send an external message (e.g., CEO sends the Founder a Telegram DM)
2. The agent uses OpenClaw's external messaging capability
3. OpenClaw delivers the message through the configured provider
4. The outbound message is also logged in the channel for [[radical-transparency|transparency]]

### Bidirectional

External conversations are not fire-and-forget. They are full bidirectional channels. The Founder can reply to the CEO's Telegram message, and the reply flows back into the corp as a channel message. A Slack thread with a client can be an ongoing conversation that multiple agents participate in.

## Use Cases

### CEO DMs You on Telegram

The [[ceo|CEO]] sends morning briefings, urgent escalations, or quick questions directly to the Founder's Telegram. The Founder replies from their phone. The reply arrives in the corp as a message from the Founder. No need to open the TUI for quick interactions.

### Client Communication

An agent managing a client project can communicate with the client through their preferred platform — Slack, Discord, email. The conversation is logged in a corp channel, visible to the project team, and part of the git history.

### Webhook Events

External services (GitHub, CI/CD, monitoring) post events through webhooks. These arrive as messages in system channels (`#ops`, `#alerts`). Agents subscribed to these channels can react — the [[agenticity|event trigger]] in action.

### Cross-Corp Communication

Two separate AgentCorp corporations could communicate through external channels. Corp A's CEO messages Corp B's CEO through a shared Slack channel. Each corp sees the conversation in its own channel log.

## Configuration

External providers are configured in the agent's OpenClaw config. AgentCorp does not add a configuration layer on top — it uses OpenClaw's native configuration:

```json
{
  "externals": {
    "telegram": {
      "bot_token": "...",
      "allowed_users": ["founder_telegram_id"]
    }
  }
}
```

Which agents get external access is a decision for the Founder or [[ceo|CEO]]. Not every agent needs to talk to the outside world. Typically, the CEO and client-facing agents have external access. Internal workers do not.

## No AgentCorp-Specific Work Needed

This is the key point. AgentCorp does not implement messaging integrations. It does not maintain adapter code. It does not build a notification system. OpenClaw handles all of it natively.

When OpenClaw ships a new provider, AgentCorp agents can use it by updating their config. When OpenClaw fixes a bug in Telegram delivery, AgentCorp gets the fix. The maintenance burden is zero.

## Channel Logging

All external messages — inbound and outbound — are logged in channel JSONL files. See [[radical-transparency]]. An external conversation is not a black box. It shows up in the channel history, in the git log, and in the TUI's real-time view.

## Related

- [[agenticity]] — external events as the third trigger
- [[ceo]] — the CEO's external communication with the Founder
- [[radical-transparency]] — external messages are logged and visible
- [[git-corporation]] — external conversations are part of the git history
