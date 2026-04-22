/**
 * Inbox helper — the single funnel every inbox-item creation goes
 * through. 0.7.4's load-bearing abstraction: tier-specific TTL and
 * destructionPolicy rules live here, so callers (router on @mention,
 * hand on dispatch, escalate on escalation, system event emitters)
 * don't each re-derive tier semantics.
 *
 * Tier table:
 *
 *   Tier 1 — ambient
 *     TTL: 24h; destructionPolicy: 'destroy-if-not-promoted'.
 *     Broadcast notifications, system events (Failsafe restarts,
 *     Herald digests, cron ticks). Genuinely fire-and-forget.
 *     Scanner removes after 24h if unpromoted. No cold state.
 *
 *   Tier 2 — direct
 *     TTL: 7d; destructionPolicy: registry default 'keep-forever'.
 *     Peer @mentions, inter-agent DMs, task handoffs from peers.
 *     Goes cold on TTL-age; preserves audit trail. Does NOT block
 *     the 0.7.3 Audit Gate.
 *
 *   Tier 3 — critical
 *     TTL: 30d; destructionPolicy: registry default 'keep-forever'.
 *     Founder DMs, escalations, direct task assignments from
 *     supervisor. Goes cold on TTL-age. **Blocks the Audit Gate
 *     while `status === 'active'`** — the agent can't end a session
 *     with a pending Tier 3 item without explicit resolution
 *     (respond / dismiss-with-real-reason / carry-forward).
 *
 * Inbox-items are always scoped to the recipient — `agent:<slug>`.
 * Agents don't author their own; they're always the RECIPIENT. The
 * `from` field names the sender.
 */

import { createChit, computeTTL } from './chits.js';
import type {
  Chit,
  ChitScope,
  InboxItemSource,
  InboxItemTier,
} from './types/chit.js';

export interface CreateInboxItemOpts {
  /** Corp root — passed through to chit-store writes. */
  corpRoot: string;
  /** Recipient agent slug. Becomes the chit's scope. */
  recipient: string;
  /** Sender severity — drives TTL, destructionPolicy, audit-gate behavior. */
  tier: InboxItemTier;
  /** Sender member id ('mark' for founder, 'herald' for herald, 'system' for daemon-emitted). */
  from: string;
  /** One-line preview for wtf header + cc-cli inbox list. Keep under ~80 chars. */
  subject: string;
  /** What generated the notification — drives how `cc-cli inbox respond` dispatches. */
  source: InboxItemSource;
  /** Source-specific reference (channel name for 'channel' source; null for most others). */
  sourceRef?: string | null;
  /**
   * Override the default createdBy. Normally equals `from` — inbox-items
   * are created by the sender conceptually, even though the daemon
   * writes them mechanically. Separate hook for cases where the "real"
   * author differs from the sender slug (e.g. system-emitted items
   * where `from = 'system'` but createdBy tracks a specific daemon
   * component).
   */
  createdBy?: string;
  /** Loose pointers to related chits (e.g. the task chit being handed). */
  references?: string[];
}

/**
 * TTL durations per tier. Matches the REFACTOR.md 0.6/0.7.4 spec.
 * Exposed for tests that want to assert TTL computation without
 * round-tripping through the full helper.
 */
export const TIER_TTL: Record<InboxItemTier, string> = {
  1: '24h',
  2: '7d',
  3: '30d',
};

/**
 * Create an inbox-item chit for the recipient. Single funnel for
 * router, hand, escalate, and system-event emitters. Returns the
 * persisted chit for immediate reference (e.g. router wants to
 * include the new chit id in the DM announcement).
 *
 * Idempotence note: this function does NOT dedup — callers that want
 * "don't create a second Tier-2 notification if an identical one is
 * already active" must check first. The trade-off: a single @mention
 * spam attack could theoretically flood an inbox, but the Tier 1/2
 * scanner-aging makes that self-limiting. Dedup logic belongs at the
 * caller where the semantics of "identical" are known (same
 * channel:offset? same task-id? same sender + subject?).
 */
export function createInboxItem(opts: CreateInboxItemOpts): Chit<'inbox-item'> {
  const scope: ChitScope = `agent:${opts.recipient}`;
  const ttl = computeTTL(TIER_TTL[opts.tier]);
  // Tier 1 is the only tier whose destruction policy diverges from
  // the inbox-item registry default ('keep-forever'). Setting this
  // field on the chit tells the lifecycle scanner to destroy-on-age
  // for this specific chit instead of cooling.
  const destructionPolicy =
    opts.tier === 1 ? ('destroy-if-not-promoted' as const) : undefined;

  return createChit(opts.corpRoot, {
    type: 'inbox-item',
    scope,
    fields: {
      'inbox-item': {
        tier: opts.tier,
        from: opts.from,
        subject: opts.subject,
        source: opts.source,
        sourceRef: opts.sourceRef ?? null,
      },
    },
    createdBy: opts.createdBy ?? opts.from,
    ttl,
    ...(destructionPolicy ? { destructionPolicy } : {}),
    references: opts.references,
    body:
      // Human-readable preamble for founder eyeballing the raw file on
      // disk. Not load-bearing; the frontmatter has everything
      // structural.
      `Tier ${opts.tier} inbox-item for \`${opts.recipient}\` from \`${opts.from}\` ` +
      `via ${opts.source}. Resolve with \`cc-cli inbox respond/dismiss/carry-forward <id>\`.\n`,
  });
}
