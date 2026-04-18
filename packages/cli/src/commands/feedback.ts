/**
 * cc-cli feedback — headless introspection of the feedback pipeline.
 *
 * Four modes:
 *   cc-cli feedback                         — corp overview + candidates
 *   cc-cli feedback --agent <name>          — per-agent pending + BRAIN
 *   cc-cli feedback --pending               — CULTURE.md promotion queue
 *   cc-cli feedback --culture               — dump CULTURE.md
 * All modes support --json for scripted consumption.
 */

import {
  getCorpFeedbackIntel,
  getAgentFeedbackIntel,
  findAllAgentDirs,
  type CorpFeedbackIntel,
  type AgentFeedbackIntel,
  type CultureCandidate,
} from '@claudecorp/shared';
import { getCorpRoot } from '../client.js';

// ── ANSI helpers ────────────────────────────────────────────────────
// Kept local to this file — we don't pull chalk to avoid expanding the
// CLI's dependency surface for one command.

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function dim(s: string): string { return `${c.dim}${s}${c.reset}`; }
function bold(s: string): string { return `${c.bold}${s}${c.reset}`; }
function red(s: string): string { return `${c.red}${s}${c.reset}`; }
function green(s: string): string { return `${c.green}${s}${c.reset}`; }
function yellow(s: string): string { return `${c.yellow}${s}${c.reset}`; }
function cyan(s: string): string { return `${c.cyan}${s}${c.reset}`; }

function polarityColor(pol: string): string {
  if (pol === 'correction') return red(pol);
  if (pol === 'confirmation') return green(pol);
  if (pol === 'mixed') return yellow(pol);
  return dim(pol);
}

function strengthBadge(strength: 'strong' | 'moderate' | 'weak'): string {
  if (strength === 'strong') return `${c.bold}${c.green}[STRONG]${c.reset}`;
  if (strength === 'moderate') return `${c.yellow}[moderate]${c.reset}`;
  return dim('[weak]');
}

// ── Entry point ─────────────────────────────────────────────────────

export interface FeedbackCmdOpts {
  agent?: string;
  pending?: boolean;
  culture?: boolean;
  json: boolean;
}

export async function cmdFeedback(opts: FeedbackCmdOpts): Promise<void> {
  const corpRoot = await getCorpRoot();

  if (opts.culture) {
    await dumpCulture(corpRoot, opts.json);
    return;
  }

  if (opts.agent) {
    await showAgent(corpRoot, opts.agent, opts.json);
    return;
  }

  if (opts.pending) {
    await showPending(corpRoot, opts.json);
    return;
  }

  await showOverview(corpRoot, opts.json);
}

// ── Overview (default) ──────────────────────────────────────────────

async function showOverview(corpRoot: string, jsonOut: boolean): Promise<void> {
  const intel = getCorpFeedbackIntel(corpRoot);

  if (jsonOut) {
    console.log(JSON.stringify(intel, null, 2));
    return;
  }

  console.log();
  console.log(bold('Feedback pipeline — corp overview'));
  console.log(dim(`  corp: ${corpRoot}`));
  console.log();

  const t = intel.totals;
  console.log(bold('Totals'));
  console.log(`  ${t.agentsWithPending} agent(s) with pending feedback — ${t.totalPendingEntries} entr${t.totalPendingEntries === 1 ? 'y' : 'ies'} awaiting dream (${red(String(t.totalCorrectionPending) + ' corr')}, ${green(String(t.totalConfirmationPending) + ' conf')})`);
  console.log(`  ${t.totalFeedbackBrainEntries} feedback-sourced BRAIN entr${t.totalFeedbackBrainEntries === 1 ? 'y' : 'ies'} · compounded ${t.totalTimesHeard}x total`);
  console.log(`  ${intel.candidates.length} CULTURE.md candidate(s) — ${green(String(t.strongCandidates) + ' strong')}, ${yellow(String(t.moderateCandidates) + ' moderate')}`);
  console.log();

  // Per-agent table
  if (intel.agents.length === 0) {
    console.log(dim('  (no agents yet)'));
  } else {
    console.log(bold('Per agent'));
    const rows = intel.agents.map(a => ({
      name: a.agentName,
      pending: a.stats.pendingCount,
      corr: a.stats.correctionCount,
      conf: a.stats.confirmationCount,
      brain: a.brainEntries.length,
      heard: a.stats.totalTimesHeard,
      repeat: a.stats.repeatedEntryCount,
    }));
    const nameW = Math.max(8, ...rows.map(r => r.name.length));
    console.log(
      `  ${'agent'.padEnd(nameW)}  ${'pending'.padStart(7)}  ${'corr'.padStart(4)}  ${'conf'.padStart(4)}  ${'brain'.padStart(5)}  ${'heard'.padStart(5)}  ${'rep'.padStart(3)}`,
    );
    console.log(`  ${dim('-'.repeat(nameW))}  ${dim('-------')}  ${dim('----')}  ${dim('----')}  ${dim('-----')}  ${dim('-----')}  ${dim('---')}`);
    for (const r of rows) {
      const pendingStr = r.pending > 0 ? yellow(String(r.pending).padStart(7)) : dim('.'.padStart(7));
      console.log(
        `  ${r.name.padEnd(nameW)}  ${pendingStr}  ${String(r.corr).padStart(4)}  ${String(r.conf).padStart(4)}  ${String(r.brain).padStart(5)}  ${String(r.heard).padStart(5)}  ${String(r.repeat).padStart(3)}`,
      );
    }
  }
  console.log();

  // CULTURE.md status
  console.log(bold('CULTURE.md'));
  if (intel.cultureContent === null) {
    console.log(dim(`  (not yet written — ${intel.culturePath})`));
  } else {
    console.log(`  ${intel.cultureSizeChars} chars at ${dim(intel.culturePath)}`);
  }
  console.log();

  // Candidates
  if (intel.candidates.length > 0) {
    console.log(bold('Promotion candidates (next CEO dream)'));
    renderCandidates(intel.candidates.slice(0, 5));
    if (intel.candidates.length > 5) {
      console.log(dim(`  ... ${intel.candidates.length - 5} more (use --pending for full list)`));
    }
    console.log();
  }

  console.log(dim('Tip: cc-cli feedback --agent <name>  |  --pending  |  --culture'));
}

// ── Per-agent drill-in ──────────────────────────────────────────────

async function showAgent(corpRoot: string, name: string, jsonOut: boolean): Promise<void> {
  const agents = findAllAgentDirs(corpRoot);
  const normalize = (s: string) => s.toLowerCase().replace(/[\s-_]+/g, '');
  const needle = normalize(name);
  const match = agents.find(a => normalize(a.name) === needle);
  if (!match) {
    console.error(red(`Agent "${name}" not found.`));
    console.error(dim(`Available: ${agents.map(a => a.name).join(', ') || '(none)'}`));
    process.exit(1);
  }

  const intel = getAgentFeedbackIntel(corpRoot, match.name, match.dir);

  if (jsonOut) {
    console.log(JSON.stringify(intel, null, 2));
    return;
  }

  console.log();
  console.log(bold(`Feedback — ${match.name}`));
  console.log(dim(`  ${match.dir}`));
  console.log();

  // Pending
  console.log(bold('Pending feedback'));
  if (!intel.hasPending) {
    console.log(dim('  (nothing pending — agent is clear)'));
  } else {
    console.log(dim(`  ${intel.pendingPath}`));
    console.log(dim(`  ${intel.stats.pendingCount} entr${intel.stats.pendingCount === 1 ? 'y' : 'ies'} awaiting next dream`));
    console.log();
    for (const p of intel.pending) {
      const when = p.timestamp?.slice(0, 16).replace('T', ' ') ?? '(no ts)';
      console.log(`  ${dim(when)}  ${polarityColor(p.polarity)}  ${dim(p.channel ?? '')}`);
      if (p.matchedPatterns.length > 0) {
        console.log(`    ${dim('matched:')} ${p.matchedPatterns.slice(0, 5).join(', ')}`);
      }
      const quoteLine = p.quote.replace(/\n/g, ' ').slice(0, 140);
      console.log(`    ${cyan('>')} ${quoteLine}${p.quote.length > 140 ? dim('…') : ''}`);
      console.log();
    }
  }

  // BRAIN entries
  console.log(bold('Feedback-sourced BRAIN entries'));
  if (intel.brainEntries.length === 0) {
    console.log(dim('  (none yet — dreams will promote pending feedback here)'));
  } else {
    for (const e of intel.brainEntries) {
      const repeatBadge = e.timesHeard >= 2 ? bold(yellow(`×${e.timesHeard}`)) : dim(`×${e.timesHeard}`);
      console.log(`  ${repeatBadge}  ${bold(e.name)}  ${dim(e.source)} · ${dim(e.type)} · ${dim('conf=' + e.confidence)}`);
      if (e.tags.length > 0) {
        console.log(`      ${dim('tags:')} ${e.tags.slice(0, 8).join(', ')}`);
      }
      const excerpt = e.excerpt.slice(0, 160);
      console.log(`      ${dim(excerpt)}${e.excerpt.length > 160 ? dim('…') : ''}`);
      console.log();
    }
  }
}

// ── Pending promotion queue ─────────────────────────────────────────

async function showPending(corpRoot: string, jsonOut: boolean): Promise<void> {
  const intel = getCorpFeedbackIntel(corpRoot);

  if (jsonOut) {
    console.log(JSON.stringify({ candidates: intel.candidates, totals: intel.totals }, null, 2));
    return;
  }

  console.log();
  console.log(bold(`CULTURE.md promotion queue — ${intel.candidates.length} candidate(s)`));
  console.log(dim('  Next CEO dream will consider these for corp-wide law.'));
  console.log();

  if (intel.candidates.length === 0) {
    console.log(dim('  (nothing queued — feedback hasn\'t compounded enough yet)'));
    return;
  }

  renderCandidates(intel.candidates);
}

function renderCandidates(candidates: CultureCandidate[]): void {
  for (const cand of candidates) {
    console.log(
      `  ${strengthBadge(cand.strength)} ${bold(cand.sharedTags.slice(0, 4).join(', '))} ` +
      dim(`· ${cand.agents.length} agent(s) · heard ${cand.totalTimesHeard}x · max ${cand.maxTimesHeard}`),
    );
    console.log(`      ${dim('agents:')} ${cand.agents.join(', ')}`);
    for (const e of cand.entries.slice(0, 3)) {
      const excerpt = e.excerpt.slice(0, 120);
      console.log(`      ${dim(`${e.agent}/${e.file} (×${e.timesHeard}):`)} ${excerpt}${e.excerpt.length > 120 ? dim('…') : ''}`);
    }
    console.log();
  }
}

// ── CULTURE.md dump ─────────────────────────────────────────────────

async function dumpCulture(corpRoot: string, jsonOut: boolean): Promise<void> {
  const intel = getCorpFeedbackIntel(corpRoot);

  if (jsonOut) {
    console.log(JSON.stringify({
      path: intel.culturePath,
      content: intel.cultureContent,
      sizeChars: intel.cultureSizeChars,
    }, null, 2));
    return;
  }

  if (intel.cultureContent === null) {
    console.log(dim(`CULTURE.md not written yet. Path: ${intel.culturePath}`));
    return;
  }

  console.log(intel.cultureContent);
}
