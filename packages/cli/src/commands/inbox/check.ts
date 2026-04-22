/**
 * `cc-cli inbox check` — UserPromptSubmit hook integration.
 *
 * Emits a `<system-reminder>` block listing new inbox items (Tier 3
 * first, then Tier 2) created SINCE the last check. Tier 1 items
 * deliberately omitted — ambient noise shouldn't inject into the
 * agent's context mid-conversation; they surface in `cc-cli inbox
 * list` for on-demand review.
 *
 * "Since last check" is tracked via a per-agent timestamp file at
 * `<workspace>/.inbox-last-checked` — no daemon query needed, pure
 * workspace file I/O. Each check reads the file, queries chits
 * updated since that timestamp, emits block, writes new timestamp.
 *
 * First-run semantics: when the timestamp file doesn't exist, the
 * command emits NOTHING and writes the current timestamp. The next
 * check has a proper baseline; agents aren't flooded with historical
 * items on first invocation.
 *
 * `--inject` is the hook-mode discriminant: when present, the
 * command suppresses empty output (no noise into Claude's context
 * when there are no items) and skips the human-readable "no new
 * items" message. Without `--inject`, interactive CLI use prints
 * a legible status line so the operator sees the check ran.
 */

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  queryChits,
  MEMBERS_JSON,
  type Chit,
  type ChitScope,
  type Member,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

export async function cmdInboxCheck(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      agent: { type: 'string' },
      inject: { type: 'boolean', default: false },
      corp: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;

  if (v.help) {
    printHelp();
    return;
  }
  if (!v.agent || typeof v.agent !== 'string') {
    // Fail-open: in hook context, missing --agent shouldn't block the
    // user's prompt from submitting. Print nothing on --inject;
    // otherwise surface the error for human operators.
    if (v.inject) return;
    fail('--agent <slug> required');
  }

  const slug = v.agent as string;
  const inject = v.inject === true;

  let corpRoot: string;
  try {
    corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);
  } catch (err) {
    // Same fail-open posture as cc-cli audit: hook context shouldn't
    // break user prompts because the corp resolver failed.
    if (inject) return;
    console.error(`cc-cli inbox check: corp resolution failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const workspace = resolveAgentWorkspace(corpRoot, slug);
  if (!workspace) {
    if (inject) return;
    fail(`agent "${slug}" not found or has no agentDir`);
  }

  const stampPath = join(workspace, '.inbox-last-checked');
  const now = new Date().toISOString();

  // First-run semantics: no baseline → write stamp, emit nothing.
  // Next check has a proper delta to work from.
  if (!existsSync(stampPath)) {
    try {
      mkdirSync(workspace, { recursive: true });
      writeFileSync(stampPath, now, 'utf-8');
    } catch {
      /* best-effort — even if we can't write, the next check just
         repeats the first-run path, which is fine. */
    }
    return;
  }

  let since: string;
  try {
    since = readFileSync(stampPath, 'utf-8').trim();
    if (!since) throw new Error('empty stamp');
  } catch {
    // Stamp exists but unreadable → treat as first-run, re-write.
    try {
      writeFileSync(stampPath, now, 'utf-8');
    } catch {
      /* best-effort */
    }
    return;
  }

  // Query new-since items. Scope narrows to the recipient, statuses
  // to active (resolved items don't need re-notification), updatedSince
  // trims the window.
  const scope: ChitScope = `agent:${slug}`;
  let items: Chit<'inbox-item'>[];
  try {
    const result = queryChits(corpRoot, {
      types: ['inbox-item'],
      statuses: ['active'],
      scopes: [scope],
      updatedSince: since,
      limit: 50,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
    items = (result.chits as Chit<'inbox-item'>[]).filter((c) => {
      const t = c.fields['inbox-item']?.tier;
      // Tier 1 excluded — ambient shouldn't inject. Tier 2/3 surface.
      // Carry-forward-flagged items also skip: the agent already
      // acknowledged them once; re-injecting every turn is noise.
      if (t !== 2 && t !== 3) return false;
      if (c.fields['inbox-item']?.carriedForward === true) return false;
      return true;
    });
  } catch {
    // Query failure → fail-open on --inject, visible on operator use.
    if (inject) return;
    console.error('cc-cli inbox check: query failed');
    process.exit(1);
  }

  // Write the new stamp BEFORE emitting so a re-run doesn't re-inject
  // the same batch. If the stamp write fails we still emit — better to
  // show one duplicate batch next turn than to hide real items.
  try {
    writeFileSync(stampPath, now, 'utf-8');
  } catch {
    /* best-effort */
  }

  if (items.length === 0) {
    if (!inject) console.log('(no new inbox items)');
    return;
  }

  // Sort: Tier 3 first, then Tier 2; within each tier, newest first.
  items.sort((a, b) => {
    const ta = a.fields['inbox-item']?.tier ?? 2;
    const tb = b.fields['inbox-item']?.tier ?? 2;
    if (ta !== tb) return tb - ta; // 3 before 2
    return b.createdAt.localeCompare(a.createdAt); // newest first
  });

  const block = renderSystemReminder(items);
  process.stdout.write(block);
}

function renderSystemReminder(items: Chit<'inbox-item'>[]): string {
  const lines: string[] = [];
  lines.push('<system-reminder>');
  lines.push(
    `Inbox: ${items.length} new item${items.length === 1 ? '' : 's'} since your last turn.`,
  );
  lines.push('');
  for (const c of items) {
    const f = c.fields['inbox-item'];
    if (!f) continue;
    lines.push(`  [T${f.tier}] ${c.id}`);
    lines.push(`      from: ${f.from}`);
    lines.push(`      subject: ${f.subject}`);
    if (f.tier === 3) {
      lines.push('      (Tier 3: audit gate will block session-end until resolved.)');
    }
  }
  lines.push('');
  lines.push(
    'Resolve with `cc-cli inbox respond/dismiss/carry-forward <id> --from <your-slug>`,',
  );
  lines.push('or `cc-cli inbox list --agent <slug>` to see everything.');
  lines.push('</system-reminder>');
  lines.push('');
  return lines.join('\n');
}

function resolveAgentWorkspace(corpRoot: string, slug: string): string | null {
  try {
    const membersPath = join(corpRoot, MEMBERS_JSON);
    if (!existsSync(membersPath)) return null;
    const members = JSON.parse(readFileSync(membersPath, 'utf-8')) as Member[];
    const member = members.find((m) => m.id === slug);
    if (!member?.agentDir) return null;
    return isAbsolute(member.agentDir) ? member.agentDir : join(corpRoot, member.agentDir);
  } catch {
    return null;
  }
}

function fail(msg: string): never {
  console.error(`cc-cli inbox check: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli inbox check — surface new inbox items since last check

Usage:
  cc-cli inbox check --agent <slug> [--inject]

Required:
  --agent <slug>          Whose inbox to check.

Options:
  --inject                Hook mode. Suppresses output when there are
                          no new items (no noise into Claude's context).
                          Wired into Claude Code's UserPromptSubmit hook
                          via the settings.json emitted by 0.7.2.
  --corp <name>           Operate on a specific corp.

Behavior:
  Reads <workspace>/.inbox-last-checked; queries Tier 2/3 inbox-item
  chits updated since that timestamp; emits a <system-reminder>
  block on stdout listing them (Tier 3 first); writes the new
  timestamp.

First-run: if the stamp file doesn't exist, writes current timestamp
and emits nothing. Prevents flooding the agent with historical items
on initial integration.

Tier 1 (ambient) items are excluded — they surface on-demand via
\`cc-cli inbox list\`, not injected mid-conversation.

Carry-forward items (acknowledged but deferred) are excluded — the
agent already saw them; re-injecting every turn is noise.`);
}
