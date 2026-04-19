/**
 * Agent session keys — one brain per agent.
 *
 * Every dispatch to an agent (jack, task handoff, cron tick, @mention,
 * dream, autoemon tick, heartbeat-with-work, anything that requires
 * reasoning) funnels through the SAME session key per agent. The agent
 * has continuous conversation memory across every kind of input.
 *
 * Before this primitive, the same agent had separate histories under
 * `jack:<slug>`, `say:<a>:<b>`, `cron:<slug>`, `loop:<slug>`, etc. —
 * each kind of work was a different "self" with different memory, and
 * parallel inputs looked schizophrenic in the JSONL because the agent
 * genuinely didn't know what its other-self had just done. Unifying
 * ends that.
 *
 * Exception (not currently used, reserved for future): pure liveness
 * pings that never hit the session layer. Callers that want to probe
 * "is the agent responsive?" without adding a turn to memory should
 * bypass /cc/say entirely rather than minting a separate sessionKey.
 */

/** Stable prefix for every agent session key written by Claude Corp. */
export const AGENT_SESSION_PREFIX = 'agent:';

/**
 * Normalize a display name or slug into the canonical agent-session
 * form: lowercase, whitespace collapsed to dashes. Idempotent — feeding
 * an already-normalized slug returns it unchanged.
 *
 * Deliberately mirrors the normalization used elsewhere in the daemon
 * (api.ts, router.ts) so a slug derived by any path resolves to the
 * same key.
 */
function normalizeSlug(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Build the agent session key for `slug`. Use this everywhere that
 * dispatches to an agent expecting the turn to accumulate in its main
 * conversation memory.
 *
 * `slug` can be a display name ("CEO", "Lead Coder"), an already-
 * normalized slug ("lead-coder"), or any intermediate form — the
 * helper normalizes either way.
 */
export function agentSessionKey(slug: string): string {
  return `${AGENT_SESSION_PREFIX}${normalizeSlug(slug)}`;
}

/**
 * Test whether `key` is in the agent-session namespace. Useful for
 * migration tooling ("does this legacy key need rewriting?") and for
 * observability filters that want to isolate the unified-session
 * traffic from any other kinds of session keys that may appear.
 */
export function isAgentSession(key: string): boolean {
  return key.startsWith(AGENT_SESSION_PREFIX);
}
