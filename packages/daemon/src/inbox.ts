import { log } from './logger.js';

interface ChannelInbox {
  channelName: string;
  total: number;
  mentions: number;
  mentionedBy: string[]; // display names of who mentioned this agent
}

interface AgentInbox {
  channels: Map<string, ChannelInbox>;
  ccSayCount: number;
}

/**
 * InboxManager — tracks unread messages per agent per channel.
 * Agents check their inbox on heartbeat (idle) or busy→idle transition.
 */
export class InboxManager {
  private inboxes = new Map<string, AgentInbox>();

  /** Record a new message in a channel for an agent */
  recordMessage(channelId: string, channelName: string, agentId: string, isMention: boolean, mentionedByName?: string): void {
    let inbox = this.inboxes.get(agentId);
    if (!inbox) {
      inbox = { channels: new Map(), ccSayCount: 0 };
      this.inboxes.set(agentId, inbox);
    }

    let ch = inbox.channels.get(channelId);
    if (!ch) {
      ch = { channelName, total: 0, mentions: 0, mentionedBy: [] };
      inbox.channels.set(channelId, ch);
    }

    ch.total++;
    if (isMention) {
      ch.mentions++;
      if (mentionedByName && !ch.mentionedBy.includes(mentionedByName)) {
        ch.mentionedBy.push(mentionedByName);
      }
    }
  }

  /** Record a cc say exchange */
  recordCcSay(agentId: string): void {
    let inbox = this.inboxes.get(agentId);
    if (!inbox) {
      inbox = { channels: new Map(), ccSayCount: 0 };
      this.inboxes.set(agentId, inbox);
    }
    inbox.ccSayCount++;
  }

  /** Build a human-readable inbox summary for an agent */
  getSummary(agentId: string): string {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) return '';

    const lines: string[] = [];

    // Sort: channels with mentions first
    const channels = [...inbox.channels.entries()].sort((a, b) => b[1].mentions - a[1].mentions);

    for (const [, ch] of channels) {
      let line = `- #${ch.channelName}: ${ch.total} new message${ch.total === 1 ? '' : 's'}`;
      if (ch.mentions > 0) {
        const from = ch.mentionedBy.length > 0 ? ` from @${ch.mentionedBy.join(', @')}` : '';
        line += ` (${ch.mentions} mention${ch.mentions === 1 ? '' : 's'}${from})`;
      }
      lines.push(line);
    }

    if (inbox.ccSayCount > 0) {
      lines.push(`- inbox.jsonl: ${inbox.ccSayCount} direct message${inbox.ccSayCount === 1 ? '' : 's'}`);
    }

    if (lines.length === 0) return '';

    return `Inbox update:\n${lines.join('\n')}\n\nRead what matters, respond where needed. Reply HEARTBEAT_OK if nothing requires action.`;
  }

  /** Clear inbox for an agent (after they've checked it) */
  clear(agentId: string): void {
    this.inboxes.delete(agentId);
  }

  /** Check if agent has any unread items */
  hasUnread(agentId: string): boolean {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) return false;
    if (inbox.ccSayCount > 0) return true;
    for (const [, ch] of inbox.channels) {
      if (ch.total > 0) return true;
    }
    return false;
  }

  /** Get total unread count for an agent */
  getUnreadCount(agentId: string): number {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) return 0;
    let total = inbox.ccSayCount;
    for (const [, ch] of inbox.channels) {
      total += ch.total;
    }
    return total;
  }
}
