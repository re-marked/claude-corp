// Types
export type {
  Member,
  MemberRank,
  MemberStatus,
  MemberType,
  MemberScope,
  Channel,
  ChannelKind,
  ChannelScope,
  ChannelMessage,
  MessageKind,
  Task,
  TaskStatus,
  TaskPriority,
  Team,
  TeamStatus,
  Corporation,
  Project,
  AgentConfig,
  GlobalConfig,
} from './types/index.js';

// Parsers
export {
  appendMessage,
  readMessages,
  tailMessages,
  parseFrontmatter,
  stringifyFrontmatter,
  readConfig,
  readConfigOr,
  writeConfig,
} from './parsers/index.js';

// Utilities
export { generateId } from './id.js';
export { extractMentionNames, resolveMentions } from './mentions.js';
export * from './paths.js';
export * from './constants.js';

// Git
export { corpGit } from './git.js';
export type { CorpGit } from './git.js';

// Global config
export {
  ensureAgentCorpHome,
  ensureGlobalConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from './global-config.js';

// Corp management
export { scaffoldCorp, listCorps, findCorp } from './corp.js';
