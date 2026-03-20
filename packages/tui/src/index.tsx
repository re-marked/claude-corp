#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { ensureClaudeCorpHome } from '@claudecorp/shared';

ensureClaudeCorpHome();
process.stdout.write('\x1Bc'); // Clear terminal
process.stdout.write('\x1b]0;Claude Corp \u25C6\x07'); // Set tab title
render(<App />, { exitOnCtrlC: true });
