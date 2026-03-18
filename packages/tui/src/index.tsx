#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { ensureClaudeCorpHome } from '@claudecorp/shared';

ensureClaudeCorpHome();
process.stdout.write('\x1Bc'); // Clear terminal
render(<App />);
