import { useState, useEffect, useRef } from 'react';
import { watch } from 'node:fs';
import { type ChannelMessage, tailMessages, readMessages } from '@agentcorp/shared';

export function useMessages(messagesPath: string, initialCount = 50) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const lastIdRef = useRef<string | null>(null);

  // Initial load
  useEffect(() => {
    const initial = tailMessages(messagesPath, initialCount);
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
          setMessages((prev) => [...prev, ...newMsgs]);
        }
      } catch {
        // File might be mid-write
      }
    });

    return () => watcher.close();
  }, [messagesPath]);

  return messages;
}
