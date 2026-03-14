import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
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
import { OnboardingView } from './views/onboarding.js';
import { ChatView } from './views/chat.js';
import { ChannelSwitcher } from './views/channel-switcher.js';
import { DaemonClient } from './lib/daemon-client.js';

export function App() {
  const corps = listCorps();

  if (corps.length === 0) {
    return <OnboardingView />;
  }

  // Resume existing corp
  return <ResumeView corpPath={corps[0]!.path} />;
}

function ResumeView({ corpPath }: { corpPath: string }) {
  const [daemon, setDaemon] = useState<Daemon | null>(null);
  const [client, setClient] = useState<DaemonClient | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [messagesPath, setMessagesPath] = useState('');
  const [status, setStatus] = useState('Starting daemon...');
  const [error, setError] = useState('');
  const [showSwitcher, setShowSwitcher] = useState(false);

  const switchToChannel = (ch: Channel) => {
    setChannel(ch);
    setMessagesPath(join(corpPath, ch.path, 'messages.jsonl'));
    setShowSwitcher(false);
  };

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

        // Wait for at least one agent to be ready
        for (let i = 0; i < 30; i++) {
          const agents = d.processManager.listAgents();
          if (agents.some((a) => a.status === 'ready')) break;
          await new Promise((r) => setTimeout(r, 1000));
        }

        // Start the message router
        d.startRouter();

        // Load all channels and members
        const allMembers = readConfig<Member[]>(join(corpPath, MEMBERS_JSON));
        const allChannels = readConfig<Channel[]>(join(corpPath, CHANNELS_JSON));
        setMembers(allMembers);
        setChannels(allChannels);

        // Default to CEO DM
        const founder = allMembers.find((m) => m.rank === 'owner');
        const ceo = allMembers.find((m) => m.rank === 'master');

        let defaultChannel = allChannels.find(
          (c) => c.kind === 'direct' && founder && ceo &&
          c.memberIds.includes(founder.id) && c.memberIds.includes(ceo.id),
        );

        // Fallback to #general
        if (!defaultChannel) {
          defaultChannel = allChannels.find((c) => c.name === 'general');
        }

        if (defaultChannel) {
          switchToChannel(defaultChannel);
        } else {
          setError('No channels found');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      d?.stop();
    };
  }, [corpPath]);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (channel && client && messagesPath) {
    if (showSwitcher) {
      return (
        <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
          <ChannelSwitcher
            channels={channels}
            currentChannelId={channel.id}
            onSelect={switchToChannel}
            onClose={() => setShowSwitcher(false)}
          />
        </Box>
      );
    }

    return (
      <ChatView
        channel={channel}
        members={members}
        messagesPath={messagesPath}
        daemonClient={client}
        onSwitchChannel={() => setShowSwitcher(true)}
      />
    );
  }

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Text>{status}</Text>
    </Box>
  );
}
