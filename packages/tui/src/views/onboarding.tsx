import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
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
} from '@claudecorp/shared';
import { Daemon } from '@claudecorp/daemon';
import { join } from 'node:path';
import { ChatView } from './chat.js';
import { CommandPalette } from './command-palette.js';
import { DaemonClient } from '../lib/daemon-client.js';
import { CorpProvider } from '../context/corp-context.js';
import { COLORS, BORDER_STYLE } from '../theme.js';
import { CLAUDE_CORP_LOGO, asciiName } from '../ascii.js';

type Step = 'your-name' | 'corp-name' | 'theme' | 'spawning' | 'ready';

const RECONNECT_INTERVAL = 5;

const THEMES = getAllThemes();

export function OnboardingView({ onComplete }: { onComplete?: () => void }) {
  const [step, setStep] = useState<Step>('your-name');
  const [userName, setUserName] = useState('');
  const [corpName, setCorpName] = useState('');
  const [themeIndex, setThemeIndex] = useState(0);
  const [error, setError] = useState('');
  const [statusText, setStatusText] = useState('');
  const [daemon, setDaemon] = useState<Daemon | null>(null);
  const [daemonClient, setDaemonClient] = useState<DaemonClient | null>(null);
  const [daemonPort, setDaemonPort] = useState(0);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [messagesPath, setMessagesPath] = useState('');
  const [corpRoot, setCorpRoot] = useState('');
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 40;

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
      setDaemonPort(port);
      setDaemonClient(new DaemonClient(port));

      const tryConnect = async (): Promise<boolean> => {
        if (globalConfig.userGateway) {
          setStatusText(`Connecting to your OpenClaw...`);
        } else {
          setStatusText(`Waking up your ${selectedTheme.ranks.master}...`);
        }

        try {
          await d.spawnAllAgents();
        } catch {
          // swallow — partial start is ok
        }

        const maxWait = globalConfig.userGateway ? 5 : 30;
        for (let i = 0; i < maxWait; i++) {
          const agents = d.processManager.listAgents();
          if (agents.some((a) => a.status === 'ready')) return true;
          if (agents.some((a) => a.status === 'crashed')) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        return false;
      };

      let ready = await tryConnect();

      // Retry loop for gateway connections
      while (!ready && globalConfig.userGateway) {
        setError('Cannot reach your OpenClaw gateway. Make sure it is running: openclaw gateway run');
        setReconnecting(true);

        // Countdown timer
        for (let s = RECONNECT_INTERVAL; s > 0; s--) {
          setCountdown(s);
          await new Promise((r) => setTimeout(r, 1000));
        }
        setCountdown(0);
        setError('');
        ready = await tryConnect();
      }

      setReconnecting(false);

      if (!ready) {
        setError(`${selectedTheme.ranks.master} failed to start.`);
        return;
      }

      d.startRouter();

      const allMembers = readConfig<Member[]>(join(root, MEMBERS_JSON));
      const allChannels = readConfig<Channel[]>(join(root, CHANNELS_JSON));
      const dm = allChannels.find((c) => c.id === dmChannel.id) ?? dmChannel;

      setMembers(allMembers);
      setChannels(allChannels);
      setChannel(dm);
      setMessagesPath(join(root, dm.path, 'messages.jsonl'));

      // Send system message to trigger CEO onboarding interview
      const { appendMessage: append, generateId: genId } = await import('@claudecorp/shared');
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

      // Stop this daemon — ResumeView will create its own
      d.stop();
      setDaemon(null);

      // Transition to ResumeView (which shows Corp Home)
      if (onComplete) {
        onComplete();
        return;
      }
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
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height={termHeight}>
        <Text color={COLORS.primary}>{CLAUDE_CORP_LOGO}</Text>
        <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.primary} paddingX={3} paddingY={1} width={50} marginTop={1}>
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
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height={termHeight}>
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
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height={termHeight}>
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
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height={termHeight}>
        <Text color={COLORS.primary}>{asciiName(corpName)}</Text>
        <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.border} paddingX={3} paddingY={1} width={50} marginTop={1}>
          <Box gap={1}>
            <Text color={COLORS.primary}><Spinner type="dots" /></Text>
            <Text color={COLORS.subtle}>{statusText}</Text>
          </Box>
          {error && <Box marginTop={1}><Text color={COLORS.danger}>{error}</Text></Box>}
          {reconnecting && countdown > 0 && (
            <Box marginTop={0}>
              <Text color={COLORS.muted}>Reconnecting in {countdown}s...</Text>
            </Box>
          )}
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
        <CorpProvider corpRoot={corpRoot} daemonClient={daemonClient} daemonPort={daemonPort} initialMembers={members} initialChannels={channels}>
          <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height={termHeight}>
            <CommandPalette
              lastVisited={new Map()}
              onNavigate={() => {}}
              onSelectChannel={switchToChannel}
              onCommand={() => {}}
              onClose={() => setShowSwitcher(false)}
            />
          </Box>
        </CorpProvider>
      );
    }

    return (
      <CorpProvider corpRoot={corpRoot} daemonClient={daemonClient} daemonPort={daemonPort} initialMembers={members} initialChannels={channels}>
        <ChatView
          channel={channel}
          messagesPath={messagesPath}
        />
      </CorpProvider>
    );
  }

  return <Text color={COLORS.danger}>Something went wrong.</Text>;
}
