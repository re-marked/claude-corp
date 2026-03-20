#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ensureClaudeCorpHome } from '@claudecorp/shared';

ensureClaudeCorpHome();

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    name: { type: 'string' },
    user: { type: 'string' },
    theme: { type: 'string' },
    channel: { type: 'string' },
    message: { type: 'string' },
    rank: { type: 'string' },
    wait: { type: 'boolean', default: false },
    timeout: { type: 'string' },
    last: { type: 'string' },
    status: { type: 'string' },
    assigned: { type: 'string' },
    repo: { type: 'string' },
    soul: { type: 'string' },
    corp: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: false,
});

const cmd = positionals[0];

if (!cmd || values.help) {
  console.log(`claudecorp-cli — Non-interactive Claude Corp management

Usage: claudecorp-cli <command> [options]

Commands:
  init       Create a new corporation
  start      Start the daemon (foreground)
  stop       Stop the running daemon
  status     Show daemon and agent status
  agents     List all agents
  send       Send a message to a channel
  hire       Hire a new agent
  dogfood    Set up dogfood project + dev team + task
  messages   Read channel messages
  tasks      List tasks
  logs       Show daemon logs

Common flags:
  --json     Output as JSON (machine-readable)
  --help     Show this help

Examples:
  claudecorp-cli init --name my-corp --user Mark --theme corporate
  claudecorp-cli start &
  claudecorp-cli send --channel general --message "hello @CEO" --wait
  claudecorp-cli dogfood
  claudecorp-cli messages --channel tasks --last 10 --json
  claudecorp-cli status --json
`);
  process.exit(0);
}

async function run() {
  switch (cmd) {
    case 'init': {
      const { cmdInit } = await import('./commands/init.js');
      await cmdInit({
        name: values.name as string,
        user: values.user as string,
        theme: (values.theme as string) ?? 'corporate',
      });
      break;
    }
    case 'start': {
      const { cmdStart } = await import('./commands/start.js');
      await cmdStart({ corp: values.corp as string | undefined });
      break;
    }
    case 'stop': {
      const { cmdStop } = await import('./commands/stop.js');
      await cmdStop();
      break;
    }
    case 'status': {
      const { cmdStatus } = await import('./commands/status.js');
      await cmdStatus({ json: !!values.json });
      break;
    }
    case 'agents': {
      const { cmdAgents } = await import('./commands/agents.js');
      await cmdAgents({ json: !!values.json });
      break;
    }
    case 'send': {
      const { cmdSend } = await import('./commands/send.js');
      await cmdSend({
        channel: values.channel as string,
        message: values.message as string,
        wait: !!values.wait,
        timeout: parseInt(values.timeout as string) || 120,
        json: !!values.json,
      });
      break;
    }
    case 'hire': {
      const { cmdHire } = await import('./commands/hire.js');
      await cmdHire({
        name: values.name as string,
        rank: values.rank as string,
        soul: values.soul as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'dogfood': {
      const { cmdDogfood } = await import('./commands/dogfood.js');
      await cmdDogfood({
        repo: values.repo as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'messages': {
      const { cmdMessages } = await import('./commands/messages.js');
      await cmdMessages({
        channel: values.channel as string,
        last: parseInt(values.last as string) || 10,
        json: !!values.json,
      });
      break;
    }
    case 'tasks': {
      const { cmdTasks } = await import('./commands/tasks.js');
      await cmdTasks({
        status: values.status as string | undefined,
        assigned: values.assigned as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'logs': {
      const { cmdLogs } = await import('./commands/logs.js');
      await cmdLogs({ last: parseInt(values.last as string) || 50 });
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}. Run claudecorp-cli --help`);
      process.exit(1);
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
