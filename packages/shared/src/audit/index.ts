/**
 * Audit subsystem barrel — the public surface of the 0.7.3 Audit Gate.
 *
 * Layering:
 *   types.ts      — pure data shapes (HookInput, AuditInput, AuditDecision)
 *   prompt.ts     — audit <audit-check> block template
 *   evidence.ts   — criterion-vs-recent-activity scanner
 *   transcript.ts — Claude Code JSONL transcript parser (I/O)
 *   engine.ts     — runAudit() pure decision function composing the above
 *
 * Consumer: `packages/cli/src/commands/audit.ts` sources inputs at the
 * hook boundary (reads stdin, resolves casket, queries inbox, parses
 * transcript) and calls runAudit. Everything below runAudit is pure;
 * all I/O lives in transcript.ts and in audit.ts itself.
 */

export type {
  HookEventName,
  HookInput,
  AuditDecision,
  AuditInput,
  RecentActivity,
  ToolCall,
  TouchedFile,
} from './types.js';

export { runAudit } from './engine.js';
export { buildAuditPrompt } from './prompt.js';
export type { AuditPromptInput } from './prompt.js';
export { scanEvidence } from './evidence.js';
export type { EvidenceScanResult } from './evidence.js';
export { parseTranscript } from './transcript.js';
export { promotePendingHandoff } from './handoff-promotion.js';
export type {
  HandoffPromotionResult,
  PendingHandoffPayload,
} from './handoff-promotion.js';
