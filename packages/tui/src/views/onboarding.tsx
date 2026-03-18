import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import {
  scaffoldCorp,
  setupCeo,
  ensureGlobalConfig,
  readConfig,
  findCorp,
  getAllThemes,
  type ThemeId,
  type Channel,
  type Member,
  MEMBERS_JSON,
  CHANNELS_JSON,
} from '@agentcorp/shared';
import { Daemon } from '@agentcorp/daemon';
import { join } from 'node:path';
import { ChatView } from './chat.js';
import { CommandPalette } from './command-palette.js';
import { DaemonClient } from '../lib/daemon-client.js';
import { COLORS, BORDER_STYLE } from '../theme.js';

type Step = 'your-name' | 'corp-name' | 'theme' | 'spawning' | 'ready';

const THEMES = getAllThemes();

export function OnboardingView() {
  const [step, setStep] = useState<Step>('your-name');
  const [userName, setUserName] = useState('');
  const [corpName, setCorpName] = useState('');
  const [themeIndex, setThemeIndex] = useState(0);
  const [error, setError] = useState('');
  const [statusText, setStatusText] = useState('');
  const [daemon, setDaemon] = useState<Daemon | null>(null);
  const [daemonClient, setDaemonClient] = useState<DaemonClient | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [messagesPath, setMessagesPath] = useState('');
  const [corpRoot, setCorpRoot] = useState('');
  const [showSwitcher, setShowSwitcher] = useState(false);

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

  const handleCorpNameSubmit = (name: string) => {
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
    setStep('theme');
    setError('');
  };

  // Theme selection keyboard
  useInput((input, key) => {
    if (step !== 'theme') return;
    if (key.upArrow) setThemeIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setThemeIndex((i) => Math.min(THEMES.length - 1, i + 1));
    if (key.return) startSetup();
  });

  const startSetup = async () => {
    const selectedTheme = THEMES[themeIndex]!;
    setStep('spawning');

    try {
      const globalConfig = ensureGlobalConfig();

      setStatusText('Creating corporation...');
      const root = await scaffoldCorp(corpName, userName, selectedTheme.id as ThemeId);
      setCorpRoot(root);

      setStatusText(`${selectedTheme.ranks.master} is waking up...`);
      const { dmChannel } = setupCeo(root, globalConfig, userName);

      setStatusText('Starting daemon...');
      const d = new Daemon(root, globalConfig);
      const port = await d.start();
      setDaemon(d);
      setDaemonClient(new DaemonClient(port));

      if (globalConfig.userGateway) {
        setStatusText(`Connecting to your OpenClaw...`);
      } else {
        setStatusText(`Waking up your ${selectedTheme.ranks.master}...`);
      }
      await d.spawnAllAgents();

      const maxWait = globalConfig.userGateway ? 5 : 30;
      let ready = false;
      for (let i = 0; i < maxWait; i++) {
        const agents = d.processManager.listAgents();
        if (agents.some((a) => a.status === 'ready')) {
          ready = true;
          break;
        }
        if (agents.some((a) => a.status === 'crashed')) break;
        await new Promise((r) => setTimeout(r, 1000));
      }

      d.startRouter();

      if (!ready) {
        if (globalConfig.userGateway) {
          setError('Cannot reach your OpenClaw gateway. Make sure it is running: openclaw gateway run');
        } else {
          setError(`${selectedTheme.ranks.master} failed to start.`);
        }
        return;
      }

      const allMembers = readConfig<Member[]>(join(root, MEMBERS_JSON));
      const allChannels = readConfig<Channel[]>(join(root, CHANNELS_JSON));
      const dm = allChannels.find((c) => c.id === dmChannel.id) ?? dmChannel;

      setMembers(allMembers);
      setChannels(allChannels);
      setChannel(dm);
      setMessagesPath(join(root, dm.path, 'messages.jsonl'));

      // Send system message to trigger CEO onboarding interview
      const { appendMessage: append, generateId: genId } = await import('@agentcorp/shared');
      const dmPath = join(root, dm.path, 'messages.jsonl');
      const kickoff = {
        id: genId(),
        channelId: dm.id,
        senderId: 'system',
        threadId: null,
        content: `New corporation "${corpName}" created. The ${selectedTheme.ranks.owner} is here. Introduce yourself and begin the onboarding interview — ask what they want this corporation to accomplish.`,
        kind: 'text' as const,
        mentions: [],
        metadata: null,
        depth: 0,
        originId: '',
        timestamp: new Date().toISOString(),
      };
      kickoff.originId = kickoff.id;
      append(dmPath, kickoff);

      setStep('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    return () => { daemon?.stop(); };
  }, [daemon]);

  // --- RENDERS ---

  if (step === 'your-name') {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height="100%">
        <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.primary} paddingX={3} paddingY={1} width={50}>
          <Box marginBottom={1}>
            <Text bold color={COLORS.primary}>What's your name?</Text>
          </Box>
          <Box>
            <Text bold color={COLORS.primary}>&gt; </Text>
            <TextInput
              value={userName}
              onChange={(v) => { setUserName(v); setError(''); }}
              onSubmit={handleUserNameSubmit}
              placeholder="Mark"
            />
          </Box>
          {error && <Text color={COLORS.danger}>{error}</Text>}
        </Box>
      </Box>
    );
  }

  if (step === 'corp-name') {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height="100%">
        <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.primary} paddingX={3} paddingY={1} width={50}>
          <Box marginBottom={1}>
            <Text bold color={COLORS.primary}>Name your corporation</Text>
          </Box>
          <Box>
            <Text bold color={COLORS.primary}>&gt; </Text>
            <TextInput
              value={corpName}
              onChange={(v) => { setCorpName(v); setError(''); }}
              onSubmit={handleCorpNameSubmit}
              placeholder="my-corporation"
            />
          </Box>
          <Box marginTop={1}>
            <Text color={COLORS.muted}>This is your company, {userName}.</Text>
          </Box>
          {error && <Text color={COLORS.danger}>{error}</Text>}
        </Box>
      </Box>
    );
  }

  if (step === 'theme') {
    const selected = THEMES[themeIndex]!;
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height="100%">
        <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.primary} paddingX={3} paddingY={1} width={60}>
          <Box marginBottom={1}>
            <Text bold color={COLORS.primary}>Choose your style</Text>
          </Box>

          {THEMES.map((t, i) => {
            const isSel = i === themeIndex;
            return (
              <Box key={t.id} flexDirection="column" marginBottom={i < THEMES.length - 1 ? 1 : 0}>
                <Box gap={1}>
                  <Text color={isSel ? COLORS.primary : COLORS.muted}>{isSel ? '▸' : ' '}</Text>
                  <Text bold={isSel} color={isSel ? COLORS.text : COLORS.subtle}>{t.name}</Text>
                  <Text color={COLORS.muted}>— {t.tagline}</Text>
                </Box>
                {isSel && (
                  <Box paddingLeft={3} flexDirection="column">
                    <Text color={COLORS.subtle}>
                      {t.ranks.owner} → {t.ranks.master} → {t.ranks.leader} → {t.ranks.worker} → {t.ranks.subagent}
                    </Text>
                    <Text color={COLORS.muted}>
                      Channels: #{t.channels.general}  #{t.channels.tasks}  #{t.channels.system}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}

          <Box marginTop={1}>
            <Text color={COLORS.muted}>↑↓ to select, Enter to confirm</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (step === 'spawning') {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height="100%">
        <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.border} paddingX={3} paddingY={1} width={50}>
          <Box gap={1}>
            <Text color={COLORS.primary}><Spinner type="dots" /></Text>
            <Text color={COLORS.subtle}>{statusText}</Text>
          </Box>
          {error && <Box marginTop={1}><Text color={COLORS.danger}>{error}</Text></Box>}
        </Box>
      </Box>
    );
  }

  const switchToChannel = (ch: Channel) => {
    setChannel(ch);
    setMessagesPath(join(corpRoot, ch.path, 'messages.jsonl'));
    setShowSwitcher(false);
  };

  if (channel && daemonClient && messagesPath) {
    if (showSwitcher) {
      return (
        <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height="100%">
          <CommandPalette
            channels={channels}
            members={members}
            onNavigate={() => {}}
            onSelectChannel={switchToChannel}
            onCommand={() => {}}
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
        daemonClient={daemonClient}
        corpRoot={corpRoot}
        onSwitchChannel={() => setShowSwitcher(true)}
      />
    );
  }

  return <Text color={COLORS.danger}>Something went wrong.</Text>;
}
