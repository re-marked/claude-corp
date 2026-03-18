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
} from '@agentcorp/shared';
import { Daemon } from '@agentcorp/daemon';
import { join } from 'node:path';
import { ViewStack, type View } from './navigation.js';
import { OnboardingView } from './views/onboarding.js';
import { ChatView } from './views/chat.js';
import { ChannelSwitcher } from './views/channel-switcher.js';
import { TaskBoard } from './views/task-board.js';
import { HierarchyView } from './views/hierarchy.js';
import { AgentInspector } from './views/agent-inspector.js';
import { StatusBar } from './components/status-bar.js';
import { DaemonClient } from './lib/daemon-client.js';
import { COLORS } from './theme.js';

export function App() {
  const corps = listCorps();

  if (corps.length === 0) {
    return <OnboardingView />;
  }

  return <ResumeView corpPath={corps[0]!.path} />;
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
  const [, forceRender] = useState(0);

  const viewStack = useMemo(() => new ViewStack(), []);

  const navigate = useCallback((view: View) => {
    viewStack.push(view);
    forceRender((n) => n + 1);
  }, [viewStack]);

  const goBack = useCallback(() => {
    viewStack.pop();
    forceRender((n) => n + 1);
  }, [viewStack]);

  // Global key handler for view navigation
  useInput((input, key) => {
    if (!ready || showSwitcher) return;
    const current = viewStack.current();
    if (!current) return;

    // Don't intercept keys when in chat (let chat handle its own input)
    if (current.type === 'chat') return;

    if (key.escape || input === 'q') {
      if (viewStack.depth() > 1) goBack();
      return;
    }
    if (input === 'c') {
      setShowSwitcher(true);
      return;
    }
    if (input === 't' && current.type !== 'task-board') {
      navigate({ type: 'task-board' });
      return;
    }
    if (input === 'h' && current.type !== 'hierarchy') {
      navigate({ type: 'hierarchy' });
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

        setStatus('Spawning agents...');
        await d.spawnAllAgents();

        for (let i = 0; i < 30; i++) {
          const agents = d.processManager.listAgents();
          if (agents.some((a) => a.status === 'ready')) break;
          await new Promise((r) => setTimeout(r, 1000));
        }

        d.startRouter();

        const allMembers = readConfig<Member[]>(join(corpPath, MEMBERS_JSON));
        const allChannels = readConfig<Channel[]>(join(corpPath, CHANNELS_JSON));
        setMembers(allMembers);
        setChannels(allChannels);

        // Default: CEO DM
        const founder = allMembers.find((m) => m.rank === 'owner');
        const ceo = allMembers.find((m) => m.rank === 'master');
        let defaultChannel = allChannels.find(
          (c) => c.kind === 'direct' && founder && ceo &&
          c.memberIds.includes(founder.id) && c.memberIds.includes(ceo.id),
        );
        if (!defaultChannel) {
          defaultChannel = allChannels.find((c) => c.name === 'general');
        }

        if (defaultChannel) {
          viewStack.clear({ type: 'chat', channelId: defaultChannel.id });
        } else {
          setError('No channels found');
          return;
        }

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

  // Channel switcher overlay
  if (showSwitcher) {
    const currentView = viewStack.current();
    const currentChannelId = currentView?.type === 'chat' ? currentView.channelId : '';
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <ChannelSwitcher
          channels={channels}
          currentChannelId={currentChannelId}
          onSelect={(ch) => {
            viewStack.replace({ type: 'chat', channelId: ch.id });
            setShowSwitcher(false);
            forceRender((n) => n + 1);
          }}
          onClose={() => setShowSwitcher(false)}
        />
      </Box>
    );
  }

  const current = viewStack.current();
  if (!current) return null;

  // Hints for status bar
  const hints: Record<string, string> = {
    'chat': 'Tab:switch  t:tasks  h:hierarchy',
    'task-board': 'n:new  f:filter  Enter:detail  q:back',
    'hierarchy': 'Enter:inspect  q:back',
    'agent-inspector': 'd:dm  q:back',
    'task-detail': 's:status  q:back',
    'corp-home': 'c:chat  t:tasks  h:hierarchy',
  };

  const renderView = () => {
    switch (current.type) {
      case 'chat': {
        const ch = channels.find((c) => c.id === current.channelId);
        if (!ch) return <Text color={COLORS.danger}>Channel not found</Text>;
        const messagesPath = join(corpPath, ch.path, 'messages.jsonl');
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
      default:
        return <Text>Unknown view</Text>;
    }
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      {renderView()}
      {current.type !== 'chat' && (
        <StatusBar
          breadcrumbs={viewStack.breadcrumbs()}
          hints={hints[current.type] ?? ''}
        />
      )}
    </Box>
  );
}
