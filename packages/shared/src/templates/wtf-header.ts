/**
 * Situational header — the "who/what/where" layer that \`cc-cli wtf\`
 * prepends to CORP.md when emitting to stdout or writing context.
 *
 * This is the DYNAMIC half of the 0.7 architecture (CORP.md is the
 * static reference manual; this header carries live state). Answers
 * the three questions an agent wakes up with: who am I, where am I,
 * what do I need to do right now.
 *
 * Pure function — caller (the wtf command) reads the member record,
 * Casket chit, any predecessor handoff WORKLOG, inbox-item chits, and
 * the current time, then passes them as opts. Zero I/O here; every
 * failure-mode decision lives in the I/O layer (wtf command), not in
 * the rendering.
 */

import type { CorpMdKind } from './corp-md.js';

export interface WtfCurrentTask {
  /** Task chit id (chit-t-xxxxxxxx format). */
  chitId: string;
  /** Human-readable task title from fields.task.title. */
  title: string;
}

export interface WtfInboxPeek {
  /** Sender member id (e.g. 'mark' for founder, 'herald' for herald). */
  from: string;
  /** One-line subject from fields.inbox-item.subject. */
  subject: string;
  /** Pre-computed relative age label ("3h ago", "20m ago"). Caller owns the clock. */
  ageLabel: string;
}

export interface WtfInboxSummary {
  tier3Count: number;
  tier2Count: number;
  tier1Count: number;
  /** Up to ~3 most recent Tier 3 items for the agent to eyeball. */
  tier3Peek?: readonly WtfInboxPeek[];
  /** Up to ~3 most recent Tier 2 items. */
  tier2Peek?: readonly WtfInboxPeek[];
}

export interface WtfHeaderOpts {
  kind: CorpMdKind;
  /** Display name — Partner's founder-given name or Employee's self-chosen slot name. */
  displayName: string;
  /** Role — 'CEO', 'Backend Engineer', etc. */
  role: string;
  /** Absolute workspace path. */
  workspacePath: string;
  /** Absolute path to the CORP.md that wtf just wrote. */
  corpMdPath: string;
  /** ISO timestamp of generation. Caller provides; template doesn't touch the clock. */
  generatedAt: string;
  /** Current task from Casket.current_step, if any. */
  currentTask?: WtfCurrentTask;
  /** Predecessor session's WORKLOG handoff XML. Employee-only; ignored for Partners. */
  handoffXml?: string;
  /** Inbox summary (counts + optional per-tier peeks). */
  inboxSummary: WtfInboxSummary;
}

/**
 * Build the situational header. The wtf command prepends this to CORP.md
 * contents when emitting a system-reminder block.
 */
export function buildWtfHeader(opts: WtfHeaderOpts): string {
  const parts: string[] = [];
  parts.push(identityLine(opts));
  parts.push(workspaceLine(opts));
  parts.push('');
  parts.push(currentTaskBlock(opts));
  parts.push('');
  parts.push(inboxBlock(opts.inboxSummary));

  // Handoff is Employee-only. Partners never render it, even if caller
  // accidentally passes handoffXml (bug-resistance).
  if (opts.kind === 'employee' && opts.handoffXml && opts.handoffXml.trim().length > 0) {
    parts.push('');
    parts.push(handoffBlock(opts.handoffXml));
  }

  parts.push('');
  parts.push(footerBlock(opts));

  return parts.join('\n') + '\n';
}

// ─── Section helpers ───────────────────────────────────────────────

function identityLine(opts: WtfHeaderOpts): string {
  return `You are ${opts.displayName}, ${opts.role} (${opts.kind}).`;
}

function workspaceLine(opts: WtfHeaderOpts): string {
  return `Sandbox: ${opts.workspacePath}`;
}

function currentTaskBlock(opts: WtfHeaderOpts): string {
  if (!opts.currentTask) {
    return `Current task: none. Check your INBOX and TASKS — or escalate if you're genuinely without direction.`;
  }
  return `Current task: ${opts.currentTask.chitId} — ${opts.currentTask.title}`;
}

function inboxBlock(summary: WtfInboxSummary): string {
  const total = summary.tier3Count + summary.tier2Count + summary.tier1Count;
  if (total === 0) {
    return `Inbox: empty.`;
  }

  const unresolvedHigh = summary.tier3Count + summary.tier2Count;
  const lines: string[] = [];

  if (unresolvedHigh === 0 && summary.tier1Count > 0) {
    lines.push(
      `Inbox: ${summary.tier1Count} ambient (auto-expire; read with \`cc-cli inbox list --tier 1\` if you want them).`,
    );
    return lines.join('\n');
  }

  lines.push(`Inbox: ${unresolvedHigh} unresolved${summary.tier1Count > 0 ? ` (+${summary.tier1Count} ambient auto-expiring)` : ''}.`);

  if (summary.tier3Count > 0) {
    lines.push(`  [T3] ${summary.tier3Count} critical — audit will block completion while unresolved:`);
    for (const peek of summary.tier3Peek ?? []) {
      lines.push(`    • ${peek.from} — "${peek.subject}" (${peek.ageLabel})`);
    }
  }

  if (summary.tier2Count > 0) {
    lines.push(`  [T2] ${summary.tier2Count} direct:`);
    for (const peek of summary.tier2Peek ?? []) {
      lines.push(`    • ${peek.from} — "${peek.subject}" (${peek.ageLabel})`);
    }
  }

  return lines.join('\n');
}

function handoffBlock(xml: string): string {
  return [
    `Handoff from predecessor session:`,
    '```xml',
    xml.trim(),
    '```',
  ].join('\n');
}

function footerBlock(opts: WtfHeaderOpts): string {
  return [
    `Generated: ${opts.generatedAt}`,
    `CORP.md at: ${opts.corpMdPath}`,
    `Re-run \`cc-cli wtf\` any time you're disoriented.`,
  ].join('\n');
}
