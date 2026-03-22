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

Your response appears in this channel automatically. Just reply naturally.`;
  },
};
