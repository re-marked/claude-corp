import React, { useState, useEffect, useContext } from 'react';
import { Box, Text, useInput, TerminalSizeContext } from '@claude-code-kit/ink-renderer';
import { TextInput } from '../components/text-input.js';
import { Spinner } from '../components/spinner.js';
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
import { Daemon, setSilentMode } from '@claudecorp/daemon';
import { join } from 'node:path';
import { ChatView } from './chat.js';
import { CommandPalette } from './command-palette.js';
import { DaemonClient } from '../lib/daemon-client.js';
import { CorpProvider } from '../context/corp-context.js';
import { COLORS, BORDER_STYLE } from '../theme.js';
import { CLAUDE_CORP_LOGO, asciiName } from '../ascii.js';

type Step = 'your-name' | 'corp-name' | 'theme' | 'dm-mode' | 'spawning' | 'restart-warning' | 'ready';

const RECONNECT_INTERVAL = 5;

const THEMES = getAllThemes();

export function OnboardingView({ onComplete }: { onComplete?: () => void }) {
  const [step, setStep] = useState<Step>('your-name');
  const [userName, setUserName] = useState('');
  const [corpName, setCorpName] = useState('');
  const [themeIndex, setThemeIndex] = useState(0);
  const [dmModeIndex, setDmModeIndex] = useState(0); // 0 = jack (recommended), 1 = async
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
  const termSize = useContext(TerminalSizeContext);
  const termHeight = termSize?.rows ?? 40;

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
    if (step === 'theme') {
      if (key.upArrow) setThemeIndex((i) => Math.max(0, i - 1));
      if (key.downArrow) setThemeIndex((i) => Math.min(THEMES.length - 1, i + 1));
      if (key.return) { setStep('dm-mode'); setError(''); }
      return;
    }
    if (step === 'dm-mode') {
      if (key.upArrow || key.downArrow) setDmModeIndex((i) => i === 0 ? 1 : 0);
      if (key.return) startSetup();
      return;
    }
    if (step === 'restart-warning') {
      if (key.return) {
        // Continue without restart — try to resume normally
        if (onComplete) {
          onComplete();
        } else {
          setStep('ready');
        }
      }
      return;
    }
  });

  const startSetup = async () => {
    const selectedTheme = THEMES[themeIndex]!;
    setStep('spawning');

    try {
      const globalConfig = ensureGlobalConfig();

      const selectedDmMode = dmModeIndex === 0 ? 'jack' : 'async' as const;
      setStatusText('Creating corporation...');
      const root = await scaffoldCorp(corpName, userName, selectedTheme.id as ThemeId, selectedDmMode);
      setCorpRoot(root);

      setStatusText(`${selectedTheme.ranks.master} is waking up...`);
      const { dmChannel } = setupCeo(root, globalConfig, userName);

      const { writeFileSync: dbg } = await import('node:fs');
      const logf = (m: string) => dbg(join(root, 'boot.log'), m + '\n', { flag: 'a' });

      setStatusText('Starting daemon...');
      setSilentMode(true);
      logf('Starting daemon...');
      const d = new Daemon(root, globalConfig);
      const port = await d.start();
      logf('Daemon on port ' + port);
      setDaemon(d);
      setDaemonPort(port);
      setDaemonClient(new DaemonClient(port));

      setStatusText(globalConfig.userGateway
        ? 'Connecting to your OpenClaw...'
        : `Waking up your ${selectedTheme.ranks.master}...`);

      logf('Spawning agents...');
      try {
        await d.spawnAllAgents();
        logf('spawnAll done');
      } catch (e) {
        logf('spawnAll error: ' + (e instanceof Error ? e.message : String(e)));
      }

      const agentList = d.processManager.listAgents();
      logf('Agents: ' + JSON.stringify(agentList.map((a: any) => ({ n: a.displayName, s: a.status }))));
      let ready = agentList.some((a) => a.status === 'ready');
      if (!ready) {
        // Give it a few seconds
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const agents = d.processManager.listAgents();
          if (agents.some((a) => a.status === 'ready')) { ready = true; break; }
          if (agents.some((a) => a.status === 'crashed')) break;
        }
      }

      if (!ready) {
        setError('Could not connect to OpenClaw. Make sure it is running: openclaw gateway run');
        return;
      }

      // NOTE: Do NOT call d.startRouter() here. This daemon is temporary —
      // it only spawns agents and verifies health. The kickoff message written
      // below will be dispatched by ResumeView's daemon, preventing double dispatch.

      const allMembers = readConfig<Member[]>(join(root, MEMBERS_JSON));
      const allChannels = readConfig<Channel[]>(join(root, CHANNELS_JSON));
      const dm = allChannels.find((c) => c.id === dmChannel.id) ?? dmChannel;

      setMembers(allMembers);
      setChannels(allChannels);
      setChannel(dm);
      setMessagesPath(join(root, dm.path, 'messages.jsonl'));

      // Send system message to trigger CEO founding conversation
      const { post: postMsg } = await import('@claudecorp/shared');
      const dmPath = join(root, dm.path, 'messages.jsonl');
      postMsg(dm.id, dmPath, {
        senderId: 'system',
        content: `New corporation "${corpName}" created. The ${selectedTheme.ranks.owner} is here. Read your BOOTSTRAP.md and begin the founding conversation.`,
        source: 'system',
      });

      // Stop this daemon — ResumeView will create its own
      d.stop();
      setDaemon(null);

      // Show restart warning — first boot can have stale agent state
      setStatusText('Corp created! Restart recommended on first boot.');
      setStep('restart-warning');
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
                      Channels: #{t.channels.general}  #{t.channels.tasks}  #{t.channels.logs}
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

  if (step === 'dm-mode') {
    const modes = [
      { id: 'jack', name: 'Jack (recommended)', desc: 'Live persistent sessions. Agents remember your conversation. Efficient — no history re-sent.' },
      { id: 'async', name: 'Async (deprecated)', desc: 'Stateless messages. Each dispatch is independent. History re-sent every time. Will be removed in v1.' },
    ];
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height={termHeight}>
        <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.primary} paddingX={3} paddingY={1} width={60}>
          <Box marginBottom={1}>
            <Text bold color={COLORS.primary}>DM mode</Text>
          </Box>

          {modes.map((m, i) => {
            const isSel = i === dmModeIndex;
            return (
              <Box key={m.id} flexDirection="column" marginBottom={1}>
                <Box gap={1}>
                  <Text color={isSel ? COLORS.primary : COLORS.muted}>{isSel ? '▸' : ' '}</Text>
                  <Text bold={isSel} color={isSel ? COLORS.text : COLORS.subtle}>{m.name}</Text>
                </Box>
                {isSel && (
                  <Box paddingLeft={3}>
                    <Text color={COLORS.subtle}>{m.desc}</Text>
                  </Box>
                )}
              </Box>
            );
          })}

          {dmModeIndex === 1 && (
            <Box marginTop={1}>
              <Text color={COLORS.danger}>Warning: async mode is deprecated and will be removed.</Text>
            </Box>
          )}

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
            <Text color={COLORS.primary}><Spinner /></Text>
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

  if (step === 'restart-warning') {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} height={termHeight}>
        <Text color={COLORS.primary}>{asciiName(corpName)}</Text>
        <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.warning} paddingX={3} paddingY={1} width={56} marginTop={1}>
          <Box marginBottom={1}>
            <Text bold color={COLORS.warning}>Corp created successfully!</Text>
          </Box>
          <Box flexDirection="column" gap={0}>
            <Text color={COLORS.text}>For the best experience on first boot, restart the TUI:</Text>
            <Text color={COLORS.muted}> </Text>
            <Text color={COLORS.info}>  Close this window and run the command again.</Text>
            <Text color={COLORS.muted}> </Text>
            <Text color={COLORS.subtle}>Some agents may not initialize properly on the very first</Text>
            <Text color={COLORS.subtle}>launch. A restart ensures everything connects cleanly.</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={COLORS.muted}>Press Enter to continue without restarting</Text>
          </Box>
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
