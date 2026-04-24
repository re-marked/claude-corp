/**
 * Shared types for OS-level supervisor config templates.
 *
 * Each platform (systemd / launchd / Task Scheduler) has its own
 * renderer that takes `ServiceOpts` and returns a `ServiceArtifact`.
 * The renderer is pure — no I/O, no platform detection. The
 * install-service CLI does the detection + writing + user-facing
 * prompts; these modules only produce the file bytes and metadata.
 *
 * This separation matters for two reasons:
 *
 *   1. Renderers stay testable with inline fixtures — pass opts,
 *      assert on the returned artifact. No mocking fs, no fighting
 *      platform-detection mocks.
 *
 *   2. A future TUI-side preview ("show me what install-service
 *      would write before I commit") can reuse the same renderers
 *      without going through a CLI subprocess.
 */

/**
 * The three platforms we generate supervisor configs for. Matches
 * Node's `process.platform` values for the supported cases; other
 * values (freebsd, sunos, etc.) are not supported — install-service
 * errors out cleanly rather than attempting to render for them.
 */
export type SupervisorPlatform = 'linux' | 'darwin' | 'win32';

/**
 * Inputs to every renderer. Minimal surface: the daemon launch
 * command + the user's home directory. Everything else (service
 * name, log paths, restart cadence) is hardcoded by the renderer
 * per-platform convention.
 */
export interface ServiceOpts {
  /**
   * The full shell command the OS supervisor invokes to start the
   * daemon. Typical values:
   *
   *   - `cc-cli start` (production install where cc-cli is in PATH)
   *   - `/usr/local/bin/node /home/me/agentcorp/packages/tui/dist/index.js`
   *     (dev/source install — explicit absolute paths)
   *
   * Each renderer escapes as needed for its format (XML entities for
   * Task Scheduler, plist string-escaping for launchd, systemd
   * ExecStart's minor quirks). Caller passes the command as they'd
   * type it at a shell prompt; the renderer handles the rest.
   */
  daemonCommand: string;

  /**
   * Absolute path to the user's home directory. Used to resolve the
   * canonical service-config path for each platform. Caller provides
   * explicitly (not auto-detected) so tests can pass a tmpdir
   * without needing to shim `os.homedir()`.
   */
  homeDir: string;
}

/**
 * Everything install-service needs to either (a) write the file
 * and tell the user how to activate, or (b) print a dry-run summary.
 *
 * The artifact is self-contained: content + write path + human-
 * facing activation instructions. install-service never needs to
 * re-derive any of these from `ServiceOpts` once it has the
 * artifact; the renderer owns that logic.
 */
export interface ServiceArtifact {
  /** Rendered file content — exactly the bytes to write to disk. */
  content: string;

  /**
   * Absolute path to write the file to. Canonical per platform:
   *
   *   - linux:   `~/.config/systemd/user/claudecorp-daemon.service`
   *   - darwin:  `~/Library/LaunchAgents/com.claudecorp.daemon.plist`
   *   - win32:   `~/.claudecorp/supervisor/claudecorp-daemon.xml`
   *
   * (Windows has no canonical user-level Task Scheduler XML
   * location; we keep it in the corp-home supervisor/ subdir since
   * schtasks imports from any path at register time.)
   */
  path: string;

  /**
   * The one-liner command the user runs after the file is written
   * to actually register the service with the OS. install-service
   * prints this verbatim with clear "run this to activate" framing;
   * it does NOT execute it automatically (system-wide state change
   * requires explicit user consent).
   *
   * Per-platform shapes:
   *   - linux:  `systemctl --user daemon-reload && systemctl --user enable --now claudecorp-daemon.service`
   *   - darwin: `launchctl load ~/Library/LaunchAgents/com.claudecorp.daemon.plist`
   *   - win32:  `schtasks /Create /TN ClaudeCorpDaemon /XML %USERPROFILE%\.claudecorp\supervisor\claudecorp-daemon.xml /F`
   */
  activationCommand: string;

  /**
   * One-sentence human explanation of what `activationCommand` does,
   * for install-service's output. Keeps the CLI output legible
   * without requiring the user to understand each platform's
   * supervisor semantics.
   */
  activationDescription: string;
}
