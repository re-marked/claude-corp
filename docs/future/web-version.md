# Web Version

A web frontend that connects to the same daemon. The daemon is the backend.
The web UI is another client, just like the TUI. Potential cloud-hosted
version later.

## The Idea

AgentCorp's architecture separates the brain (daemon) from the viewport (TUI).
The TUI is a React app rendered in the terminal via Ink. A web version is
a React app rendered in the browser. Both connect to the same daemon, see the
same data, and control the same agents.

This is not a rewrite. It is a second client for an existing backend.

## Architecture

```
                +------------------+
                |     Daemon       |
                |  (Node.js)       |
                |                  |
                |  - Agent mgmt    |
                |  - Message router|
                |  - fs.watch      |
                |  - Git ops       |
                |  - Heartbeat     |
                +--------+---------+
                         |
              +----------+----------+
              |                     |
     +--------+--------+  +--------+--------+
     |    TUI Client   |  |   Web Client    |
     |    (Ink/React)   |  |  (React/Vite)   |
     |    Terminal      |  |  Browser        |
     +--------+--------+  +--------+--------+
              |                     |
         stdin/stdout          WebSocket
         (local IPC)           (localhost or remote)
```

### Communication Protocol

The TUI currently communicates with the daemon via local IPC (stdin/stdout
or Unix domain socket). The web client needs a network protocol.

**WebSocket** is the natural choice:
- Bidirectional (server pushes new messages, client sends user input).
- Persistent connection (no polling).
- Works locally and over the network.

The daemon exposes a WebSocket server on a configurable port (default: 19001):

```typescript
// packages/daemon/src/ws-server.ts
export function startWebSocketServer(port: number, daemon: Daemon): void;
```

### API Surface

The WebSocket protocol mirrors the daemon's internal IPC:

| Message Type | Direction | Purpose |
|-------------|-----------|---------|
| `channel.list` | client -> server | List all channels |
| `channel.messages` | client -> server | Get messages for a channel |
| `channel.send` | client -> server | Send a message |
| `channel.subscribe` | client -> server | Watch a channel for new messages |
| `channel.update` | server -> client | New message in a subscribed channel |
| `member.list` | client -> server | List all members |
| `member.get` | client -> server | Get member details |
| `task.list` | client -> server | List tasks |
| `task.create` | client -> server | Create a task |
| `task.update` | client -> server | Update a task |
| `corp.stats` | client -> server | Get corp statistics |
| `corp.activity` | server -> client | Real-time activity feed |

### Shared Components

The TUI uses Ink (React for terminals). The web client uses React for browsers.
Many components share the same logic but different rendering:

| Shared (packages/shared) | TUI-specific | Web-specific |
|--------------------------|-------------|-------------|
| Message parsing | Ink `<Text>` rendering | HTML/CSS rendering |
| Task filtering | Terminal key bindings | Click/touch handlers |
| Channel switching logic | Ctrl+K in terminal | Cmd+K in browser |
| Hierarchy tree building | Box-drawing characters | SVG/Canvas tree |
| Mention extraction | Terminal color codes | Styled `<span>` pills |

The web client would live in a new package: `packages/web`.

## Web UI Specifics

### What Changes

- **Navigation**: Sidebar + main panel layout instead of full-screen views.
  More like Discord/Slack -- channel list on the left, content in the center,
  member sidebar on the right.
- **Hierarchy tree**: SVG or Canvas rendering instead of box-drawing characters.
  Potentially a force-directed graph (D3.js) for the full corporation view.
- **Task board**: Drag-and-drop Kanban instead of keyboard-driven list.
- **Agent inspector**: Tabbed panel instead of keyboard-switched sub-views.
- **Chat**: Rich text rendering (markdown, code blocks, images if agents
  produce them).

### What Stays the Same

- Data model (same filesystem, same JSONL, same frontmatter).
- Agent behavior (daemon manages agents regardless of which client is connected).
- Git tracking (all mutations still committed).
- Channel semantics (broadcast, team, direct, crisis, external).

## Cloud-Hosted Version

### Phase 1: Local Web

The web client connects to `localhost:19001`. The daemon runs on the user's
machine. Same as the TUI, just in a browser tab.

This is useful for:
- Users who prefer a graphical interface.
- Showing the corp to colleagues (screen share a browser, not a terminal).
- Mobile access on the local network.

### Phase 2: Remote Access

The daemon is exposed to the internet (via Tailscale, Cloudflare Tunnel,
or a VPN). The web client connects to the daemon's public URL.

This enables:
- Managing the corp from a phone.
- Sharing the corp with collaborators (read-only or full access).
- The CEO sends a briefing link that opens in the web UI.

### Phase 3: Cloud-Hosted Daemon

The daemon runs on a server (Fly.io, Railway, bare metal). The filesystem
is a persistent volume. Agents run as containers instead of local processes.

This is the cloud product version, built on AgentCorp's file-first
architecture. The transition path:

1. Replace `execa` with container management (Docker/Fly Machines API).
2. Replace local filesystem with mounted volume.
3. Replace `fs.watch` with inotify on the volume.
4. Keep everything else the same.

The web client does not change at all -- it still talks WebSocket to the
daemon.

## Authentication

### Local (Phase 1-2)

No auth needed for localhost. For remote access, a simple bearer token
generated on daemon startup:

```json
{
  "webServer": {
    "port": 19001,
    "authToken": "agc_abc123..."
  }
}
```

The web client sends the token in the WebSocket handshake.

### Cloud (Phase 3)

Full auth: OAuth, session management, RBAC. This is where the web version
becomes a real product and needs real infrastructure.

## Relationship to Other Features

- [[layer-7-externals]]: The web client could display external channel
  activity inline, with platform icons.
- [[layer-6-views]]: Every TUI view has a web equivalent. The web versions
  can be richer (graphs, drag-and-drop, images).
- [[agent-economy]]: The economy dashboard benefits enormously from a
  graphical chart rather than a terminal bar chart.

## Open Questions

- Should the web client be a separate package or a separate repo?
  Separate package in the monorepo keeps shared code easy.
- Should the web client work offline (PWA with cached state)?
  Nice to have, not essential for v1.
- Should there be a mobile-native app eventually? The web version with
  responsive design might be sufficient. Evaluate after web v1.
- How to handle multiple clients connected simultaneously? The daemon
  should broadcast state changes to all connected clients (TUI + web).
  WebSocket makes this straightforward.
