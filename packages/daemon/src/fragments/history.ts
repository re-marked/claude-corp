import type { Fragment } from './types.js';

export const historyFragment: Fragment = {
  id: 'history',
  applies: (ctx) => ctx.recentHistory.length > 0,
  order: 100,
  render: (ctx) => `# Recent Conversation in #${ctx.channelName}

${ctx.recentHistory.join('\n')}

Read this history for context. If the triggering message is just an @mention with no content, respond to the most recent unanswered question or topic.`,
};
