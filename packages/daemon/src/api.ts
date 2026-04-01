import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  createTask,
  listTasks,
  readTask,
  updateTask,
  taskPath,
  createProject,
  listProjects,
  createTeam,
  listTeams,
  readConfig,
  writeConfig,
  appendMessage,
  generateId,
  KNOWN_MODELS,
  resolveModelAlias,
  writeGlobalConfig,
  readGlobalConfig,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
  type ChannelMessage,
} from '@claudecorp/shared';
import type { Daemon } from './daemon.js';
import { dispatchToAgent } from './dispatch.js';
import { hireAgent } from './hire.js';
import { writeTaskEvent, logTaskAssignment, dispatchTaskToDm } from './task-events.js';
import { log, logError } from './logger.js';

/** Format tool call into a human-readable description for chat history. */
function formatToolMsg(toolName: string, args?: Record<string, unknown>): string {
  const name = toolName.toLowerCase();
  if (name === 'write' || name === 'create' || name === 'write_file') {
    return `wrote ${args?.path ?? args?.file_path ?? args?.filePath ?? 'a file'}`;
  }
  if (name === 'edit' || name === 'edit_file' || name === 'patch') {
    return `edited ${args?.path ?? args?.file_path ?? args?.filePath ?? 'a file'}`;
  }
  if (name === 'read' || name === 'read_file') {
    return `read ${args?.path ?? args?.file_path ?? args?.filePath ?? 'a file'}`;
  }
  if (name === 'bash' || name === 'execute' || name === 'exec' || name === 'shell' || name === 'run') {
    const cmd = String(args?.command ?? args?.cmd ?? args?.input ?? '').trim();
    return cmd ? `ran \`${cmd.split('\n')[0]!.substring(0, 80)}\`` : 'ran a command';
  }
  if (name === 'glob' || name === 'search' || name === 'find') {
    return `searched ${args?.pattern ?? args?.query ?? 'files'}`;
  }
  if (name === 'grep') return `searched for "${args?.pattern ?? args?.query ?? '...'}"`;
  if (name === 'web_search' || name === 'websearch') return `searched web: "${args?.query ?? '...'}"`;
  if (name === 'web_fetch' || name === 'fetch' || name === 'curl') return `fetched ${args?.url ?? 'a URL'}`;
  const path = args?.path ?? args?.file_path ?? args?.filePath;
  if (path) return `${name} ${path}`;
  const cmd = args?.command ?? args?.cmd;
  if (cmd) return `${name}: ${String(cmd).substring(0, 60)}`;
  return `used ${toolName}`;
}

export function createApi(daemon: Daemon): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // GET /status
      if (method === 'GET' && path === '/status') {
        json(res, {
          ok: true,
          corpRoot: daemon.corpRoot,
          agents: daemon.processManager.listAgents().map((a) => ({
            memberId: a.memberId,
            displayName: a.displayName,
            port: a.port,
            status: a.status,
            workStatus: daemon.getAgentWorkStatus(a.memberId),
          })),
        });
        return;
      }

      // GET /streaming — live partial responses from agents
      if (method === 'GET' && path === '/streaming') {
        const streams: Record<string, { agentName: string; content: string; channelId: string }> = {};
        for (const [id, data] of daemon.streaming) {
          streams[id] = data;
        }
        json(res, streams);
        return;
      }

      // GET /uptime
      if (method === 'GET' && path === '/uptime') {
        const uptimeInfo = daemon.getUptimeInfo();
        json(res, uptimeInfo);
        return;
      }

      // GET /git/log — recent commit history for time-machine
      if (method === 'GET' && path === '/git/log') {
        const count = parseInt(url.searchParams.get('count') ?? '20', 10);
        const commits = await daemon.gitManager.getLog(count);
        json(res, commits);
        return;
      }

      // GET /git/show/:hash — details for a specific commit
      const showMatch = path.match(/^\/git\/show\/([a-f0-9]+)$/);
      if (method === 'GET' && showMatch) {
        const detail = await daemon.gitManager.showCommit(showMatch[1]!);
        json(res, { detail });
        return;
      }

      // POST /git/rewind/:hash — go back to a specific point in time
      const rewindMatch = path.match(/^\/git\/rewind\/([a-f0-9]+)$/);
      if (method === 'POST' && rewindMatch) {
        const result = await daemon.gitManager.rewindTo(rewindMatch[1]!);
        json(res, { result });
        return;
      }

      // POST /git/forward — undo the last rewind
      if (method === 'POST' && path === '/git/forward') {
        const result = await daemon.gitManager.forward();
        json(res, { result });
        return;
      }

      // GET /agents
      if (method === 'GET' && path === '/agents') {
        json(res, daemon.processManager.listAgents().map((a) => ({
          memberId: a.memberId,
          displayName: a.displayName,
          port: a.port,
          status: a.status,
          workStatus: daemon.getAgentWorkStatus(a.memberId),
        })));
        return;
      }

      // POST /agents/:id/start
      const startMatch = path.match(/^\/agents\/([^/]+)\/start$/);
      if (method === 'POST' && startMatch) {
        const memberId = decodeURIComponent(startMatch[1]!);
        const agent = await daemon.processManager.spawnAgent(memberId);
        json(res, { ok: true, port: agent.port, status: agent.status });
        return;
      }

      // POST /agents/:id/stop
      const stopMatch = path.match(/^\/agents\/([^/]+)\/stop$/);
      if (method === 'POST' && stopMatch) {
        const memberId = decodeURIComponent(stopMatch[1]!);
        await daemon.processManager.stopAgent(memberId);
        json(res, { ok: true });
        return;
      }

      // POST /agents/:id/restart
      const restartMatch = path.match(/^\/agents\/([^/]+)\/restart$/);
      if (method === 'POST' && restartMatch) {
        const memberId = decodeURIComponent(restartMatch[1]!);
        try {
          await daemon.processManager.stopAgent(memberId);
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
        const agent = await daemon.processManager.spawnAgent(memberId);
        daemon.setAgentWorkStatus(memberId, agent.displayName, 'idle');
        json(res, { ok: true, status: agent.status });
        return;
      }

      // POST /agents/hire
      if (method === 'POST' && path === '/agents/hire') {
        const body = await readBody(req) as Record<string, unknown>;
        const { creatorId, agentName, displayName, rank } = body;
        if (!creatorId || !agentName || !displayName || !rank) {
          json(res, { error: 'creatorId, agentName, displayName, and rank are required' }, 400);
          return;
        }
        const result = await hireAgent(daemon, {
          creatorId: creatorId as string,
          agentName: agentName as string,
          displayName: displayName as string,
          rank: rank as any,
          scope: (body.scope as any) ?? undefined,
          scopeId: (body.scopeId as string) ?? undefined,
          soulContent: (body.soulContent as string) ?? undefined,
          agentsContent: (body.agentsContent as string) ?? undefined,
          heartbeatContent: (body.heartbeatContent as string) ?? undefined,
          model: (body.model as string) ?? undefined,
          provider: (body.provider as string) ?? undefined,
        });
        json(res, { ok: true, member: result.member, dmChannel: result.dmChannel });
        return;
      }

      // POST /tasks/create
      if (method === 'POST' && path === '/tasks/create') {
        const body = await readBody(req) as Record<string, unknown>;
        if (!body.title || !body.createdBy) {
          json(res, { error: 'title and createdBy are required' }, 400);
          return;
        }
        const task = createTask(daemon.corpRoot, {
          title: body.title as string,
          description: (body.description as string) ?? undefined,
          priority: (body.priority as any) ?? undefined,
          assignedTo: (body.assignedTo as string) ?? undefined,
          createdBy: body.createdBy as string,
          parentTaskId: (body.parentTaskId as string) ?? undefined,
          dueAt: (body.dueAt as string) ?? undefined,
        });

        // TaskWatcher handles the [TASK] event via fs.watch — don't write here (prevents double)
        daemon.analytics.trackTaskCreated();
        daemon.heartbeat.refreshAll();

        // Creating a task does NOT dispatch. Only "hand" dispatches.
        // If handTo is provided, hand the task immediately (create + hand shorthand).
        const handTo = body.handTo as string | undefined;
        if (handTo && task.assignedTo) {
          logTaskAssignment(daemon.corpRoot, task.assignedTo, task.title);
          dispatchTaskToDm(daemon, task.assignedTo, task.title, task.id);
        }

        json(res, { ok: true, task });
        return;
      }

      // GET /tasks
      if (method === 'GET' && path === '/tasks') {
        const status = url.searchParams.get('status') ?? undefined;
        const assignedTo = url.searchParams.get('assignedTo') ?? undefined;
        const tasks = listTasks(daemon.corpRoot, {
          status: status as any,
          assignedTo,
        });
        json(res, tasks.map((t) => t.task));
        return;
      }

      // GET /tasks/:id
      const taskGetMatch = path.match(/^\/tasks\/([^/]+)$/);
      if (method === 'GET' && taskGetMatch) {
        const taskId = decodeURIComponent(taskGetMatch[1]!);
        try {
          const filePath = taskPath(daemon.corpRoot, taskId);
          const { task, body } = readTask(filePath);
          json(res, { task, body });
        } catch {
          json(res, { error: 'Task not found' }, 404);
        }
        return;
      }

      // PATCH /tasks/:id
      const taskPatchMatch = path.match(/^\/tasks\/([^/]+)$/);
      if (method === 'PATCH' && taskPatchMatch) {
        const taskId = decodeURIComponent(taskPatchMatch[1]!);
        const body = await readBody(req) as Record<string, unknown>;
        try {
          const filePath = taskPath(daemon.corpRoot, taskId);
          const oldTask = readTask(filePath).task;
          const updated = updateTask(filePath, body as any);

          // TaskWatcher handles status change events via fs.watch — don't double-write
          daemon.heartbeat.refreshAll();

          json(res, { ok: true, task: updated });
        } catch {
          json(res, { error: 'Task not found' }, 404);
        }
        return;
      }

      // POST /tasks/:id/hand — hand a task to an agent (assign + dispatch + refresh)
      const taskHandMatch = path.match(/^\/tasks\/([^/]+)\/hand$/);
      if (method === 'POST' && taskHandMatch) {
        const taskId = decodeURIComponent(taskHandMatch[1]!);
        const body = await readBody(req) as Record<string, unknown>;
        const toSlug = body.to as string;
        if (!toSlug) {
          json(res, { error: '"to" (agent slug) is required' }, 400);
          return;
        }

        try {
          // Resolve agent by slug or ID
          const members = readConfig<any[]>(join(daemon.corpRoot, MEMBERS_JSON));
          const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
          const target = members.find((m: any) =>
            m.type === 'agent' && (normalize(m.displayName) === normalize(toSlug) || m.id === toSlug),
          );
          if (!target) {
            json(res, { error: `Agent "${toSlug}" not found` }, 404);
            return;
          }

          // Resolve who is handing (explicit handedBy, or detect from members)
          const founder = members.find((m: any) => m.rank === 'owner');
          const handedBy = (body.handedBy as string) ?? founder?.id ?? null;
          const hander = members.find((m: any) => m.id === handedBy);
          const handerName = hander?.displayName ?? 'system';

          // Update task: assign + record hander + timestamp
          const filePath = taskPath(daemon.corpRoot, taskId);
          const updated = updateTask(filePath, {
            assignedTo: target.id,
            handedBy,
            handedAt: new Date().toISOString(),
          } as any);

          // Log to #tasks (read-only event) + dispatch to agent's DM
          logTaskAssignment(daemon.corpRoot, target.id, updated.title);
          dispatchTaskToDm(daemon, target.id, updated.title, taskId);

          // Refresh all agents' TASKS.md + casket files
          daemon.heartbeat.refreshAll();

          json(res, { ok: true, task: updated, handedTo: target.displayName, handedBy: handerName });
        } catch {
          json(res, { error: 'Task not found' }, 404);
        }
        return;
      }

      // POST /projects/create
      if (method === 'POST' && path === '/projects/create') {
        const body = await readBody(req) as Record<string, unknown>;
        if (!body.name || !body.type || !body.createdBy) {
          json(res, { error: 'name, type, and createdBy are required' }, 400);
          return;
        }
        const project = createProject(daemon.corpRoot, {
          name: body.name as string,
          type: body.type as any,
          path: (body.path as string) ?? undefined,
          lead: (body.lead as string) ?? undefined,
          description: (body.description as string) ?? undefined,
          createdBy: body.createdBy as string,
        });
        json(res, { ok: true, project });
        return;
      }

      // GET /projects
      if (method === 'GET' && path === '/projects') {
        const projects = listProjects(daemon.corpRoot);
        json(res, projects);
        return;
      }

      // POST /teams/create
      if (method === 'POST' && path === '/teams/create') {
        const body = await readBody(req) as Record<string, unknown>;
        if (!body.projectId || !body.name || !body.leaderId || !body.createdBy) {
          json(res, { error: 'projectId, name, leaderId, and createdBy are required' }, 400);
          return;
        }
        const team = createTeam(daemon.corpRoot, {
          projectId: body.projectId as string,
          name: body.name as string,
          description: (body.description as string) ?? undefined,
          leaderId: body.leaderId as string,
          createdBy: body.createdBy as string,
        });
        json(res, { ok: true, team });
        return;
      }

      // GET /teams
      if (method === 'GET' && path === '/teams') {
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const teams = listTeams(daemon.corpRoot, projectId);
        json(res, teams);
        return;
      }

      // GET /models — current model config
      if (method === 'GET' && path === '/models') {
        const gw = daemon.processManager.corpGateway;
        const gwModels = gw ? gw.getModels() : { defaultModel: `${daemon.globalConfig.defaults.provider}/${daemon.globalConfig.defaults.model}`, agents: [] };
        json(res, {
          corpDefault: {
            model: daemon.globalConfig.defaults.model,
            provider: daemon.globalConfig.defaults.provider,
          },
          fallbackChain: daemon.globalConfig.defaults.fallbackChain ?? [],
          agents: gwModels.agents,
          availableModels: KNOWN_MODELS,
        });
        return;
      }

      // POST /models/default — change corp-wide default model
      if (method === 'POST' && path === '/models/default') {
        const body = await readBody(req) as Record<string, unknown>;
        const modelInput = body.model as string;
        const provider = (body.provider as string) ?? 'anthropic';
        if (!modelInput) { json(res, { error: 'model is required' }, 400); return; }

        const model = resolveModelAlias(modelInput) ?? modelInput;

        // Update in-memory config
        daemon.globalConfig.defaults.model = model;
        daemon.globalConfig.defaults.provider = provider;

        // Persist to disk
        try {
          const persisted = readGlobalConfig();
          persisted.defaults.model = model;
          persisted.defaults.provider = provider;
          writeGlobalConfig(persisted);
        } catch {}

        // Update corp gateway
        const gw = daemon.processManager.corpGateway;
        if (gw) gw.updateDefaultModel(model, provider);

        // Broadcast event
        daemon.events.broadcast({ type: 'model_changed', agentName: null, model });

        json(res, { ok: true, model, provider });
        return;
      }

      // POST /models/agent/:name — set per-agent model override
      const modelAgentMatch = path.match(/^\/models\/agent\/([^/]+)$/);
      if (method === 'POST' && modelAgentMatch) {
        const agentName = decodeURIComponent(modelAgentMatch[1]!);
        const body = await readBody(req) as Record<string, unknown>;
        const modelInput = body.model as string;
        const provider = (body.provider as string) ?? 'anthropic';
        if (!modelInput) { json(res, { error: 'model is required' }, 400); return; }

        const model = resolveModelAlias(modelInput) ?? modelInput;

        const gw = daemon.processManager.corpGateway;
        if (gw) gw.updateAgentModel(agentName, model, provider);

        daemon.events.broadcast({ type: 'model_changed', agentName, model });

        json(res, { ok: true, agentName, model, provider });
        return;
      }

      // DELETE /models/agent/:name — clear per-agent override
      if (method === 'DELETE' && modelAgentMatch) {
        const agentName = decodeURIComponent(modelAgentMatch[1]!);
        const gw = daemon.processManager.corpGateway;
        if (gw) gw.updateAgentModel(agentName, null);

        daemon.events.broadcast({ type: 'model_changed', agentName, model: daemon.globalConfig.defaults.model });

        json(res, { ok: true, agentName, model: 'default' });
        return;
      }

      // POST /models/fallback — set fallback chain
      if (method === 'POST' && path === '/models/fallback') {
        const body = await readBody(req) as Record<string, unknown>;
        const chain = body.chain as string[];
        if (!Array.isArray(chain)) { json(res, { error: 'chain must be an array of model IDs' }, 400); return; }

        daemon.globalConfig.defaults.fallbackChain = chain;

        try {
          const persisted = readGlobalConfig();
          persisted.defaults.fallbackChain = chain;
          writeGlobalConfig(persisted);
        } catch {}

        json(res, { ok: true, fallbackChain: chain });
        return;
      }

      // PATCH /channels/:id — update channel name or mode
      const channelPatchMatch = path.match(/^\/channels\/([^/]+)$/);
      if (method === 'PATCH' && channelPatchMatch) {
        const channelId = decodeURIComponent(channelPatchMatch[1]!);
        const body = await readBody(req) as Record<string, unknown>;
        const channels = readConfig<any[]>(join(daemon.corpRoot, 'channels.json'));
        const ch = channels.find((c: any) => c.id === channelId);
        if (!ch) { json(res, { error: 'Channel not found' }, 404); return; }

        if (body.name && typeof body.name === 'string') ch.name = body.name;
        if (body.mode && (body.mode === 'dm' || body.mode === 'mention' || body.mode === 'all')) ch.mode = body.mode;

        writeConfig(join(daemon.corpRoot, 'channels.json'), channels);
        json(res, { ok: true, channel: ch });
        return;
      }

      // POST /cc/say — direct agent-to-agent dispatch (synchronous, private, no JSONL)
      if (method === 'POST' && path === '/cc/say') {
        const body = await readBody(req) as Record<string, unknown>;
        const targetSlug = body.target as string;
        const message = body.message as string;
        if (!targetSlug || !message) {
          json(res, { error: 'target and message are required' }, 400);
          return;
        }

        // Resolve target agent by slug
        const members = readConfig<any[]>(join(daemon.corpRoot, MEMBERS_JSON));
        const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
        const target = members.find((m: any) =>
          m.type === 'agent' && (normalize(m.displayName) === normalize(targetSlug) || m.id === targetSlug),
        );
        if (!target) { json(res, { error: `Agent "${targetSlug}" not found` }, 404); return; }

        const agentProc = daemon.processManager.getAgent(target.id);
        if (!agentProc || agentProc.status !== 'ready') {
          json(res, { error: `Agent "${target.displayName}" is not online` }, 503); return;
        }

        // Build lightweight context — no channel, minimal prompt
        const corpRoot = daemon.corpRoot.replace(/\\/g, '/');
        const agentDir = target.agentDir ? join(daemon.corpRoot, target.agentDir).replace(/\\/g, '/') : corpRoot;
        const allMembers = members.map((m: any) => ({ name: m.displayName, rank: m.rank, type: m.type, status: m.status }));

        let supervisorName: string | null = null;
        if (target.spawnedBy) {
          const sup = members.find((m: any) => m.id === target.spawnedBy);
          supervisorName = sup?.displayName ?? null;
        }

        const context = {
          agentDir,
          corpRoot,
          channelName: 'cc-direct',
          channelMembers: [target.displayName],
          corpMembers: allMembers,
          recentHistory: [],
          daemonPort: daemon.getPort(),
          agentMemberId: target.id,
          agentRank: target.rank,
          agentDisplayName: target.displayName,
          channelKind: 'direct' as const,
          supervisorName,
        };

        // Set target busy
        daemon.setAgentWorkStatus(target.id, target.displayName, 'busy');

        // Channel ID for WebSocket events (Jack passes this so TUI gets streaming)
        const channelId = (body.channelId as string) ?? '';

        // Resolve channel path for writing tool events to JSONL
        let channelMsgPath = '';
        if (channelId) {
          const channels = readConfig<any[]>(join(daemon.corpRoot, CHANNELS_JSON));
          const ch = channels.find((c: any) => c.id === channelId);
          if (ch) channelMsgPath = join(daemon.corpRoot, ch.path, MESSAGES_JSONL);
        }
        // Cache tool args from start events — end events often lack them
        const toolArgsCache = new Map<string, Record<string, unknown>>();

        try {
          const wsClient = agentProc.mode === 'remote' ? daemon.openclawWS : daemon.corpGatewayWS;
          // Persistent sessions by default — ALL communication has memory.
          // Deterministic key per sender→target pair: OpenClaw accumulates conversation history.
          // Explicit sessionKey (from Jack/TUI) overrides. Otherwise: persistent per pair.
          const saySenderId = (body.senderId as string) ?? 'founder';
          const senderSlug = members.find((m: any) => m.id === saySenderId)?.displayName?.toLowerCase().replace(/\s+/g, '-') ?? 'system';
          const targetSlugNorm = normalize(target.displayName);
          const sessionKey = (body.sessionKey as string)
            ?? `say:${senderSlug}:${targetSlugNorm}`;

          // Emit WebSocket events so TUI gets streaming + tool indicators
          if (channelId) {
            daemon.events.broadcast({
              type: 'dispatch_start',
              agentName: target.displayName,
              channelId,
            });
            daemon.streaming.set(target.id, {
              agentName: target.displayName,
              content: '',
              channelId,
            });
          }

          const result = await dispatchToAgent(
            agentProc,
            message,
            context,
            sessionKey,
            // onToken — stream content to TUI
            channelId ? (accumulated) => {
              daemon.streaming.set(target.id, {
                agentName: target.displayName,
                content: accumulated,
                channelId,
              });
              daemon.events.broadcast({
                type: 'stream_token',
                agentName: target.displayName,
                channelId,
                content: accumulated,
              });
            } : undefined,
            wsClient,
            // Tool callbacks — emit events + write tool_event messages to JSONL
            channelId ? {
              onToolStart: (tool) => {
                if (tool.toolCallId && tool.args) {
                  toolArgsCache.set(tool.toolCallId, tool.args);
                }
                daemon.events.broadcast({
                  type: 'tool_start',
                  agentName: target.displayName,
                  channelId,
                  toolName: tool.name,
                  args: tool.args,
                });
              },
              onToolEnd: (tool) => {
                const args = tool.args ?? toolArgsCache.get(tool.toolCallId);
                toolArgsCache.delete(tool.toolCallId);

                daemon.events.broadcast({
                  type: 'tool_end',
                  agentName: target.displayName,
                  channelId,
                  toolName: tool.name,
                });

                // Write tool_event message to channel JSONL (visible in chat history)
                if (channelMsgPath) {
                  const toolContent = formatToolMsg(tool.name, args);
                  const toolMsg: ChannelMessage = {
                    id: generateId(),
                    channelId,
                    senderId: target.id,
                    threadId: null,
                    content: toolContent,
                    kind: 'tool_event',
                    mentions: [],
                    metadata: {
                      source: 'jack',
                      toolName: tool.name,
                      toolCallId: tool.toolCallId,
                      toolArgs: args,
                      toolResult: tool.result
                        ? (typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result)).slice(0, 300)
                        : undefined,
                    },
                    depth: 0,
                    originId: '',
                    timestamp: new Date().toISOString(),
                  };
                  toolMsg.originId = toolMsg.id;
                  appendMessage(channelMsgPath, toolMsg);
                }
              },
            } : undefined,
          );

          // Clean up streaming state + emit end events
          if (channelId) {
            daemon.streaming.delete(target.id);
            daemon.events.broadcast({ type: 'stream_end', agentName: target.displayName, channelId });
            daemon.events.broadcast({ type: 'dispatch_end', agentName: target.displayName, channelId });
          }
          daemon.setAgentWorkStatus(target.id, target.displayName, 'idle');

          // Write to target agent's inbox.jsonl
          const { appendFileSync } = await import('node:fs');
          const now = new Date().toISOString();
          const senderId = (body.senderId as string) ?? 'system';
          const senderName = members.find((m: any) => m.id === senderId)?.displayName ?? 'unknown';
          const inboxPath = join(daemon.corpRoot, target.agentDir ?? `agents/${targetSlug}/`, 'inbox.jsonl');

          const question = JSON.stringify({ ts: now, from: senderName, to: target.displayName, content: message }) + '\n';
          const answerLine = JSON.stringify({ ts: now, from: target.displayName, to: senderName, content: result.content }) + '\n';
          try {
            appendFileSync(inboxPath, question + answerLine, 'utf-8');
          } catch (writeErr) {
            logError(`[cc-say] Inbox write failed (${inboxPath}): ${writeErr}`);
          }

          json(res, { ok: true, from: target.displayName, response: result.content });
        } catch (err) {
          // Clean up streaming state on failure — prevents infinite spinner in TUI
          if (channelId) {
            daemon.streaming.delete(target.id);
            daemon.events.broadcast({ type: 'stream_end', agentName: target.displayName, channelId });
            daemon.events.broadcast({ type: 'dispatch_end', agentName: target.displayName, channelId });
          }
          daemon.setAgentWorkStatus(target.id, target.displayName, 'idle');

          // Detect overloaded errors on remote CEO gateway → restart to clear cooldown
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('overloaded') && agentProc.mode === 'remote') {
            const count = (daemon.overloadCounts.get(target.id) ?? 0) + 1;
            daemon.overloadCounts.set(target.id, count);

            if (count >= 3) {
              log(`[cc-say] Remote gateway overloaded ${count}x — restarting user OpenClaw to clear cooldown`);
              daemon.overloadCounts.delete(target.id);
              try {
                const { execa: run } = await import('execa');
                const gw = daemon.globalConfig.userGateway;
                if (gw) {
                  if (process.platform === 'win32') {
                    await run('taskkill', ['/F', '/IM', 'openclaw.exe'], { reject: false, timeout: 5000 });
                  } else {
                    await run('pkill', ['-f', 'openclaw.*gateway'], { reject: false, timeout: 5000 });
                  }
                  await new Promise(r => setTimeout(r, 2000));
                  const proc = run('openclaw', ['gateway', 'run'], { stdio: 'pipe', reject: false, detached: true });
                  proc.unref?.();
                  await new Promise(r => setTimeout(r, 5000));
                  log(`[cc-say] User OpenClaw restarted — cooldown state cleared`);
                }
              } catch (restartErr) {
                logError(`[cc-say] Failed to restart user OpenClaw: ${restartErr}`);
              }
            }
          } else {
            // Non-overload error or non-remote → reset counter
            daemon.overloadCounts.delete(target.id);
          }

          json(res, { error: `Dispatch failed: ${errMsg}` }, 500);
        }
        return;
      }

      // POST /messages/send
      if (method === 'POST' && path === '/messages/send') {
        const body = await readBody(req);
        const { channelId, content, senderId } = body as { channelId: string; content: string; senderId?: string };
        if (!channelId || !content) {
          json(res, { error: 'channelId and content required' }, 400);
          return;
        }
        const result = await daemon.sendMessage(channelId, content, senderId);
        json(res, result);
        return;
      }

      // --- Clock endpoints ---

      // GET /clocks — list all registered clocks
      if (method === 'GET' && path === '/clocks') {
        json(res, daemon.clocks.list());
        return;
      }

      // GET /clocks/:id — single clock detail
      const clockGetMatch = path.match(/^\/clocks\/([^/]+)$/);
      if (method === 'GET' && clockGetMatch) {
        const id = decodeURIComponent(clockGetMatch[1]!);
        const clock = daemon.clocks.get(id);
        if (!clock) { json(res, { error: 'Clock not found' }, 404); return; }
        json(res, clock);
        return;
      }

      // POST /clocks/:id/pause
      const clockPauseMatch = path.match(/^\/clocks\/([^/]+)\/pause$/);
      if (method === 'POST' && clockPauseMatch) {
        const id = decodeURIComponent(clockPauseMatch[1]!);
        try {
          daemon.clocks.pause(id);
          json(res, { ok: true, clock: daemon.clocks.get(id) });
        } catch (e) {
          json(res, { error: String(e) }, 404);
        }
        return;
      }

      // POST /clocks/:id/resume
      const clockResumeMatch = path.match(/^\/clocks\/([^/]+)\/resume$/);
      if (method === 'POST' && clockResumeMatch) {
        const id = decodeURIComponent(clockResumeMatch[1]!);
        try {
          daemon.clocks.resume(id);
          json(res, { ok: true, clock: daemon.clocks.get(id) });
        } catch (e) {
          json(res, { error: String(e) }, 404);
        }
        return;
      }

      // POST /plan — sketch or deep plan, any agent
      if (method === 'POST' && path === '/plan') {
        const { buildPlanPrompt, randomPlanVerb, PLAN_TIMEOUTS } = await import('./plan-prompt.js');
        const { taskId: makeTaskId } = await import('@claudecorp/shared');
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const body = await readBody(req) as Record<string, unknown>;
        const goal = body.goal as string;
        if (!goal) { json(res, { error: 'goal is required' }, 400); return; }

        const planType = ((body.type as string) ?? 'sketch') as 'sketch' | 'plan';
        const channelId = (body.channelId as string) ?? '';
        const projectName = body.projectName as string | undefined;
        const verb = randomPlanVerb();
        const agentSlug = body.agent as string | undefined;

        // Find target agent:
        // - Deep plan (type=plan) → Planner agent (Opus) by default
        // - Sketch (type=sketch) → specified agent, or CEO
        const members = readConfig<any[]>(join(daemon.corpRoot, MEMBERS_JSON));
        const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
        let target: any;
        if (agentSlug) {
          target = members.find((m: any) => m.type === 'agent' && (normalize(m.displayName) === normalize(agentSlug) || m.id === agentSlug));
        } else if (planType === 'plan') {
          // Deep plan → use Planner agent (Opus) if available, fall back to CEO
          target = members.find((m: any) => m.displayName === 'Planner' && m.type === 'agent')
            ?? members.find((m: any) => m.rank === 'master' && m.type === 'agent');
        } else {
          target = members.find((m: any) => m.rank === 'master' && m.type === 'agent');
        }
        if (!target) { json(res, { error: `Agent "${agentSlug ?? 'CEO'}" not found` }, 404); return; }

        const agentDir = target.agentDir ? join(daemon.corpRoot, target.agentDir).replace(/\\/g, '/') : daemon.corpRoot;
        const slug = normalize(target.displayName);
        const timeout = PLAN_TIMEOUTS[planType] ?? PLAN_TIMEOUTS.sketch;

        const prompt = buildPlanPrompt({
          goal,
          type: planType,
          agentName: target.displayName,
          agentDir,
          corpRoot: daemon.corpRoot.replace(/\\/g, '/'),
          projectName,
        });

        try {
          const resp = await fetch(`http://127.0.0.1:${daemon.getPort()}/cc/say`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              target: slug,
              message: prompt,
              sessionKey: `jack:${slug}`,
              channelId: channelId || undefined,
            }),
            signal: AbortSignal.timeout(timeout),
          });

          const data = await resp.json() as Record<string, unknown>;

          if (data.ok && data.response) {
            const planId = makeTaskId();
            const plansDir = join(daemon.corpRoot, 'plans');
            mkdirSync(plansDir, { recursive: true });

            // Add frontmatter to the plan
            const now = new Date().toISOString();
            const titleMatch = (data.response as string).match(/^#\s+(?:Plan|Sketch):\s*(.+)/m);
            const title = titleMatch?.[1]?.trim() ?? goal.slice(0, 60);
            const frontmatter = `---\nid: ${planId}\ntitle: "${title.replace(/"/g, '\\"')}"\ntype: ${planType}\nauthor: ${target.displayName}\nstatus: draft\ncreatedAt: ${now}\n---\n\n`;
            const content = frontmatter + (data.response as string);

            writeFileSync(join(plansDir, `${planId}.md`), content, 'utf-8');

            // Write event to #tasks channel
            const eventVerb = planType === 'sketch' ? 'sketched' : 'planned';
            writeTaskEvent(daemon.corpRoot, `[PLAN] "${title}" ${eventVerb} by ${target.displayName} → plans/${planId}.md`);

            json(res, {
              ok: true,
              planId,
              planPath: `plans/${planId}.md`,
              planType,
              verb,
              author: target.displayName,
              response: (data.response as string).slice(0, 1000),
            });
          } else {
            json(res, { ok: false, error: (data as any).error ?? 'Plan failed', verb }, 500);
          }
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err), verb }, 500);
        }
        return;
      }

      // POST /dream — force-trigger a dream for an agent
      if (method === 'POST' && path === '/dream') {
        const body = await readBody(req) as Record<string, unknown>;
        const target = body.agent as string;
        if (!target) { json(res, { error: 'agent slug required' }, 400); return; }
        const result = await daemon.dreams.forceDream(target);
        json(res, result, result.ok ? 200 : 400);
        return;
      }

      // POST /loops — create a new loop
      if (method === 'POST' && path === '/loops') {
        const body = await readBody(req) as Record<string, unknown>;
        const interval = body.interval as string;
        const command = body.command as string;
        if (!interval || !command) {
          json(res, { error: 'interval and command are required' }, 400);
          return;
        }
        try {
          const loop = daemon.loops.create({
            name: body.name as string | undefined,
            interval,
            command,
            targetAgent: body.targetAgent as string | undefined,
            maxRuns: body.maxRuns as number | undefined,
            channelId: body.channelId as string | undefined,
            taskId: body.taskId as string | undefined,
          });
          json(res, { ok: true, loop });
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
        }
        return;
      }

      // POST /crons — create a new cron job
      if (method === 'POST' && path === '/crons') {
        const body = await readBody(req) as Record<string, unknown>;
        const schedule = body.schedule as string;
        const command = body.command as string;
        if (!schedule || !command) {
          json(res, { error: 'schedule and command are required' }, 400);
          return;
        }
        try {
          const cron = daemon.crons.create({
            name: body.name as string | undefined,
            schedule,
            command,
            targetAgent: body.targetAgent as string | undefined,
            maxRuns: body.maxRuns as number | undefined,
            channelId: body.channelId as string | undefined,
            spawnTask: !!body.spawnTask,
            taskTitle: body.taskTitle as string | undefined,
            assignTo: body.assignTo as string | undefined,
            taskPriority: body.taskPriority as string | undefined,
            taskDescription: body.taskDescription as string | undefined,
          });
          json(res, { ok: true, cron });
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
        }
        return;
      }

      // DELETE /clocks/:slug — remove a loop or cron (not system clocks)
      const clockDeleteMatch = path.match(/^\/clocks\/([^/]+)$/);
      if (method === 'DELETE' && clockDeleteMatch) {
        const rawId = decodeURIComponent(clockDeleteMatch[1]!);
        const internalSlug = daemon.clocks.resolveKey(rawId) ?? rawId;
        const clock = daemon.clocks.get(rawId);
        if (!clock) { json(res, { error: 'Clock not found' }, 404); return; }
        if (clock.type !== 'loop' && clock.type !== 'cron') {
          json(res, { error: 'Cannot delete system clocks — only loops and crons' }, 403);
          return;
        }
        try {
          if (clock.type === 'loop') daemon.loops.stop(internalSlug);
          else daemon.crons.stop(internalSlug);
          json(res, { ok: true });
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
        }
        return;
      }

      // POST /clocks/:slug/complete — mark a loop/cron as completed
      const clockCompleteMatch = path.match(/^\/clocks\/([^/]+)\/complete$/);
      if (method === 'POST' && clockCompleteMatch) {
        const rawId = decodeURIComponent(clockCompleteMatch[1]!);
        const internalSlug = daemon.clocks.resolveKey(rawId) ?? rawId;
        const clock = daemon.clocks.get(rawId);
        if (!clock) { json(res, { error: 'Clock not found' }, 404); return; }
        if (clock.type !== 'loop' && clock.type !== 'cron') {
          json(res, { error: 'Cannot complete system clocks' }, 403); return;
        }
        try {
          if (clock.type === 'loop') daemon.loops.complete(internalSlug);
          else daemon.crons.complete(internalSlug);
          json(res, { ok: true });
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
        }
        return;
      }

      // POST /clocks/:slug/dismiss — dismiss a loop/cron (hidden but preserved)
      const clockDismissMatch = path.match(/^\/clocks\/([^/]+)\/dismiss$/);
      if (method === 'POST' && clockDismissMatch) {
        const rawId = decodeURIComponent(clockDismissMatch[1]!);
        const internalSlug = daemon.clocks.resolveKey(rawId) ?? rawId;
        const clock = daemon.clocks.get(rawId);
        if (!clock) { json(res, { error: 'Clock not found' }, 404); return; }
        if (clock.type !== 'loop' && clock.type !== 'cron') {
          json(res, { error: 'Cannot dismiss system clocks' }, 403); return;
        }
        try {
          if (clock.type === 'loop') daemon.loops.dismiss(internalSlug);
          else daemon.crons.dismiss(internalSlug);
          json(res, { ok: true });
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
        }
        return;
      }

      // --- Contract endpoints ---

      // POST /contracts/create
      if (method === 'POST' && path === '/contracts/create') {
        const { createContract: cc, getProjectByName: gpbn } = await import('@claudecorp/shared');
        const body = await readBody(req) as Record<string, unknown>;
        if (!body.projectName || !body.title || !body.goal || !body.createdBy) {
          json(res, { error: 'projectName, title, goal, and createdBy are required' }, 400);
          return;
        }
        const project = gpbn(daemon.corpRoot, body.projectName as string);
        if (!project) { json(res, { error: `Project "${body.projectName}" not found` }, 404); return; }

        const contract = cc(daemon.corpRoot, {
          title: body.title as string,
          goal: body.goal as string,
          projectId: project.id,
          projectName: project.name,
          leadId: (body.leadId as string) ?? null,
          priority: (body.priority as any) ?? 'normal',
          deadline: (body.deadline as string) ?? null,
          blueprintId: (body.blueprintId as string) ?? null,
          createdBy: body.createdBy as string,
          description: (body.description as string) ?? undefined,
        });

        writeTaskEvent(daemon.corpRoot, `[CONTRACT] "${contract.title}" created in project ${project.name}`);
        daemon.analytics.trackTaskCreated(); // Contracts count as high-level task creation

        json(res, { ok: true, contract });
        return;
      }

      // GET /contracts?project=<name>&status=<status>
      if (method === 'GET' && path === '/contracts') {
        const { listContracts: lc, listAllContracts: lac } = await import('@claudecorp/shared');
        const projectName = url.searchParams.get('project');
        const status = url.searchParams.get('status');
        const filter = status ? { status: status as any } : undefined;

        const contracts = projectName
          ? lc(daemon.corpRoot, projectName, filter)
          : lac(daemon.corpRoot, filter);

        json(res, contracts.map(c => c.contract));
        return;
      }

      // GET /contracts/:project/:id
      const contractGetMatch = path.match(/^\/contracts\/([^/]+)\/([^/]+)$/);
      if (method === 'GET' && contractGetMatch) {
        const { readContract: rc, contractPath: cp, getContractProgress: gcp } = await import('@claudecorp/shared');
        const projectName = decodeURIComponent(contractGetMatch[1]!);
        const contractId = decodeURIComponent(contractGetMatch[2]!);
        try {
          const filePath = cp(daemon.corpRoot, projectName, contractId);
          const { contract, body: contractBody } = rc(filePath);
          const progress = gcp(daemon.corpRoot, contract);
          json(res, { contract, body: contractBody, progress });
        } catch {
          json(res, { error: 'Contract not found' }, 404);
        }
        return;
      }

      // PATCH /contracts/:project/:id
      const contractPatchMatch = path.match(/^\/contracts\/([^/]+)\/([^/]+)$/);
      if (method === 'PATCH' && contractPatchMatch) {
        const { updateContract: uc, contractPath: cp } = await import('@claudecorp/shared');
        const projectName = decodeURIComponent(contractPatchMatch[1]!);
        const contractId = decodeURIComponent(contractPatchMatch[2]!);
        const body = await readBody(req) as Record<string, unknown>;
        try {
          const filePath = cp(daemon.corpRoot, projectName, contractId);
          const updated = uc(filePath, body as any);

          if (body.status) {
            writeTaskEvent(daemon.corpRoot, `[CONTRACT] "${updated.title}" → ${updated.status}`);
          }

          daemon.heartbeat.refreshAll();
          json(res, { ok: true, contract: updated });
        } catch {
          json(res, { error: 'Contract not found' }, 404);
        }
        return;
      }

      // --- Analytics endpoints ---

      // GET /analytics — full analytics snapshot
      if (method === 'GET' && path === '/analytics') {
        json(res, daemon.analytics.getSnapshot());
        return;
      }

      // GET /analytics/stats — corp-wide stats summary
      if (method === 'GET' && path === '/analytics/stats') {
        json(res, daemon.analytics.getCorpStats());
        return;
      }

      json(res, { error: 'Not found' }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`[daemon] API error: ${message}`);
      json(res, { error: message }, 500);
    }
  });

  return server;
}


function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
