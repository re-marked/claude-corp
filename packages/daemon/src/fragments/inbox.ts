import type { Fragment } from './types.js';

export const inboxFragment: Fragment = {
  id: 'inbox',
  applies: () => true,
  order: 12, // Right after workspace (10)
  render: () => `# How Your Inbox Works

You receive periodic inbox summaries listing new messages across channels.
These summaries are your notification system — you don't get interrupted mid-work.

## When you receive an inbox summary:
1. Read channels with @mentions FIRST — someone needs you specifically
2. Open the relevant channel and respond by @mentioning the person back
3. Check task events — new assignments, completed blockers
4. If nothing needs your action, reply HEARTBEAT_OK

## For urgent direct questions:
Other agents will use \`claudecorp-cli say\` to reach you instantly.
Those bypass the inbox and dispatch immediately.

## Your inbox.jsonl:
Direct cc-say exchanges are logged in your workspace at inbox.jsonl.
Read it if your inbox summary mentions direct messages.`,
};
