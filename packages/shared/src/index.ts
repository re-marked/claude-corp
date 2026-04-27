// Types
export type {
  Member,
  MemberRank,
  MemberStatus,
  MemberType,
  MemberScope,
  AgentWorkStatus,
  AgentKind,
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
  InboxItemFields,
  InboxItemTier,
  InboxItemSource,
  EscalationFields,
  BlueprintFields,
  BlueprintStep,
  BlueprintVar,
  SweeperRunFields,
  KinkFields,
  BreakerTripFields,
  ClearanceSubmissionFields,
  ReviewCommentFields,
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
  isReferenced,
  isMentioned,
  hasKeepTag,
  hasAged,
  computeVerdict,
} from './chit-promotion.js';
export type { ReferenceIndex, PromotionVerdict } from './chit-promotion.js';
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

// Task state machine — Project 1.3 mechanical enforcement of the 10-state
// workflow lifecycle. See task-state-machine.ts module docstring for the
// transition table + design rationale.
export {
  validateTransition,
  resolveTransition,
  legalTriggersFrom,
  initialState,
  isTerminal,
  isTerminalSuccess,
  isTerminalFailure,
  TaskTransitionError,
  TRANSITION_RULES,
  TERMINAL_STATES,
  TERMINAL_SUCCESS_STATES,
  TERMINAL_FAILURE_STATES,
  ALL_STATES,
} from './task-state-machine.js';
export type { TaskTransitionTrigger } from './task-state-machine.js';

// Chain walker — pure readiness / propagation primitives over the
// dependsOn DAG. Task events (daemon) invoke advanceChain on close
// and apply the returned DependentDeltas via the state machine.
export {
  isReady,
  analyzeReadiness,
  nextReadyTask,
  advanceChain,
  applyDependentDelta,
  applyDependentDeltas,
  applyChainAdvance,
  ChainCycleError,
} from './chain.js';
export type {
  ReadinessReason,
  ReadinessResult,
  AdvanceChainResult,
  DependentDelta,
  ApplyDeltaOpts,
  ApplyDeltaResult,
  ApplyChainAdvanceOpts,
  ChainAdvanceApplyResult,
  ChainAdvanceRedispatchResult,
  ChainAdvanceCascadeNotification,
} from './chain.js';

// Role resolver — Project 1.4. Picks an Employee slot for a role-mode
// hand / block / escalate. Pure; callers apply the resolved target.
export { resolveRoleToEmployee, resolveSlotOrRole } from './role-resolver.js';
export type {
  RoleResolveResult,
  RoleResolvedResult,
  RolePartnerOnlyResult,
  RoleNoCandidatesResult,
  RoleUnknownResult,
  SlotOrRoleResolution,
} from './role-resolver.js';

// Hand core — the shared mechanics for Casket-pointer writes + state
// machine transitions + announcement. CLI cmdHand and daemon cron
// task-spawn both use this; the daemon no longer has its own
// /tasks/:id/hand endpoint.
export { handChitToSlot, handChitToRoleQueue, HandNotAllowedError } from './hand-core.js';
export type {
  HandChitToSlotOpts,
  HandChitToSlotResult,
  HandChitToRoleQueueOpts,
  HandChitToRoleQueueResult,
} from './hand-core.js';

// Project 1.7: pre-compact threshold math. Pure; mirrors Claude Code's
// autocompact formula + adds our wider signal-window buffer so the
// pre-compact-signal fragment can fire before autocompact destroys
// raw context.
export {
  calculateCompactionThreshold,
  formatThresholdSummary,
} from './compaction-threshold.js';
export type { CompactionThresholdState } from './compaction-threshold.js';

// Casket lifecycle primitives — the durable work-pointer surface that
// 0.7.3's audit gate reads and that 1.3's chain walker will eventually
// write. Module docstring explains the "was 1% built, this is the
// minimum lifecycle to unblock 0.7.3" framing.
export {
  casketExists,
  createCasketIfMissing,
  getCurrentStep,
  advanceCurrentStep,
  incrementSessionCount,
} from './casket.js';

// Inbox helper — single funnel for all inbox-item chit creation (router
// on @mention, hand on dispatch, escalate on escalation, system-event
// emitters). Tier-specific TTL + destructionPolicy rules centralized.
export { createInboxItem, TIER_TTL } from './inbox.js';
export type { CreateInboxItemOpts } from './inbox.js';

// Kink helpers — dedup-aware write + auto-resolve for the kink chit
// type. Sweepers use these instead of raw createChit; future daemon-
// internal detectors (boot-time misconfig, harness anomalies) can too.
export { writeOrBumpKink, resolveKink } from './kinks.js';
export type {
  WriteOrBumpKinkOpts,
  WriteOrBumpKinkResult,
  ResolveKinkOpts,
  KinkResolution,
} from './kinks.js';

// Project 1.10.4: bacteria observability substrate. Events log shape +
// read/write helpers consumed by status command, lineage view, Sexton's
// wake prompts, TUI sidebar aggregation. Append-only JSONL — bacteria
// executor writes; everyone else reads.
export { appendBacteriaEvent, readBacteriaEvents } from './bacteria-events.js';
export type {
  BacteriaEvent,
  MitoseEvent,
  ApoptoseEvent,
  ReadBacteriaEventsOpts,
} from './bacteria-events.js';

// Project 1.10.4: founder-controlled bacteria pause registry. Decision
// module skips paused roles. Tiny JSON at <corpRoot>/bacteria-paused.json.
export { readPausedRoles, pauseRole, resumeRole } from './bacteria-paused.js';

// Shared formatting helpers — single source for human-facing strings
// (durations etc) so behavior stays consistent across CLI surfaces +
// Sexton's wake prose.
export { formatDuration } from './format.js';

// Project 1.11: crash-loop circuit breaker. Pure detection helper +
// idempotent trip/close lifecycle + read surface for the spawn-refusal
// path, founder controls, Sexton wake summary, TUI sidebar.
export {
  evaluateBreakerTrigger,
  tripBreaker,
  closeBreakerForSlug,
  findActiveBreaker,
  listActiveBreakers,
  CRASH_LOOP_THRESHOLD_DEFAULT,
  CRASH_LOOP_WINDOW_MS_DEFAULT,
} from './bacteria-breaker.js';

// Project 1.12: clearinghouse helpers — pure priority scoring, queue
// ordering, lock lifecycle (singleton JSON), and submission state
// cascade (submission → task → contract). The Pressman/Editor agents
// and CLI commands compose against these.
export {
  scoreSubmission,
  rankQueue,
  readClearinghouseLock,
  claimClearinghouseLock,
  releaseClearinghouseLock,
  forceReleaseClearinghouseLock,
  markSubmissionMerged,
  markSubmissionFailed,
  detectStaleLock,
  findOrphanedProcessingSubmissions,
  resetOrphanedSubmission,
  resumeClearinghouse,
} from './clearinghouse.js';
export type {
  ScorableSubmission,
  QueueEntry,
  ClearinghouseLockState,
  ClaimLockOpts,
  ReleaseLockOpts,
  MarkSubmissionMergedOpts,
  MarkSubmissionFailedOpts,
  StaleLockInfo,
  OrphanedSubmission,
  ResumeClearinghouseResult,
} from './clearinghouse.js';
export type {
  BreakerTriggerKink,
  BreakerTriggerDecision,
  TripBreakerOpts,
  TripBreakerResult,
  CloseBreakerOpts,
  ListActiveBreakersOpts,
} from './bacteria-breaker.js';

// Project 1.9.6: seed bundled built-in blueprint markdown files
// into a fresh corp's chit store at init. Mirrors installDefaultSkills —
// the bundled `blueprints/` dir ships with the package, seeded once
// at scaffoldCorp time. User-authored blueprints (via cc-cli blueprint
// new) stay distinct via origin='authored'; seeded ones are 'builtin'.
export { seedBuiltinBlueprints } from './blueprint-seed.js';

// Blueprint var merge + coerce — Project 1.8 PR 2. Bridges CLI-shaped
// string inputs to the typed Handlebars context the parser needs.
// Pure; no Handlebars dependency (that lives in blueprint-parser.ts).
export { coerceVarValue, mergeBlueprintVars, BlueprintVarError } from './blueprint-vars.js';
export type { BlueprintVarValue } from './blueprint-vars.js';

// Blueprint parser — Handlebars expansion layer on top of the vars
// merge. Strict-mode catches undeclared references; the cast primitive
// (next commit) consumes ParsedBlueprint directly and has no Handlebars
// awareness. Pure.
export { parseBlueprint, BlueprintParseError } from './blueprint-parser.js';
export type { ParsedBlueprint, ParsedBlueprintStep } from './blueprint-parser.js';

// Blueprint cast — Project 1.8 PR 2. Validation-first primitive that
// composes parser + chit CRUD into Contract + Task chits. All failure
// modes that CAN be caught before any chit write ARE caught (var coercion,
// template syntax, strict-mode refs, status check, role resolution,
// registry existence). CLI in PR 3 wraps this.
export { castFromBlueprint, BlueprintCastError } from './blueprint-cast.js';
export type {
  CastFromBlueprintOpts,
  CastFromBlueprintResult,
} from './blueprint-cast.js';

// Sweeper cast — Project 1.9. Sibling to castFromBlueprint for
// kind=sweeper blueprints. Produces one sweeper-run chit (vs Contract
// + Tasks). Shares the parse / status pipeline; diverges at chit
// write. See blueprint-cast.ts module docstring for the rationale.
export { castSweeperFromBlueprint } from './blueprint-cast.js';
export type {
  CastSweeperFromBlueprintOpts,
  CastSweeperFromBlueprintResult,
} from './blueprint-cast.js';

// Blueprint lookup — Project 1.8 PR 3. Centralizes name → chit resolution
// with scope precedence, so every CLI command + Sexton's patrol cooking
// uses one consistent lookup path.
export {
  findBlueprintByName,
  resolveBlueprint,
  listBlueprintChits,
} from './blueprint-lookup.js';
export type {
  BlueprintLookupOpts,
  BlueprintListOpts,
} from './blueprint-lookup.js';

// Role registry — canonical role metadata for Project 1.1's Employee/
// Partner split. CORP.md renders role-specific sections from these
// entries; `cc-cli hire --role` validates against them; `cc-cli tame`
// reads defaultKind as the promotion sanity check.
export {
  ROLES,
  getRole,
  isKnownRole,
  roleIds,
  partnerRoles,
  employeeRoles,
} from './roles.js';
export type { RoleEntry, RoleTier } from './roles.js';
// Re-export computeTTL now that it's public (inbox.ts consumes it; other
// inbox-like helpers may too).
export { computeTTL } from './chits.js';

// Audit Gate — the 0.7.3 pure decision engine + transcript parser +
// evidence scanner + prompt template. The cc-cli audit command wires
// these together at the hook boundary; everything below is pure
// (except transcript.ts which reads the JSONL file).
export {
  runAudit,
  buildAuditPrompt,
  scanEvidence,
  parseTranscript,
  parseTranscriptBeforeCompact,
  promotePendingHandoff,
  revertTaskFromUnderReview,
  peekLatestHandoffChit,
  consumeHandoffChit,
  buildPreCompactInstructions,
  buildCheckpointObservation,
  extractLatestUsageFromTranscript,
} from './audit/index.js';
export type {
  HookEventName,
  HookInput,
  AuditDecision,
  AuditInput,
  RecentActivity,
  ToolCall,
  TouchedFile,
  AuditPromptInput,
  EvidenceScanResult,
  HandoffPromotionResult,
  PendingHandoffPayload,
  RevertUnderReviewResult,
  PreCompactInstructionsInput,
  CheckpointBuilderInput,
  CheckpointCasketRef,
  CheckpointChitSpec,
  CheckpointRecentActivity,
  TranscriptUsageSnapshot,
} from './audit/index.js';

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
export {
  renderServiceForPlatform,
  renderSystemdService,
  renderLaunchdPlist,
  renderTaskSchedulerXml,
  UnsupportedPlatformError,
  type SupervisorPlatform,
  type ServiceOpts,
  type ServiceArtifact,
} from './templates/supervisor/index.js';
export {
  buildClaudeMd,
  buildThinClaudeMd,
  type ClaudeMdTemplateOpts,
  type ThinClaudeMdOpts,
} from './templates/claude-md.js';
export {
  buildHookSettings,
  type HookSettings,
  type HookSettingsOpts,
  type HookEntry,
} from './templates/hook-settings.js';
export { buildCorpMd, type CorpMdOpts, type CorpMdKind } from './templates/corp-md.js';
export {
  buildWtfHeader,
  type WtfHeaderOpts,
  type WtfCurrentTask,
  type WtfInboxPeek,
  type WtfInboxSummary,
} from './templates/wtf-header.js';
export {
  buildWtfOutput,
  resolveCurrentTask,
  readWorklogHandoff,
  resolveInboxSummary,
  formatAge,
  inferKind,
  resolveKind,
  type WtfOutputOpts,
  type WtfOutput,
} from './wtf-state.js';

// Ranks
export { canHire } from './ranks.js';

// Hierarchy
export { buildHierarchy } from './hierarchy.js';
export type { HierarchyNode } from './hierarchy.js';

// Projects
export { createProject, listProjects, getProject, getProjectByName } from './projects.js';
export { createContract, readContract, updateContract, listContracts, listAllContracts, contractPath, getContractProgress, findContractById } from './contracts.js';
export type { CreateContractOpts, ContractFilter, ContractWithBody } from './contracts.js';
// Legacy prose-blueprint API (listBlueprints / getBlueprint /
// installDefaultBlueprints + BlueprintMeta / Blueprint) was removed
// in Project 1.8 alongside the four prose .md files in
// packages/shared/src/blueprints/. Blueprints are now chits — see
// blueprint-chit-type.ts, blueprint-parser.ts, blueprint-cast.ts,
// and blueprint-lookup.ts for the replacement surface.
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
