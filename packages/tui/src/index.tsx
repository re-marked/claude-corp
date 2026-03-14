#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { ensureAgentCorpHome } from '@agentcorp/shared';

ensureAgentCorpHome();
render(<App />);
