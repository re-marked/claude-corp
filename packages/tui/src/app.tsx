import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  listCorps,
  deleteCorp,
  readConfig,
  ensureGlobalConfig,
  type Channel,
  type Member,
  MEMBERS_JSON,
  CHANNELS_JSON,
} from '@claudecorp/shared';
import { Daemon, setSilentMode } from '@claudecorp/daemon';
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
import { TimeMachine } from './views/time-machine.js';
import { StatusBar } from './components/status-bar.js';
import { DaemonClient } from './lib/daemon-client.js';
import { useDaemonEvents } from './hooks/use-daemon-events.js';
import { CorpProvider } from './context/corp-context.js';
import { COLORS } from './theme.js';
import { setDaemonRef } from './lib/daemon-ref.js';
import { BootSequence, getBootStyle } from './components/boot-sequence.js';

export function App({ forceNew: forceNewProp }: { forceNew?: boolean } = {}) {
  // All hooks MUST be before any early returns (React rules of hooks)
  const [termSize, setTermSize] = useState({ cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 });
  const [, forceReload] = useState(0);
  const [selectedCorp, setSelectedCorp] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(!!forceNewProp);

  useEffect(() => {
    const onResize = () => setTermSize({ cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 });
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, []);

  // Min terminal size guard
  if (termSize.cols < 80 || termSize.rows < 20) {
    return (
      <Text color={COLORS.warning}>Too small ({termSize.cols}x{termSize.rows}) — need 80x20</Text>
    );
  }

  const corps = listCorps();

  if (corps.length === 0 || showOnboarding) {
    return <OnboardingView onComplete={() => { setShowOnboarding(false); forceReload((n) => n + 1); }} />;
  }

  if (selectedCorp) {
    return <ResumeView corpPath={selectedCorp} />;
  }

  if (corps.length === 1) {
    return <ResumeView corpPath={corps[0]!.path} />;
  }

  return (
    <CorpSelector
      corps={corps}
      onSelect={(path) => setSelectedCorp(path)}
      onNew={() => forceReload((n) => n + 1)}
      onDelete={(name) => { deleteCorp(name); forceReload((n) => n + 1); }}
    />
  );
}

function CorpSelector({ corps, onSelect, onNew, onDelete }: {
  corps: { name: string; path: string }[];
  onSelect: (path: string) => void;
  onNew: () => void;
  onDelete: (name: string) => void;
}) {
  // Items: corps + "New corporation" action
  const totalItems = corps.length + 1;
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setIndex((i) => Math.min(totalItems - 1, i + 1));
    if (key.return) {
      if (index < corps.length) {
        onSelect(corps[index]!.path);
      } else {
        onNew();
      }
    }
    // Backspace/Delete on a corp = delete it
    if ((key.backspace || key.delete) && index < corps.length) {
      onDelete(corps[index]!.name);
    }
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
        <Box key="__new" gap={1}>
          <Text color={index === corps.length ? COLORS.success : COLORS.muted}>
            {index === corps.length ? '\u25B8' : ' '}
          </Text>
          <Text bold={index === corps.length} color={index === corps.length ? COLORS.success : COLORS.muted}>
            + New corporation
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.muted}>{'\u2191\u2193'} select  Enter open  Backspace delete</Text>
        </Box>
      </Box>
    </Box>
  );
}

function ResumeView({ corpPath }: { corpPath: string }) {
  const [daemon, setDaemon] = useState<Daemon | null>(null);
  const [client, setClient] = useState<DaemonClient | null>(null);
  const [daemonPort, setDaemonPort] = useState(0);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [status, setStatus] = useState('Starting daemon...');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const lastVisitedRef = React.useRef<Map<string, string>>(new Map());
  const [, forceRender] = useState(0);
  const bootStyle = getBootStyle();
  const [bootDone, setBootDone] = useState(!bootStyle);

  // WebSocket event bus for real-time streaming + dispatch updates
  const events = useDaemonEvents(daemonPort);

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
    if (!ready) return;
    
    // Don't handle other keys when palette is open (let the palette handle them)
    if (showSwitcher) return;
    
    const current = viewStack.current();

    // Ctrl+K — command palette (only when palette is closed)
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
        setSilentMode(true); // Logs go to file only, not stdout (garbles TUI)
        const globalConfig = ensureGlobalConfig();
        d = new Daemon(corpPath, globalConfig);
        const port = await d.start();
        setDaemon(d);
        setDaemonRef(d); // For crash cleanup in index.tsx
        setDaemonPort(port);
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

  if (!ready || !client || !bootDone) {
    if (bootStyle) {
      return <BootSequence style={bootStyle} onComplete={() => setBootDone(true)} />;
    }
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <Text color={COLORS.subtle}>{status}</Text>
      </Box>
    );
  }

  // Command palette overlay
  if (showSwitcher) {
    return (
      <CorpProvider
        corpRoot={corpPath}
        daemonClient={client}
        daemonPort={daemonPort}
        initialMembers={members}
        initialChannels={channels}
      >
        <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height="100%">
          <CommandPalette
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
      </CorpProvider>
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
    'time-machine': 'Enter:rewind  F:forward  R:refresh  Esc:back',
  };

  const renderView = () => {
    switch (current.type) {
      case 'chat': {
        const ch = channels.find((c) => c.id === current.channelId);
        if (!ch) return <Text color={COLORS.danger}>Channel not found</Text>;
        const messagesPath = join(corpPath, ch.path, 'messages.jsonl');
        // Mark channel as visited (for unread indicators)
        lastVisitedRef.current.set(ch.id, new Date().toISOString());
        // Get streaming data for this channel from WebSocket events
        const streamForChannel = events.streams.get(current.channelId) ?? null;
        // Get tool activity for this channel
        const toolForChannel = [...events.toolActivity.values()].find(
          (t) => t.channelId === current.channelId,
        );
        return (
          <ChatView
            channel={ch}
            messagesPath={messagesPath}
            streamData={streamForChannel}
            dispatchingAgents={[...events.dispatching]}
            activeToolCall={toolForChannel ? { agentName: toolForChannel.agentName, toolName: toolForChannel.toolName } : null}
            onNavigate={navigate}
          />
        );
      }
      case 'task-board':
        return (
          <TaskBoard
            onNavigate={navigate}
            onBack={goBack}
          />
        );
      case 'hierarchy':
        return (
          <HierarchyView
            onNavigate={navigate}
            onBack={goBack}
          />
        );
      case 'task-detail':
        return (
          <TaskDetail
            taskId={current.taskId}
            onBack={goBack}
          />
        );
      case 'agent-inspector':
        return (
          <AgentInspector
            memberId={current.memberId}
            onNavigate={navigate}
            onBack={goBack}
          />
        );
      case 'corp-home':
        return (
          <CorpHome
            onNavigate={navigate}
          />
        );
      case 'time-machine':
        return (
          <TimeMachine
            onBack={goBack}
          />
        );
      default:
        return <Text>Unknown view</Text>;
    }
  };

  return (
    <CorpProvider
      corpRoot={corpPath}
      daemonClient={client}
      daemonPort={daemonPort}
      initialMembers={members}
      initialChannels={channels}
    >
      <Box flexDirection="column" flexGrow={1}>
        {renderView()}
        {current.type !== 'chat' && (
          <StatusBar
            breadcrumbs={viewStack.breadcrumbs(new Map(channels.map((c) => [c.id, c.name])))}
            hints={hints[current.type] ?? ''}
          />
        )}
      </Box>
    </CorpProvider>
  );
}
