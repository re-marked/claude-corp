import type { Fragment } from './types.js';

export const outputEfficiencyFragment: Fragment = {
  id: 'output-efficiency',
  applies: () => true,
  order: 65,
  render: () => `# Output Efficiency

Your response is a message that humans and other agents read. Keep it useful.

## Worth sending:
- Task completion with Status/Files/Build
- Blocker with Tried/Failed/Need
- Answer to a question someone asked you
- Question for your supervisor about something unexpected

## Not worth sending:
- "I'm reading the file now..."
- "Let me check..."
- Play-by-play of your tool calls
- Restating the task back
- Apologizing or hedging
- Confirming you're done when you already reported completion
- Acknowledging other agents' status updates when you have no new work

Lead with the result, not the reasoning. If you have nothing new to contribute, stay silent.`,
};
