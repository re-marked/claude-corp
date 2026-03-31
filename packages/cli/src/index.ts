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
    model: { type: 'string' },
    agent: { type: 'string' },
    chain: { type: 'string' },
    hash: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    taskId: { type: 'string' },
    reason: { type: 'string' },
    priority: { type: 'string' },
    project: { type: 'string' },
    lead: { type: 'string' },
    type: { type: 'string' },
    wait: { type: 'boolean', default: false },
    timeout: { type: 'string' },
    last: { type: 'string' },
    status: { type: 'string' },
    assigned: { type: 'string' },
    to: { type: 'string' },
    task: { type: 'string' },
    repo: { type: 'string' },
    soul: { type: 'string' },
    corp: { type: 'string' },
    goal: { type: 'string' },
    id: { type: 'string' },
    blueprint: { type: 'string' },
    deadline: { type: 'string' },
    interval: { type: 'string' },
    schedule: { type: 'string' },
    command: { type: 'string' },
    maxRuns: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: false,
});

const cmd = positionals[0];

if (!cmd || values.help) {
  console.log(`cc-cli — Non-interactive Claude Corp management

Usage: cc-cli <command> [options]

Commands:
  init       Create a new corporation
  start      Start the daemon (foreground)
  stop       Stop the running daemon
  status     Show daemon and agent status
  stats      Show comprehensive corp statistics
  agents     List all agents
  members    Show member roster with online/offline status
  hierarchy  Show corporation org chart
  inspect    Show detailed agent info (SOUL, tasks, model)
  send       Send a message to a channel
  hire       Hire a new agent
  agent      Start/stop an agent (agent start/stop --agent <id>)
  models     View and change AI models
  channels   List all channels
  messages   Read channel messages
  tasks      List tasks
  task       Create a task (task create --title "...")
  projects   List/create projects
  teams      List/create teams
  tm         Time machine — view snapshots, rewind, fast-forward
  uptime     Show daemon uptime and message count
  version    Show package versions
  logs       Show daemon logs
  dogfood    Set up dogfood project + dev team + task

Automation commands:
  loop create --interval "5m" --command "cc-cli status"
  loop create --interval "5m" --agent ceo --command "Check status"
  loop list | loop stop <name>
  cron create --schedule "@daily" --agent herald --command "Summarize"
  cron create --schedule "0 9 * * 1" --agent ceo --command "Sprint review"
  cron list | cron stop <name>

Model commands:
  models                                    List current model config
  models default --model opus               Change corp default
  models set --agent hr --model haiku       Per-agent override
  models clear --agent hr                   Clear override
  models fallback --chain "sonnet,haiku"    Set fallback chain

Management commands:
  task create --title "..." [--priority high] [--assigned <id>]
  projects list | projects create --name "..." [--type development]
  teams list | teams create --name "..." --project <id> --lead <id>
  agent start --agent <id> | agent stop --agent <id>

Common flags:
  --json     Output as JSON (machine-readable)
  --help     Show this help

Examples:
  cc-cli init --name my-corp --user Mark --theme corporate
  cc-cli start &
  cc-cli send --channel general --message "hello @CEO" --wait
  cc-cli hire --name Researcher --rank worker --model haiku
  cc-cli task create --title "Research competitors" --assigned researcher
  cc-cli models default --model opus
  cc-cli members
  cc-cli hierarchy
  cc-cli inspect --agent ceo
  cc-cli stats --json
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
    case 'say': {
      const { cmdSay } = await import('./commands/say.js');
      await cmdSay({
        agent: values.agent as string | undefined,
        message: values.message as string | undefined,
        json: !!values.json,
      });
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
        model: values.model as string | undefined,
        project: values.project as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'models': {
      const { cmdModels } = await import('./commands/models.js');
      await cmdModels({
        action: positionals[1] as string | undefined,
        agent: values.agent as string | undefined,
        model: values.model as string | undefined,
        chain: values.chain as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'channels': {
      const { cmdChannels } = await import('./commands/channels.js');
      await cmdChannels({ json: !!values.json });
      break;
    }
    case 'uptime': {
      const { cmdUptime } = await import('./commands/uptime.js');
      await cmdUptime({ json: !!values.json });
      break;
    }
    case 'version': {
      const { cmdVersion } = await import('./commands/version.js');
      await cmdVersion({ json: !!values.json });
      break;
    }
    case 'failsafe': {
      const { cmdFailsafe } = await import('./commands/failsafe.js');
      await cmdFailsafe({ action: positionals[1] as string | undefined, json: !!values.json });
      break;
    }
    case 'tm':
    case 'time-machine': {
      const { cmdTimeMachine } = await import('./commands/time-machine.js');
      await cmdTimeMachine({
        action: positionals[1] as string | undefined,
        hash: values.hash as string | undefined,
        last: parseInt(values.last as string) || 15,
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
    case 'activity':
    case 'feed': {
      const { cmdActivity } = await import('./commands/activity.js');
      await cmdActivity({
        agent: values.agent as string | undefined,
        channel: values.channel as string | undefined,
        last: parseInt(values.last as string) || undefined,
        verbose: false,
        json: !!values.json,
      });
      break;
    }
    case 'loop':
    case 'loops': {
      const { cmdLoop } = await import('./commands/loop.js');
      await cmdLoop({
        action: positionals[1],
        interval: values.interval as string | undefined,
        command: values.command as string | undefined,
        agent: values.agent as string | undefined,
        name: values.name as string | undefined,
        maxRuns: values.maxRuns ? parseInt(values.maxRuns as string) : undefined,
        json: !!values.json,
      });
      break;
    }
    case 'cron':
    case 'crons': {
      const { cmdCron } = await import('./commands/cron.js');
      await cmdCron({
        action: positionals[1],
        schedule: values.schedule as string | undefined,
        command: values.command as string | undefined,
        agent: values.agent as string | undefined,
        name: values.name as string | undefined,
        maxRuns: values.maxRuns ? parseInt(values.maxRuns as string) : undefined,
        json: !!values.json,
      });
      break;
    }
    case 'clock':
    case 'clocks': {
      const { cmdClock } = await import('./commands/clock.js');
      await cmdClock({ json: !!values.json });
      break;
    }
    case 'stats': {
      const { cmdStats } = await import('./commands/stats.js');
      await cmdStats({ json: !!values.json });
      break;
    }
    case 'members':
    case 'who': {
      const { cmdMembers } = await import('./commands/members.js');
      await cmdMembers({ json: !!values.json });
      break;
    }
    case 'hierarchy': {
      const { cmdHierarchy } = await import('./commands/hierarchy.js');
      await cmdHierarchy({ json: !!values.json });
      break;
    }
    case 'inspect': {
      const { cmdInspect } = await import('./commands/inspect.js');
      await cmdInspect({ agent: values.agent as string | undefined, json: !!values.json });
      break;
    }
    case 'agent': {
      const { cmdAgentControl } = await import('./commands/agent-control.js');
      const action = positionals[1];
      if (action !== 'start' && action !== 'stop') {
        console.error('Usage: cc-cli agent start|stop --agent <name>');
        process.exit(1);
      }
      await cmdAgentControl({ action, agent: values.agent as string | undefined, json: !!values.json });
      break;
    }
    case 'jack': {
      const { cmdJack } = await import('./commands/jack.js');
      await cmdJack({
        agent: values.agent as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'hand': {
      const { cmdHand } = await import('./commands/hand.js');
      await cmdHand({
        task: values.task as string | undefined,
        to: values.to as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'task': {
      const action = positionals[1];
      if (action === 'create') {
        const { cmdTaskCreate } = await import('./commands/task-create.js');
        await cmdTaskCreate({
          title: values.title as string | undefined,
          description: values.description as string | undefined,
          priority: values.priority as string | undefined,
          assigned: values.assigned as string | undefined,
          to: values.to as string | undefined,
          json: !!values.json,
        });
      } else {
        console.error('Usage: cc-cli task create --title "..." [--to <agent>] [--priority high]');
        process.exit(1);
      }
      break;
    }
    case 'contract':
    case 'contracts': {
      const { cmdContract } = await import('./commands/contract.js');
      await cmdContract({
        action: positionals[1] as string | undefined,
        project: values.project as string | undefined,
        title: values.title as string | undefined,
        goal: values.goal as string | undefined,
        lead: values.lead as string | undefined,
        priority: values.priority as string | undefined,
        deadline: values.deadline as string | undefined,
        blueprint: values.blueprint as string | undefined,
        status: values.status as string | undefined,
        id: values.id as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'blueprint':
    case 'blueprints': {
      const { cmdBlueprint } = await import('./commands/blueprint.js');
      await cmdBlueprint({
        action: positionals[1] as string | undefined,
        name: values.name as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'projects': {
      const { cmdProjects } = await import('./commands/projects.js');
      await cmdProjects({
        action: positionals[1] as string | undefined,
        name: values.name as string | undefined,
        type: values.type as string | undefined,
        lead: values.lead as string | undefined,
        description: values.description as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'teams': {
      const { cmdTeams } = await import('./commands/teams.js');
      await cmdTeams({
        action: positionals[1] as string | undefined,
        name: values.name as string | undefined,
        project: values.project as string | undefined,
        lead: values.lead as string | undefined,
        description: values.description as string | undefined,
        json: !!values.json,
      });
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}. Run cc-cli --help`);
      process.exit(1);
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
