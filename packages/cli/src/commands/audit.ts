/**
 * cc-cli audit — stub for the Project 0.7.3 Audit Gate.
 *
 * This is the command the Stop hook (for Claude Code) and PreCompact
 * hook (for Partners) invoke to decide whether to allow session-end /
 * compaction. 0.7.3 will replace the stub with the real blocking
 * audit: reads the agent's Casket, parses acceptance criteria, checks
 * file read-backs + build + test output + git status + inbox
 * resolution, returns \`{decision: "block", reason: "..."}\` until
 * evidence shows up.
 *
 * Until then, this stub approves every stop. Agents can end sessions
 * freely — the discipline enforcement lands with 0.7.3. Shipping the
 * stub NOW is load-bearing for 0.7.2: the settings.json hook points
 * at cc-cli audit, and without a real command the Stop hook would
 * either crash or behave unpredictably per Claude Code version. The
 * stub closes that risk.
 *
 * Exit code 0 with a JSON decision object on stdout — the exact shape
 * Claude Code's blockable hooks expect. When 0.7.3 changes the
 * decision to "block" conditionally, the call surface stays the same.
 */

export interface AuditOpts {
  agent?: string;
  json: boolean;
}

export async function cmdAudit(opts: AuditOpts): Promise<void> {
  // 0.7.2 stub: always approve. Full audit logic lands in 0.7.3.
  // The --agent flag is accepted but ignored until 0.7.3 needs it
  // to resolve the Casket + task chit + inbox query.
  void opts;
  process.stdout.write(JSON.stringify({ decision: 'approve' }) + '\n');
}
