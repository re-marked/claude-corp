#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { ensureClaudeCorpHome } from '@claudecorp/shared';
import { getPasteFilter, enableBracketedPaste, disableBracketedPaste } from './lib/paste-filter.js';
import { daemonRef, killProcessTree } from './lib/daemon-ref.js';

ensureClaudeCorpHome();
process.stdout.write('\x1b[?1049h'); // Enter alt screen buffer (preserves scrollback)
process.stdout.write('\x1b]0;Claude Corp \u25C6\x07'); // Set tab title

// Bracketed paste mode — terminal wraps pasted text with escape sequences
enableBracketedPaste();
const pasteStdin = getPasteFilter();

const { unmount, waitUntilExit } = render(<App />, {
  stdin: pasteStdin as any,
  exitOnCtrlC: true,
  kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
});

function restoreTerminal() {
  disableBracketedPaste();
  process.stdout.write('\x1b[?1049l'); // Leave alt screen buffer
}

// Wait for Ink to unmount (Ctrl+C), then properly stop daemon before exiting
waitUntilExit().then(async () => {
  restoreTerminal();
  // Actually await daemon stop — this kills gateway + agent processes
  try { await daemonRef?.stop(); } catch {}
  process.exit(0);
}).catch((err) => {
  restoreTerminal();
  if (err) process.stderr.write(`[Claude Corp] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

// Crash recovery — restore terminal even on uncaught errors
function emergencyCleanup(label: string, err: unknown) {
  process.stderr.write(`\n[Claude Corp] Fatal: ${label}\n`);
  if (err instanceof Error) process.stderr.write((err.stack ?? err.message) + '\n');
  restoreTerminal();
  try { unmount(); } catch {}
  // Sync kill entire process tree — last resort
  killProcessTree();
}

process.on('uncaughtException', (err) => emergencyCleanup('uncaughtException', err));
process.on('unhandledRejection', (reason) => emergencyCleanup('unhandledRejection', reason));
