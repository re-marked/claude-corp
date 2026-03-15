import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Daemon } from './daemon.js';
import { hireAgent } from './hire.js';

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
        });
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
