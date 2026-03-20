import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  listCorps,
  readConfig,
  ensureGlobalConfig,
  type Channel,
  type Member,
  MEMBERS_JSON,
  CHANNELS_JSON,
} from '@claudecorp/shared';
import { Daemon } from '@claudecorp/daemon';
import { join } from 'node:path';
import { ViewStack, type View } from './navigation.js';
import { OnboardingView } from './views/onboarding.js';
import { ChatView } from './views/chat.js';
import { CommandPalette } from './views/command-palette.js';
import { TaskBoard } from './views/task-board.js';
import { HierarchyView } from './views/hierarchy.js';
import { AgentInspector } from './views/agent-inspector.js';
import { TaskDetail } from './views/task-detail.js';
import { CorpHome } from './views/corp-home.js';
import { StatusBar } from './components/status-bar.js';
import { DaemonClient } from './lib/daemon-client.js';
import { COLORS } from './theme.js';

export function App() {
  const [, forceReload] = useState(0);
  const [selectedCorp, setSelectedCorp] = useState<string | null>(null);
  const corps = listCorps();

  if (corps.length === 0) {
    return <OnboardingView onComplete={() => forceReload((n) => n + 1)} />;
  }

  if (selectedCorp) {
    return <ResumeView corpPath={selectedCorp} />;
  }

  if (corps.length === 1) {
    return <ResumeView corpPath={corps[0]!.path} />;
  }

  return <CorpSelector corps={corps} onSelect={(path) => setSelectedCorp(path)} />;
}

function CorpSelector({ corps, onSelect }: { corps: { name: string; path: string }[]; onSelect: (path: string) => void }) {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setIndex((i) => Math.min(corps.length - 1, i + 1));
    if (key.return) onSelect(corps[index]!.path);
  });

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={3} paddingY={1} width={50}>
        <Box marginBottom={1}>
          <Text bold color={COLORS.primary}>Select a corporation</Text>
        </Box>
        {corps.map((c, i) => (
          <Box key={c.name} gap={1}>
            <Text color={i === index ? COLORS.primary : COLORS.muted}>
              {i === index ? '\u25B8' : ' '}
            </Text>
            <Text bold={i === index} color={i === index ? COLORS.text : COLORS.subtle}>
              {c.name}
            </Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text color={COLORS.muted}>\u2191\u2193 to select, Enter to open</Text>
        </Box>
      </Box>
    </Box>
  );
}

function ResumeView({ corpPath }: { corpPath: string }) {
  const [daemon, setDaemon] = useState<Daemon | null>(null);
  const [client, setClient] = useState<DaemonClient | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [status, setStatus] = useState('Starting daemon...');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const lastVisitedRef = React.useRef<Map<string, string>>(new Map());
  const [, forceRender] = useState(0);

  const viewStack = useMemo(() => new ViewStack(), []);

  const navigate = useCallback((view: View) => {
    if (view.type === 'corp-home') {
      viewStack.clear(view);
    } else {
      viewStack.push(view);
    }
    forceRender((n) => n + 1);
  }, [viewStack]);

  const goBack = useCallback(() => {
    viewStack.pop();
    forceRender((n) => n + 1);
  }, [viewStack]);

  // Find CEO DM channel for Ctrl+D
  const ceoDmChannel = useMemo(() => {
    const founder = members.find((m) => m.rank === 'owner');
    const ceo = members.find((m) => m.rank === 'master');
    if (!founder || !ceo) return null;
    return channels.find(
      (c) => c.kind === 'direct' && c.memberIds.includes(founder.id) && c.memberIds.includes(ceo.id),
    );
  }, [members, channels]);

  // Global key handler — Ctrl combos work in ALL views including chat
  useInput((input, key) => {
    if (!ready || showSwitcher) return;
    const current = viewStack.current();

    // Ctrl+K — command palette
    if (key.ctrl && input === 'k') {
      setShowSwitcher(true);
      return;
    }
    // Ctrl+H — corp home (no-op if already there)
    if (key.ctrl && input === 'h') {
      if (current?.type !== 'corp-home') navigate({ type: 'corp-home' });
      return;
    }
    // Ctrl+T — task board (no-op if already there)
    if (key.ctrl && input === 't') {
      if (current?.type !== 'task-board') navigate({ type: 'task-board' });
      return;
    }
    // Ctrl+D — CEO DM (no-op if already in that channel)
    if (key.ctrl && input === 'd') {
      if (ceoDmChannel && !(current?.type === 'chat' && current.channelId === ceoDmChannel.id)) {
        navigate({ type: 'chat', channelId: ceoDmChannel.id });
      }
      return;
    }
    // Escape — go back
    if (key.escape) {
      if (viewStack.depth() > 1) goBack();
      return;
    }
  });

  useEffect(() => {
    let d: Daemon | null = null;

    (async () => {
      try {
        const globalConfig = ensureGlobalConfig();
        d = new Daemon(corpPath, globalConfig);
        const port = await d.start();
        setDaemon(d);
        setClient(new DaemonClient(port));

        const daemon = d!;
        const tryConnect = async (): Promise<boolean> => {
          try {
            await daemon.spawnAllAgents();
          } catch (err) {
            console.error('[startup] Agent spawning had errors:', err);
          }

          const maxWait = globalConfig.userGateway ? 5 : 15;
          for (let i = 0; i < maxWait; i++) {
            const agents = daemon.processManager.listAgents();
            if (agents.some((a) => a.status === 'ready')) return true;
            if (agents.some((a) => a.status === 'crashed')) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          return false;
        };

        setStatus('Spawning agents...');
        let agentsReady = await tryConnect();

        // Retry loop for gateway connections
        while (!agentsReady && globalConfig.userGateway) {
          setStatus('Cannot reach your OpenClaw gateway. Reconnecting in 5s...');
          await new Promise((r) => setTimeout(r, 5000));
          setStatus('Reconnecting to OpenClaw gateway...');
          agentsReady = await tryConnect();
        }

        try {
          d.startRouter();
        } catch (err) {
          console.error('[startup] Router start failed:', err);
        }

        // Read corp data — use safe fallbacks for corrupted files
        let allMembers: Member[] = [];
        let allChannels: Channel[] = [];
        try {
          allMembers = readConfig<Member[]>(join(corpPath, MEMBERS_JSON));
        } catch {
          console.error('[startup] members.json unreadable');
        }
        try {
          allChannels = readConfig<Channel[]>(join(corpPath, CHANNELS_JSON));
        } catch {
          console.error('[startup] channels.json unreadable');
        }
        setMembers(allMembers);
        setChannels(allChannels);

        // Default: Corp Home (the "Discord landing" experience)
        viewStack.clear({ type: 'corp-home' });

        setReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => { d?.stop(); };
  }, [corpPath]);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={COLORS.danger}>Error: {error}</Text>
      </Box>
    );
  }

  if (!ready || !client) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <Text color={COLORS.subtle}>{status}</Text>
      </Box>
    );
  }

  // Command palette overlay
  if (showSwitcher) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height="100%">
        <CommandPalette
          channels={channels}
          members={members}
          corpRoot={corpPath}
          lastVisited={lastVisitedRef.current}
          onNavigate={(view) => {
            navigate(view);
            setShowSwitcher(false);
          }}
          onSelectChannel={(ch) => {
            viewStack.replace({ type: 'chat', channelId: ch.id });
            setShowSwitcher(false);
            forceRender((n) => n + 1);
          }}
          onCommand={(cmd) => {
            setShowSwitcher(false);
            // Commands handled by ChatView when it renders
            if (cmd === 'hire' || cmd === 'task' || cmd === 'project' || cmd === 'team') {
              // Navigate to chat first, then the command will be handled
            }
          }}
          onClose={() => setShowSwitcher(false)}
        />
      </Box>
    );
  }

  const current = viewStack.current();
  if (!current) return null;

  // Hints for status bar
  const globalHints = 'C-K:palette  C-H:home  C-T:tasks  C-D:ceo  Esc:back';
  const hints: Record<string, string> = {
    'chat': globalHints,
    'task-board': `Enter:detail  Tab:filter  ${globalHints}`,
    'hierarchy': `Enter:inspect  ${globalHints}`,
    'agent-inspector': globalHints,
    'task-detail': globalHints,
    'corp-home': `Enter:open  ${globalHints}`,
  };

  const renderView = () => {
    switch (current.type) {
      case 'chat': {
        const ch = channels.find((c) => c.id === current.channelId);
        if (!ch) return <Text color={COLORS.danger}>Channel not found</Text>;
        const messagesPath = join(corpPath, ch.path, 'messages.jsonl');
        // Mark channel as visited (for unread indicators)
        lastVisitedRef.current.set(ch.id, new Date().toISOString());
        return (
          <ChatView
            channel={ch}
            members={members}
            messagesPath={messagesPath}
            daemonClient={client}
            corpRoot={corpPath}
            onSwitchChannel={() => setShowSwitcher(true)}
            onNavigate={navigate}
          />
        );
      }
      case 'task-board':
        return (
          <TaskBoard
            corpRoot={corpPath}
            members={members}
            daemonClient={client}
            onNavigate={navigate}
            onBack={goBack}
          />
        );
      case 'hierarchy':
        return (
          <HierarchyView
            corpRoot={corpPath}
            onNavigate={navigate}
            onBack={goBack}
          />
        );
      case 'task-detail':
        return (
          <TaskDetail
            corpRoot={corpPath}
            taskId={current.taskId}
            members={members}
            onBack={goBack}
          />
        );
      case 'agent-inspector':
        return (
          <AgentInspector
            corpRoot={corpPath}
            memberId={current.memberId}
            members={members}
            channels={channels}
            onNavigate={navigate}
            onBack={goBack}
          />
        );
      case 'corp-home':
        return (
          <CorpHome
            corpRoot={corpPath}
            daemonClient={client}
            initialMembers={members}
            initialChannels={channels}
            onNavigate={navigate}
          />
        );
      default:
        return <Text>Unknown view</Text>;
    }
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      {renderView()}
      {current.type !== 'chat' && (
        <StatusBar
          breadcrumbs={viewStack.breadcrumbs(new Map(channels.map((c) => [c.id, c.name])))}
          hints={hints[current.type] ?? ''}
        />
      )}
    </Box>
  );
}
