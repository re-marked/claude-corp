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
  ProjectType,
  AgentConfig,
  GlobalConfig,
} from './types/index.js';

// Parsers
export {
  appendMessage,
  readMessages,
  tailMessages,
  readNewLines,
  getFileSize,
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
  ensureClaudeCorpHome,
  ensureGlobalConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from './global-config.js';

// Corp management
export { scaffoldCorp, listCorps, findCorp } from './corp.js';

// Agent setup
export {
  setupAgentWorkspace,
  createDmChannel,
  addMemberToRegistry,
  addChannelToRegistry,
  addMemberToChannel,
} from './agent-setup.js';
export type { AgentSetupOpts, AgentSetupResult } from './agent-setup.js';

// CEO
export { setupCeo } from './ceo.js';
export type { CeoSetupResult } from './ceo.js';

// Ranks
export { canHire } from './ranks.js';

// Hierarchy
export { buildHierarchy } from './hierarchy.js';
export type { HierarchyNode } from './hierarchy.js';

// Projects
export { createProject, listProjects, getProject, getProjectByName } from './projects.js';
export type { CreateProjectOpts } from './projects.js';

// Teams
export { createTeam, listTeams, getTeam, addMemberToTeam } from './teams.js';
export type { CreateTeamOpts } from './teams.js';

// Themes
export { getTheme, getAllThemes, rankLabel } from './themes.js';
export type { Theme, ThemeId } from './themes.js';

// Tasks
export { createTask, readTask, updateTask, listTasks, taskPath } from './tasks.js';
export type { CreateTaskOpts, TaskFilter, TaskWithBody } from './tasks.js';
