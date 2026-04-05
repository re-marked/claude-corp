import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Box, Text, useInput, Static } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import {
  type Channel,
  type Member,
  readConfig,
  post,
  parseIntervalExpression,
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
import { SleepingBanner } from '../components/sleeping-banner.js';
import { AfkWizard } from './afk-wizard.js';
import { useCorp } from '../context/corp-context.js';

const THINKING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — agents can work long

function formatMs(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

interface StreamData {
  agentName: string;
  content: string;
  channelId: string;
}

interface ToolCallData {
  agentName: string;
  toolName: string;
}

interface Props {
  channel: Channel;
  messagesPath: string;
  /** Streaming state from WebSocket events — multiple agents can stream simultaneously */
  streamData?: StreamData[] | null;
  /** Agent names currently dispatching */
  dispatchingAgents?: string[];
  /** Active tool calls for this channel (multiple agents can use tools at once) */
  activeToolCalls?: ToolCallData[];
  onNavigate?: (view: import('../navigation.js').View) => void;
}

export function ChatView({ channel, messagesPath, streamData, dispatchingAgents = [], activeToolCalls = [], onNavigate }: Props) {
  const { corpRoot, daemonClient, daemonPort, members: ctxMembers } = useCorp();
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
  const [showAfkWizard, setShowAfkWizard] = useState(false);
  const [showMemberSidebar, setShowMemberSidebar] = useState(false);

  // Plan review mode — replaces input when a plan arrives
  const [planReview, setPlanReview] = useState<{
    planId: string;
    planPath: string;
    choice: number; // 0=approve, 1=edit, 2=dismiss
    editing: boolean;
    editText: string;
  } | null>(null);

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

  // Track sleeping status for DM agents (autoemon)
  const [sleepInfo, setSleepInfo] = useState<{ sleepUntil: number; remainingMs: number; reason: string } | null>(null);
  const [slumberActive, setSlumberActive] = useState(false);

  // Poll SLUMBER status regardless of channel type (every 10s)
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const status = await daemonClient.get('/autoemon/status') as any;
        if (active) setSlumberActive(status.globalState === 'active');
      } catch { if (active) setSlumberActive(false); }
    };
    check();
    const timer = setInterval(check, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!isDm || !dmAgent) { setSleepInfo(null); return; }

    const checkSleep = async () => {
      try {
        const resp = await daemonClient.get(`/autoemon/sleep/${dmAgent.id}`);
        const data = resp as any;
        if (data.sleepUntil) {
          setSleepInfo({ sleepUntil: data.sleepUntil, remainingMs: data.remainingMs, reason: data.reason });
        } else {
          setSleepInfo(null);
        }
      } catch {
        setSleepInfo(null);
      }
    };

    checkSleep();
    const timer = setInterval(checkSleep, 5000); // Poll every 5s
    return () => clearInterval(timer);
  }, [isDm, dmAgent?.id]);

  useInput((input, key) => {
    if (showHireWizard || showModelWizard) return;
    // Plan review mode keyboard handling
    if (planReview) {
      if (key.escape) { setPlanReview(null); return; }
      if (!planReview.editing) {
        if (key.upArrow) { setPlanReview(p => p ? { ...p, choice: Math.max(0, p.choice - 1) } : p); return; }
        if (key.downArrow) { setPlanReview(p => p ? { ...p, choice: Math.min(2, p.choice + 1) } : p); return; }
        if (key.return) {
          if (planReview.choice === 0) {
            // Approve — tell CEO to execute
            writeSystemMessage('Plan approved. CEO will decompose into tasks.');
            if (jackMode?.active) {
              handleSend(`The plan at ${planReview.planPath} is approved. Decompose it into a Contract with tasks and start execution. Follow the Coordinator workflow.`);
            }
            setPlanReview(null);
          } else if (planReview.choice === 1) {
            // Edit — enter text input mode
            setPlanReview(p => p ? { ...p, editing: true, editText: '' } : p);
          } else {
            // Dismiss
            writeSystemMessage('Plan dismissed.');
            setPlanReview(null);
          }
          return;
        }
      } else {
        // Editing mode — TextInput handles text, we just handle escape
        if (key.escape) { setPlanReview(p => p ? { ...p, editing: false } : p); return; }
        // Let TextInput handle all other input (return handled by onSubmit)
      }
      return; // Consume all input in plan review mode
    }
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
    post(channel.id, join(corpRoot, channel.path, MESSAGES_JSONL), {
      senderId: 'system',
      content,
      source: 'system',
      kind: 'system',
    });
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

    // /sketch <goal> — quick plan (5 min)
    // /plan <goal> — deep plan (20 min)
    if (text.trim().toLowerCase().startsWith('/sketch') || text.trim().toLowerCase().startsWith('/plan')) {
      const isSketch = text.trim().toLowerCase().startsWith('/sketch');
      const cmdLen = isSketch ? 7 : 5;
      const planType = isSketch ? 'sketch' : 'plan';
      const goal = text.trim().slice(cmdLen).trim();
      if (!goal) {
        writeSystemMessage(isSketch
          ? 'Usage: /sketch <goal> — quick 5-min outline'
          : 'Usage: /plan <goal> — deep 20-min research + structured plan');
        return;
      }

      // Auto-target agent in DM, or default to CEO
      let targetAgent: string | undefined;
      if (channel.kind === 'direct') {
        const agent = members.find(m => m.type === 'agent' && channel.memberIds.includes(m.id));
        if (agent) targetAgent = agent.displayName.toLowerCase().replace(/\s+/g, '-');
      }

      const verbs = ['brewing', 'devising', 'architecting', 'contemplating', 'deliberating', 'mapping out', 'crafting', 'distilling'];
      const verb = verbs[Math.floor(Math.random() * verbs.length)]!;
      const agentName = targetAgent ?? 'CEO';
      const timeLabel = isSketch ? '~5 min' : 'up to 20 min';
      writeSystemMessage(`${agentName} is ${verb} a ${planType} for: ${goal}\nThis may take ${timeLabel}...`);

      try {
        const result = await daemonClient.createPlan({
          goal,
          type: planType,
          agent: targetAgent,
          channelId: channel.id,
        });
        if (result.ok && result.planId) {
          writeSystemMessage(`${result.planType === 'sketch' ? 'Sketch' : 'Plan'} saved: ${result.planPath}`);
          setPlanReview({
            planId: result.planId,
            planPath: result.planPath!,
            choice: 0,
            editing: false,
            editText: '',
          });
        } else {
          writeSystemMessage(`${planType} failed: ${result.error ?? 'unknown'}`);
        }
      } catch (err) {
        writeSystemMessage(`${planType} error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /dream @agent — force-trigger a memory consolidation dream
    if (text.trim().toLowerCase().startsWith('/dream')) {
      const parts = text.trim().split(/\s+/).slice(1);
      let agentSlug: string;
      if (parts[0]?.startsWith('@')) {
        agentSlug = parts[0].slice(1);
      } else if (parts[0]) {
        agentSlug = parts[0];
      } else if (channel.kind === 'direct') {
        const agent = members.find(m => m.type === 'agent' && channel.memberIds.includes(m.id));
        agentSlug = agent?.displayName.toLowerCase().replace(/\s+/g, '-') ?? '';
      } else {
        writeSystemMessage('Usage: /dream @agent — force-trigger memory consolidation');
        return;
      }
      if (!agentSlug) { writeSystemMessage('Usage: /dream @agent'); return; }
      writeSystemMessage(`Triggering dream for @${agentSlug}...`);
      try {
        const result = await daemonClient.triggerDream(agentSlug);
        if (result.ok) {
          writeSystemMessage(`Dream complete: ${result.summary ?? 'consolidated'}`);
        } else {
          writeSystemMessage(`Dream failed: ${result.error ?? 'unknown'}`);
        }
      } catch (err) {
        writeSystemMessage(`Dream error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /hand <task-id> @agent — hand a task to an agent (start work)
    if (text.trim().toLowerCase().startsWith('/hand')) {
      const parts = text.trim().split(/\s+/).slice(1);
      if (parts.length < 1) {
        writeSystemMessage('Usage: /hand <task-id> @agent\nCreating a task is planning. Handing it starts the work.');
        return;
      }
      const handTaskId = parts[0]!;
      let agentSlug: string;

      if (parts.length >= 2) {
        agentSlug = parts[1]!.startsWith('@') ? parts[1].slice(1) : parts[1]!;
      } else if (channel.kind === 'direct') {
        // DM auto-assign — if in a DM, hand to the agent in this channel
        const agent = members.find(m => m.type === 'agent' && channel.memberIds.includes(m.id));
        if (agent) {
          agentSlug = agent.displayName.toLowerCase().replace(/\s+/g, '-');
        } else {
          writeSystemMessage('Usage: /hand <task-id> @agent');
          return;
        }
      } else {
        writeSystemMessage('Usage: /hand <task-id> @agent\nOr use /hand in a DM to auto-assign to that agent.');
        return;
      }

      // Validate the agent exists
      const targetAgent = members.find(m =>
        m.type === 'agent' && m.displayName.toLowerCase().replace(/\s+/g, '-') === agentSlug.toLowerCase(),
      );
      if (!targetAgent) {
        writeSystemMessage(`Agent @${agentSlug} not found. Available: ${members.filter(m => m.type === 'agent').map(m => m.displayName).join(', ')}`);
        return;
      }

      // Check if agent is busy — warn but don't block
      const agentStatus = await daemonClient.status().catch(() => null);
      const agentInfo = (agentStatus as any)?.agents?.find((a: any) => a.memberId === targetAgent.id);
      const busyWarning = agentInfo?.workStatus === 'busy' ? ' (agent is busy — task will queue in their inbox)' : '';

      try {
        const result = await daemonClient.handTask(handTaskId, agentSlug);
        if ((result as any).ok) {
          const task = (result as any).task;
          const title = task?.title ?? handTaskId;
          const priority = task?.priority ?? 'normal';
          writeSystemMessage(`Handed "${title}" [${priority}] → @${targetAgent.displayName}${busyWarning}. Work begins.`);
        } else {
          writeSystemMessage(`Failed to hand: ${(result as any).error ?? 'unknown error'}`);
        }
      } catch (err) {
        writeSystemMessage(`Failed to hand task: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /status shows agent work status + daemon port inline
    if (text.trim().toLowerCase() === '/status') {
      try {
        const status = await daemonClient.status();
        const lines = status.agents.map((a: any) => {
          const ws = a.workStatus ?? 'offline';
          const icon = ws === 'idle' || ws === 'busy' ? '\u25CF' : '\u25CB';
          return `${icon} ${a.displayName.padEnd(16)} ${ws}`;
        });
        writeSystemMessage(`Daemon: 127.0.0.1:${daemonPort}\n\nAgent Status:\n${lines.join('\n')}`);
      } catch {
        writeSystemMessage('Failed to get status');
      }
      return;
    }

    // /slumber [duration] — enter SLUMBER mode (autonomous CEO)
    // /afk [duration] — alias for /slumber
    if (text.trim().toLowerCase().startsWith('/slumber') || text.trim().toLowerCase().startsWith('/afk')) {
      const parts = text.trim().split(/\s+/).slice(1);
      const arg = parts[0]; // e.g., "3h", "night-owl", "sprint", "wizard", "profiles", "stats"

      // /afk with no args → open the AFK wizard
      if (!arg && text.trim().toLowerCase() === '/afk') {
        setShowAfkWizard(true);
        return;
      }

      // /slumber wizard → also opens the wizard
      if (arg === 'wizard') {
        setShowAfkWizard(true);
        return;
      }

      // Detect: is the arg a profile name or a duration?
      let durationMs: number | undefined;
      let durationLabel = 'indefinitely';
      let profileId: string | undefined;

      if (arg) {
        // Try duration first (3h, 45m, 6h30m)
        const parsed = parseIntervalExpression(arg);
        if (parsed) {
          durationMs = parsed;
          const hours = Math.floor(parsed / 3_600_000);
          const mins = Math.round((parsed % 3_600_000) / 60_000);
          durationLabel = hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`;
        } else {
          // Not a duration — try as profile name
          try {
            const profile = await daemonClient.get(`/autoemon/profile/${arg}`) as any;
            if (profile?.id) {
              profileId = profile.id;
              if (profile.durationMs) {
                durationMs = profile.durationMs;
                const hours = Math.floor(profile.durationMs / 3_600_000);
                const mins = Math.round((profile.durationMs % 3_600_000) / 60_000);
                durationLabel = hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`;
              }
            } else {
              writeSystemMessage(`Unknown profile or duration: "${arg}". Use: /slumber 3h, /slumber night-owl, /slumber sprint`);
              return;
            }
          } catch {
            writeSystemMessage(`Unknown: "${arg}". Use: /slumber 3h, /slumber night-owl, /slumber sprint`);
            return;
          }
        }
      }

      // Check if already in SLUMBER
      try {
        const status = await daemonClient.get('/autoemon/status') as any;
        if (status.globalState === 'active') {
          writeSystemMessage(`SLUMBER is already active (${status.enrolledCount} agents enrolled). Use /wake to stop.`);
          return;
        }
      } catch {}

      // Check CEO is online before attempting SLUMBER
      const ceoMember = members.find(m => m.rank === 'master' && m.type === 'agent');
      if (!ceoMember) {
        writeSystemMessage('No CEO found. Cannot enter SLUMBER.');
        return;
      }
      try {
        const statusCheck = await daemonClient.status();
        const ceoAgent = statusCheck.agents.find((a: any) => a.memberId === ceoMember.id);
        if (!ceoAgent || ceoAgent.status !== 'ready') {
          writeSystemMessage('CEO is offline. Start the daemon and ensure CEO is running before entering SLUMBER.');
          return;
        }
      } catch {}

      // Step 1: Tell CEO to acknowledge — SLUMBER doesn't activate until CEO responds
      writeSystemMessage(`Entering SLUMBER ${durationLabel}... asking CEO to acknowledge.`);

      try {
        const ceoSlug = ceoMember.displayName.toLowerCase().replace(/\s+/g, '-');

        const slumberPrompt = [
          `[SLUMBER MODE ACTIVATED${durationMs ? ` — ${durationLabel}` : ''}]`,
          `The Founder is stepping away. You have autonomous control.`,
          `Acknowledge briefly and continue from where the conversation left off.`,
          `You'll receive <tick> prompts. Act on them autonomously.`,
        ].join('\n');

        // Send to CEO via say() — response appears in the DM naturally
        const data = await daemonClient.post('/cc/say', {
          target: ceoSlug,
          message: slumberPrompt,
          sessionKey: `jack:${ceoSlug}`,
          channelId: channel.id,
        }) as any;

        if (data.ok) {
          // Step 2: CEO acknowledged — NOW activate autoemon
          await daemonClient.post('/autoemon/activate', {
            source: 'slumber',
            durationMs,
            profileId,
          });

          // Use profile icon for the SLUMBER message, or default moon
          const profileIcon = profileId ? (await daemonClient.get(`/autoemon/profile/${profileId}`) as any)?.icon ?? '🌑' : '🌑';
          const profileNote = profileId ? ` [${profileId}]` : '';
          const moonEmoji = profileIcon;
          writeSystemMessage(`${moonEmoji} SLUMBER active${profileNote}${durationMs ? ` (${durationLabel})` : ''}. CEO acknowledged. Agents are autonomous.\nType /wake to end, /brief for a status update.`);
        } else {
          writeSystemMessage(`CEO failed to acknowledge: ${data.error ?? 'unknown'}. SLUMBER not activated.`);
        }
      } catch (err) {
        writeSystemMessage(`SLUMBER activation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /slumber profiles — list available SLUMBER profiles
    if (text.trim().toLowerCase() === '/slumber profiles' || text.trim().toLowerCase() === '/profiles') {
      try {
        const profiles = await daemonClient.get('/autoemon/profiles') as any[];
        if (!profiles?.length) {
          writeSystemMessage('No SLUMBER profiles found.');
          return;
        }
        const lines = profiles.map((p: any) => {
          const dur = p.durationMs ? `${Math.round(p.durationMs / 3_600_000)}h` : '∞';
          const interval = p.tickIntervalMs >= 3_600_000
            ? `${Math.round(p.tickIntervalMs / 3_600_000)}h`
            : `${Math.round(p.tickIntervalMs / 60_000)}m`;
          const budget = p.budgetTicks ? `${p.budgetTicks} ticks` : '∞';
          return `${p.icon} ${p.name} (${p.id})\n   ${p.description}\n   ${interval} ticks · ${dur} duration · ${budget} budget · ${p.conscription}`;
        });
        writeSystemMessage(`SLUMBER Profiles:\n\n${lines.join('\n\n')}\n\nUse: /slumber <profile-id>`);
      } catch {
        writeSystemMessage('Failed to load profiles.');
      }
      return;
    }

    // /dangerously-enable-auto-afk — toggle Founder Away auto-activation
    if (text.trim().toLowerCase() === '/dangerously-enable-auto-afk') {
      try {
        const { readConfig: rc, writeConfig: wc, CORP_JSON: CJ } = await import('@claudecorp/shared');
        const corpJson = rc<any>(join(corpRoot, CJ));
        const current = corpJson.dangerouslyEnableAutoAfk ?? false;
        const newValue = !current;
        corpJson.dangerouslyEnableAutoAfk = newValue;
        wc(join(corpRoot, CJ), corpJson);

        if (newValue) {
          // Start the checker immediately (don't wait for daemon restart)
          await daemonClient.post('/autoemon/start-away-checker');

          writeSystemMessage([
            '⚠️ AUTO-AFK ENABLED',
            '',
            'When you go idle for 30+ minutes, SLUMBER will activate automatically',
            'with the Guard Duty profile (CEO monitors only, no new work).',
            '',
            'The CEO will notify you in DM when this happens.',
            'Type /wake to resume control at any time.',
            'Run this command again to disable.',
          ].join('\n'));
        } else {
          writeSystemMessage('Auto-AFK disabled. SLUMBER will only activate via /slumber or /afk.');
        }
      } catch (err) {
        writeSystemMessage(`Failed to toggle auto-AFK: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /slumber schedule <profile> — register a recurring SLUMBER schedule
    if (text.trim().toLowerCase().startsWith('/slumber schedule')) {
      const scheduleArg = text.trim().split(/\s+/).slice(2).join(' ');
      if (!scheduleArg) {
        writeSystemMessage('Usage: /slumber schedule <profile-id>\nExample: /slumber schedule night-owl\nRegisters the profile\'s schedule for auto-activation.');
        return;
      }

      // "off" clears all schedules
      if (scheduleArg === 'off' || scheduleArg === 'clear') {
        await daemonClient.post('/autoemon/schedule/clear');
        writeSystemMessage('All SLUMBER schedules cleared.');
        return;
      }

      try {
        const result = await daemonClient.post('/autoemon/schedule', { profileId: scheduleArg }) as any;
        if (result.ok) {
          writeSystemMessage([
            `${result.icon} SLUMBER schedule set: ${result.profileName}`,
            `  Window: ${result.schedule}`,
            `  Duration: ${result.durationLabel}`,
            `  Profile: ${result.profileId}`,
            '',
            'The daemon will auto-activate SLUMBER during this window.',
            'Use /slumber schedule off to clear.',
          ].join('\n'));
        } else {
          writeSystemMessage(result.error ?? 'Failed to set schedule.');
        }
      } catch (err) {
        writeSystemMessage(`Schedule failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /slumber stats — show SLUMBER analytics
    if (text.trim().toLowerCase() === '/slumber stats' || text.trim().toLowerCase() === '/stats') {
      try {
        const data = await daemonClient.get('/autoemon/analytics') as any;
        writeSystemMessage(data.report ?? 'No SLUMBER data recorded.');
      } catch {
        writeSystemMessage('Failed to load analytics.');
      }
      return;
    }

    // /wake — end SLUMBER, CEO summarizes what happened
    if (text.trim().toLowerCase() === '/wake') {
      try {
        const status = await daemonClient.get('/autoemon/status') as any;
        if (status.globalState === 'inactive') {
          writeSystemMessage('SLUMBER is not active. Nothing to wake from.');
          return;
        }

        writeSystemMessage('Waking up... CEO is preparing a summary.');

        // Ask CEO to summarize — pass channelId so response appears naturally in chat
        const ceoSlug = members.find(m => m.rank === 'master' && m.type === 'agent')
          ?.displayName.toLowerCase().replace(/\s+/g, '-') ?? 'ceo';

        await daemonClient.post('/autoemon/wrapup', {
          reason: 'wake_command',
          channelId: channel.id,
          agentSlug: ceoSlug,
        });

        // Grab analytics before deactivation clears them
        let analyticsNote = '';
        try {
          const analytics = await daemonClient.get('/autoemon/analytics') as any;
          if (analytics?.totalTicks > 0) {
            const score = analytics.productivityScore ?? 0;
            const bar = '█'.repeat(Math.round(score / 10)) + '░'.repeat(10 - Math.round(score / 10));
            analyticsNote = `\n\nProductivity: ${bar} ${score}%\nTicks: ${analytics.totalTicks} total, ${analytics.productiveTicks} productive, ${analytics.idleTicks} idle`;
          }
        } catch {}

        // CEO's response is now persisted to JSONL by the say endpoint.
        // Deactivate and mark transition.
        await daemonClient.post('/autoemon/deactivate');
        writeSystemMessage(`☀ SLUMBER ended. Welcome back.${analyticsNote}`);
      } catch (err) {
        // Force deactivate even if digest fails
        try { await daemonClient.post('/autoemon/deactivate'); } catch {}
        writeSystemMessage(`SLUMBER ended (digest failed: ${err instanceof Error ? err.message : String(err)})`);
      }
      return;
    }

    // /brief — mid-SLUMBER status update from CEO (doesn't end SLUMBER)
    if (text.trim().toLowerCase() === '/brief') {
      try {
        const status = await daemonClient.get('/autoemon/status') as any;
        if (status.globalState !== 'active') {
          writeSystemMessage('SLUMBER is not active. Use /slumber to start.');
          return;
        }

        writeSystemMessage('Asking CEO for a brief update...');

        const ceoSlug = members.find(m => m.rank === 'master' && m.type === 'agent')
          ?.displayName.toLowerCase().replace(/\s+/g, '-') ?? 'ceo';

        const elapsed = status.activatedAt ? Date.now() - status.activatedAt : 0;
        const elapsedMin = Math.round(elapsed / 60_000);

        const briefPrompt = [
          `The Founder wants a brief status update. SLUMBER continues after this.`,
          ``,
          `Session so far: ${elapsedMin}m elapsed, ${status.totalTicks} ticks, ${status.totalProductiveTicks} productive.`,
          ``,
          `Give a quick update:`,
          `- What have you done so far?`,
          `- What are you working on now?`,
          `- Anything urgent?`,
          ``,
          `Keep it short — the Founder is just checking in, not ending SLUMBER.`,
        ].join('\n');

        await daemonClient.post('/cc/say', {
          target: ceoSlug,
          message: briefPrompt,
          sessionKey: `jack:${ceoSlug}`,
          channelId: channel.id,
        });

        // CEO's response will appear in the DM naturally via streaming
      } catch (err) {
        writeSystemMessage(`Brief failed: ${err instanceof Error ? err.message : String(err)}`);
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
        '  /task              Create a task (planning)',
        '  /hand <id> @agent  Hand a task to an agent (action)',
        '  /project           Open project creation wizard',
        '  /team              Open team creation wizard',
        '  /dogfood           Set up development project',
        '',
        'Automation:',
        '  /loop 5m <cmd>     Create a recurring loop (every 5m)',
        '  /loop 5m @ceo <prompt>  Loop that dispatches to agent',
        '  /loop list         Show active loops',
        '  /loop stop <name>  Stop a loop',
        '  /cron @daily @herald <prompt>  Create a cron job',
        '  /cron list         Show active crons',
        '  /cron stop <name>  Stop a cron',
        '',
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
      setTimeout(() => onNavigate?.({ type: 'clock' }), 10);
      return;
    }

    // /loop — create, list, or stop loops
    if (text.trim().toLowerCase().startsWith('/loop')) {
      const parts = text.trim().split(/\s+/).slice(1);
      if (parts.length === 0 || parts[0] === 'list') {
        // List active loops
        try {
          const clocks = await daemonClient.listClocks();
          const loops = (clocks as any[]).filter((c: any) => c.type === 'loop');
          if (loops.length === 0) {
            writeSystemMessage('No active loops. Usage: /loop 5m cc-cli status');
          } else {
            const lines = loops.map((l: any) => `  ${l.status === 'running' ? '\u25CF' : '\u25CB'} ${l.name} — ${l.fireCount}x fired`);
            writeSystemMessage(`Loops (${loops.length}):\n${lines.join('\n')}`);
          }
        } catch { writeSystemMessage('Failed to list loops'); }
        return;
      }
      if (parts[0] === 'info' && parts[1]) {
        try {
          const slug = parts.slice(1).join('-');
          const clocks = await daemonClient.listClocks();
          const loop = (clocks as any[]).find((c: any) =>
            c.type === 'loop' && (c.id === slug || c.name?.toLowerCase().includes(slug.toLowerCase())),
          );
          if (!loop) { writeSystemMessage(`Loop "${slug}" not found`); return; }
          const lines = [
            `\u2500\u2500\u2500 Loop: ${loop.name} \u2500\u2500\u2500`,
            `  ID:         ${loop.id}`,
            `  Status:     ${loop.status}`,
            `  Interval:   ${loop.description ?? 'N/A'}`,
            `  Fires:      ${loop.fireCount}x`,
            `  Errors:     ${loop.errorCount}`,
            `  Last fired: ${loop.lastFiredAt ? new Date(loop.lastFiredAt).toLocaleTimeString() : 'never'}`,
            `  Next fire:  ${loop.nextFireAt ? new Date(loop.nextFireAt).toLocaleTimeString() : 'N/A'}`,
          ];
          if (loop.lastError) lines.push(`  Last error: ${loop.lastError}`);
          writeSystemMessage(lines.join('\n'));
        } catch (err) { writeSystemMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`); }
        return;
      }
      if (parts[0] === 'stop' || parts[0] === 'delete') {
        if (!parts[1]) { writeSystemMessage('Usage: /loop stop <name>'); return; }
        try {
          await daemonClient.deleteClock(parts.slice(1).join('-'));
          writeSystemMessage(`Loop deleted: ${parts.slice(1).join(' ')}`);
        } catch (err) { writeSystemMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`); }
        return;
      }
      if (parts[0] === 'complete') {
        if (!parts[1]) { writeSystemMessage('Usage: /loop complete <name>'); return; }
        try {
          await daemonClient.completeClock(parts.slice(1).join('-'));
          writeSystemMessage(`Loop completed: ${parts.slice(1).join(' ')}`);
        } catch (err) { writeSystemMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`); }
        return;
      }
      if (parts[0] === 'dismiss') {
        if (!parts[1]) { writeSystemMessage('Usage: /loop dismiss <name>'); return; }
        try {
          await daemonClient.dismissClock(parts.slice(1).join('-'));
          writeSystemMessage(`Loop dismissed: ${parts.slice(1).join(' ')}`);
        } catch (err) { writeSystemMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`); }
        return;
      }
      // Create: /loop 5m cc-cli status  OR  /loop 5m @ceo Check deploy --task bold-fox
      // DM auto-assign: if in a DM and no @agent, auto-target the DM agent
      const interval = parts[0]!;
      let targetAgent: string | undefined;
      let taskId: string | undefined;

      // Extract --task flag from anywhere in the parts
      const taskFlagIdx = parts.indexOf('--task');
      if (taskFlagIdx >= 0 && parts[taskFlagIdx + 1]) {
        taskId = parts[taskFlagIdx + 1];
        parts.splice(taskFlagIdx, 2); // Remove --task and its value
      }

      let command: string;
      if (parts[1]?.startsWith('@')) {
        targetAgent = parts[1].slice(1);
        command = parts.slice(2).join(' ');
      } else {
        command = parts.slice(1).join(' ');
        // DM auto-assign — if in a DM, the agent in this channel is the target
        if (channel.kind === 'direct' && !targetAgent) {
          const agent = members.find(m =>
            m.type === 'agent' && channel.memberIds.includes(m.id),
          );
          if (agent) {
            targetAgent = agent.displayName.toLowerCase().replace(/\s+/g, '-');
          }
        }
      }
      if (!command) {
        writeSystemMessage('Usage: /loop <interval> <command>  or  /loop <interval> @agent <prompt> [--task <id>]');
        return;
      }
      try {
        const result = await daemonClient.createLoop({
          interval, command, targetAgent, channelId: channel.id, taskId,
        });
        if (result.ok) {
          writeSystemMessage(`Loop created: every ${interval} → ${targetAgent ? `@${targetAgent}: ` : ''}${command}`);
        } else {
          writeSystemMessage(`Failed: ${(result as any).error}`);
        }
      } catch (err) {
        writeSystemMessage(`Failed to create loop: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /cron — create, list, or stop crons
    if (text.trim().toLowerCase().startsWith('/cron')) {
      const parts = text.trim().split(/\s+/).slice(1);
      if (parts.length === 0 || parts[0] === 'list') {
        try {
          const clocks = await daemonClient.listClocks();
          const crons = (clocks as any[]).filter((c: any) => c.type === 'cron');
          if (crons.length === 0) {
            writeSystemMessage('No active crons. Usage: /cron @daily @herald Write summary');
          } else {
            const lines = crons.map((c: any) => `  ${c.status === 'running' ? '\u25CF' : '\u25CB'} ${c.name} — ${c.fireCount}x fired`);
            writeSystemMessage(`Crons (${crons.length}):\n${lines.join('\n')}`);
          }
        } catch { writeSystemMessage('Failed to list crons'); }
        return;
      }
      if (parts[0] === 'stop' || parts[0] === 'delete') {
        if (!parts[1]) { writeSystemMessage('Usage: /cron stop <name>'); return; }
        try {
          await daemonClient.deleteClock(parts.slice(1).join('-'));
          writeSystemMessage(`Cron deleted: ${parts.slice(1).join(' ')}`);
        } catch (err) { writeSystemMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`); }
        return;
      }
      if (parts[0] === 'complete') {
        if (!parts[1]) { writeSystemMessage('Usage: /cron complete <name>'); return; }
        try {
          await daemonClient.completeClock(parts.slice(1).join('-'));
          writeSystemMessage(`Cron completed: ${parts.slice(1).join(' ')}`);
        } catch (err) { writeSystemMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`); }
        return;
      }
      if (parts[0] === 'dismiss') {
        if (!parts[1]) { writeSystemMessage('Usage: /cron dismiss <name>'); return; }
        try {
          await daemonClient.dismissClock(parts.slice(1).join('-'));
          writeSystemMessage(`Cron dismissed: ${parts.slice(1).join(' ')}`);
        } catch (err) { writeSystemMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`); }
        return;
      }
      // Create: /cron @daily @herald Write summary  OR  /cron "0 9 * * 1" @ceo Sprint review
      let schedule: string;
      let restParts: string[];
      // Check if first arg is a quoted cron expression or a preset
      if (parts[0]!.startsWith('@') && !parts[0]!.startsWith('@e')) {
        // Preset like @daily, @hourly, @weekly
        schedule = parts[0]!;
        restParts = parts.slice(1);
      } else if (parts[0]!.match(/^\d/)) {
        // Raw cron: take first 5 fields
        schedule = parts.slice(0, 5).join(' ');
        restParts = parts.slice(5);
      } else {
        writeSystemMessage('Usage: /cron <schedule> [@agent] <command>\nSchedule: @daily, @hourly, @weekly, or "0 9 * * 1"');
        return;
      }
      let targetAgent: string | undefined;
      let command: string;
      if (restParts[0]?.startsWith('@')) {
        targetAgent = restParts[0].slice(1);
        command = restParts.slice(1).join(' ');
      } else {
        command = restParts.join(' ');
        // DM auto-assign
        if (channel.kind === 'direct' && !targetAgent) {
          const agent = members.find(m =>
            m.type === 'agent' && channel.memberIds.includes(m.id),
          );
          if (agent) targetAgent = agent.displayName.toLowerCase().replace(/\s+/g, '-');
        }
      }
      if (!command) {
        writeSystemMessage('Usage: /cron <schedule> [@agent] <command>');
        return;
      }
      // Extract --spawn-task flag
      const spawnTask = command.includes('--spawn-task');
      if (spawnTask) command = command.replace('--spawn-task', '').trim();

      try {
        const result = await daemonClient.createCron({
          schedule, command, targetAgent, channelId: channel.id,
          spawnTask: spawnTask || undefined,
          taskTitle: spawnTask ? `${command.slice(0, 40)} — {date}` : undefined,
          assignTo: targetAgent,
        });
        if (result.ok) {
          const cron = result.cron;
          writeSystemMessage(`Cron created: ${cron.humanSchedule ?? schedule} → ${targetAgent ? `@${targetAgent}: ` : ''}${command}`);
        } else {
          writeSystemMessage(`Failed: ${(result as any).error}`);
        }
      } catch (err) {
        writeSystemMessage(`Failed to create cron: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      post(channel.id, messagesPath, {
        senderId: members.find(m => m.rank === 'owner')?.id ?? 'system',
        content: text,
        source: 'user',
      });
      setTimeout(() => refreshMessages(), 50); // Force re-read after self-write

      // Send raw message — OpenClaw manages conversation history via persistent session key.
      // No client-side history stuffing. Proper turn structure > flat text dump.
      try {
        const result = await daemonClient.say(jackMode.agentSlug, text, jackMode.sessionKey, channel.id);

        if (result.ok && result.response) {
          // Response is already written to JSONL by the say endpoint.
          // No TUI-side write needed — prevents double messages.
          setTimeout(() => refreshMessages(), 100);
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

  const handleTaskCreated = (title: string, taskId: string) => {
    writeSystemMessage(`Task "${title}" created — ID: ${taskId}`);
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

  if (showAfkWizard) {
    return (
      <Box flexDirection="column" minHeight={10}>
        <AfkWizard
          onLaunch={async (profileId, durationMs, goal) => {
            setShowAfkWizard(false);
            // Reuse the existing SLUMBER activation flow
            const ceoMember = members.find(m => m.rank === 'master' && m.type === 'agent');
            if (!ceoMember) { writeSystemMessage('No CEO found.'); return; }
            const ceoSlug = ceoMember.displayName.toLowerCase().replace(/\s+/g, '-');

            const durationLabel = durationMs ? formatMs(durationMs) : 'indefinitely';
            writeSystemMessage(`Entering SLUMBER (${profileId})... asking CEO to acknowledge.`);

            try {
              const data = await daemonClient.post('/cc/say', {
                target: ceoSlug,
                message: `[SLUMBER MODE ACTIVATED — ${profileId}${durationMs ? ` for ${durationLabel}` : ''}${goal ? `\nGoal: ${goal}` : ''}]\nThe Founder is stepping away. You have autonomous control.\nAcknowledge briefly and continue from where the conversation left off.\nYou'll receive <tick> prompts. Act on them autonomously.`,
                sessionKey: `jack:${ceoSlug}`,
                channelId: channel.id,
              }) as any;

              if (data.ok) {
                await daemonClient.post('/autoemon/activate', { source: 'slumber', durationMs, profileId });
                const profile = await daemonClient.get(`/autoemon/profile/${profileId}`) as any;
                writeSystemMessage(`${profile?.icon ?? '🌑'} SLUMBER active [${profileId}]${durationMs ? ` (${durationLabel})` : ''}. CEO acknowledged.\nType /wake to end, /brief for a status update.`);
              } else {
                writeSystemMessage(`CEO failed to acknowledge: ${data.error ?? 'unknown'}`);
              }
            } catch (err) {
              writeSystemMessage(`SLUMBER failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }}
          onCancel={() => setShowAfkWizard(false)}
        />
      </Box>
    );
  }

  if (showProjectWizard) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={10}>
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
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={10}>
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
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={10}>
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
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={10}>
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
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={10}>
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
  const channelStreams = (streamData ?? []).filter(s => s.channelId === channel.id);
  const isStreaming = channelStreams.length > 0;
  const hasStreamContent = channelStreams.some(s => s.content);

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

    // Tool events — compact inline display with result tree
    if (msg.kind === 'tool_event') {
      const toolColor = sender ? agentColor(COLORS, sender.rank) : COLORS.subtle;
      const meta = msg.metadata as Record<string, unknown> | null;
      const rawResult = meta?.toolResult as string | undefined;

      // Clean up tool result — strip JSON wrappers, extract meaningful text
      let resultPreview = '';
      if (rawResult) {
        let cleaned = rawResult;
        // Strip cc-cli JSON wrapper: {"content":[{"type":"text","text":"actual text...
        try {
          const parsed = JSON.parse(cleaned);
          if (parsed?.content?.[0]?.text) {
            cleaned = parsed.content[0].text;
          } else if (typeof parsed === 'string') {
            cleaned = parsed;
          }
        } catch {
          // Not JSON — use as-is
        }
        // Take first meaningful line, truncate
        const firstLine = cleaned.split('\n').find((l: string) => l.trim())?.trim() ?? '';
        resultPreview = firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine;
      }

      return (
        <Box key={msg.id} flexDirection="column" paddingLeft={1}>
          <Box gap={1}>
            <Text color={COLORS.muted}> {'\u2502'}</Text>
            <Text color={toolColor}>{name}</Text>
            <Text color={COLORS.subtle}> {msg.content}</Text>
          </Box>
          {resultPreview && (
            <Box gap={1} paddingLeft={1}>
              <Text color={COLORS.border}>{'\u2514'}</Text>
              <Text color={COLORS.muted} italic>{resultPreview}</Text>
            </Box>
          )}
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
      {/* Messages — Static writes to terminal scrollback. Cap at 100 to prevent heap OOM. */}
      <Static items={messages.slice(-100)}>
        {(msg) => renderMsg(msg)}
      </Static>
      {/* Streaming messages — each renders inline like a real message in the chat */}
      {channelStreams.filter(s => s.content).map(stream => {
        const streamAgent = members.find(m => m.displayName === stream.agentName);
        const streamColor = streamAgent ? agentColor(COLORS, streamAgent.rank) : COLORS.agentWorker;
        const streamTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return (
          <Box key={`stream-${stream.agentName}`} flexDirection="column" marginBottom={1}>
            <Box gap={1}>
              <Text color={streamColor}>{'\u25CF'}</Text>
              <Text bold color={streamColor}>{stream.agentName}</Text>
              <Text color={COLORS.muted}>{streamTime}</Text>
              <Text color={COLORS.muted}><Spinner type="dots" /></Text>
            </Box>
            <Box paddingLeft={2}>
              <Text wrap="wrap">{renderContent(stream.content, memberMap)}</Text>
            </Box>
          </Box>
        );
      })}
      {/* Tool activity indicators — each agent's active tool shown separately */}
      {activeToolCalls.filter(tc => !channelStreams.some(s => s.content && s.agentName === tc.agentName)).map(tc => {
        const toolAgent = members.find(m => m.displayName === tc.agentName);
        const toolColor = toolAgent ? agentColor(COLORS, toolAgent.rank) : COLORS.agentWorker;
        return (
          <Box key={`tool-${tc.agentName}`} gap={1} paddingLeft={1}>
            <Text color={toolColor}>{'\u25CF'}</Text>
            <Text color={toolColor}>{tc.agentName}</Text>
            <Text color={COLORS.muted}><Spinner type="dots" /></Text>
            <Text color={COLORS.subtle}>{tc.toolName}</Text>
          </Box>
        );
      })}
      {/* Typing/working indicator — agents dispatching but not yet streaming */}
      {!hasStreamContent && activeToolCalls.length === 0 && (isStreaming || thinking || dispatchingAgents.length > 0) && (
        <Box gap={1} paddingLeft={1}>
          <Text color={COLORS.muted}><Spinner type="dots" /></Text>
          <Text color={COLORS.subtle}>
            {(() => {
              const THINKING_VERBS = ['thinking', 'reasoning', 'contemplating', 'ideating', 'pondering', 'mulling'];
              const WORKING_VERBS = ['working', 'processing', 'executing', 'crunching', 'operating', 'computing'];
              const verb = thinkingAgents.length > 0
                ? THINKING_VERBS[Math.floor(Date.now() / 8000) % THINKING_VERBS.length]
                : WORKING_VERBS[Math.floor(Date.now() / 8000) % WORKING_VERBS.length];
              const names = thinkingAgents.length > 0 ? thinkingAgents.join(', ') : [...dispatchingAgents].join(', ');
              const count = thinkingAgents.length > 0 ? thinkingAgents.length : dispatchingAgents.length;
              return `${names} ${count === 1 ? 'is' : 'are'} ${verb}...`;
            })()}
          </Text>
        </Box>
      )}
      {/* Plan review mode — replaces input with approve/edit/dismiss choice */}
      {planReview ? (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor={COLORS.info} paddingX={1} marginTop={1} flexDirection="column">
            <Text bold color={COLORS.info}>Plan Review — {planReview.planPath}</Text>
            {!planReview.editing ? (
              <Box flexDirection="column" marginTop={1}>
                {['Approve — start building', 'Edit — give feedback first', 'Dismiss — discard plan'].map((label, i) => (
                  <Box key={i} gap={1}>
                    <Text color={planReview.choice === i ? COLORS.primary : COLORS.muted}>
                      {planReview.choice === i ? '\u25B8' : ' '}
                    </Text>
                    <Text color={planReview.choice === i ? COLORS.text : COLORS.subtle} bold={planReview.choice === i}>
                      {label}
                    </Text>
                  </Box>
                ))}
                <Text color={COLORS.muted} dimColor> up/down, Enter to confirm</Text>
              </Box>
            ) : (
              <Box flexDirection="column" marginTop={1}>
                <Text color={COLORS.subtle}>Feedback for the CEO (Enter to send, Esc to cancel):</Text>
                <Box>
                  <Text bold color={COLORS.primary}>&gt; </Text>
                  <TextInput
                    value={planReview.editText}
                    onChange={(v) => setPlanReview(p => p ? { ...p, editText: v } : p)}
                    onSubmit={(v) => {
                      if (!v.trim()) return;
                      handleSend(`Feedback on the plan at ${planReview.planPath}: ${v}. Revise the plan and save the updated version to the same file.`);
                      writeSystemMessage('Feedback sent. CEO will revise — plan review will resume when done.');
                      // Stay in plan review mode but reset to choice view
                      // The revised plan will stream in the DM, user can re-review
                      setPlanReview(p => p ? { ...p, editing: false, editText: '', choice: 0 } : p);
                    }}
                    placeholder="The auth section needs OAuth support too..."
                  />
                </Box>
              </Box>
            )}
          </Box>
          <Text color={COLORS.info}> PLAN REVIEW  up/down:select  Enter:confirm  Esc:cancel</Text>
        </Box>
      ) : (
        <>
          {/* Sleeping agent banner — shown in DMs when agent is in autoemon sleep */}
          {sleepInfo && dmAgent && (
            <SleepingBanner
              agentName={dmAgent.displayName}
              sleepReason={sleepInfo.reason}
              remainingMs={sleepInfo.remainingMs}
              rank={dmAgent.rank}
            />
          )}
          <MessageInput
            onSend={handleSend}
            disabled={sending}
            placeholder={sleepInfo && dmAgent
              ? `Type to wake ${dmAgent.displayName}...`
              : jackMode?.active ? `Jacked into ${jackMode.agentName} — live session` : 'Type a message... (/hire to add agents)'}
            agents={members.filter(m => m.type === 'agent').map(m => ({ slug: m.displayName.toLowerCase().replace(/\s+/g, '-'), displayName: m.displayName }))}
          />
          <Text color={slumberActive ? '#a5b4fc' : jackMode?.active ? COLORS.warning : COLORS.muted}> {slumberActive ? 'SLUMBER active · /wake /brief  ' : ''}{jackMode?.active ? `JACKED:${jackMode.agentName}  /unjack to disconnect` : activeThread ? `Thread in #${channel.name}  C-Y:close` : `#${channel.name}`}  C-K:palette  C-H:home  C-T:tasks  Esc:back</Text>
        </>
      )}
    </Box>
  );
}
