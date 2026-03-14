import { join } from 'node:path';
import { AGENTCORP_HOME } from './constants.js';

export function corpPath(corpName: string): string {
  return join(AGENTCORP_HOME, corpName);
}

export function agentPath(corpRoot: string, agentDir: string): string {
  return join(corpRoot, agentDir);
}

export function channelPath(corpRoot: string, channelRelPath: string): string {
  return join(corpRoot, channelRelPath);
}

export function messagesPath(corpRoot: string, channelRelPath: string): string {
  return join(corpRoot, channelRelPath, 'messages.jsonl');
}

export function projectPath(corpRoot: string, projectName: string): string {
  return join(corpRoot, 'projects', projectName);
}

export function teamPath(
  corpRoot: string,
  projectName: string,
  teamName: string,
): string {
  return join(corpRoot, 'projects', projectName, 'teams', teamName);
}
