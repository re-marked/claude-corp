import { useState, useEffect, useRef } from 'react';
import { watch, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type ChannelMessage, tailMessages, readMessages } from '@claudecorp/shared';

/** Only show messages written by our system. External OpenClaw writes are hidden. */
function filterExternal(msgs: ChannelMessage[]): ChannelMessage[] {
  return msgs.filter((msg) => {
    if (msg.kind !== 'text') return true;                        // system/task events always show
    if (msg.senderId === 'system') return true;                   // system sender always show
    const meta = msg.metadata as Record<string, unknown> | null;
    return meta?.source === 'router' || meta?.source === 'user'; // only our tagged writes
  });
}

/** Thread reply counts keyed by parent message id. */
export type ThreadCounts = Map<string, number>;

/**
 * @param threadId — undefined: main channel only (no thread messages). string: show only that thread.
 */
export function useMessages(messagesPath: string, initialCount = 50, threadId?: string) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [threadCounts, setThreadCounts] = useState<ThreadCounts>(new Map());
  const lastIdRef = useRef<string | null>(null);
  const allMsgsRef = useRef<ChannelMessage[]>([]);

  function applyFilter(msgs: ChannelMessage[]): { filtered: ChannelMessage[]; counts: ThreadCounts } {
    const external = filterExternal(msgs);
    const counts = new Map<string, number>();

    // Count thread replies (exclude tool events — they inflate the count)
    for (const m of external) {
      if (m.threadId && m.kind === 'text') {
        counts.set(m.threadId, (counts.get(m.threadId) ?? 0) + 1);
      }
    }

    // Filter by thread view
    let filtered: ChannelMessage[];
    if (threadId) {
      // Thread view — show parent message + thread replies
      filtered = external.filter((m) => m.threadId === threadId || m.id === threadId);
    } else {
      // Main view — hide thread replies (they show as "N replies" badge)
      filtered = external.filter((m) => !m.threadId);
    }

    return { filtered, counts };
  }

  // Initial load
  useEffect(() => {
    const all = filterExternal(tailMessages(messagesPath, initialCount * 2));
    allMsgsRef.current = all;
    const { filtered, counts } = applyFilter(all);
    setMessages(filtered);
    setThreadCounts(counts);
    if (all.length > 0) {
      lastIdRef.current = all[all.length - 1]!.id;
    }
  }, [messagesPath, threadId]);

  // Watch for changes
  useEffect(() => {
    if (!existsSync(messagesPath)) {
      mkdirSync(dirname(messagesPath), { recursive: true });
      writeFileSync(messagesPath, '');
    }
    const watcher = watch(messagesPath, () => {
      try {
        const newMsgs = lastIdRef.current
          ? readMessages(messagesPath, { after: lastIdRef.current })
          : tailMessages(messagesPath, initialCount * 2);

        if (newMsgs.length > 0) {
          lastIdRef.current = newMsgs[newMsgs.length - 1]!.id;
          const newFiltered = filterExternal(newMsgs);
          allMsgsRef.current = [...allMsgsRef.current, ...newFiltered].slice(-200);

          // Recompute thread counts from all messages
          const counts = new Map<string, number>();
          for (const m of allMsgsRef.current) {
            if (m.threadId) {
              counts.set(m.threadId, (counts.get(m.threadId) ?? 0) + 1);
            }
          }
          setThreadCounts(counts);

          // Filter new messages for current view
          const viewMsgs = threadId
            ? newFiltered.filter((m) => m.threadId === threadId || m.id === threadId)
            : newFiltered.filter((m) => !m.threadId);

          if (viewMsgs.length > 0) {
            setMessages((prev) => {
              const combined = [...prev, ...viewMsgs];
              return combined.length > 200 ? combined.slice(-200) : combined;
            });
          }
        }
      } catch {
        // File might be mid-write
      }
    });

    return () => watcher.close();
  }, [messagesPath, threadId]);

  return { messages, threadCounts };
}
