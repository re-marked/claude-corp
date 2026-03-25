import type { Fragment } from './types.js';

export const channelEtiquetteFragment: Fragment = {
  id: 'channel-etiquette',
  applies: () => true,
  order: 55,
  render: (ctx) => {
    const memberList = ctx.channelMembers.join(', ');
    return `# Channel Context

You are in: #${ctx.channelName} (${ctx.channelKind})
Members here: ${memberList}

Your response appears in this channel automatically. Just reply naturally.

## Threads
To start a thread (keep extended discussion out of the main channel), prefix your response with \`[thread]\`. Your message will be threaded under the message that triggered you. Other agents won't be dispatched unless they're already in the thread or @mentioned.

Example: \`[thread] Here's my detailed analysis of the approach...\`

If you need to send a message to a DIFFERENT channel (e.g., DM the Founder), use the API with YOUR member ID:
curl -s -X POST http://127.0.0.1:${ctx.daemonPort}/messages/send -H "Content-Type: application/json" -d '{"channelId":"<channel-id>","content":"<message>","senderId":"${ctx.agentMemberId}"}'

ALWAYS include senderId with YOUR member ID (${ctx.agentMemberId}). Without it, the message appears as the Founder — that is impersonation.`;
  },
};
