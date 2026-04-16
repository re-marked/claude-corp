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

**Variations:**

Score (potentiometer — founder uses arrow keys to pick a number):
\`\`\`xml
<askFounder type="score" min="0" max="10">
  <question>How much do you trust agents to work autonomously?</question>
</askFounder>
\`\`\`

Multi-select (founder toggles multiple options):
\`\`\`xml
<askFounder type="multi">
  <question>Which features should we prioritize?</question>
  <answers>
    <answer value="auth">Authentication</answer>
    <answer value="search">Search</answer>
  </answers>
</askFounder>
\`\`\`

Add \`preview="code or mockup here"\` to an answer for a preview pane. Use \\\\n for newlines.

Don't overuse structured questions — most are better asked in plain text. Reserve them for decisions that genuinely need a clear, parseable answer.`;
  },
};
