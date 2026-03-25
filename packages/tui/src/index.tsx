#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
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
}

if (args[0] === 'help') {
  console.log(`claudecorp — Your personal AI corporation

  claudecorp              Launch the TUI
  claudecorp new          Create a new corporation (opens onboarding)
  claudecorp list         List all corporations
  claudecorp delete <n>   Delete a corporation
  claudecorp --boot factory|diagnostic   Launch with boot animation`);
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

const { unmount, waitUntilExit } = render(<App forceNew={forceNew} />, {
  stdin: pasteStdin as any,
  exitOnCtrlC: true,
  kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
});

function restoreTerminal() {
  disableBracketedPaste();
}

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
