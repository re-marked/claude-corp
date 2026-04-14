/**
 * Harness resolution helpers used across daemon subsystems that need to
 * reason about which substrate an agent (or corp) actually uses.
 *
 * Single resolution rule, everywhere:
 *   Member.harness > Corporation.harness > 'openclaw'
 *
 * Keeping the rule in one place prevents it from drifting between
 * `HarnessRouter`'s per-dispatch resolver, `ProcessManager.spawnAgent`'s
 * gateway-vs-harness branch, and `Daemon.connectOpenClawWS`'s
 * should-we-even-try-the-user-gateway guard.
 */

import { join } from 'node:path';
import {
  readConfig,
  MEMBERS_JSON,
  CORP_JSON,
  type Member,
  type Corporation,
} from '@claudecorp/shared';

/** Default harness applied when neither member nor corp specifies one. */
export const DEFAULT_HARNESS = 'openclaw';

/**
 * Resolve a member's effective harness name. Mirrors
 * `Daemon.resolveHarnessForAgent` behavior so every subsystem reads
 * the same answer for the same agent.
 */
export function resolveMemberHarness(
  member: Member | undefined,
  corpHarness: string | undefined,
): string {
  return member?.harness ?? corpHarness ?? DEFAULT_HARNESS;
}

/**
 * Does this corp have at least one agent whose effective harness is
 * openclaw? Used by the daemon to decide whether to attempt connecting
 * to the user's personal OpenClaw gateway — if no agent will ever
 * dispatch through it, the connect attempt is pure overhead (and up
 * to a 10-second block when that OpenClaw isn't running).
 *
 * Malformed config (missing members.json, unreadable corp.json) falls
 * through to `true` so that broken-but-recoverable corps don't
 * accidentally skip a legitimate openclaw connection.
 */
export function corpHasOpenClawAgent(corpRoot: string): boolean {
  let members: Member[];
  let corp: Corporation;
  try {
    members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
    corp = readConfig<Corporation>(join(corpRoot, CORP_JSON));
  } catch {
    return true;
  }
  const corpHarness = corp.harness;
  for (const member of members) {
    if (member.type !== 'agent') continue;
    if (resolveMemberHarness(member, corpHarness) === DEFAULT_HARNESS) return true;
  }
  return false;
}
