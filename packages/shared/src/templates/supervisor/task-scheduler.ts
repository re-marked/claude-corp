/**
 * Windows Task Scheduler XML renderer for the Claude Corp daemon.
 *
 * Task Scheduler is Windows's closest equivalent to systemd/launchd.
 * It runs in the user's security context for user-level tasks (no
 * admin required), supports restart-on-failure via a built-in
 * retry policy, and triggers on login for persistent "starts when
 * I log in" behavior.
 *
 * Unlike systemd and launchd, Task Scheduler has no canonical
 * user-level XML location on disk — it stores its own copy in the
 * registry once imported. So we write the XML to the corp-home
 * supervisor subdir (`~/.claudecorp/supervisor/claudecorp-daemon.xml`)
 * and the activation command imports it via `schtasks /Create /XML`.
 * After import, the file on disk is a historical artifact; the task
 * lives in Task Scheduler's own store. We keep it on disk anyway so
 * the user can re-import if they need to.
 *
 * Key XML nodes and why:
 *
 *   LogonTrigger        Fires at user login. Combined with the
 *                       restart-on-failure policy below, this is
 *                       the unkillability trigger on Windows.
 *
 *   Actions/Exec        cmd.exe /c <daemonCommand>. The /c wrapper
 *                       lets arbitrary shell syntax (like npx or
 *                       piping) work; without it, Task Scheduler
 *                       treats the Arguments string as execv-style
 *                       and quoting gets weird.
 *
 *   RestartOnFailure    Interval PT30S + Count 100. Retry every 30
 *                       seconds up to 100 times on non-zero exit.
 *                       After 100 restarts in one session it gives
 *                       up — by then something's genuinely broken
 *                       and the user needs to intervene. (Tighter
 *                       than launchd's unbounded restart, but the
 *                       Task Scheduler UI exposes the retry state
 *                       so the user sees "oh, it's been restarting
 *                       for 50 minutes" without needing to grep
 *                       logs.)
 *
 *   AllowHardTerminate  True — lets the OS kill the daemon if it
 *                       hangs at shutdown. The alternative is the
 *                       daemon blocking system shutdown, which is
 *                       a worse failure mode than a forced kill.
 *
 *   MultipleInstancesPolicy IgnoreNew. If the user manually runs
 *                       the task while it's already running, do
 *                       nothing. Prevents accidental double-starts.
 *
 *   Priority            7 (Below Normal). The daemon does orchestr-
 *                       ation work, not latency-sensitive UI —
 *                       below-normal priority keeps foreground work
 *                       responsive without starving the daemon.
 *
 * Task Scheduler XML is case-sensitive and schema-strict; one
 * misnamed element fails import with a cryptic error. The XML here
 * is cribbed from a working `schtasks /Query /XML` export so the
 * schema matches what schtasks itself produces.
 */

import { join } from 'node:path';
import type { ServiceOpts, ServiceArtifact } from './types.js';

/**
 * XML entity escape for the five characters that have meaning in
 * XML. daemonCommand and homeDir go through this before embedding.
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderTaskXml(daemonCommand: string, homeDir: string): string {
  // Windows paths use backslashes; normalize homeDir for the
  // WorkingDirectory field so it works whether the caller passed a
  // forward-slash or backslash path.
  const workingDir = homeDir.replace(/\//g, '\\');

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Claude Corp Daemon — restarts the claudecorp daemon on login and on failure.</Description>
    <URI>\\ClaudeCorpDaemon</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT30S</Interval>
      <Count>100</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c ${escapeXml(daemonCommand)}</Arguments>
      <WorkingDirectory>${escapeXml(workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function renderTaskSchedulerXml(opts: ServiceOpts): ServiceArtifact {
  const path = join(opts.homeDir, '.claudecorp', 'supervisor', 'claudecorp-daemon.xml');
  // Use the literal %USERPROFILE% expansion in the activation command
  // so the user can copy-paste it into any cmd/PowerShell without
  // needing to know their resolved home path.
  const activationPath = '%USERPROFILE%\\.claudecorp\\supervisor\\claudecorp-daemon.xml';
  return {
    content: renderTaskXml(opts.daemonCommand, opts.homeDir),
    path,
    activationCommand: `schtasks /Create /TN ClaudeCorpDaemon /XML ${activationPath} /F`,
    activationDescription:
      'Imports the XML definition into Task Scheduler as "ClaudeCorpDaemon". /F forces overwrite if a task by that name exists. Starts at next login; restart-on-failure every 30s, up to 100 retries.',
  };
}
