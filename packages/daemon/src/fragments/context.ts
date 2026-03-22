import type { Fragment } from './types.js';

export const contextFragment: Fragment = {
  id: 'context',
  applies: () => true,
  order: 90,
  render: (ctx) => {
    const memberList = ctx.corpMembers
      .map((m) => `- ${m.name} (${m.rank}, ${m.type}, ${m.status})`)
      .join('\n');

    return `# All Corp Members

${memberList}`;
  },
};
