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
  KNOWN_MODELS,
  resolveModelAlias,
  writeGlobalConfig,
  readGlobalConfig,
  MEMBERS_JSON,
} from '@claudecorp/shared';
import type { Daemon } from './daemon.js';
import { dispatchToAgent } from './dispatch.js';
import { hireAgent } from './hire.js';
import { writeTaskEvent, logTaskAssignment, dispatchTaskToDm } from './task-events.js';
import { logError } from './logger.js';

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

        // Post task event + suppress TaskWatcher duplicate + refresh TASKS.md
        writeTaskEvent(daemon.corpRoot, `"${task.title}" created (priority: ${task.priority})`);
        daemon.taskWatcher.suppressNextCreate(taskPath(daemon.corpRoot, task.id));
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

          // Post status change event + refresh TASKS.md
          if (body.status && body.status !== oldTask.status) {
            writeTaskEvent(
              daemon.corpRoot,
              `"${updated.title}" → ${updated.status}`,
            );
          }
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

        try {
          const wsClient = agentProc.mode === 'remote' ? daemon.openclawWS : daemon.corpGatewayWS;
          // Support persistent session keys for Jack mode (live interactive sessions)
          const sessionKey = (body.sessionKey as string)
            ?? `cc-say:${agentProc.model.replace('openclaw:', '')}:${Date.now()}`;
          const result = await dispatchToAgent(agentProc, message, context, sessionKey, undefined, wsClient);
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
          daemon.setAgentWorkStatus(target.id, target.displayName, 'idle');
          json(res, { error: `Dispatch failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
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
