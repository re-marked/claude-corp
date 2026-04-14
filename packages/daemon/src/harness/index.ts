/**
 * Harness abstraction — public surface.
 *
 * The daemon routes every dispatch through an AgentHarness. Built-in
 * implementations:
 *
 *   - OpenClawHarness — production, wraps OpenClaw gateway + WS client
 *   - MockHarness     — deterministic, for tests + local dev
 *
 * Future harnesses (ClaudeCodeHarness, etc.) register against the same
 * AgentHarness contract.
 */

export type {
  AgentHarness,
  AgentSpec,
  DispatchCallbacks,
  DispatchOpts,
  DispatchResult,
  HarnessConfig,
  HarnessErrorCategory,
  HarnessFactory,
  HarnessHealth,
  ToolCallInfo,
} from './types.js';

export { HarnessError } from './types.js';

export { OpenClawHarness, type OpenClawHarnessDeps } from './openclaw-harness.js';
export {
  MockHarness,
  type MockHarnessOptions,
  type MockResponse,
  type MockResponseLike,
  type MockToolCall,
  type RecordedDispatch,
} from './mock-harness.js';
export { HarnessRegistry, defaultHarnessRegistry } from './registry.js';
export { HarnessRouter, type HarnessRouterDeps } from './router.js';
export {
  ClaudeCodeHarness,
  type ClaudeCodeHarnessDeps,
  type ClaudeChildProcess,
  type ClaudeSpawnFn,
  type ClaudeSpawnOptions,
} from './claude-code-harness.js';
export {
  ClaudeCodeStreamParser,
  type ClaudeCodeEvent,
  type ClaudeCodeEventListener,
} from './claude-code-stream.js';
export {
  sessionIdFor,
  uuidv5,
  CLAUDE_CORP_SESSION_NAMESPACE,
} from './session-id.js';
export { findExecutableInPath, quoteForWindowsCmd } from './spawn-utils.js';
