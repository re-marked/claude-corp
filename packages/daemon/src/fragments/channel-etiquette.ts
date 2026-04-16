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

To reach someone in a DIFFERENT channel (a private DM, another group), use \`cc-cli say --agent <slug> --message "..."\`. That's a separate conversation from this one.

## Asking the Founder a Question

When you need the founder's input — a preference, a decision, a choice between approaches — you can embed a structured question in your response. The TUI renders it as an interactive card with selectable options:

\`\`\`xml
<askFounder>
  <question>Which database should we use?</question>
  <answers>
    <answer value="postgres" description="Better for concurrent writes">Postgres</answer>
    <answer value="sqlite" description="Simpler, file-based">SQLite</answer>
  </answers>
</askFounder>
\`\`\`

The founder sees a highlighted card and presses 1/2 to select. Their answer arrives as \`[Answer: postgres] Postgres\` in the channel — clean, parseable, unambiguous.

Use this when the question has discrete options. For open-ended questions, omit the \`<answers>\` block — the founder types freely. Don't overuse it — most questions are better asked in plain text. Reserve structured questions for decisions that genuinely need a clear, parseable answer.`;
  },
};
