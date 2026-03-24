import { watch, type FSWatcher, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseFrontmatter,
  stringifyFrontmatter,
  readConfig,
  appendMessage,
  generateId,
  type Member,
  type Channel,
  type ChannelMessage,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import { hireAgent } from './hire.js';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';

interface HireRequest {
  agentName: string;
  displayName: string;
  rank: string;
  status: 'pending' | 'hired' | 'failed';
  createdBy?: string;
  model?: string;
  provider?: string;
  error?: string;
  [key: string]: unknown; // Allow stringify to Record<string, unknown>
}

export class HireWatcher {
  private daemon: Daemon;
  private watcher: FSWatcher | null = null;
  private processed = new Set<string>();
  private processing = new Set<string>(); // prevent double-processing from rapid fs.watch events

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  start(): void {
    const hiringDir = join(this.daemon.corpRoot, 'hiring');
    if (!existsSync(hiringDir)) {
      mkdirSync(hiringDir, { recursive: true });
    }

    // Mark existing files as already processed (don't re-hire on daemon restart)
    try {
      for (const f of readdirSync(hiringDir).filter((f) => f.endsWith('.md'))) {
        const raw = readFileSync(join(hiringDir, f), 'utf-8');
        const { meta } = parseFrontmatter<HireRequest>(raw);
        if (meta.status === 'hired' || meta.status === 'failed') {
          this.processed.add(join(hiringDir, f));
        }
      }
    } catch {}

    this.watcher = watch(hiringDir, (_event, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      this.onHireFile(join(hiringDir, filename));
    });
    this.watcher.on('error', () => {
      this.watcher = null;
      setTimeout(() => this.start(), 2000);
    });

    log(`[hire-watcher] Watching hiring/ for new hire requests`);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private async onHireFile(filePath: string): Promise<void> {
    if (this.processed.has(filePath)) return;
    if (this.processing.has(filePath)) return;
    if (!existsSync(filePath)) return;

    let meta: HireRequest;
    let body: string;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = parseFrontmatter<HireRequest>(raw);
      meta = parsed.meta;
      body = parsed.body;
    } catch {
      return; // File might be partially written
    }

    // Only process pending requests
    if (meta.status !== 'pending') {
      if (meta.status === 'hired' || meta.status === 'failed') {
        this.processed.add(filePath);
      }
      return;
    }

    // Validate required fields
    if (!meta.agentName || !meta.displayName || !meta.rank) {
      this.markFailed(filePath, meta, body, 'Missing required fields: agentName, displayName, rank');
      return;
    }

    this.processing.add(filePath);
    log(`[hire-watcher] Processing hire request: ${meta.displayName} (${meta.rank})`);

    try {
      // Use body as SOUL.md content if provided
      const soulContent = body.trim() || undefined;

      const { member, dmChannel } = await hireAgent(this.daemon, {
        creatorId: meta.createdBy ?? this.findCeoId(),
        agentName: meta.agentName,
        displayName: meta.displayName,
        rank: meta.rank as any,
        soulContent,
        model: meta.model,
        provider: meta.provider,
      });

      // Mark as hired
      meta.status = 'hired';
      writeFileSync(filePath, stringifyFrontmatter(meta as Record<string, unknown>, body));
      this.processed.add(filePath);

      // Notify in #general
      this.postHireEvent(`${meta.displayName} has been hired as ${meta.agentName} (${meta.rank})`);

      log(`[hire-watcher] Successfully hired ${meta.displayName}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.markFailed(filePath, meta, body, errMsg);
      logError(`[hire-watcher] Failed to hire ${meta.displayName}: ${errMsg}`);
    } finally {
      this.processing.delete(filePath);
    }
  }

  private markFailed(filePath: string, meta: HireRequest, body: string, error: string): void {
    meta.status = 'failed';
    meta.error = error;
    try {
      writeFileSync(filePath, stringifyFrontmatter(meta as Record<string, unknown>, body));
    } catch {}
    this.processed.add(filePath);
    this.postHireEvent(`Failed to hire ${meta.displayName ?? meta.agentName}: ${error}`);
  }

  private postHireEvent(content: string): void {
    try {
      const channels = readConfig<Channel[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
      const general = channels.find((c) => c.name.includes('general') || c.name.includes('lobby'));
      if (!general) return;

      const msg: ChannelMessage = {
        id: generateId(),
        channelId: general.id,
        senderId: 'system',
        threadId: null,
        content: `[HIRE] ${content}`,
        kind: 'system',
        mentions: [],
        metadata: null,
        depth: 0,
        originId: '',
        timestamp: new Date().toISOString(),
      };
      msg.originId = msg.id;
      appendMessage(join(this.daemon.corpRoot, general.path, MESSAGES_JSONL), msg);
    } catch {}
  }

  private findCeoId(): string {
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const ceo = members.find((m) => m.rank === 'master' && m.type === 'agent');
      return ceo?.id ?? '';
    } catch {
      return '';
    }
  }
}
