/**
 * Deterministic session ID derivation for Claude Code.
 *
 * Claude Code's `--session-id` flag requires a valid UUID. Claude Corp
 * uses Jack keys (strings like `say:ceo:mark`) as conversation identity.
 * We bridge the two by deriving a stable UUIDv5 from the Jack key using
 * a fixed namespace UUID.
 *
 * Same Jack key → same UUID across:
 *   - Process restarts (no state stored on disk)
 *   - Daemon restarts
 *   - Different installations of Claude Corp
 *
 * Which means `claude -p --session-id <uuid>` will always find the same
 * session file on disk and resume the conversation. This is the mechanism
 * Jack's per-pair conversation memory relies on when Claude Code is the
 * underlying substrate.
 */

import { createHash } from 'node:crypto';

/**
 * Fixed namespace UUID for Claude Corp harness session IDs.
 *
 * Arbitrary-but-stable. Changing this value would invalidate every
 * existing Claude Code session on every install — treat as permanent.
 * Generated via `crypto.randomUUID()` during PR 3 development.
 */
export const CLAUDE_CORP_SESSION_NAMESPACE = '1b3f7c9a-2e4d-4a5b-9c8d-7e6f5a4b3c2d';

/**
 * Compute RFC 4122 v5 UUID from a name within a namespace UUID.
 *
 * Algorithm (RFC 4122 §4.3):
 *   1. SHA1(namespace_bytes || name_bytes)
 *   2. Take first 16 bytes
 *   3. Set version bits (0101 in high nibble of byte 6)
 *   4. Set variant bits (10 in high bits of byte 8 = RFC 4122)
 *   5. Format as canonical UUID string
 */
export function uuidv5(name: string, namespace = CLAUDE_CORP_SESSION_NAMESPACE): string {
  const namespaceBytes = parseUuidToBytes(namespace);
  const nameBytes = Buffer.from(name, 'utf-8');
  const combined = Buffer.concat([namespaceBytes, nameBytes]);
  const hash = createHash('sha1').update(combined).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return formatBytesToUuid(bytes);
}

/**
 * Canonical Claude Code session id for a given Jack session key.
 * Wraps uuidv5 with the default Claude Corp namespace; tests that want
 * namespace isolation can call uuidv5 directly with their own.
 */
export function sessionIdFor(jackKey: string): string {
  if (!jackKey) throw new Error('Jack key must be a non-empty string');
  return uuidv5(jackKey);
}

function parseUuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

function formatBytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
