#!/usr/bin/env node
import React from 'react';
import { render } from '@claude-code-kit/ink-renderer';
import { App } from './app.js';
import { ensureClaudeCorpHome, listCorps, deleteCorp } from '@claudecorp/shared';
import { getPasteFilter, enableBracketedPaste, disableBracketedPaste } from './lib/paste-filter.js';
import { daemonRef, killProcessTree } from './lib/daemon-ref.js';

// --- Subcommands (no TUI needed) ---

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (args[0] === 'list') {
  ensureClaudeCorpHome();
  const corps = listCorps();
  if (corps.length === 0) {
    console.log('No corporations. Run `claudecorp new` to create one.');
  } else {
    for (const c of corps) console.log(`  ${c.name.padEnd(20)} ${c.path}`);
  }
  process.exit(0);
}

if (args[0] === 'delete') {
  ensureClaudeCorpHome();
  const name = args[1];
  if (!name) {
    console.log('Usage: claudecorp delete <corp-name>');
    const corps = listCorps();
    if (corps.length > 0) {
      console.log('\nAvailable corps:');
      for (const c of corps) console.log(`  ${c.name}`);
    }
    process.exit(1);
  }
  try {
    const ok = deleteCorp(name);
    if (ok) {
      console.log(`Deleted "${name}".`);
    } else {
      console.log(`Corp "${name}" not found.`);
      const corps = listCorps();
      if (corps.length > 0) {
        console.log('\nAvailable corps:');
        for (const c of corps) console.log(`  ${c.name}`);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (args[0] === 'help') {
  console.log(`cc — Your personal AI corporation

  cc              Launch the TUI
  cc new          Create a new corporation (opens onboarding)
  cc list         List all corporations
  cc delete <n>   Delete a corporation`);
  process.exit(0);
}

// --- Demo modes ---

if (process.argv.includes('--sleep-banner-demo')) {
  const React = await import('react');
  const { render, Box } = await import('@claude-code-kit/ink-renderer');
  const { SleepingBanner } = await import('./components/sleeping-banner.js');
  const { COLORS } = await import('./theme.js');

  const inst = await render(
    React.createElement(Box, { flexDirection: 'column', flexGrow: 1 },
      React.createElement(SleepingBanner, {
        agentName: 'CEO',
        sleepReason: 'Deep work — reviewing architecture docs',
        remainingMs: 4 * 60 * 60 * 1000, // 4 hours
        rank: 'master',
      }),
    ),
  );

  // Keep running for screenshot, Ctrl+C to exit
  await inst.waitUntilExit();
  process.exit(0);
}

// --- TUI launch ---

ensureClaudeCorpHome();
process.stdout.write('\x1b[2J\x1b[H'); // Clear screen (keeps scrollback, scroll wheel works)
process.stdout.write('\x1b]0;Claude Corp \u25C6\x07'); // Set tab title

enableBracketedPaste();
const pasteStdin = getPasteFilter();

// Pass 'new' flag to App so it forces onboarding even if corps exist
const forceNew = args[0] === 'new';

function restoreTerminal() {
  disableBracketedPaste();
}

// cck render() is async — use top-level await (ESM + Node 22+)
//
// PR 2b tried wrapping in <AlternateScreen> to enable native mouse
// tracking (onClick, onMouseEnter, wheel events). AlternateScreen
// also hijacks terminal scroll, drag-to-select (copy-paste), and
// constrains layout in ways that broke the input bar and made normal
// terminal interaction hostile. Reverted here — a proper mouse story
// needs a more surgical opt-in (per-region tracking, modifier-guarded
// select pass-through, explicit enable toggle) which is future work.
// Stacks, sparklines, animated icons, quiet-interval dividers, and
// Ctrl+Y keyboard expansion all continue to work without alt-screen.
const { unmount, waitUntilExit } = await render(<App forceNew={forceNew} />, {
  stdin: pasteStdin as any,
  exitOnCtrlC: true,
});

waitUntilExit().then(async () => {
  restoreTerminal();
  try { await daemonRef?.stop(); } catch {}
  process.exit(0);
}).catch((err) => {
  restoreTerminal();
  if (err) process.stderr.write(`[Claude Corp] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

function emergencyCleanup(label: string, err: unknown) {
  process.stderr.write(`\n[Claude Corp] Fatal: ${label}\n`);
  if (err instanceof Error) process.stderr.write((err.stack ?? err.message) + '\n');
  restoreTerminal();
  try { unmount(); } catch {}
  killProcessTree();
}

process.on('uncaughtException', (err) => emergencyCleanup('uncaughtException', err));
process.on('unhandledRejection', (reason) => emergencyCleanup('unhandledRejection', reason));
