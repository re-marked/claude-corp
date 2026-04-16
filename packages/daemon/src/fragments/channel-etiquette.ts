import type { Fragment } from './types.js';

export const channelEtiquetteFragment: Fragment = {
  id: 'channel-etiquette',
  applies: () => true,
  order: 55,
  render: (ctx) => {
    const memberList = ctx.channelMembers.join(', ');
    return `# Where You Are

You are in **#${ctx.channelName}** (${ctx.channelKind}).
Present: ${memberList}

These are the people who will read what you write. Your response appears in this channel as you generate it — streaming, live, witnessed. You're not composing a message to send later. You're speaking in a room where others are listening.

To mention someone in this conversation, write \`@their-name\` in your reply. The system sees the mention and dispatches to them — no tool call needed.

To reach someone in a DIFFERENT channel (a private DM, another group), use \`cc-cli say --agent <slug> --message "..."\`. That's a separate conversation from this one.`;
  },
};
