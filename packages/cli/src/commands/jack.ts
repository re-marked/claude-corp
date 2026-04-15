import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getClient, getCorpRoot, getMembers } from '../client.js';
import { DaemonClient } from '@claudecorp/daemon';

interface ConversationEntry {
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
  durationMs?: number;
}

export async function cmdJack(opts: {
  agent?: string;
  json: boolean;
}) {
  const agentSlug = opts.agent ?? 'ceo';
  const client = getClient();
  const corpRoot = await getCorpRoot();
  const members = getMembers(corpRoot);

  // Resolve agent
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
  const target = members.find(m =>
    m.type === 'agent' && (normalize(m.displayName) === normalize(agentSlug) || m.id === agentSlug),
  );
  if (!target) {
    console.error(`Agent "${agentSlug}" not found.`);
    process.exit(1);
  }

  // Check agent is online
  try {
    const status = await client.status();
    const agentStatus = (status as any).agents?.find((a: any) => a.memberId === target.id);
    if (!agentStatus || agentStatus.status !== 'ready') {
      console.error(`${target.displayName} is not online (status: ${agentStatus?.status ?? 'unknown'}).`);
      console.error('Start the daemon first: cc-cli start');
      process.exit(1);
    }
  } catch {
    console.error('Cannot connect to daemon. Start it first: cc-cli start');
    process.exit(1);
  }

  // Persistent session key — deterministic per agent so consecutive
  // `cc-cli jack` invocations resume the same conversation rather than
  // each one spawning a fresh claude-code session. Matches the format
  // used by every daemon-side dispatcher (autoemon, dreams, slumber,
  // api). The previous `:${Date.now()}` suffix made every jack call
  // re-introduce the agent.
  const sessionKey = `jack:${normalize(target.displayName)}`;
  const conversation: ConversationEntry[] = [];
  const jackStart = Date.now();

  // --- Banner ---
  console.log('');
  console.log(`  ┌─────────────────────────────────────┐`);
  console.log(`  │  JACK — Live Session                 │`);
  console.log(`  │  Agent: ${target.displayName.padEnd(28)}│`);
  console.log(`  │  Rank:  ${target.rank.padEnd(28)}│`);
  console.log(`  │  Session: ${sessionKey.slice(0, 26).padEnd(26)}│`);
  console.log(`  │                                     │`);
  console.log(`  │  /help for commands, Ctrl+C to quit │`);
  console.log(`  └─────────────────────────────────────┘`);
  console.log('');

  // --- Readline loop ---
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `[jacked:${normalize(target.displayName)}] > `,
    terminal: true,
  });

  let messageCount = 0;

  const handleLine = async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // --- Special commands ---
    if (input === '/help' || input === '/?') {
      console.log('');
      console.log('  Jack session commands:');
      console.log('  /help       — this help');
      console.log('  /status     — show agent + corp status');
      console.log('  /activity   — recent corp activity');
      console.log('  /history    — show conversation so far');
      console.log('  /save       — save conversation to file');
      console.log('  /unjack     — disconnect (same as Ctrl+C)');
      console.log('');
      rl.prompt();
      return;
    }

    if (input === '/unjack' || input === '/quit' || input === '/exit') {
      rl.close();
      return;
    }

    if (input === '/status') {
      try {
        const status = await client.status();
        const agents = (status as any).agents ?? [];
        console.log('');
        for (const a of agents) {
          const icon = a.status === 'ready' ? '\u25C6' : '\u25CB';
          console.log(`  ${icon} ${a.displayName.padEnd(16)} ${a.status}`);
        }
        console.log('');
      } catch (err) {
        console.error('  Failed to get status.');
      }
      rl.prompt();
      return;
    }

    if (input === '/history') {
      console.log('');
      if (conversation.length === 0) {
        console.log('  No conversation yet.');
      } else {
        for (const entry of conversation) {
          const label = entry.role === 'user' ? 'You' : target.displayName;
          const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          const duration = entry.durationMs ? ` (${(entry.durationMs / 1000).toFixed(1)}s)` : '';
          const preview = entry.content.length > 100 ? entry.content.slice(0, 97) + '...' : entry.content;
          console.log(`  [${time}]${duration} ${label}: ${preview}`);
        }
      }
      console.log('');
      rl.prompt();
      return;
    }

    if (input === '/save') {
      saveConversation(corpRoot, target.displayName, conversation, jackStart);
      rl.prompt();
      return;
    }

    if (input === '/activity') {
      try {
        const { cmdActivity } = await import('./activity.js');
        console.log('');
        await cmdActivity({ last: 10, json: false });
        console.log('');
      } catch {
        console.error('  Activity unavailable.');
      }
      rl.prompt();
      return;
    }

    // --- Normal message: dispatch to agent ---
    messageCount++;
    conversation.push({ role: 'user', content: input, timestamp: new Date().toISOString() });

    // Build message with conversation context fallback
    // (in case OpenClaw doesn't maintain session history per key)
    let message = input;
    if (conversation.length > 2) {
      const history = conversation.slice(0, -1).map(e => {
        const label = e.role === 'user' ? 'Founder' : target.displayName;
        return `[${label}]: ${e.content}`;
      }).join('\n');
      message = `Previous conversation:\n${history}\n\n[Founder]: ${input}`;
    }

    const startTime = Date.now();
    process.stdout.write(`\n  ${target.displayName} is thinking...`);

    try {
      const result = await client.say(agentSlug, message, sessionKey);
      const durationMs = Date.now() - startTime;

      // Clear "thinking" line
      process.stdout.write('\r' + ' '.repeat(60) + '\r');

      if (result.ok && result.response) {
        conversation.push({
          role: 'agent',
          content: result.response,
          timestamp: new Date().toISOString(),
          durationMs,
        });

        // Format response nicely
        const duration = (durationMs / 1000).toFixed(1);
        console.log(`  [${target.displayName}] (${duration}s)`);
        console.log('');

        // Indent multi-line responses
        const lines = result.response.split('\n');
        for (const l of lines) {
          console.log(`  ${l}`);
        }
        console.log('');
      } else {
        console.log(`  [error] ${(result as any).error ?? 'No response'}`);
        console.log('');
      }
    } catch (err) {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      console.log(`  [error] Dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log('  Session continues. Try again or /unjack to quit.');
      console.log('');
    }

    rl.prompt();
  };

  rl.on('line', (line) => {
    // Pause prompt during async handling
    handleLine(line);
  });

  // Ctrl+C handler
  process.on('SIGINT', () => {
    rl.close();
  });

  rl.prompt();

  // Block until the readline closes (user types /unjack, hits Ctrl+C,
  // or stdin ends). Without this await, the function returned synchronously
  // and v2.1.18's top-level `run().then(() => process.exit(0))` would kill
  // the interactive session immediately after prompting. Previously the
  // active readline interface was the only thing holding the event loop
  // open — implicit, fragile, and broken by the auto-exit fix.
  await new Promise<void>((resolve) => {
    rl.on('close', () => {
      const duration = Math.round((Date.now() - jackStart) / 1000);
      const minutes = Math.floor(duration / 60);
      const seconds = duration % 60;
      const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

      console.log('');
      console.log(`  Unjacked. Session: ${messageCount} messages, ${timeStr}.`);

      // Auto-save if there was any conversation
      if (conversation.length > 0) {
        saveConversation(corpRoot, target.displayName, conversation, jackStart);
      }

      resolve();
    });
  });
}

/** Save conversation transcript to corp root. */
function saveConversation(
  corpRoot: string,
  agentName: string,
  conversation: ConversationEntry[],
  startTime: number,
): void {
  try {
    const logsDir = join(corpRoot, 'logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

    const date = new Date(startTime).toISOString().split('T')[0];
    const slug = agentName.toLowerCase().replace(/\s+/g, '-');
    const filename = `jack-${slug}-${date}-${startTime}.md`;
    const filePath = join(logsDir, filename);

    const lines = [
      `# Jack Session — ${agentName}`,
      `Date: ${new Date(startTime).toISOString()}`,
      `Messages: ${conversation.length}`,
      '',
      '---',
      '',
    ];

    for (const entry of conversation) {
      const label = entry.role === 'user' ? '**Founder**' : `**${agentName}**`;
      const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const duration = entry.durationMs ? ` (${(entry.durationMs / 1000).toFixed(1)}s)` : '';
      lines.push(`### ${label} — ${time}${duration}`);
      lines.push('');
      lines.push(entry.content);
      lines.push('');
    }

    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    console.log(`  Conversation saved to logs/${filename}`);
  } catch {
    console.error('  Failed to save conversation.');
  }
}
