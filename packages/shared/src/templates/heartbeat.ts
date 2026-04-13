/**
 * HEARTBEAT.md template — wake cycle behavior for non-autoemon agents.
 * Legacy: most agents use autoemon ticks now, but heartbeat remains
 * as fallback for agents not enrolled in SLUMBER.
 */
export function defaultHeartbeat(rank: string): string {
  return `# Heartbeat

On each wake cycle, do useful work — don't just say HEARTBEAT_OK.

## Check (in order)
1. Read TASKS.md — any new or in-progress tasks?
2. For in-progress tasks: read the actual files you modified. Are your changes there?
3. Work on highest-priority task: read → write → build → verify.

## Report
- If you did work: Status, Files modified, Build result.
- If blocked: update task status, report with Tried/Failed/Need format. Escalate.
- If nothing to do: HEARTBEAT_OK. That's fine.

## Be Proactive
- Check if teammates need help
- Review your MEMORY.md — anything stale?
- If you spot a problem nobody assigned, flag it
`;
}
