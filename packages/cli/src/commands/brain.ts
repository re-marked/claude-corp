/**
 * cc-cli brain — B.R.A.I.N. memory navigation from the CLI.
 *
 * Subcommands:
 *   brain                         — show usage + quick stats
 *   brain list [--type <type>]    — list all BRAIN files
 *   brain show <name>             — read a specific BRAIN file
 *   brain search <query>          — full-text search across body, tags, filename
 *   brain search --tag <tag>      — search by tag
 *   brain search --type <type>    — search by memory type
 *   brain links <name>            — show inbound + outbound wikilinks for a file
 *   brain stale                   — files not validated in 30+ days
 *   brain orphans                 — files with no inbound wikilinks
 *   brain stats                   — comprehensive stats
 *   brain graph                   — link topology + clusters
 *   brain tags                    — list all tags by frequency
 */

import { getCorpRoot, getMembers } from '../client.js';
import {
  listBrainFiles,
  searchBrain,
  searchByTag,
  searchByType,
  readBrainFile,
  createBrainFile,
  validateBrainFile,
  deleteBrainFile,
  findBacklinks,
  findStaleFiles,
  findOrphans,
  getBrainStats,
  buildBrainGraph,
  STALENESS_THRESHOLD_DAYS,
  getCorpCultureStats,
  getAgentTagSignature,
  getAgentOverlaps,
  getCultureHealth,
  suggestTagNormalization,
  type BrainFile,
  type BrainMemoryType,
  type BrainSource,
  type BrainConfidence,
} from '@claudecorp/shared';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

export async function cmdBrain(opts: {
  args: string[];
  agent?: string;
  tag?: string;
  type?: string;
  source?: string;
  confidence?: string;
  json: boolean;
}): Promise<void> {
  const corpRoot = await getCorpRoot();
  const agentDir = await resolveAgentDir(corpRoot, opts.agent);

  if (!agentDir) {
    console.error('Could not resolve agent. Use --agent <name> or specify in context.');
    return;
  }

  const subcommand = opts.args[0]?.toLowerCase();

  if (!subcommand) {
    await showUsageAndStats(agentDir, opts.json);
    return;
  }

  switch (subcommand) {
    // Navigation
    case 'list': return showList(agentDir, opts.type as BrainMemoryType | undefined, opts.json);
    case 'show':
    case 'read': return showFile(agentDir, opts.args[1], opts.json);
    case 'search': return showSearch(agentDir, opts.args.slice(1), opts.tag, opts.type, opts.json);
    case 'links': return showLinks(agentDir, opts.args[1], opts.json);
    // Diagnostics
    case 'stale': return showStale(agentDir, opts.json);
    case 'orphans': return showOrphans(agentDir, opts.json);
    case 'stats': return showStats(agentDir, opts.json);
    case 'graph': return showGraph(agentDir, opts.json);
    // Actions
    case 'create': return doCreate(agentDir, opts.args.slice(1), opts.type, opts.tag, opts.source, opts.confidence, opts.json);
    // Culture
    case 'culture': return showCulture(corpRoot, agentDir, opts.args.slice(1), opts.json);
    case 'validate': return doValidate(agentDir, opts.args[1], opts.json);
    case 'delete':
    case 'rm': return doDelete(agentDir, opts.args[1], opts.json);
    case 'tags': return showTags(agentDir, opts.json);
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log('Run cc-cli brain for usage.');
  }
}

// ── Agent Resolution ────────────────────────────────────────────────

async function resolveAgentDir(corpRoot: string, agentName?: string): Promise<string | null> {
  // If agent name provided, use it
  if (agentName) {
    const dir = join(corpRoot, 'agents', agentName);
    return existsSync(dir) ? dir : null;
  }

  // Default to CEO
  const ceoDir = join(corpRoot, 'agents', 'ceo');
  if (existsSync(ceoDir)) return ceoDir;

  // Try first agent found
  const agentsDir = join(corpRoot, 'agents');
  if (!existsSync(agentsDir)) return null;
  const agents = readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  return agents.length > 0 ? join(agentsDir, agents[0]!.name) : null;
}

// ── Subcommand Implementations ──────────────────────────────────────

async function showUsageAndStats(agentDir: string, json: boolean): Promise<void> {
  const stats = getBrainStats(agentDir);

  if (json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  const agentName = agentDir.split(/[/\\]/).pop();
  console.log(`B.R.A.I.N. — ${agentName}`);
  console.log('');

  if (stats.fileCount === 0) {
    console.log('  No memories yet.');
    console.log('');
  } else {
    console.log(`  ${stats.fileCount} memor${stats.fileCount === 1 ? 'y' : 'ies'}, ${stats.totalLinks} link${stats.totalLinks === 1 ? '' : 's'}`);

    // Type breakdown
    for (const [type, count] of Object.entries(stats.typeCounts)) {
      console.log(`  ${count} ${type}`);
    }
    console.log('');

    // Stale warning
    if (stats.staleFiles.length > 0) {
      console.log(`  ⚠ ${stats.staleFiles.length} stale (not validated in ${STALENESS_THRESHOLD_DAYS}+ days)`);
      console.log('');
    }
  }

  console.log('Usage:');
  console.log('  cc-cli brain list [--type <type>]     List memories');
  console.log('  cc-cli brain show <name>              Read a memory');
  console.log('  cc-cli brain search <query>           Full-text search');
  console.log('  cc-cli brain search --tag <tag>       Search by tag');
  console.log('  cc-cli brain search --type <type>     Search by type');
  console.log('  cc-cli brain links <name>             Show wikilinks');
  console.log('  cc-cli brain stale                    Memories needing validation');
  console.log('  cc-cli brain orphans                  Unlinked memories');
  console.log('  cc-cli brain stats                    Detailed statistics');
  console.log('  cc-cli brain graph                    Link topology');
  console.log('  cc-cli brain tags                     All tags by frequency');
  console.log('');
  console.log('Actions:');
  console.log('  cc-cli brain create <name> --type <type> --tag <tags> <body>');
  console.log('                                        Create a memory with frontmatter');
  console.log('  cc-cli brain validate <name>          Mark a memory as still valid');
  console.log('  cc-cli brain delete <name>            Delete a memory');
  console.log('');
  console.log('Culture (cross-agent):');
  console.log('  cc-cli brain culture                  Corp-wide culture overview');
  console.log('  cc-cli brain culture signature        Your unique vs shared tags');
  console.log('  cc-cli brain culture overlap          Pairwise agent tag overlap');
  console.log('  cc-cli brain culture health           Is the culture alive?');
  console.log('  cc-cli brain culture normalize        Tag cleanup suggestions');
  console.log('');
  console.log('Options:');
  console.log('  --agent <name>    Target a specific agent (default: ceo)');
  console.log('  --json            Machine-readable output');
}

async function showList(agentDir: string, typeFilter: BrainMemoryType | undefined, json: boolean): Promise<void> {
  let files = listBrainFiles(agentDir);

  if (typeFilter) {
    files = files.filter(f => f.meta.type === typeFilter);
  }

  if (json) {
    console.log(JSON.stringify(files.map(f => ({
      name: f.name,
      type: f.meta.type,
      tags: f.meta.tags,
      source: f.meta.source,
      confidence: f.meta.confidence,
      links: f.links.length,
      created: f.meta.created,
      updated: f.meta.updated,
      last_validated: f.meta.last_validated,
    })), null, 2));
    return;
  }

  if (files.length === 0) {
    console.log(typeFilter ? `No ${typeFilter} memories.` : 'No memories yet.');
    return;
  }

  // Group by type
  const byType = new Map<string, BrainFile[]>();
  for (const file of files) {
    const existing = byType.get(file.meta.type) || [];
    existing.push(file);
    byType.set(file.meta.type, existing);
  }

  for (const [type, typeFiles] of byType) {
    console.log(`${type.toUpperCase()}`);
    for (const file of typeFiles) {
      const tags = file.meta.tags.length > 0 ? ` [${file.meta.tags.join(', ')}]` : '';
      const links = file.links.length > 0 ? ` (${file.links.length} links)` : '';
      const confidence = file.meta.confidence !== 'medium' ? ` {${file.meta.confidence}}` : '';
      console.log(`  ${file.name}${tags}${links}${confidence}`);
    }
    console.log('');
  }
}

async function showFile(agentDir: string, name: string | undefined, json: boolean): Promise<void> {
  if (!name) {
    console.error('Usage: cc-cli brain show <name>');
    return;
  }

  const file = readBrainFile(agentDir, name);
  if (!file) {
    console.error(`Memory not found: ${name}`);
    return;
  }

  if (json) {
    console.log(JSON.stringify(file, null, 2));
    return;
  }

  console.log(`${file.name}`);
  console.log(`  type: ${file.meta.type}  source: ${file.meta.source}  confidence: ${file.meta.confidence}`);
  console.log(`  tags: ${file.meta.tags.join(', ') || '(none)'}`);
  console.log(`  created: ${file.meta.created}  updated: ${file.meta.updated}  validated: ${file.meta.last_validated}`);

  if (file.links.length > 0) {
    console.log(`  links: ${file.links.map(l => `[[${l}]]`).join(', ')}`);
  }

  const backlinks = findBacklinks(file.name, agentDir);
  if (backlinks.length > 0) {
    console.log(`  backlinks: ${backlinks.map(l => `[[${l}]]`).join(', ')}`);
  }

  console.log('');
  console.log(file.body);
}

async function showSearch(
  agentDir: string,
  args: string[],
  tagFilter?: string,
  typeFilter?: string,
  json: boolean = false,
): Promise<void> {
  let results;

  if (tagFilter) {
    const files = searchByTag(agentDir, tagFilter);
    results = files.map(f => ({ file: f, matchReason: `tag: ${tagFilter}` }));
  } else if (typeFilter) {
    const files = searchByType(agentDir, typeFilter as BrainMemoryType);
    results = files.map(f => ({ file: f, matchReason: `type: ${typeFilter}` }));
  } else {
    const query = args.join(' ');
    if (!query) {
      console.error('Usage: cc-cli brain search <query> or --tag <tag> or --type <type>');
      return;
    }
    results = searchBrain(agentDir, query);
  }

  if (json) {
    console.log(JSON.stringify(results.map(r => ({
      name: r.file.name,
      type: r.file.meta.type,
      tags: r.file.meta.tags,
      matchReason: r.matchReason,
    })), null, 2));
    return;
  }

  if (results.length === 0) {
    console.log('No results.');
    return;
  }

  console.log(`${results.length} result${results.length === 1 ? '' : 's'}:`);
  console.log('');
  for (const { file, matchReason } of results) {
    const firstLine = file.body.split('\n')[0]?.slice(0, 60) || '';
    console.log(`  ${file.name} (${file.meta.type})`);
    console.log(`    ${firstLine}`);
    console.log(`    matched: ${matchReason}`);
    console.log('');
  }
}

async function showLinks(agentDir: string, name: string | undefined, json: boolean): Promise<void> {
  if (!name) {
    console.error('Usage: cc-cli brain links <name>');
    return;
  }

  const file = readBrainFile(agentDir, name);
  if (!file) {
    console.error(`Memory not found: ${name}`);
    return;
  }

  const backlinks = findBacklinks(name, agentDir);

  if (json) {
    console.log(JSON.stringify({ outbound: file.links, inbound: backlinks }, null, 2));
    return;
  }

  console.log(`Links for [[${name}]]:`);
  console.log('');

  if (file.links.length > 0) {
    console.log('  Outbound (this file links to):');
    for (const link of file.links) {
      const target = readBrainFile(agentDir, link);
      const status = target ? `${target.meta.type}` : 'missing';
      console.log(`    → [[${link}]] (${status})`);
    }
  } else {
    console.log('  Outbound: none');
  }

  console.log('');

  if (backlinks.length > 0) {
    console.log('  Inbound (linked TO by):');
    for (const link of backlinks) {
      const source = readBrainFile(agentDir, link);
      const status = source ? `${source.meta.type}` : 'unknown';
      console.log(`    ← [[${link}]] (${status})`);
    }
  } else {
    console.log('  Inbound: none (orphan)');
  }
}

async function showStale(agentDir: string, json: boolean): Promise<void> {
  const stale = findStaleFiles(agentDir);

  if (json) {
    console.log(JSON.stringify(stale.map(f => ({
      name: f.name,
      type: f.meta.type,
      last_validated: f.meta.last_validated,
    })), null, 2));
    return;
  }

  if (stale.length === 0) {
    console.log(`No stale memories (all validated within ${STALENESS_THRESHOLD_DAYS} days).`);
    return;
  }

  console.log(`${stale.length} stale memor${stale.length === 1 ? 'y' : 'ies'} (not validated in ${STALENESS_THRESHOLD_DAYS}+ days):`);
  console.log('');
  for (const file of stale) {
    const daysSince = Math.floor((Date.now() - new Date(file.meta.last_validated).getTime()) / (1000 * 60 * 60 * 24));
    console.log(`  ${file.name} — ${file.meta.type}, last validated ${file.meta.last_validated} (${daysSince}d ago)`);
  }
  console.log('');
  console.log('Re-read these and either validate or delete them.');
}

async function showOrphans(agentDir: string, json: boolean): Promise<void> {
  const orphans = findOrphans(agentDir);

  if (json) {
    console.log(JSON.stringify(orphans.map(f => ({
      name: f.name,
      type: f.meta.type,
      tags: f.meta.tags,
    })), null, 2));
    return;
  }

  if (orphans.length === 0) {
    console.log('No orphan memories — everything is linked.');
    return;
  }

  console.log(`${orphans.length} orphan memor${orphans.length === 1 ? 'y' : 'ies'} (no inbound [[wikilinks]]):`);
  console.log('');
  for (const file of orphans) {
    const tags = file.meta.tags.length > 0 ? ` [${file.meta.tags.join(', ')}]` : '';
    console.log(`  ${file.name} — ${file.meta.type}${tags}`);
  }
  console.log('');
  console.log('Consider linking these from related memories, or pruning if no longer needed.');
}

async function showStats(agentDir: string, json: boolean): Promise<void> {
  const stats = getBrainStats(agentDir);

  if (json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  const agentName = agentDir.split(/[/\\]/).pop();
  console.log(`B.R.A.I.N. STATS — ${agentName}`);
  console.log('');

  // Overview
  console.log(`  Memories: ${stats.fileCount}`);
  console.log(`  Links: ${stats.totalLinks}`);
  console.log(`  Stale: ${stats.staleFiles.length}`);
  console.log(`  Orphans: ${stats.orphanFiles.length}`);
  console.log('');

  // By type
  if (Object.keys(stats.typeCounts).length > 0) {
    console.log('  BY TYPE');
    for (const [type, count] of Object.entries(stats.typeCounts)) {
      const bar = '█'.repeat(count);
      console.log(`    ${type.padEnd(20)} ${bar} ${count}`);
    }
    console.log('');
  }

  // Top tags
  if (stats.topTags.length > 0) {
    console.log('  TOP TAGS');
    for (const { tag, count } of stats.topTags.slice(0, 10)) {
      console.log(`    ${tag.padEnd(20)} ${count}`);
    }
    console.log('');
  }

  // Stale warnings
  if (stats.staleFiles.length > 0) {
    console.log(`  ⚠ STALE (${STALENESS_THRESHOLD_DAYS}+ days since validation)`);
    for (const { name, daysSinceValidation } of stats.staleFiles) {
      console.log(`    ${name} — ${daysSinceValidation}d ago`);
    }
    console.log('');
  }
}

async function showGraph(agentDir: string, json: boolean): Promise<void> {
  const graph = buildBrainGraph(agentDir);

  if (json) {
    console.log(JSON.stringify(graph, null, 2));
    return;
  }

  if (graph.nodes.length === 0) {
    console.log('No memories to graph.');
    return;
  }

  console.log(`BRAIN GRAPH — ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.clusters.length} cluster${graph.clusters.length === 1 ? '' : 's'}`);
  console.log('');

  // Show clusters
  for (let i = 0; i < graph.clusters.length; i++) {
    const cluster = graph.clusters[i]!;
    if (cluster.length === 1) {
      console.log(`  ○ ${cluster[0]} (isolated)`);
    } else {
      console.log(`  Cluster ${i + 1} (${cluster.length} nodes):`);
      for (const node of cluster) {
        const outbound = graph.edges.filter(e => e.from === node).map(e => e.to);
        if (outbound.length > 0) {
          console.log(`    ${node} → ${outbound.join(', ')}`);
        } else {
          console.log(`    ${node}`);
        }
      }
    }
    console.log('');
  }
}

async function showTags(agentDir: string, json: boolean): Promise<void> {
  const stats = getBrainStats(agentDir);

  if (json) {
    console.log(JSON.stringify(stats.topTags, null, 2));
    return;
  }

  if (stats.topTags.length === 0) {
    console.log('No tags yet.');
    return;
  }

  console.log(`${stats.topTags.length} unique tag${stats.topTags.length === 1 ? '' : 's'}:`);
  console.log('');
  for (const { tag, count } of stats.topTags) {
    const bar = '█'.repeat(count);
    console.log(`  ${tag.padEnd(25)} ${bar} ${count}`);
  }
}

// ── Action Commands ─────────────────────────────────────────────────

async function doCreate(
  agentDir: string,
  args: string[],
  typeArg?: string,
  tagArg?: string,
  sourceArg?: string,
  confidenceArg?: string,
  json: boolean = false,
): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: cc-cli brain create <name> --type <type> [--tag <tags>] [--source <source>] [--confidence <level>] [body...]');
    console.error('');
    console.error('Types:      founder-preference, technical, decision, self-knowledge, correction, relationship');
    console.error('Sources:    founder-direct, observation, dream, correction, agent-secondhand');
    console.error('Confidence: high, medium, low');
    return;
  }

  const type = (typeArg || 'technical') as BrainMemoryType;
  const source = (sourceArg || 'observation') as BrainSource;
  const confidence = (confidenceArg || 'medium') as BrainConfidence;
  const tags = tagArg ? tagArg.split(',').map(t => t.trim()) : [];
  const body = args.slice(1).join(' ') || '(empty — fill in the content)';

  try {
    const file = createBrainFile(agentDir, name, body, type, tags, source, confidence);

    if (json) {
      console.log(JSON.stringify({ created: file.name, type: file.meta.type, tags: file.meta.tags, path: file.path }, null, 2));
      return;
    }

    console.log(`Created: ${file.name}`);
    console.log(`  type: ${file.meta.type}  tags: ${file.meta.tags.join(', ') || '(none)'}`);
    console.log(`  path: ${file.path}`);
  } catch (err: any) {
    console.error(err.message);
  }
}

async function doValidate(agentDir: string, name: string | undefined, json: boolean): Promise<void> {
  if (!name) {
    console.error('Usage: cc-cli brain validate <name>');
    console.error('Marks a memory as still valid (updates last_validated to today).');
    return;
  }

  try {
    const file = validateBrainFile(agentDir, name);

    if (json) {
      console.log(JSON.stringify({ validated: file.name, last_validated: file.meta.last_validated }, null, 2));
      return;
    }

    console.log(`Validated: ${file.name} — last_validated set to ${file.meta.last_validated}`);
  } catch (err: any) {
    console.error(err.message);
  }
}

async function doDelete(agentDir: string, name: string | undefined, json: boolean): Promise<void> {
  if (!name) {
    console.error('Usage: cc-cli brain delete <name>');
    console.error('Permanently deletes a BRAIN memory. Use for contradicted or stale memories.');
    return;
  }

  const deleted = deleteBrainFile(agentDir, name);

  if (json) {
    console.log(JSON.stringify({ deleted: name, success: deleted }));
    return;
  }

  if (deleted) {
    console.log(`Deleted: ${name}`);
    console.log('Remember to remove the entry from MEMORY.md if it was indexed.');
  } else {
    console.error(`Memory not found: ${name}`);
  }
}

// ── Culture Commands ────────────────────────────────────────────────

async function showCulture(corpRoot: string, agentDir: string, args: string[], json: boolean): Promise<void> {
  const sub = args[0]?.toLowerCase();

  switch (sub) {
    case 'overlap': return showCultureOverlap(corpRoot, json);
    case 'health': return showCultureHealth(corpRoot, json);
    case 'normalize': return showCultureNormalize(corpRoot, json);
    case 'signature': return showCultureSignature(corpRoot, agentDir, json);
    default: return showCultureOverview(corpRoot, agentDir, json);
  }
}

async function showCultureOverview(corpRoot: string, agentDir: string, json: boolean): Promise<void> {
  const stats = getCorpCultureStats(corpRoot);

  if (json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log('B.R.A.I.N. CULTURE ANALYSIS');
  console.log('');

  // Health badge
  const healthBadge = {
    thriving: '🟢 THRIVING',
    healthy: '🟡 HEALTHY',
    thin: '🟠 THIN',
    absent: '🔴 ABSENT',
  }[stats.health.status];
  console.log(`  Status: ${healthBadge}`);
  console.log(`  Agents analyzed: ${stats.agents.length}`);
  console.log(`  Total unique tags: ${stats.health.totalUniqueTags}`);
  console.log(`  Shared vocabulary: ${stats.health.sharedTagCount} tags`);
  console.log(`  Average alignment: ${stats.health.averageAlignment}%`);
  console.log(`  Tag diversity: ${stats.health.diversityRatio}`);
  console.log('');

  // Shared vocabulary
  if (stats.sharedVocabulary.length > 0) {
    console.log('  SHARED VOCABULARY (cultural tags)');
    for (const tag of stats.sharedVocabulary.slice(0, 15)) {
      const bar = '█'.repeat(tag.agentCount);
      console.log(`    ${tag.tag.padEnd(25)} ${bar} ${tag.agentCount} agents, ${tag.totalUses} uses`);
    }
    console.log('');
  }

  // Agent signatures
  if (stats.agents.length > 0) {
    console.log('  AGENT SIGNATURES');
    for (const agent of stats.agents) {
      if (agent.fileCount === 0) {
        console.log(`    ${agent.agentName.padEnd(20)} (no BRAIN files)`);
        continue;
      }
      const uniqueStr = agent.uniqueTags.length > 0
        ? ` unique: ${agent.uniqueTags.slice(0, 3).join(', ')}${agent.uniqueTags.length > 3 ? '...' : ''}`
        : '';
      console.log(`    ${agent.agentName.padEnd(20)} ${agent.fileCount} files, ${agent.alignmentScore}% aligned${uniqueStr}`);
    }
    console.log('');
  }

  // Warnings
  if (stats.health.warnings.length > 0) {
    console.log('  ⚠ WARNINGS');
    for (const warning of stats.health.warnings) {
      console.log(`    ${warning}`);
    }
    console.log('');
  }

  // Normalization suggestions
  if (stats.normalizationSuggestions.length > 0) {
    console.log('  TAG CLEANUP SUGGESTIONS');
    for (const s of stats.normalizationSuggestions.slice(0, 5)) {
      console.log(`    ${s.tags.join(' / ')} → ${s.suggestedCanonical} (${s.reason})`);
    }
    console.log('');
  }

  console.log('Subcommands:');
  console.log('  brain culture                   This overview');
  console.log('  brain culture signature          Your unique vs shared tags');
  console.log('  brain culture overlap            Pairwise agent tag overlap');
  console.log('  brain culture health             Detailed health assessment');
  console.log('  brain culture normalize          Tag cleanup suggestions');
}

async function showCultureSignature(corpRoot: string, agentDir: string, json: boolean): Promise<void> {
  const sig = getAgentTagSignature(corpRoot, agentDir);

  if (json) {
    console.log(JSON.stringify(sig, null, 2));
    return;
  }

  console.log(`TAG SIGNATURE — ${sig.agentName}`);
  console.log('');
  console.log(`  Files: ${sig.fileCount}`);
  console.log(`  Cultural alignment: ${sig.alignmentScore}%`);
  console.log('');

  if (sig.sharedTags.length > 0) {
    console.log(`  SHARED TAGS (${sig.sharedTags.length}) — part of the corp's vocabulary`);
    console.log(`    ${sig.sharedTags.join(', ')}`);
    console.log('');
  }

  if (sig.uniqueTags.length > 0) {
    console.log(`  UNIQUE TAGS (${sig.uniqueTags.length}) — your idiosyncrasy`);
    console.log(`    ${sig.uniqueTags.join(', ')}`);
    console.log('');
  }

  if (Object.keys(sig.tagsByType).length > 0) {
    console.log('  TAGS BY MEMORY TYPE');
    for (const [type, tags] of Object.entries(sig.tagsByType)) {
      console.log(`    ${type.padEnd(22)} ${(tags as string[]).join(', ')}`);
    }
    console.log('');
  }
}

async function showCultureOverlap(corpRoot: string, json: boolean): Promise<void> {
  const overlaps = getAgentOverlaps(corpRoot);

  if (json) {
    console.log(JSON.stringify(overlaps, null, 2));
    return;
  }

  if (overlaps.length === 0) {
    console.log('No tag overlap between agents yet.');
    return;
  }

  console.log('AGENT TAG OVERLAP');
  console.log('');
  for (const o of overlaps) {
    const bar = '█'.repeat(Math.max(1, Math.round(o.overlapScore / 10)));
    console.log(`  ${o.agentA} ↔ ${o.agentB}`);
    console.log(`    ${bar} ${o.overlapScore}% Jaccard similarity`);
    console.log(`    shared: ${o.sharedTags.join(', ')}`);
    console.log('');
  }
}

async function showCultureHealth(corpRoot: string, json: boolean): Promise<void> {
  const health = getCultureHealth(corpRoot);

  if (json) {
    console.log(JSON.stringify(health, null, 2));
    return;
  }

  const badge = {
    thriving: '🟢 THRIVING — strong shared vocabulary, agents speak the same language',
    healthy: '🟡 HEALTHY — some shared vocabulary forming, room to grow',
    thin: '🟠 THIN — agents developing isolated vocabularies',
    absent: '🔴 ABSENT — no cross-agent cultural signal yet',
  }[health.status];

  console.log('CULTURE HEALTH');
  console.log('');
  console.log(`  ${badge}`);
  console.log('');
  console.log(`  Shared tags:        ${health.sharedTagCount}`);
  console.log(`  Total unique tags:  ${health.totalUniqueTags}`);
  console.log(`  Average alignment:  ${health.averageAlignment}%`);
  console.log(`  Diversity ratio:    ${health.diversityRatio}`);
  console.log('');

  if (health.leastAligned) {
    console.log(`  Least aligned:      ${health.leastAligned.name} (${health.leastAligned.score}%)`);
  }
  if (health.mostIdiosyncratic) {
    console.log(`  Most idiosyncratic: ${health.mostIdiosyncratic.name} (${health.mostIdiosyncratic.uniqueCount} unique tags)`);
  }
  console.log('');

  if (health.warnings.length > 0) {
    console.log('  WARNINGS');
    for (const w of health.warnings) {
      console.log(`    ⚠ ${w}`);
    }
  } else {
    console.log('  No warnings.');
  }
}

async function showCultureNormalize(corpRoot: string, json: boolean): Promise<void> {
  const suggestions = suggestTagNormalization(corpRoot);

  if (json) {
    console.log(JSON.stringify(suggestions, null, 2));
    return;
  }

  if (suggestions.length === 0) {
    console.log('No tag normalization suggestions. Tags are clean.');
    return;
  }

  console.log('TAG NORMALIZATION SUGGESTIONS');
  console.log('');
  for (const s of suggestions) {
    console.log(`  ${s.tags.join(' / ')} → ${s.suggestedCanonical}`);
    console.log(`    reason: ${s.reason}`);
    console.log('');
  }
  console.log('To normalize, update tags in the affected BRAIN files manually or during the next dream cycle.');
}
