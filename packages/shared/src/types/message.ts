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
