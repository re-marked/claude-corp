export type MessageKind = 'text' | 'system' | 'task_event' | 'tool_event';

export interface ChannelMessage {
  id: string;
  channelId: string;
  senderId: string;
  threadId: string | null;
  content: string;
  kind: MessageKind;
  mentions: string[];
  metadata: Record<string, unknown> | null;
  depth: number;
  originId: string;
  timestamp: string;
}

/**
 * Kinds of ambient / scheduled work that are indistinguishable from
 * the agent's POV (all just "prompts that arrived") but that the TUI
 * should collapse into stacked badges so the main conversation stays
 * clean. When the source of a dispatch is one of these, the triggering
 * site stamps `metadata.ambient` on both the incoming prompt message
 * and the agent's response.
 */
export type AmbientKind =
  | 'heartbeat'     // Pulse dispatches with a real prompt ("HEARTBEAT_OK")
  | 'cron'          // Cron timer fires
  | 'loop'          // Loop iteration
  | 'autoemon'      // Autoemon tick during SLUMBER
  | 'dream'         // Memory consolidation pass
  | 'inbox'         // Scheduled inbox drain
  | 'failsafe'      // Failsafe monitoring heartbeat
  | 'herald'        // Herald narration pings
  | 'recovery';     // Post-failure recovery notification

/**
 * Metadata convention for ambient / scheduled work. Lives on
 * `message.metadata.ambient`. TUI reads this to render collapsed
 * badges grouped by kind (e.g., "⏱ 5 heartbeats in 15min").
 */
export interface AmbientMetadata {
  kind: AmbientKind;
  /**
   * One-line summary for the collapsed badge. E.g., "daily-brief" for
   * a cron, "heartbeat" for a pulse ping, "12m memory consolidation"
   * for a dream. No timestamp — the message's own timestamp suffices.
   */
  summary: string;
}
