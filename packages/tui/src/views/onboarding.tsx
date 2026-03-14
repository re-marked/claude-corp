import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import {
  scaffoldCorp,
  setupCeo,
  ensureGlobalConfig,
  readConfig,
  findCorp,
  type Channel,
  type Member,
  MEMBERS_JSON,
  CHANNELS_JSON,
} from '@agentcorp/shared';
import { Daemon } from '@agentcorp/daemon';
import { join } from 'node:path';
import { ChatView } from './chat.js';
import { DaemonClient } from '../lib/daemon-client.js';

type Step = 'your-name' | 'corp-name' | 'spawning' | 'ready';

export function OnboardingView() {
  const [step, setStep] = useState<Step>('your-name');
  const [userName, setUserName] = useState('');
  const [corpName, setCorpName] = useState('');
  const [error, setError] = useState('');
  const [statusText, setStatusText] = useState('');
  const [daemon, setDaemon] = useState<Daemon | null>(null);
  const [daemonClient, setDaemonClient] = useState<DaemonClient | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [messagesPath, setMessagesPath] = useState('');

  const handleUserNameSubmit = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name cannot be empty');
      return;
    }
    setUserName(trimmed);
    setStep('corp-name');
    setError('');
  };

  const handleCorpNameSubmit = async (name: string) => {
    const trimmed = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!trimmed) {
      setError('Name cannot be empty');
      return;
    }
    if (findCorp(trimmed)) {
      setError('A corporation with that name already exists');
      return;
    }

    setCorpName(trimmed);
    setStep('spawning');
    setError('');

    try {
      // Step 1: Ensure config (auto-detects user's OpenClaw gateway)
      const globalConfig = ensureGlobalConfig();

      // Step 2: Scaffold corp
      setStatusText('Creating corporation...');
      const root = await scaffoldCorp(trimmed, userName);

      // Step 3: Setup CEO
      setStatusText('Setting up your CEO...');
      const { dmChannel } = setupCeo(root, globalConfig, userName);

      // Step 4: Start daemon
      setStatusText('Starting daemon...');
      const d = new Daemon(root, globalConfig);
      const port = await d.start();
      setDaemon(d);
      setDaemonClient(new DaemonClient(port));

      // Step 5: Connect to CEO
      if (globalConfig.userGateway) {
        setStatusText('Connecting to your OpenClaw...');
      } else {
        setStatusText('Waking up your CEO...');
      }
      await d.spawnAllAgents();

      // Wait for CEO to be ready
      const maxWait = globalConfig.userGateway ? 5 : 30; // Remote = fast, local = slow
      let ready = false;
      for (let i = 0; i < maxWait; i++) {
        const agents = d.processManager.listAgents();
        if (agents.some((a) => a.status === 'ready')) {
          ready = true;
          break;
        }
        if (agents.some((a) => a.status === 'crashed')) {
          break; // Don't wait if already crashed
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (!ready) {
        if (globalConfig.userGateway) {
          setError('Cannot reach your OpenClaw gateway. Make sure it is running: openclaw gateway run');
        } else {
          setError('CEO failed to start. Check that OpenClaw is installed and API keys are configured in ~/.agentcorp/global-config.json');
        }
        return;
      }

      // Load channel and members for chat view
      const allMembers = readConfig<Member[]>(join(root, MEMBERS_JSON));
      const allChannels = readConfig<Channel[]>(join(root, CHANNELS_JSON));
      const dm = allChannels.find((c) => c.id === dmChannel.id) ?? dmChannel;

      setMembers(allMembers);
      setChannel(dm);
      setMessagesPath(join(root, dm.path, 'messages.jsonl'));
      setStep('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      daemon?.stop();
    };
  }, [daemon]);

  if (step === 'your-name') {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <Box marginBottom={1}>
          <Text bold>What's your name?</Text>
        </Box>
        <Box>
          <Text bold color="green">&gt; </Text>
          <TextInput
            value={userName}
            onChange={(v) => { setUserName(v); setError(''); }}
            onSubmit={handleUserNameSubmit}
            placeholder="Mark"
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Your CEO will know you by this name.
          </Text>
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (step === 'corp-name') {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <Box marginBottom={1}>
          <Text bold>Name your corporation</Text>
        </Box>
        <Box>
          <Text bold color="green">&gt; </Text>
          <TextInput
            value={corpName}
            onChange={(v) => { setCorpName(v); setError(''); }}
            onSubmit={handleCorpNameSubmit}
            placeholder="my-corporation"
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            This is your company, {userName}. You are the founder.{'\n'}
            Your AI CEO will handle the rest.
          </Text>
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (step === 'spawning') {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <Box marginBottom={1}>
          <Text bold>Setting up {corpName}...</Text>
        </Box>
        <Box gap={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>{statusText}</Text>
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // step === 'ready'
  if (channel && daemonClient && messagesPath) {
    return (
      <ChatView
        channel={channel}
        members={members}
        messagesPath={messagesPath}
        daemonClient={daemonClient}
      />
    );
  }

  return <Text color="red">Something went wrong.</Text>;
}
