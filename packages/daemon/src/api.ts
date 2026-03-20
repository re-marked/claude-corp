import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
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
} from '@claudecorp/shared';
import type { Daemon } from './daemon.js';
import { hireAgent } from './hire.js';
import { writeTaskEvent, notifyTaskAssignment } from './task-events.js';

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
          })),
          dispatching: [...daemon.router.activeDispatches],
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

      // GET /agents
      if (method === 'GET' && path === '/agents') {
        json(res, daemon.processManager.listAgents().map((a) => ({
          memberId: a.memberId,
          displayName: a.displayName,
          port: a.port,
          status: a.status,
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

        // @mention the assignee so the router dispatches immediately
        if (task.assignedTo) {
          notifyTaskAssignment(daemon.corpRoot, task.assignedTo, task.title);
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

      // POST /messages/send
      if (method === 'POST' && path === '/messages/send') {
        const body = await readBody(req);
        const { channelId, content } = body as { channelId: string; content: string };
        if (!channelId || !content) {
          json(res, { error: 'channelId and content required' }, 400);
          return;
        }
        const result = await daemon.sendMessage(channelId, content);
        json(res, result);
        return;
      }

      json(res, { error: 'Not found' }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[daemon] API error: ${message}`);
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
