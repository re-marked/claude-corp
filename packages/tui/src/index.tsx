#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { ensureClaudeCorpHome } from '@claudecorp/shared';
import { getPasteFilter, enableBracketedPaste, disableBracketedPaste } from './lib/paste-filter.js';
import { daemonRef } from './lib/daemon-ref.js';

ensureClaudeCorpHome();
process.stdout.write('\x1b[?1049h'); // Enter alt screen buffer (preserves scrollback)
process.stdout.write('\x1b]0;Claude Corp \u25C6\x07'); // Set tab title

// Bracketed paste mode — terminal wraps pasted text with escape sequences
enableBracketedPaste();
const pasteStdin = getPasteFilter();

const { unmount } = render(<App />, {
  stdin: pasteStdin as any,
  exitOnCtrlC: true,
  incrementalRendering: true,
  kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
});

// Clean exit — restore terminal state
process.on('exit', () => {
  disableBracketedPaste();
  process.stdout.write('\x1b[?1049l'); // Leave alt screen buffer
});

// Crash recovery — restore terminal even on uncaught errors
function emergencyCleanup(label: string, err: unknown) {
  process.stderr.write(`\n[Claude Corp] Fatal: ${label}\n`);
  if (err instanceof Error) process.stderr.write((err.stack ?? err.message) + '\n');
  disableBracketedPaste();
  process.stdout.write('\x1b[?1049l');
  try { daemonRef?.stop(); } catch {}
  try { unmount(); } catch {}
  process.exit(1);
}

process.on('uncaughtException', (err) => emergencyCleanup('uncaughtException', err));
process.on('unhandledRejection', (reason) => emergencyCleanup('unhandledRejection', reason));
