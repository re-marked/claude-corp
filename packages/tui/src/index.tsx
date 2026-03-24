#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { ensureClaudeCorpHome } from '@claudecorp/shared';
import { getPasteFilter, enableBracketedPaste, disableBracketedPaste } from './lib/paste-filter.js';

ensureClaudeCorpHome();
process.stdout.write('\x1Bc'); // Clear terminal
process.stdout.write('\x1b]0;Claude Corp \u25C6\x07'); // Set tab title

// Enable bracketed paste mode — terminal wraps pasted text with escape sequences
// so we can distinguish paste from typing. The PasteFilterStdin intercepts these
// and emits 'paste' events instead of passing raw paste data to Ink.
enableBracketedPaste();
const pasteStdin = getPasteFilter();

render(<App />, { stdin: pasteStdin as any, exitOnCtrlC: true });

process.on('exit', disableBracketedPaste);
