import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Box, Text, useInput, Static } from 'ink';
import Spinner from 'ink-spinner';
import {
  type Channel,
  type Member,
  type ChannelMessage,
  readConfig,
  appendMessage,
  generateId,
  MEMBERS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import { join } from 'node:path';
import { MessageList, renderContent } from '../components/message-list.js';
import { MessageInput } from '../components/message-input.js';
import { MemberSidebar } from '../components/member-sidebar.js';
import { useMessages } from '../hooks/use-messages.js';
import { HireWizard } from './hire-wizard.js';
import { ModelWizard } from './model-wizard.js';
import { COLORS, BORDER_STYLE, agentColor } from '../theme.js';
import { TaskWizard } from './task-wizard.js';
import { ProjectWizard } from './project-wizard.js';
import { TeamWizard } from './team-wizard.js';
import { useCorp } from '../context/corp-context.js';

const THINKING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — agents can work long

interface StreamData {
  agentName: string;
  content: string;
  channelId: string;
}

interface Props {
  channel: Channel;
  messagesPath: string;
  /** Streaming state from WebSocket events */
  streamData?: StreamData | null;
  /** Agent names currently dispatching */
  dispatchingAgents?: string[];
  /** Active tool call (from WebSocket) */
  activeToolCall?: { agentName: string; toolName: string } | null;
  onNavigate?: (view: import('../navigation.js').View) => void;
}

export function ChatView({ channel, messagesPath, streamData, dispatchingAgents = [], activeToolCall, onNavigate }: Props) {
  const { corpRoot, daemonClient, members: ctxMembers } = useCorp();
  const [activeThread, setActiveThread] = useState<string | undefined>(undefined);
  const { messages, threadCounts, refresh: refreshMessages } = useMessages(messagesPath, 50, activeThread);
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [thinkingAgents, setThinkingAgents] = useState<string[]>([]);
  const [members, setMembers] = useState(ctxMembers);
  const [showHireWizard, setShowHireWizard] = useState(false);
  const [showModelWizard, setShowModelWizard] = useState(false);
  const [showTaskWizard, setShowTaskWizard] = useState(false);
  const [showProjectWizard, setShowProjectWizard] = useState(false);
  const [showTeamWizard, setShowTeamWizard] = useState(false);
  const [showMemberSidebar, setShowMemberSidebar] = useState(false);

  // Jack mode — persistent conversation session with an agent
  // Default: jack is ON for DMs (corp.json defaultDmMode, defaults to 'jack')
  const [jackMode, setJackMode] = useState<{
    active: boolean;
    sessionKey: string;
    agentSlug: string;
    agentName: string;
    agentId: string;
  } | null>(null);

  // Auto-jack on DM channel entry
  useEffect(() => {
    if (channel.kind !== 'direct') {
      setJackMode(null);
      return;
    }

    // Read corp defaultDmMode (defaults to 'jack')
    let dmMode: 'jack' | 'async' = 'jack';
    try {
      const { readConfig, CORP_JSON } = require('@claudecorp/shared');
      const corp = readConfig(join(corpRoot, CORP_JSON));
      if (corp.defaultDmMode === 'async') dmMode = 'async';
    } catch {}

    if (dmMode !== 'jack') return;

    // Find the agent in this DM
    const founder = members.find(m => m.rank === 'owner');
    const agent = members.find(m =>
      m.type === 'agent' && channel.memberIds.includes(m.id) && m.id !== founder?.id,
    );
    if (!agent) return;

    const slug = agent.displayName.toLowerCase().replace(/\s+/g, '-');
    setJackMode({
      active: true,
      sessionKey: `jack:${slug}:${Date.now()}`,
      agentSlug: slug,
      agentName: agent.displayName,
      agentId: agent.id,
    });
  }, [channel.id]); // Re-run on channel switch
  const lastMsgCount = useRef(messages.length);
  // Update tab title when channel changes
  useEffect(() => {
    process.stdout.write(`\x1b]0;Claude Corp \u25C6 #${channel.name}\x07`);
  }, [channel.id]);

  // Refresh members when new messages arrive (new agents may have been hired)
  useEffect(() => {
    if (messages.length > lastMsgCount.current) {
      try {
        const fresh = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
        if (fresh.length !== members.length) {
          setMembers(fresh);
        }
      } catch {
        // Non-fatal
      }
    }
  }, [messages.length]);

  // When a new message arrives from someone else, stop thinking
  useEffect(() => {
    if (messages.length > lastMsgCount.current) {
      const newMsg = messages[messages.length - 1];
      const founder = members.find((m) => m.rank === 'owner');
      if (newMsg && founder && newMsg.senderId !== founder.id && newMsg.kind === 'text') {
        setThinking(false);
        process.stdout.write('\x07'); // Terminal bell
      }
    }
    lastMsgCount.current = messages.length;
  }, [messages.length]);

  // Streaming + dispatch state now comes from WebSocket events (via props)

  // Timeout the spinner
  useEffect(() => {
    if (!thinking) return;
    const timer = setTimeout(() => setThinking(false), THINKING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [thinking]);

  // Detect DM channel — find the other agent
  const isDm = channel.kind === 'direct';
  const dmAgent = isDm
    ? members.find((m) => channel.memberIds.includes(m.id) && m.type === 'agent')
    : null;

  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  useInput((input, key) => {
    if (showHireWizard || showModelWizard) return;
    if (key.ctrl && input === 'm') {
      setShowMemberSidebar(prev => !prev);
    }
    // Ctrl+Y — open/close thread view (Ctrl+T is task board)
    if (key.ctrl && input === 'y') {
      if (activeThread) {
        setActiveThread(undefined);
      } else {
        // Open the thread with most replies
        const sorted = [...threadCounts.entries()].sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0) setActiveThread(sorted[0]![0]);
      }
    }
  });

  const writeSystemMessage = (content: string) => {
    const sysMsg: ChannelMessage = {
      id: generateId(),
      channelId: channel.id,
      senderId: 'system',
      threadId: null,
      content,
      kind: 'system',
      mentions: [],
      metadata: null,
      depth: 0,
      originId: '',
      timestamp: new Date().toISOString(),
    };
    sysMsg.originId = sysMsg.id;
    appendMessage(join(corpRoot, channel.path, MESSAGES_JSONL), sysMsg);
  };

  const handleHired = (agentName: string, displayName: string) => {
    // Write system message to current channel
    writeSystemMessage(`${displayName} has been hired as ${agentName}. You can now @mention them.`);
    // Refresh members
    try {
      const fresh = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
      setMembers(fresh);
    } catch {}
    // Close wizard after a moment
    setTimeout(() => setShowHireWizard(false), 1500);
  };

  const handleSend = useCallback(async (text: string) => {
    // /jack — re-enter live session (if previously unjacked)
    if (text.trim().toLowerCase() === '/jack') {
      if (channel.kind !== 'direct') {
        writeSystemMessage('Jack only works in DM channels. Navigate to an agent DM first.');
        return;
      }
      if (jackMode?.active) {
        writeSystemMessage('Already jacked. Type /unjack to switch to async mode.');
        return;
      }
      const founder = members.find(m => m.rank === 'owner');
      const agent = members.find(m =>
        m.type === 'agent' && channel.memberIds.includes(m.id) && m.id !== founder?.id,
      );
      if (!agent) {
        writeSystemMessage('No agent found in this DM channel.');
        return;
      }
      const slug = agent.displayName.toLowerCase().replace(/\s+/g, '-');
      setJackMode({
        active: true,
        sessionKey: `jack:${slug}:${Date.now()}`,
        agentSlug: slug,
        agentName: agent.displayName,
        agentId: agent.id,
      });
      writeSystemMessage(`Jacked into ${agent.displayName}. Live session — persistent memory. /unjack to switch to async.`);
      return;
    }

    // /unjack or /async-deprecated — drop to stateless async mode
    if (text.trim().toLowerCase() === '/unjack' || text.trim().toLowerCase() === '/async-deprecated') {
      if (!jackMode?.active) {
        writeSystemMessage('Already in async mode. Type /jack to enter live session.');
        return;
      }
      setJackMode(null);
      writeSystemMessage('Unjacked. Async mode (deprecated) — each message is stateless. /jack to re-enter live session.');
      return;
    }

    // /hire opens the wizard
    if (text.trim().toLowerCase() === '/hire') {
      setShowHireWizard(true);
      return;
    }

    // /model opens the model selector
    if (text.trim().toLowerCase() === '/model') {
      setShowModelWizard(true);
      return;
    }

    // /theme cycles through color palettes
    if (text.trim().toLowerCase().startsWith('/theme')) {
      const { PALETTE_NAMES, PALETTES, saveTheme, currentThemeName } = await import('../theme.js');
      const arg = text.trim().split(/\s+/)[1]?.toLowerCase();
      if (arg && PALETTES[arg]) {
        saveTheme(arg);
        process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
        writeSystemMessage(`Theme: ${arg}`);
      } else {
        const current = currentThemeName();
        const idx = PALETTE_NAMES.indexOf(current);
        const next = PALETTE_NAMES[(idx + 1) % PALETTE_NAMES.length]!;
        saveTheme(next);
        process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
        writeSystemMessage(`Theme: ${next} (${PALETTE_NAMES.join(' | ')})`);
      }
      return;
    }

    // /task opens the task wizard
    if (text.trim().toLowerCase() === '/task') {
      setShowTaskWizard(true);
      return;
    }

    // /status shows agent work status inline
    if (text.trim().toLowerCase() === '/status') {
      try {
        const status = await daemonClient.status();
        const lines = status.agents.map((a: any) => {
          const ws = a.workStatus ?? 'offline';
          const icon = ws === 'idle' || ws === 'busy' ? '\u25CF' : '\u25CB';
          return `${icon} ${a.displayName.padEnd(16)} ${ws}`;
        });
        writeSystemMessage(`Agent Status:\n${lines.join('\n')}`);
      } catch {
        writeSystemMessage('Failed to get status');
      }
      return;
    }

    // /project opens the project wizard
    if (text.trim().toLowerCase() === '/project') {
      setShowProjectWizard(true);
      return;
    }

    // /team opens the team wizard
    if (text.trim().toLowerCase() === '/team') {
      setShowTeamWizard(true);
      return;
    }

    // /time-machine, /tm, /rewind, /forward — all open the Time Machine view
    if (text.trim().toLowerCase() === '/time-machine' || text.trim().toLowerCase() === '/tm' || text.trim().toLowerCase() === '/rewind' || text.trim().toLowerCase() === '/forward' || text.trim().toLowerCase() === '/ff') {
      onNavigate?.({ type: 'time-machine' });
      return;
    }

    // /thread — view or exit thread
    if (text.trim().toLowerCase() === '/thread' || text.trim().toLowerCase() === '/t') {
      if (activeThread) {
        setActiveThread(undefined); // back to main channel
      } else {
        // Open the most recent thread
        const sorted = [...threadCounts.entries()].sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0) {
          setActiveThread(sorted[0]![0]);
        }
      }
      return;
    }

    // /ping responds with pong!
    if (text.trim().toLowerCase() === '/ping') {
      writeSystemMessage('pong!');
      return;
    }

    // /help shows available commands
    if (text.trim().toLowerCase() === '/help') {
      const helpText = [
        '━━━ Available Commands ━━━',
        '',
        '📍 Navigation:',
        '  /h, /hierarchy     View corp hierarchy',
        '  /t, /tasks         View task board',
        '  /a, /agents        View agents (alias for hierarchy)',
        '  /home              Go to corp home',
        '  /channels, /ch     List all channels',
        '',
        '📊 Info:',
        '  /who, /m, /members Show member roster with online/offline status',
        '  /stats             Show comprehensive corp statistics',
        '  /version           Show package versions and runtime info',
        '  /weather           Show current weather for London',
        '  /ping              Test command (responds with pong!)',
        '  /uptime            Show daemon uptime and message count',
        '  /logs              Show recent daemon logs',
        '  /tm                Open Time Machine (rewind/forward any snapshot)',
        '  /theme [name]      Switch color palette (coral|lavender|indigo|rose|mono)',
        '',
        '⚙️ Management:',
        '  /hire              Open agent hiring wizard',
        '  /model             View and change AI models',
        '  /task              Open task creation wizard',
        '  /project           Open project creation wizard',
        '  /team              Open team creation wizard',
        '  /dogfood           Set up development project',
        '  /help              Show this help message',
      ];
      writeSystemMessage(helpText.join('\n'));
      return;
    }

    // /stats — show comprehensive corp statistics
    if (text.trim().toLowerCase() === '/stats') {
      try {
        // Get agents and their status
        const agents = await daemonClient.listAgents();
        const statusMap = new Map(agents.map((a) => [a.memberId, a.status]));
        const online = members.filter((m) => m.type === 'user' || statusMap.get(m.id) === 'ready');
        const offline = members.filter((m) => m.type === 'agent' && statusMap.get(m.id) !== 'ready');

        // Get tasks by status
        const tasks = await daemonClient.listTasks();
        const taskStats = {
          pending: tasks.filter(t => t.status === 'pending').length,
          in_progress: tasks.filter(t => t.status === 'in_progress').length,
          completed: tasks.filter(t => t.status === 'completed').length,
          failed: tasks.filter(t => t.status === 'failed').length,
          blocked: tasks.filter(t => t.status === 'blocked').length,
        };

        // Get channels count
        const { readConfig: rc, CHANNELS_JSON: CJ } = await import('@claudecorp/shared');
        const { join: j } = await import('node:path');
        const allChannels = rc<{ name: string; kind: string; scope: string }[]>(j(corpRoot, CJ));
        
        // Get uptime and message count
        const { uptime, totalMessages } = await daemonClient.getUptime();

        const lines: string[] = [
          '━━━ Corp Statistics ━━━',
          '',
          '👥 Agents:',
          `   Online:  ${online.length}`,
          `   Offline: ${offline.length}`,
          `   Total:   ${members.length}`,
          '',
          '📋 Tasks:',
          `   Pending:     ${taskStats.pending}`,
          `   In Progress: ${taskStats.in_progress}`,
          `   Completed:   ${taskStats.completed}`,
          `   Failed:      ${taskStats.failed}`,
          `   Blocked:     ${taskStats.blocked}`,
          `   Total:       ${tasks.length}`,
          '',
          '💬 Channels:',
          `   Total: ${allChannels.length}`,
          '',
          '📊 Activity:',
          `   Messages: ${(totalMessages ?? 0).toLocaleString()}`,
          `   Uptime:   ${uptime}`,
        ];

        writeSystemMessage(lines.join('\n'));
      } catch (err) {
        writeSystemMessage(`Failed to fetch corp statistics: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /version — show package versions
    if (text.trim().toLowerCase() === '/version') {
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        
        // Read package.json files
        const sharedPkg = JSON.parse(fs.readFileSync(path.join(corpRoot, 'packages/shared/package.json'), 'utf8'));
        const daemonPkg = JSON.parse(fs.readFileSync(path.join(corpRoot, 'packages/daemon/package.json'), 'utf8'));
        const tuiPkg = JSON.parse(fs.readFileSync(path.join(corpRoot, 'packages/tui/package.json'), 'utf8'));
        const clipPkg = JSON.parse(fs.readFileSync(path.join(corpRoot, 'packages/cli/package.json'), 'utf8'));
        
        const lines = [
          '━━━ Version Information ━━━',
          '',
          '📦 Package Versions:',
          `   @claudecorp/shared: ${sharedPkg.version}`,
          `   @claudecorp/daemon: ${daemonPkg.version}`,
          `   @claudecorp/tui:    ${tuiPkg.version}`,
          `   @claudecorp/cli:    ${clipPkg.version}`,
          '',
          '⚙️ Runtime:',
          `   Node.js: ${process.version}`,
        ];
        
        writeSystemMessage(lines.join('\n'));
      } catch (error) {
        writeSystemMessage(`Error reading version info: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return;
    }

    // /weather — fetch current weather data
    if (text.trim().toLowerCase() === '/weather') {
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        
        // Read API configuration
        const configPath = path.join(corpRoot, 'weather-config.json');
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);
        const apiKey = config.apiKey;
        
        // Fetch weather from OpenWeatherMap API
        const url = `https://api.openweathermap.org/data/2.5/weather?q=London,UK&appid=${apiKey}&units=metric`;
        const response = await fetch(url);
        
        if (!response.ok) {
          throw new Error(`Weather API error: ${response.status} ${response.statusText}`);
        }
        
        const weatherData: any = await response.json();
        
        const lines = [
          '━━━ Weather: London ━━━',
          '',
          `🌡️ Temperature: ${Math.round(weatherData.main.temp)}°C`,
          `🌤️ Conditions: ${weatherData.weather[0].description}`,
          `💧 Humidity: ${weatherData.main.humidity}%`,
        ];
        
        writeSystemMessage(lines.join('\n'));
      } catch (err) {
        writeSystemMessage(`Failed to fetch weather: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /who, /m, /members — show member roster with status
    const cmd = text.trim().toLowerCase();
    if (cmd === '/who' || cmd === '/m' || cmd === '/members') {
      try {
        const agents = await daemonClient.listAgents();
        const statusMap = new Map(agents.map((a) => [a.memberId, a.status]));
        const online = members.filter((m) => m.type === 'user' || statusMap.get(m.id) === 'ready');
        const offline = members.filter((m) => m.type === 'agent' && statusMap.get(m.id) !== 'ready');

        const lines: string[] = [`━━━ Roster (${online.length} online) ━━━`];
        for (const m of online) {
          lines.push(`  ◆ ${m.displayName.padEnd(16)} ${m.rank.padEnd(8)} ${m.type === 'user' ? 'founder' : 'online'}`);
        }
        if (offline.length > 0) {
          lines.push('');
          for (const m of offline) {
            lines.push(`  ◇ ${m.displayName.padEnd(16)} ${m.rank.padEnd(8)} offline`);
          }
        }
        writeSystemMessage(lines.join('\n'));
      } catch (err) {
        writeSystemMessage(`Failed to fetch member status: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /uptime — show daemon uptime and message count
    if (cmd === '/uptime') {
      try {
        const { uptime, totalMessages } = await daemonClient.getUptime();
        
        // Format message count with commas
        const messageCountStr = (totalMessages ?? 0).toLocaleString();
        
        writeSystemMessage(`⏱ Uptime: ${uptime} | Messages: ${messageCountStr}`);
      } catch (err) {
        writeSystemMessage(`Failed to fetch uptime: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /logs — show recent daemon logs
    if (cmd === '/logs') {
      try {
        const { readFileSync, existsSync } = await import('node:fs');
        const { DAEMON_LOG_PATH } = await import('@claudecorp/shared');
        if (existsSync(DAEMON_LOG_PATH)) {
          const content = readFileSync(DAEMON_LOG_PATH, 'utf-8');
          const lines = content.trim().split('\n').slice(-30);
          writeSystemMessage('--- Recent Daemon Logs ---\n' + lines.join('\n'));
        } else {
          writeSystemMessage('No daemon logs found.');
        }
      } catch {}
      return;
    }

    // /channels — list all channels
    if (cmd === '/channels' || cmd === '/ch') {
      try {
        const { readConfig: rc, CHANNELS_JSON: CJ } = await import('@claudecorp/shared');
        const { join: j } = await import('node:path');
        const allCh = rc<{ name: string; kind: string; scope: string }[]>(j(corpRoot, CJ));
        const lines = ['━━━ Channels ━━━'];
        for (const c of allCh) {
          const icon = c.kind === 'direct' ? '◆' : '#';
          lines.push(`  ${icon} ${c.name.padEnd(24)} ${c.kind.padEnd(10)} ${c.scope}`);
        }
        writeSystemMessage(lines.join('\n'));
      } catch {}
      return;
    }

    // Navigation commands
    if (cmd === '/h' || cmd === '/hierarchy') {
      onNavigate?.({ type: 'hierarchy' });
      return;
    }
    if (cmd === '/t' || cmd === '/tasks') {
      onNavigate?.({ type: 'task-board' });
      return;
    }
    if (cmd === '/a' || cmd === '/agents') {
      onNavigate?.({ type: 'hierarchy' });
      return;
    }
    if (cmd === '/home') {
      onNavigate?.({ type: 'corp-home' });
      return;
    }
    if (cmd === '/clock' || cmd === '/clocks') {
      onNavigate?.({ type: 'clock' });
      return;
    }

    // /dogfood — set up a dev project pointing at this repo with a team and task
    if (cmd === '/dogfood') {
      writeSystemMessage('Setting up dogfood: project + dev team + task...');
      const f = members.find((m) => m.rank === 'owner');
      const ceo = members.find((m) => m.rank === 'master');
      const creatorId = ceo?.id ?? f?.id ?? '';
      const repoPath = process.cwd().replace(/\\/g, '/');

      try {
        // 1. Create project
        await daemonClient.createProject({
          name: 'claude-corp',
          type: 'codebase',
          path: repoPath,
          lead: ceo?.id,
          description: 'Claude Corp — the AI corporation framework itself. Dogfooding: agents build the tool that runs them.',
          createdBy: f?.id ?? '',
        });
        writeSystemMessage('Project "claude-corp" created.');

        // 2. Hire tech lead
        await daemonClient.hireAgent({
          creatorId,
          agentName: 'atlas',
          displayName: 'Atlas',
          rank: 'leader',
          soulContent: `# Identity

You are Atlas, the Tech Lead of the Claude Corp dev team.

# Responsibilities

- Architect features for the Claude Corp codebase (Node.js/TypeScript monorepo)
- Break down tasks into actionable sub-tasks and delegate to your team
- Review code quality, ensure changes follow existing patterns
- The codebase is at: ${repoPath}
- Packages: shared/ (types, parsers), daemon/ (router, process manager, gateway), tui/ (Ink/React terminal UI)
- Build command: cd ${repoPath} && pnpm build

# CRITICAL: You write REAL code

- You must ACTUALLY read files, write code, and run builds. Not describe what you would do.
- Use the write tool to create/modify files. Use bash to run builds and verify.
- Never claim something "already exists" without reading the actual file path first.
- After completing work: list every file you created or modified, and run pnpm build to prove it compiles.
- If a task says "implement X", that means X does NOT exist yet. Create it.

# Communication Style

Direct, technical, encouraging. Lead with specifics — file paths, function names, concrete suggestions.
When delegating, give clear acceptance criteria. When reviewing, check their actual file diffs.`,
        });
        writeSystemMessage('Atlas (Tech Lead) hired.');

        // 3. Hire frontend dev
        await daemonClient.hireAgent({
          creatorId,
          agentName: 'pixel',
          displayName: 'Pixel',
          rank: 'worker',
          soulContent: `# Identity

You are Pixel, a Frontend Developer specializing in terminal UIs.

# Responsibilities

- Build and improve TUI views and components (packages/tui/)
- Work with React/Ink to create beautiful terminal interfaces
- The codebase is at: ${repoPath}
- Key files: packages/tui/src/views/, packages/tui/src/components/, packages/tui/src/theme.ts
- Build command: cd ${repoPath} && pnpm build

# CRITICAL: You write REAL code

- You must ACTUALLY create .tsx files and modify existing ones. Use the write tool.
- Read existing views (chat.tsx, hierarchy.tsx) to understand patterns BEFORE writing.
- After writing code, run: cd ${repoPath} && pnpm build — if it fails, fix the errors.
- Never claim a component exists unless you read the file and saw the code.
- Your deliverable is working code, not descriptions of code.

# Communication Style

Creative, detail-oriented. You care about aesthetics AND usability.
Show your work — paste key snippets of what you wrote. Ask about edge cases.`,
        });
        writeSystemMessage('Pixel (Frontend Dev) hired.');

        // 4. Hire backend dev
        await daemonClient.hireAgent({
          creatorId,
          agentName: 'forge',
          displayName: 'Forge',
          rank: 'worker',
          soulContent: `# Identity

You are Forge, a Backend Developer focused on the daemon and shared libraries.

# Responsibilities

- Build and improve the daemon (packages/daemon/) — router, process manager, gateway, APIs
- Maintain shared types and utilities (packages/shared/)
- The codebase is at: ${repoPath}
- Key files: packages/daemon/src/, packages/shared/src/
- Build command: cd ${repoPath} && pnpm build

# CRITICAL: You write REAL code

- You must ACTUALLY create/modify .ts files. Use the write tool.
- Read existing code (daemon.ts, router.ts, process-manager.ts) to understand patterns BEFORE writing.
- After writing code, run: cd ${repoPath} && pnpm build — if it fails, fix the errors.
- Never claim something works without running the build. Never claim a file exists without reading it.
- Your deliverable is working code, not descriptions of code.

# Communication Style

Methodical, systems-thinking. You think about failure modes, race conditions, and data integrity.
Always consider what happens when things go wrong.`,
        });
        writeSystemMessage('Forge (Backend Dev) hired.');

        // 5. Refresh members
        try {
          const fresh = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
          setMembers(fresh);
        } catch {}

        // 6. Create a real task for the team
        const atlas = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON)).find(
          (m) => m.agentDir === 'agents/atlas/',
        );
        await daemonClient.createTask({
          title: 'Implement member sidebar in channel view',
          priority: 'high',
          assignedTo: atlas?.id,
          createdBy: f?.id ?? '',
          description: `Add a member sidebar to the chat view (packages/tui/src/views/chat.tsx).

## Requirements
- Show list of channel members on the right side of the chat
- Each member: status diamond + name + rank
- Online/offline status from daemon API
- Toggle with a hotkey (e.g., 'm' to show/hide)
- Follow existing theme (COLORS, STATUS from theme.ts)
- Sidebar should be ~20 chars wide

## Reference
- See hierarchy.tsx for member rendering patterns
- See theme.ts for status icons and colors
- Channel members available from channel.memberIds + members.json

## Acceptance Criteria
- Sidebar renders correctly alongside message list
- Shows accurate online/offline status
- Togglable without disrupting chat input
- Matches warm charcoal theme`,
        });
        writeSystemMessage('Task "Implement member sidebar" created and assigned to Atlas.');
        writeSystemMessage('Dogfood setup complete! Your dev team is ready. Check /tasks and /hierarchy.');
      } catch (err) {
        writeSystemMessage(`Dogfood error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // --- JACK MODE: use say() with persistent session key ---
    if (jackMode?.active) {
      setSending(true);
      setThinking(true);
      setThinkingAgents([jackMode.agentName]);

      // Write user message to DM JSONL (so it appears in chat history)
      const userMsg: ChannelMessage = {
        id: generateId(),
        channelId: channel.id,
        senderId: members.find(m => m.rank === 'owner')?.id ?? 'system',
        threadId: null,
        content: text,
        kind: 'text',
        mentions: [],
        metadata: { source: 'jack' },
        depth: 0,
        originId: '',
        timestamp: new Date().toISOString(),
      };
      userMsg.originId = userMsg.id;
      appendMessage(messagesPath, userMsg);
      setTimeout(() => refreshMessages(), 50); // Force re-read after self-write

      // Send raw message — OpenClaw manages conversation history via persistent session key.
      // No client-side history stuffing. Proper turn structure > flat text dump.
      try {
        const result = await daemonClient.say(jackMode.agentSlug, text, jackMode.sessionKey);

        if (result.ok && result.response) {
          // Write agent response to DM JSONL
          const agentMsg: ChannelMessage = {
            id: generateId(),
            channelId: channel.id,
            senderId: jackMode.agentId,
            threadId: null,
            content: result.response,
            kind: 'text',
            mentions: [],
            metadata: { source: 'jack' },
            depth: 0,
            originId: '',
            timestamp: new Date().toISOString(),
          };
          agentMsg.originId = agentMsg.id;
          appendMessage(messagesPath, agentMsg);
          setTimeout(() => refreshMessages(), 50); // Force re-read after self-write
        } else {
          writeSystemMessage(`Jack dispatch failed: ${(result as any).error ?? 'No response'}`);
        }
      } catch (err) {
        writeSystemMessage(`Jack error: ${err instanceof Error ? err.message : String(err)}. Session continues.`);
      }

      setThinking(false);
      setThinkingAgents([]);
      setSending(false);
      return;
    }

    // --- NORMAL MODE: write to channel, let router dispatch ---
    setSending(true);
    try {
      const { dispatching, dispatchTargets } = await daemonClient.sendMessage(channel.id, text);
      if (dispatching) {
        setThinking(true);
        setThinkingAgents(dispatchTargets);
      }
    } catch (err) {
      // Message send failed
    }
    setSending(false);
  }, [channel.id, daemonClient, jackMode, messagesPath, members]);

  const founder = members.find((m) => m.rank === 'owner');

  const handleTaskCreated = (title: string) => {
    writeSystemMessage(`Task "${title}" created. Check #tasks for details.`);
    setTimeout(() => setShowTaskWizard(false), 1500);
  };

  const handleProjectCreated = (name: string) => {
    writeSystemMessage(`Project "${name}" created. New channels are now available.`);
    setTimeout(() => setShowProjectWizard(false), 1500);
  };

  const handleTeamCreated = (name: string) => {
    writeSystemMessage(`Team "${name}" created. A team channel has been added.`);
    setTimeout(() => setShowTeamWizard(false), 1500);
  };

  if (showProjectWizard) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <ProjectWizard
          daemonClient={daemonClient}
          founderId={founder?.id ?? ''}
          onClose={() => setShowProjectWizard(false)}
          onCreated={handleProjectCreated}
        />
      </Box>
    );
  }

  if (showTeamWizard) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <TeamWizard
          daemonClient={daemonClient}
          founderId={founder?.id ?? ''}
          members={members}
          onClose={() => setShowTeamWizard(false)}
          onCreated={handleTeamCreated}
        />
      </Box>
    );
  }

  if (showTaskWizard) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <TaskWizard
          daemonClient={daemonClient}
          founderId={founder?.id ?? ''}
          members={members}
          onClose={() => setShowTaskWizard(false)}
          onCreated={handleTaskCreated}
        />
      </Box>
    );
  }

  if (showHireWizard) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <HireWizard
          daemonClient={daemonClient}
          founderId={founder?.id ?? ''}
          onClose={() => setShowHireWizard(false)}
          onHired={handleHired}
        />
      </Box>
    );
  }

  if (showModelWizard) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <ModelWizard
          daemonClient={daemonClient}
          onClose={() => setShowModelWizard(false)}
          onChanged={(target, model) => {
            writeSystemMessage(`Model changed: ${target} → ${model}`);
            setTimeout(() => setShowModelWizard(false), 1500);
          }}
        />
      </Box>
    );
  }

  // Derive streaming state for this channel from props
  const channelStream = streamData?.channelId === channel.id ? streamData : null;
  const isStreaming = !!channelStream;
  const hasStreamContent = !!(channelStream?.content);

  const renderMsg = (msg: ChannelMessage) => {
    const sender = members.find((m) => m.id === msg.senderId);
    const name = sender?.displayName ?? 'system';
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isSystem = msg.senderId === 'system' || msg.kind === 'system' || msg.kind === 'task_event';

    if (isSystem) {
      return (
        <Box key={msg.id} flexDirection="column" paddingLeft={1} marginBottom={0}>
          <Text color={COLORS.muted}> {'\u2502'} {msg.content}</Text>
        </Box>
      );
    }

    // Tool events — compact inline display
    if (msg.kind === 'tool_event') {
      const toolColor = sender ? agentColor(COLORS, sender.rank) : COLORS.subtle;
      return (
        <Box key={msg.id} gap={1} paddingLeft={1}>
          <Text color={COLORS.muted}> {'\u2502'}</Text>
          <Text color={toolColor}>{name}</Text>
          <Text color={COLORS.subtle}>{msg.content}</Text>
        </Box>
      );
    }

    const replyCount = threadCounts.get(msg.id) ?? 0;
    const isUser = sender?.type === 'user';
    const nameColor = isUser ? COLORS.user : agentColor(COLORS, sender?.rank);
    return (
      <Box key={msg.id} flexDirection="column" marginBottom={1}>
        <Box gap={1}>
          <Text color={nameColor}>{'\u25CF'}</Text>
          <Text bold color={nameColor}>{name}</Text>
          <Text color={COLORS.muted}>{time}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text wrap="wrap">{renderContent(msg.content, memberMap)}</Text>
        </Box>
        {replyCount > 0 && !activeThread && (
          <Box paddingLeft={2} marginTop={0}>
            <Text color={COLORS.info}>  {replyCount} {replyCount === 1 ? 'reply' : 'replies'}</Text>
            <Text color={COLORS.muted}> \u00B7 C-Y to open</Text>
          </Box>
        )}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Messages — Static writes to terminal scrollback permanently */}
      <Static items={messages}>
        {(msg) => renderMsg(msg)}
      </Static>
      {/* Dynamic: streaming preview + indicators + input */}
      {hasStreamContent && dispatchingAgents.includes(channelStream!.agentName) && (
        <Box flexDirection="column" marginBottom={1}>
          <Box gap={1}>
            <Text color={COLORS.agentWorker}>{'\u25CF'}</Text>
            <Text bold color={COLORS.agentWorker}>{channelStream!.agentName}</Text>
            <Text color={COLORS.muted}><Spinner type="dots" /></Text>
          </Box>
          <Box paddingLeft={2}>
            <Text wrap="wrap">{channelStream!.content}</Text>
          </Box>
        </Box>
      )}
      {!hasStreamContent && (isStreaming || thinking || dispatchingAgents.length > 0) && (
        <Box gap={1} paddingLeft={1}>
          <Text color={COLORS.muted}><Spinner type="dots" /></Text>
          <Text color={COLORS.subtle}>
            {activeToolCall
              ? `${activeToolCall.agentName} ${activeToolCall.toolName}...`
              : thinkingAgents.length > 0
                ? `${thinkingAgents.join(', ')} ${thinkingAgents.length === 1 ? 'is' : 'are'} typing...`
                : `${[...dispatchingAgents].join(', ')} ${dispatchingAgents.length === 1 ? 'is' : 'are'} working...`}
          </Text>
        </Box>
      )}
      <MessageInput
        onSend={handleSend}
        disabled={sending}
        placeholder={jackMode?.active ? `Jacked into ${jackMode.agentName} — live session` : 'Type a message... (/hire to add agents)'}
        agents={members.filter(m => m.type === 'agent').map(m => ({ slug: m.displayName.toLowerCase().replace(/\s+/g, '-'), displayName: m.displayName }))}
      />
      <Text color={jackMode?.active ? COLORS.warning : COLORS.muted}> {jackMode?.active ? `JACKED:${jackMode.agentName}  /unjack to disconnect` : activeThread ? `Thread in #${channel.name}  C-Y:close` : `#${channel.name}`}  C-K:palette  C-H:home  C-T:tasks  Esc:back</Text>
    </Box>
  );
}
