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
  const [channel, setChannel] = useState<Channel | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [messagesPath, setMessagesPath] = useState('');
  const [status, setStatus] = useState('Starting daemon...');
  const [error, setError] = useState('');

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

        // Find the CEO DM channel
        const allMembers = readConfig<Member[]>(join(corpPath, MEMBERS_JSON));
        const allChannels = readConfig<Channel[]>(join(corpPath, CHANNELS_JSON));
        const founder = allMembers.find((m) => m.rank === 'owner');
        const ceo = allMembers.find((m) => m.rank === 'master');

        let dm = allChannels.find(
          (c) => c.kind === 'direct' && founder && ceo &&
          c.memberIds.includes(founder.id) && c.memberIds.includes(ceo.id),
        );

        // Fallback to #general
        if (!dm) {
          dm = allChannels.find((c) => c.name === 'general');
        }

        if (dm) {
          setChannel(dm);
          setMembers(allMembers);
          setMessagesPath(join(corpPath, dm.path, 'messages.jsonl'));
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
    return (
      <ChatView
        channel={channel}
        members={members}
        messagesPath={messagesPath}
        daemonClient={client}
      />
    );
  }

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Text>{status}</Text>
    </Box>
  );
}
