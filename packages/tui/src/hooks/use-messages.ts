import { useState, useEffect, useRef } from 'react';
import { watch } from 'node:fs';
import { type ChannelMessage, tailMessages, readMessages } from '@claudecorp/shared';

/** Filter out agent messages not written by the router (external OpenClaw writes). */
function filterExternal(msgs: ChannelMessage[]): ChannelMessage[] {
  return msgs.filter((msg) => {
    if (msg.kind !== 'text') return true;                  // system/task events always show
    if (msg.senderId === 'system') return true;             // system messages always show
    const meta = msg.metadata as Record<string, unknown> | null;
    if (meta?.source === 'router') return true;             // our router wrote it
    // User messages (no metadata) are fine — only agents have metadata.source
    // If no metadata at all, it's a user message or legacy message — show it
    if (!meta) return true;
    // Agent message without source: 'router' — external write, hide it
    return false;
  });
}

export function useMessages(messagesPath: string, initialCount = 50) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const lastIdRef = useRef<string | null>(null);

  // Initial load
  useEffect(() => {
    const initial = filterExternal(tailMessages(messagesPath, initialCount));
    setMessages(initial);
    if (initial.length > 0) {
      lastIdRef.current = initial[initial.length - 1]!.id;
    }
  }, [messagesPath]);

  // Watch for changes
  useEffect(() => {
    const watcher = watch(messagesPath, () => {
      try {
        const newMsgs = lastIdRef.current
          ? readMessages(messagesPath, { after: lastIdRef.current })
          : tailMessages(messagesPath, initialCount);

        if (newMsgs.length > 0) {
          lastIdRef.current = newMsgs[newMsgs.length - 1]!.id;
          const filtered = filterExternal(newMsgs);
          if (filtered.length > 0) {
            setMessages((prev) => [...prev, ...filtered]);
          }
        }
      } catch {
        // File might be mid-write
      }
    });

    return () => watcher.close();
  }, [messagesPath]);

  return messages;
}
