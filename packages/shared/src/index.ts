// Types
export type {
  Member,
  MemberRank,
  MemberStatus,
  MemberType,
  MemberScope,
  AgentWorkStatus,
  Channel,
  ChannelKind,
  ChannelScope,
  ChannelMessage,
  MessageKind,
  Task,
  TaskStatus,
  TaskPriority,
  TaskComplexity,
  Team,
  TeamStatus,
  Corporation,
  Project,
  ProjectType,
  AgentConfig,
  GlobalConfig,
  Clock,
  ClockType,
  ClockStatus,
  ScheduledClock,
  ScheduledClockStatus,
  CronTaskTemplate,
  Contract,
  ContractStatus,
  ContractProgress,
  Chit,
  ChitTypeId,
  ChitStatus,
  ChitScope,
  ChitCommon,
  FieldsForType,
  TaskFields,
  TaskWorkflowStatus,
  ContractFields,
  ObservationFields,
  CasketFields,
  HandoffFields,
  DispatchContextFields,
  PreBrainEntryFields,
  StepLogFields,
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
export {
  generateId,
  memberId,
  channelId,
  taskId,
  contractId,
  projectId,
  teamId,
  clockId,
  messageId,
  gatewayToken,
  tempSuffix,
} from './id.js';
export { extractMentionNames, resolveMentions, memberSlug } from './mentions.js';
export { atomicWriteSync } from './atomic-write.js';
export {
  CHIT_TYPES,
  ChitValidationError,
  getChitType,
  isKnownChitType,
} from './chit-types.js';
export type { ChitTypeEntry, DestructionPolicy } from './chit-types.js';
export {
  migrateTasksToChits,
  taskToChit,
} from './migrations/migrate-tasks.js';
export type { TaskMigrationResult, TaskMigrationOpts } from './migrations/migrate-tasks.js';

export {
  migrateContractsToChits,
  contractToChit,
} from './migrations/migrate-contracts.js';
export type { ContractMigrationResult, ContractMigrationOpts } from './migrations/migrate-contracts.js';

export {
  migrateObservationsToChits,
  bulletToChit,
} from './migrations/migrate-observations.js';
export type {
  ObservationMigrationResult,
  ObservationMigrationOpts,
} from './migrations/migrate-observations.js';

export {
  chitId,
  casketChitId,
  isChitIdFormat,
  chitPath,
  chitScopeFromPath,
  createChit,
  readChit,
  updateChit,
  closeChit,
  promoteChit,
  archiveChit,
  queryChits,
  findChitById,
  checkConcurrentModification,
  ChitConcurrentModificationError,
  ChitMalformedError,
} from './chits.js';
export type {
  CreateChitOpts,
  UpdateChitOpts,
  ChitWithBody,
  QueryChitsOpts,
  QueryChitsResult,
  MalformedChit,
} from './chits.js';
export { detectFeedback, FEEDBACK_PATTERN_COUNTS } from './feedback-detector.js';
export type { FeedbackPolarity, FeedbackMatch } from './feedback-detector.js';

// One brain per agent — unified session keys for every reasoning dispatch
export {
  agentSessionKey,
  isAgentSession,
  AGENT_SESSION_PREFIX,
} from './session-key.js';

// Schedule parsing
export {
  parseIntervalExpression,
  isIntervalExpression,
  isCronPreset,
  cronPresetToExpression,
  isRawCronExpression,
  normalizeScheduleInput,
  formatIntervalMs,
  formatCountdown,
  formatRelativeTime,
  type NormalizedSchedule,
} from './schedule-parser.js';
export * from './paths.js';
export * from './constants.js';

// Git
export { corpGit } from './git.js';
export type { CorpGit, WorktreeInfo, MergeResult } from './git.js';

// Global config
export {
  ensureClaudeCorpHome,
  ensureGlobalConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from './global-config.js';

// Workspace filename migration (legacy RULES.md/ENVIRONMENT.md → AGENTS.md/TOOLS.md).
// migrateAgentWorkspaceFilenames walks the whole corp at daemon startup and
// flags-but-doesn't-resolve conflicts (safe, idempotent). reconcileAgentWorkspace
// is the interactive per-agent version used by `cc-cli agent set-harness`:
// resolves conflicts by keeping the newer file + backing up the older, and
// writes/removes CLAUDE.md to match the target harness.
export {
  migrateAgentWorkspaceFilenames,
  type WorkspaceMigrationResult,
} from './migrate-workspace-filenames.js';
export {
  reconcileAgentWorkspace,
  type ReconcileAgentWorkspaceOpts,
  type ReconcileAgentWorkspaceResult,
} from './reconcile-agent-workspace.js';

// Corp management
export { scaffoldCorp, listCorps, findCorp, deleteCorp } from './corp.js';

// Skills
export { syncSkillsToAgent, syncSkillsToAllAgents, installDefaultSkills } from './skills.js';

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
export { setupCeo, buildCeoAgents } from './ceo.js';
export type { CeoSetupResult } from './ceo.js';

// B.R.A.I.N. — Browseable, Reflective, Authored, Indexed Notes
export {
  BRAIN_DIR,
  STALENESS_THRESHOLD_DAYS,
  getBrainDir,
  getBrainFilePath,
  ensureBrainDir,
  extractWikilinks,
  resolveWikilink,
  findBacklinks,
  createFrontmatter,
  validateFrontmatter,
  createBrainFile,
  readBrainFile,
  updateBrainFile,
  validateBrainFile,
  deleteBrainFile,
  listBrainFiles,
  searchByTag,
  searchByType,
  searchBySource,
  searchByConfidence,
  searchBrain,
  findStaleFiles,
  findOrphans,
  getBrainStats,
  generateMemoryIndex,
  buildBrainGraph,
} from './brain.js';
export type { BrainGraphEdge, BrainGraph } from './brain.js';
export type {
  BrainFile,
  BrainFrontmatter,
  BrainMemoryType,
  BrainSource,
  BrainConfidence,
  BrainStats,
} from './types/brain.js';

// B.R.A.I.N. Culture — cross-agent tag intelligence
export {
  findAllAgentDirs,
  getCorpTags,
  getSharedTags,
  getAgentTagSignature,
  getAllAgentSignatures,
  getAgentOverlaps,
  suggestTagNormalization,
  getCultureHealth,
  getCorpCultureStats,
} from './brain-culture.js';

// Corp Culture — CULTURE.md + feedback promotion
export {
  CULTURE_MD_FILENAME,
  getCulturePath,
  readCulture,
  writeCulture,
  getCultureCandidates,
} from './culture.js';
export type {
  CandidateStrength,
  CandidateEntry,
  CultureCandidate,
} from './culture.js';
export type {
  CorpTag,
  AgentTagSignature,
  AgentOverlap,
  TagNormalizationSuggestion,
  CultureHealth,
  CorpCultureStats,
} from './brain-culture.js';

// Feedback Intel — read-only introspection of the feedback pipeline
export {
  parsePendingFeedback,
  getAgentFeedbackIntel,
  getCorpFeedbackIntel,
} from './feedback-intel.js';
export type {
  PendingFeedbackEntry,
  FeedbackBrainEntry,
  AgentFeedbackIntel,
  CorpFeedbackIntel,
} from './feedback-intel.js';

// Templates
export { UNIVERSAL_SOUL } from './templates/soul.js';
export { CEO_BOOTSTRAP } from './templates/bootstrap-ceo.js';
export { AGENT_BOOTSTRAP, buildAgentBootstrap } from './templates/bootstrap-agent.js';
export { defaultIdentity } from './templates/identity.js';
export { MEMORY_TEMPLATE } from './templates/memory.js';
export { USER_TEMPLATE } from './templates/user.js';
export { defaultEnvironment, type EnvironmentTemplateOpts, type EnvironmentHarness } from './templates/environment.js';
export { defaultRules, type RulesTemplateOpts, type TemplateHarness } from './templates/rules.js';
export { defaultHeartbeat } from './templates/heartbeat.js';
export { buildClaudeMd, type ClaudeMdTemplateOpts } from './templates/claude-md.js';

// Ranks
export { canHire } from './ranks.js';

// Hierarchy
export { buildHierarchy } from './hierarchy.js';
export type { HierarchyNode } from './hierarchy.js';

// Projects
export { createProject, listProjects, getProject, getProjectByName } from './projects.js';
export { createContract, readContract, updateContract, listContracts, listAllContracts, contractPath, getContractProgress, findContractById } from './contracts.js';
export type { CreateContractOpts, ContractFilter, ContractWithBody } from './contracts.js';
export { listBlueprints, getBlueprint, installDefaultBlueprints } from './blueprints.js';
export type { BlueprintMeta, Blueprint } from './blueprints.js';
export type { CreateProjectOpts } from './projects.js';

// Teams
export { createTeam, listTeams, getTeam, addMemberToTeam } from './teams.js';
export type { CreateTeamOpts } from './teams.js';

// Themes
export { getTheme, getAllThemes, rankLabel } from './themes.js';
export type { Theme, ThemeId } from './themes.js';

// Tasks
export { createTask, readTask, updateTask, listTasks, taskPath, findTaskById } from './tasks.js';
export type { CreateTaskOpts, TaskFilter, TaskWithBody } from './tasks.js';

// Models
export {
  KNOWN_MODELS,
  DEFAULT_FALLBACK_CHAIN,
  resolveModelAlias,
  getModelEntry,
  isKnownModel,
  formatProviderModel,
  parseProviderModel,
  modelDisplayName,
  modelAlias,
} from './models.js';
export type { ModelEntry } from './models.js';

// Observations — daily append-only agent activity logs
export {
  observe,
  appendObservation,
  formatObservation,
  readTodaysObservations,
  readObservationsForDate,
  parseObservations,
  getObservationStats,
  listObservationLogs,
  countRecentObservations,
  getObservationLogPath,
  getObservationsDir,
} from './observations.js';
export type {
  Observation,
  ObservationCategory,
  ObservationLogStats,
} from './observations.js';

// Post — unified message persistence primitive
export { post } from './post.js';
export type { PostSource, PostKind, PostOpts } from './post.js';
