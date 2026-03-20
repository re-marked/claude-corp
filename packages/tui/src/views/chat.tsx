import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
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
import { MessageList } from '../components/message-list.js';
import { MessageInput } from '../components/message-input.js';
import { MemberSidebar } from '../components/member-sidebar.js';
import { useMessages } from '../hooks/use-messages.js';
import { HireWizard } from './hire-wizard.js';
import { COLORS, BORDER_STYLE } from '../theme.js';
import { TaskWizard } from './task-wizard.js';
import { ProjectWizard } from './project-wizard.js';
import { TeamWizard } from './team-wizard.js';
import type { DaemonClient } from '../lib/daemon-client.js';

const THINKING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — agents can work long

interface Props {
  channel: Channel;
  members: Member[];
  messagesPath: string;
  daemonClient: DaemonClient;
  corpRoot: string;
  onSwitchChannel?: () => void;
  onNavigate?: (view: import('../navigation.js').View) => void;
}

export function ChatView({ channel, members: initialMembers, messagesPath, daemonClient, corpRoot, onSwitchChannel, onNavigate }: Props) {
  const messages = useMessages(messagesPath);
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [thinkingAgents, setThinkingAgents] = useState<string[]>([]);
  const [members, setMembers] = useState(initialMembers);
  const [showHireWizard, setShowHireWizard] = useState(false);
  const [showTaskWizard, setShowTaskWizard] = useState(false);
  const [showProjectWizard, setShowProjectWizard] = useState(false);
  const [showTeamWizard, setShowTeamWizard] = useState(false);
  const [showMemberSidebar, setShowMemberSidebar] = useState(false);
  const lastMsgCount = useRef(messages.length);

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
      if (newMsg && founder && newMsg.senderId !== founder.id) {
        setThinking(false);
      }
    }
    lastMsgCount.current = messages.length;
  }, [messages.length]);

  // Timeout the spinner
  useEffect(() => {
    if (!thinking) return;
    const timer = setTimeout(() => setThinking(false), THINKING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [thinking]);

  useInput((input, key) => {
    if (showHireWizard) return;
    if (key.ctrl && input === 'm') {
      setShowMemberSidebar(prev => !prev);
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
    // /hire opens the wizard
    if (text.trim().toLowerCase() === '/hire') {
      setShowHireWizard(true);
      return;
    }

    // /task opens the task wizard
    if (text.trim().toLowerCase() === '/task') {
      setShowTaskWizard(true);
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

    // /logs — show recent daemon logs
    const cmd = text.trim().toLowerCase();
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
  }, [channel.id, daemonClient]);

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

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle="round" borderColor={COLORS.border} paddingX={1}>
        <Text bold color={COLORS.primary}># {channel.name}</Text>
        {!showMemberSidebar && <Text color={COLORS.muted}>  C-M: members</Text>}
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
          <MessageList messages={messages} members={members} />
          {thinking && (
            <Box gap={1} marginTop={1}>
              <Text color={COLORS.primary}><Spinner type="dots" /></Text>
              <Text color={COLORS.subtle}>
                {thinkingAgents.length > 0
                  ? `${thinkingAgents.join(', ')} ${thinkingAgents.length === 1 ? 'is' : 'are'} typing...`
                  : 'Thinking...'}
              </Text>
            </Box>
          )}
        </Box>
        <MemberSidebar 
          members={members} 
          channelMemberIds={channel.memberIds} 
          visible={showMemberSidebar}
          daemonClient={daemonClient}
        />
      </Box>
      <MessageInput
        onSend={handleSend}
        disabled={sending}
        placeholder="Type a message... (/hire to add agents)"
      />
    </Box>
  );
}
