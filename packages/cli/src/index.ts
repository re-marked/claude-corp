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
    from: { type: 'string' },
    rank: { type: 'string' },
    kind: { type: 'string' },
    role: { type: 'string' },
    slug: { type: 'string' },
    model: { type: 'string' },
    agent: { type: 'string' },
    chain: { type: 'string' },
    hash: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    taskId: { type: 'string' },
    reason: { type: 'string' },
    priority: { type: 'string' },
    complexity: { type: 'string' },
    project: { type: 'string' },
    lead: { type: 'string' },
    type: { type: 'string' },
    wait: { type: 'boolean', default: false },
    override: { type: 'boolean', default: false },
    // `cc-cli done` flags — completed is multi-valued so agents can
    // list each acceptance criterion as a separate --completed "..."
    // without a manual delimiter.
    completed: { type: 'string', multiple: true },
    'next-action': { type: 'string' },
    'open-question': { type: 'string' },
    'sandbox-state': { type: 'string' },
    notes: { type: 'string' },
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
    'spawn-task': { type: 'boolean', default: false },
    'task-title': { type: 'string' },
    tag: { type: 'string' },
    source: { type: 'string' },
    confidence: { type: 'string' },
    harness: { type: 'string' },
    supervisor: { type: 'string' },
    cascade: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    pending: { type: 'boolean', default: false },
    culture: { type: 'boolean', default: false },
    hook: { type: 'boolean', default: false },
    // Project 1.6: `cc-cli wtf --peek` reads without consuming the
    // handoff chit (diagnostic inspection path; default consumes).
    peek: { type: 'boolean', default: false },
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
  wtf        "Where tf am I, what tf do I do" — emits CORP.md + your situational context
  whoami     "Who am I" — slug, role, kind, lineage, current casket. Read-only introspection.
  audit      Session-end audit gate (Stop / PreCompact hook invokes this). --override --reason "..." for founder bypass.
  done       Employee "I'm done with this task" signal. Writes pending handoff; audit promotes on approve.
  inbox      Tiered inbox management. cc-cli inbox <list|respond|dismiss|carry-forward|check>.
  tame       Promote an Employee to Partner. --slug <id> --reason "..." [--name <new-name>].
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
  fire       Fire (archive) an agent
  remove     Remove (delete completely) an agent
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
  refresh    Refresh SOUL.md + AGENTS.md from current templates (--all, --force, --dry-run)
  dogfood    Set up dogfood project + dev team + task
  chit       Unified work-record primitive (create/read/update/close/list/promote/archive)
  observe    Capture an observation — alias for 'chit create --type observation'
  migrate    Corp data migrations (migrate tasks: pre-chits Tasks → Chits)
  daemon     Daemon-level ops (daemon install-service: OS supervisor setup)
  sweeper    Code sweepers — Sexton's workers (sweeper run <name>)
  bacteria   Auto-scaling Employee pool: status / lineage / pause / resume / evict

Feedback pipeline:
  feedback                              Corp overview — pending, BRAIN, CULTURE candidates
  feedback --agent <name>               Per-agent: pending file + feedback-sourced BRAIN
  feedback --pending                    CULTURE.md promotion queue (next CEO dream)
  feedback --culture                    Dump CULTURE.md to stdout

B.R.A.I.N. commands:
  brain                                 Show usage + quick stats
  brain list [--type <type>]            List memories (optionally filter by type)
  brain show <name>                     Read a specific memory
  brain search <query>                  Full-text search
  brain search --tag <tag>              Search by tag
  brain search --type <type>            Search by memory type
  brain links <name>                    Show inbound + outbound wikilinks
  brain stale                           Memories needing validation
  brain orphans                         Unlinked memories
  brain stats                           Detailed statistics
  brain graph                           Link topology + clusters
  brain tags                            All tags by frequency
  brain create <name> --type <type>     Create a memory with frontmatter
  brain validate <name>                 Mark a memory as still valid
  brain delete <name>                   Delete a memory
  brain culture                         Corp-wide culture analysis
  brain culture signature               Agent's unique vs shared tags
  brain culture overlap                 Pairwise tag overlap between agents
  brain culture health                  Is the culture alive?
  brain culture normalize               Tag cleanup suggestions

SLUMBER commands:
  slumber [duration|profile]          Activate SLUMBER (e.g., slumber 3h, slumber night-owl)
  slumber profiles                    List available SLUMBER profiles
  slumber stats                       Show SLUMBER analytics
  slumber status                      Show autoemon state
  slumber schedule <profile>          Set recurring schedule
  slumber schedule off                Clear schedule
  wake                                End SLUMBER — CEO summarizes what happened
  brief                               Mid-SLUMBER check-in from CEO

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
  task create --title "..." [--priority high] [--complexity medium] [--assigned <id>]
  projects list | projects create --name "..." [--type development]
  teams list | teams create --name "..." --project <id> --lead <id>
  agent start --agent <id> | agent stop --agent <id>
  agent set-harness --agent <id> --harness <name>              Change execution substrate
  agent fire   --agent <id> [--cascade]                        Archive agent (offline, searchable)
  agent remove --agent <id> [--cascade]                        Remove agent permanently
  harness list                                      Show registered harnesses + health
  hire --name <n> --rank <r> [--harness claude-code|openclaw]  Pick substrate at creation

Common flags:
  --json     Output as JSON (machine-readable)
  --help     Show this help

Examples:
  cc-cli init --name my-corp --user Mark --theme corporate
  cc-cli start &
  cc-cli send --channel general --from founder --message "hello @CEO" --wait
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
    case 'chit': {
      // Each chit subcommand parses its own args to keep the main
      // dispatcher from needing to know every chit-specific flag.
      // process.argv.slice(3) = everything after `node cc-cli chit`.
      const { cmdChit } = await import('./commands/chit.js');
      await cmdChit(process.argv.slice(3));
      break;
    }
    case 'inbox': {
      // Same pass-through pattern as chit — each subcommand owns its flags.
      const { cmdInbox } = await import('./commands/inbox.js');
      await cmdInbox(process.argv.slice(3));
      break;
    }
    case 'daemon': {
      // Daemon-level operations (install-service today; uninstall /
      // status / logs as they land). Pass-through same as chit/inbox.
      const { cmdDaemon } = await import('./commands/daemon.js');
      await cmdDaemon(process.argv.slice(3));
      break;
    }
    case 'sweeper': {
      // Code sweepers (Sexton's workers). Pass-through same as
      // chit/inbox — each subcommand owns its flags.
      const { cmdSweeper } = await import('./commands/sweeper.js');
      await cmdSweeper(process.argv.slice(3));
      break;
    }
    case 'bacteria': {
      // Project 1.10.4: auto-scaling Employee pool observability +
      // control. Pass-through pattern same as sweeper/chit/inbox.
      const { cmdBacteria } = await import('./commands/bacteria.js');
      await cmdBacteria(process.argv.slice(3));
      break;
    }
    case 'breaker': {
      // Project 1.11: crash-loop circuit breaker founder controls.
      const { cmdBreaker } = await import('./commands/breaker.js');
      await cmdBreaker(process.argv.slice(3));
      break;
    }
    case 'clearinghouse': {
      // Project 1.12.1: Pressman's primitives surface — pick / acquire-
      // worktree / rebase / test / merge / finalize / file-blocker /
      // mark-failed / release / status. Walked by the Pressman Employee
      // session per the patrol/clearing blueprint.
      const { cmdClearinghouse } = await import('./commands/clearinghouse.js');
      await cmdClearinghouse(process.argv.slice(3));
      break;
    }
    case 'tame': {
      const { cmdTame } = await import('./commands/tame.js');
      await cmdTame({
        slug: values.slug as string | undefined,
        reason: values.reason as string | undefined,
        name: values.name as string | undefined,
        from: values.from as string | undefined,
        corp: values.corp as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'observe': {
      // Thin alias for `cc-cli chit create --type observation`. Same
      // pass-through pattern as the chit dispatcher: raw args after
      // 'observe', the alias handler injects --type and delegates.
      const { cmdObserve } = await import('./commands/observe.js');
      await cmdObserve(process.argv.slice(3));
      break;
    }
    case 'migrate': {
      // Corp data migrations. First target: `migrate tasks` (0.3).
      // Each migration is idempotent; safe to re-run.
      const { cmdMigrate } = await import('./commands/migrate.js');
      await cmdMigrate(process.argv.slice(3));
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
        from: values.from as string | undefined,
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
        harness: values.harness as string | undefined,
        supervisor: values.supervisor as string | undefined,
        kind: values.kind as string | undefined,
        role: values.role as string | undefined,
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
    case 'dream': {
      const { cmdDream } = await import('./commands/dream.js');
      await cmdDream({
        agent: values.agent as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'feedback': {
      const { cmdFeedback } = await import('./commands/feedback.js');
      await cmdFeedback({
        agent: values.agent as string | undefined,
        pending: !!values.pending,
        culture: !!values.culture,
        json: !!values.json,
      });
      break;
    }
    case 'refresh': {
      const { cmdRefresh } = await import('./commands/refresh.js');
      await cmdRefresh({
        agent: positionals[1] ?? (values.agent as string | undefined),
        all: !!values.all,
        force: !!values.force,
        dryRun: !!values['dry-run'],
        corp: values.corp as string | undefined,
      });
      break;
    }
    case 'brain': {
      const { cmdBrain } = await import('./commands/brain.js');
      await cmdBrain({
        args: positionals.slice(1),
        agent: values.agent as string | undefined,
        tag: values.tag as string | undefined,
        type: values.type as string | undefined,
        source: values.source as string | undefined,
        confidence: values.confidence as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'slumber': {
      const { cmdSlumber } = await import('./commands/slumber.js');
      await cmdSlumber({ args: positionals.slice(1), json: !!values.json });
      break;
    }
    case 'wake': {
      const { cmdWake } = await import('./commands/slumber.js');
      await cmdWake({ json: !!values.json });
      break;
    }
    case 'brief': {
      const { cmdBrief } = await import('./commands/slumber.js');
      await cmdBrief({ json: !!values.json });
      break;
    }
    case 'plan': {
      const { cmdPlan } = await import('./commands/plan.js');
      await cmdPlan({
        action: positionals[1],
        goal: (values.goal as string | undefined) ?? (positionals.slice(2).join(' ') || undefined),
        project: values.project as string | undefined,
        name: values.name as string | undefined,
        agent: values.agent as string | undefined,
        type: values.type as string | undefined,
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
        task: values.task as string | undefined,
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
        spawnTask: !!(values as any)['spawn-task'],
        taskTitle: (values as any)['task-title'] as string | undefined,
        assignTo: values.to as string | undefined,
        taskPriority: values.priority as string | undefined,
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
      const action = positionals[1];
      if (action === 'set-harness') {
        const { cmdAgentSetHarness } = await import('./commands/agent-control.js');
        await cmdAgentSetHarness({
          agent: values.agent as string | undefined,
          harness: values.harness as string | undefined,
          corp: values.corp as string | undefined,
          json: !!values.json,
        });
        break;
      }
      if (action === 'fire' || action === 'remove') {
        const { cmdAgentFire } = await import('./commands/agent-control.js');
        await cmdAgentFire({
          agent: values.agent as string | undefined,
          action: action as 'fire' | 'remove',
          cascade: !!values.cascade,
          json: !!values.json,
        });
        break;
      }
      if (action !== 'start' && action !== 'stop') {
        console.error('Usage: cc-cli agent start|stop|set-harness|fire|remove --agent <name> [--harness <name>] [--cascade]');
        process.exit(1);
      }
      const { cmdAgentControl } = await import('./commands/agent-control.js');
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
    case 'harness':
    case 'harnesses': {
      const { cmdHarness } = await import('./commands/harness.js');
      await cmdHarness({ args: positionals.slice(1), json: !!values.json });
      break;
    }
    case 'hand': {
      // Project 1.4 rewrite: hand takes --chit (preferred) or --task
      // (back-compat alias), resolves slot OR role, writes Casket
      // directly. process.argv.slice(3) = everything after
      // `cc-cli hand`, including raw flags — matches the pattern used
      // by cmdChit / cmdInbox / cmdObserve so hand.ts's parseArgs can
      // own its flag surface without this dispatcher growing per-flag.
      const { cmdHand } = await import('./commands/hand.js');
      await cmdHand(process.argv.slice(3));
      break;
    }
    case 'escalate': {
      // Project 1.4: Employee-to-Partner judgment request. Creates
      // escalation chit + writes Partner's Casket + fires inbox at
      // severity-matched tier (blocker → Tier 3, question/review →
      // Tier 2). Same raw-argv pattern as hand.
      const { cmdEscalate } = await import('./commands/escalate.js');
      await cmdEscalate(process.argv.slice(3));
      break;
    }
    case 'block': {
      // Project 1.4.1: dynamic blocker injection. Files a sub-task,
      // adds to caller's dependsOn, transitions caller to blocked via
      // state machine, hands blocker chit to assignee, fires inbox
      // on caller so wtf surfaces the BLOCKED state. Same raw-argv
      // pattern as hand / escalate.
      const { cmdBlock } = await import('./commands/block.js');
      await cmdBlock(process.argv.slice(3));
      break;
    }
    case 'wtf': {
      const { cmdWtf } = await import('./commands/wtf.js');
      await cmdWtf({
        agent: values.agent as string | undefined,
        corp: values.corp as string | undefined,
        hook: !!values.hook,
        peek: !!values.peek,
        json: !!values.json,
      });
      break;
    }
    case 'whoami': {
      const { cmdWhoami } = await import('./commands/whoami.js');
      // Route through the rawArgs overload so the command's own
      // `strict: true` parseOpts runs (typo rejection, value validation).
      // The top-level parseArgs is strict:false; passing pre-parsed values
      // bypasses whoami's own validator.
      await cmdWhoami(process.argv.slice(3));
      break;
    }
    case 'audit': {
      const { cmdAudit } = await import('./commands/audit.js');
      await cmdAudit({
        agent: values.agent as string | undefined,
        override: !!values.override,
        reason: values.reason as string | undefined,
        from: values.from as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'done': {
      const { cmdDone } = await import('./commands/done.js');
      // `--completed` is multi-valued to mirror the handoff chit's
      // `completed: string[]` shape — pass it repeatedly, one per
      // criterion done.
      const completed = Array.isArray(values.completed)
        ? (values.completed as string[])
        : values.completed
          ? [values.completed as string]
          : undefined;
      await cmdDone({
        from: values.from as string | undefined,
        completed,
        nextAction: values['next-action'] as string | undefined,
        openQuestion: values['open-question'] as string | undefined,
        sandboxState: values['sandbox-state'] as string | undefined,
        notes: values.notes as string | undefined,
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
          complexity: values.complexity as string | undefined,
          assigned: values.assigned as string | undefined,
          to: values.to as string | undefined,
          json: !!values.json,
        });
      } else {
        console.error('Usage: cc-cli task create --title "..." [--to <agent>] [--priority high] [--complexity medium]');
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
        from: values.from as string | undefined,
        json: !!values.json,
      });
      break;
    }
    case 'blueprint': {
      // Project 1.8: blueprint became a chit-type + a subcommand group
      // (new / list / show / validate / cast). The dispatcher parses
      // its own flags from raw argv — the top-level cli stays thin,
      // same pattern as hand / escalate / chit / inbox.
      const { cmdBlueprint } = await import('./commands/blueprint.js');
      await cmdBlueprint(process.argv.slice(3));
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

run().then(
  () => {
    // Force-exit on success so cc-cli doesn't hang ~5s while undici's
    // keep-alive connection pool to the daemon ages out. Affects every
    // command — without this, agents calling `cc-cli inspect`,
    // `cc-cli status`, etc. via Bash see the subprocess dangle after
    // the output prints, blocking the agent's next step.
    // `start` holds the process via an unresolving Promise so this
    // never fires for the long-running daemon path.
    //
    // Use exitCode + unref'd timeout instead of process.exit() to let
    // Node drain async handles first — process.exit() while libuv handles
    // are mid-close triggers an assertion crash on Windows.
    process.exitCode = 0;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);

// Safety net: force-exit 500ms after run() resolves. Covers two
// distinct failure modes that both cause cc-cli to hang past the
// 2-second test budget:
//
// 1. Linux: undici's HTTP keep-alive connection pool holds open
//    sockets for ~5s after the last request. With process.exitCode
//    alone, Node waits for them. CI (Linux) fails cli-exit-cleanly
//    tests because `cc-cli version` dangles ~5s.
//
// 2. Windows: calling process.exit() *while* libuv handles are
//    mid-close triggers "Assertion failed: !(handle->flags &
//    UV_HANDLE_CLOSING)". The 500ms delay gives handles time to
//    finish closing before we force exit.
//
// The timeout is unref'd so it doesn't keep the event loop alive —
// if handles drain naturally before 500ms (most paths), Node exits
// immediately and the timeout never fires. Applies on every platform
// because both failure modes exist and the fix is identical.
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
