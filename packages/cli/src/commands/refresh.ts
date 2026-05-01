import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  readConfigOr,
  readConfig,
  UNIVERSAL_SOUL,
  defaultRules,
  buildCeoAgents,
  MEMBERS_JSON,
  type Member,
  type AgentConfig,
} from '@claudecorp/shared';
import {
  buildHeraldRules,
  buildJanitorRules,
  buildWardenRules,
  buildPlannerRules,
} from '@claudecorp/daemon';
import { getCorpRoot } from '../client.js';

/**
 * cc-cli refresh — migrate SOUL.md + AGENTS.md for existing agents
 * to the current templates. Without this, every template evolution
 * (adding a voice rule, tweaking a tools listing) stranded existing
 * corps on the old substrate — the only way to pick up changes was
 * delete-the-corp-and-re-onboard, which is brutal when the founding
 * conversation takes minutes and is emotionally loaded.
 *
 * Default is diff-then-prompt: read SOUL.md / AGENTS.md on disk,
 * compare to the current template, show what would change, ask for
 * y/N. --force skips the prompt, --dry-run shows the diff and exits.
 *
 * Scope is just SOUL.md + AGENTS.md (the two substrate files that
 * actually track the template). IDENTITY/USER/MEMORY/BOOTSTRAP/
 * observations/BRAIN are agent-authored or stateful — they never
 * get refreshed.
 */

interface RefreshOpts {
  agent?: string;
  all?: boolean;
  force?: boolean;
  dryRun?: boolean;
  /** Corp name override — picks a specific corp when multiple exist and no daemon is running. */
  corp?: string;
}

interface RefreshTarget {
  name: string;
  path: string;
  content: string;
}

export async function cmdRefresh(opts: RefreshOpts): Promise<void> {
  if (!opts.agent && !opts.all) {
    console.error('Usage: cc-cli refresh <agent-slug> [--force] [--dry-run]');
    console.error('       cc-cli refresh --all          [--force] [--dry-run]');
    console.error('');
    console.error('Regenerate SOUL.md + AGENTS.md for the named agent (or all agents)');
    console.error('from the current templates. Shows a diff and prompts before writing.');
    console.error('');
    console.error('  --force     skip the y/N prompt, write unconditionally');
    console.error('  --dry-run   show the diff and exit; write nothing');
    process.exit(1);
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const members = readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);
  const agents = members.filter((m) => m.type === 'agent' && m.agentDir);

  const targets: Member[] = opts.all
    ? agents
    : [findAgent(agents, opts.agent!)].filter((a): a is Member => a !== undefined);

  if (targets.length === 0) {
    if (opts.agent) console.error(`Agent "${opts.agent}" not found.`);
    else console.error('No agents in this corp.');
    process.exit(1);
  }

  for (const agent of targets) {
    await refreshAgent(corpRoot, agent, opts);
  }
}

async function refreshAgent(corpRoot: string, agent: Member, opts: RefreshOpts): Promise<void> {
  const agentDir = join(corpRoot, agent.agentDir!);
  console.log(`\n→ ${agent.displayName}  (${agent.agentDir})`);

  if (!existsSync(agentDir)) {
    console.log(`  agent directory missing — skipping`);
    return;
  }

  const harness = resolveHarness(agentDir, agent);
  const rank = agent.rank ?? 'worker';

  // System agents with role-specific bullets (Herald, Janitor, Warden,
  // Planner) compose their AGENTS.md as `defaultRules + role-specific
  // bullets` — same pattern as buildCeoAgents. Hand-hired workers /
  // leaders get bare defaultRules. CEO gets buildCeoAgents (master
  // rank + authority bullets). Sexton (Project 1.9) gets the bare
  // defaultRules path — her role-specific operational content lives
  // in patrol blueprints, not a pre-written rules block; see
  // sexton.ts docstring for the rationale.
  const slug = (agent.agentDir ?? '').replace(/\/$/, '').split('/').pop() ?? '';
  let agentsContent: string;
  if (rank === 'master') {
    agentsContent = buildCeoAgents(harness);
  } else if (slug === 'herald') {
    agentsContent = buildHeraldRules(harness);
  } else if (slug === 'janitor') {
    agentsContent = buildJanitorRules(harness);
  } else if (slug === 'warden') {
    agentsContent = buildWardenRules(harness);
  } else if (slug === 'planner') {
    agentsContent = buildPlannerRules(harness);
  } else {
    agentsContent = defaultRules({ rank, harness });
  }

  const targets: RefreshTarget[] = [
    {
      name: 'SOUL.md',
      path: join(agentDir, 'SOUL.md'),
      content: UNIVERSAL_SOUL,
    },
    {
      name: 'AGENTS.md',
      path: join(agentDir, 'AGENTS.md'),
      content: agentsContent,
    },
  ];

  for (const t of targets) {
    await refreshFile(t, opts);
  }
}

async function refreshFile(t: RefreshTarget, opts: RefreshOpts): Promise<void> {
  if (!existsSync(t.path)) {
    console.log(`  ${t.name}: missing — writing from template`);
    if (!opts.dryRun) writeFileSync(t.path, t.content, 'utf-8');
    return;
  }

  const current = readFileSync(t.path, 'utf-8');
  if (current === t.content) {
    console.log(`  ${t.name}: up to date`);
    return;
  }

  console.log(`  ${t.name}: DRIFT`);
  printDiff(current, t.content);

  if (opts.dryRun) {
    console.log(`  (dry run — not writing)`);
    return;
  }

  if (!opts.force) {
    const go = await promptYesNo(`  Apply template to ${t.name}?`);
    if (!go) {
      console.log(`  skipped`);
      return;
    }
  }

  writeFileSync(t.path, t.content, 'utf-8');
  console.log(`  \u2713 refreshed`);
}

function resolveHarness(agentDir: string, agent: Member): 'openclaw' | 'claude-code' {
  // Member.harness is authoritative when set
  if (agent.harness === 'claude-code') return 'claude-code';
  if (agent.harness === 'openclaw') return 'openclaw';

  // Fallback to config.json
  const configPath = join(agentDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = readConfig<AgentConfig>(configPath);
      if (config.harness === 'claude-code') return 'claude-code';
    } catch {}
  }
  return 'openclaw';
}

function findAgent(agents: Member[], slug: string): Member | undefined {
  const n = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, '');
  const needle = n(slug);
  return agents.find(
    (a) =>
      a.id === slug ||
      n(a.displayName) === needle ||
      (a.agentDir && n(a.agentDir).includes(needle)),
  );
}

function printDiff(a: string, b: string): void {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const aSet = new Set(aLines);
  const bSet = new Set(bLines);
  const added = bLines.filter((l) => !aSet.has(l) && l.trim() !== '');
  const removed = aLines.filter((l) => !bSet.has(l) && l.trim() !== '');

  const cap = (l: string) => (l.length > 120 ? l.slice(0, 117) + '...' : l);

  if (added.length) {
    console.log(`    + ${added.length} line(s) to add:`);
    for (const l of added.slice(0, 10)) console.log(`      + ${cap(l)}`);
    if (added.length > 10) console.log(`      + ... and ${added.length - 10} more`);
  }
  if (removed.length) {
    console.log(`    - ${removed.length} line(s) to remove:`);
    for (const l of removed.slice(0, 10)) console.log(`      - ${cap(l)}`);
    if (removed.length > 10) console.log(`      - ... and ${removed.length - 10} more`);
  }
}

function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
