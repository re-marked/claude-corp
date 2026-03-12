# Daemon

The daemon is the persistent background process that keeps the corporation running. It manages agent processes, routes messages between agents, and coordinates git operations. It is the only component that spawns or kills child processes.

## Lifecycle

The daemon is auto-started by the [[tui]] on launch if it is not already running. It writes a PID file to `~/.agentcorp/.daemon.pid` and a port file to `~/.agentcorp/.daemon.port` so the TUI (and future CLIs) can find it.

When the TUI exits, the daemon keeps running. Agents continue their work — heartbeats fire, messages route, tasks progress. The daemon stops only when explicitly told to via `agentcorp daemon stop` or system shutdown.

## Three Jobs

The daemon has exactly three responsibilities:

### 1. Router

See [[router]] for the full pipeline.

The router watches JSONL message files across all channels using `fs.watch`. When a new line is appended, it:

1. Reads the new line(s)
2. Extracts @mentions from the message content
3. Resolves mentions against `members.json` to find the target agent
4. Dispatches via HTTP POST to the agent's OpenClaw webhook endpoint

This is the nervous system of the corporation. Without the router, agents cannot hear each other.

### 2. Process Manager

The process manager owns the lifecycle of every OpenClaw agent process in the corp. It uses `execa` to spawn and control processes.

**Spawning an agent:**

1. Read the agent's config from `agents/<agent-id>/config.json`
2. Allocate a port from the configured range (default: 18800-18999)
3. Spawn OpenClaw via execa: `openclaw gateway --bind localhost --port <port> --allow-unconfigured`
4. Set the working directory to the agent's workspace folder
5. Inject API keys from `~/.agentcorp/global-config.json` into `auth-profiles.json`
6. Record the PID and port in the daemon's in-memory process table
7. Update `members.json` with the agent's connection info (port, status: running)

**Stopping an agent:**

1. Send SIGTERM to the process via execa
2. Wait up to 5 seconds for graceful shutdown
3. SIGKILL if still alive
4. Update `members.json` (status: suspended)
5. Release the port back to the pool

**Health monitoring:**

The process manager checks agent processes every 30 seconds:
- If a process has exited unexpectedly, mark it as crashed in `members.json`
- Optionally auto-restart based on the agent's `restart_policy` config
- Log all process events to `~/.agentcorp/.daemon.log`

### 3. Git Manager

The git manager uses SimpleGit to keep the corp's git history clean and meaningful.

**Post-prompt commits:**

After an agent completes a prompt loop (detected by webhook response or idle timeout), the git manager:

1. Stages all changes in the agent's workspace
2. Creates a commit attributed to the agent: `Agent: <agent-name> — <summary>`
3. Uses the agent's configured name and email for git author metadata

**Coordination with the router:**

The git manager and router coordinate to avoid committing mid-conversation. The router signals "conversation in progress" while messages are actively flowing. The git manager waits for a quiet period (default: 10 seconds of no new messages in a channel) before committing.

**Git Janitor (periodic):**

Every 15 minutes, the git manager runs a cleanup pass:
- Commit any uncommitted changes that slipped through (safety net)
- Prune empty commits if any were created
- Ensure the working tree is clean

## Internal API

The daemon exposes a minimal HTTP API on localhost for the TUI and CLI to interact with:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/status` | GET | Daemon health, uptime, managed process count |
| `/agents` | GET | List all managed agent processes with status |
| `/agents/:id/start` | POST | Start an agent process |
| `/agents/:id/stop` | POST | Stop an agent process |
| `/agents/:id/restart` | POST | Restart an agent process |

This API is unauthenticated — it only binds to `127.0.0.1`. If the daemon is reachable, you are on the same machine.

## Logging

All daemon activity is logged to `~/.agentcorp/.daemon.log`:
- Process spawn/stop/crash events
- Router dispatch events (message routed from channel X to agent Y)
- Git commit events
- Errors and warnings

The log file is plain text, one line per event, with ISO timestamps. It is not inside the corp git repo — it is operational metadata, not corp state.

## Failure Modes

- **Daemon crash**: Orphaned OpenClaw processes may remain. On next daemon start, it scans for processes matching known ports and re-adopts or kills them.
- **Port conflict**: If a port is already in use, the process manager tries the next available port in the range.
- **fs.watch limits**: On Linux, `fs.watch` may hit inotify limits with many channels. The daemon logs a warning and falls back to polling (500ms interval) for overflow channels.
