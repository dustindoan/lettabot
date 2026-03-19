/**
 * EdgeProxySession — Lightweight AgentSession that forwards messages
 * to an upstream lettabotd instance via HTTP.
 *
 * The edge device handles channel protocol (Signal, Telegram, etc.)
 * while agent reasoning happens upstream. Responses flow back through
 * the proxy and are delivered locally through the edge's channels.
 */

import type { AgentSession } from './interfaces.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { InboundMessage, TriggerContext, StreamMsg } from './types.js';
import type { GroupBatcher } from './group-batcher.js';
import { TypingHeartbeat } from '../channels/types.js';
import { createLogger } from '../logger.js';

const log = createLogger('EdgeProxy');

export interface EdgeProxyConfig {
  name: string;
  upstreamUrl: string;
  apiKey?: string;
  displayName?: string;
}

export class EdgeProxySession implements AgentSession {
  private config: EdgeProxyConfig;
  private channels: Map<string, ChannelAdapter> = new Map();
  private lastMessageTarget: { channel: string; chatId: string } | null = null;
  private lastUserMessageTime: Date | null = null;

  // Group batching (runs on edge)
  private groupBatcher: GroupBatcher | null = null;
  private groupIntervals: Map<string, number> = new Map();
  private instantGroupIds: Set<string> = new Set();
  private listeningGroupIds: Set<string> = new Set();

  onTriggerHeartbeat?: () => Promise<void>;

  constructor(config: EdgeProxyConfig) {
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Channel registration
  // ---------------------------------------------------------------------------

  registerChannel(adapter: ChannelAdapter): void {
    adapter.onMessage = (msg) => this.handleMessage(msg, adapter);
    adapter.onCommand = (_cmd, _chatId, _args) => {
      // Commands not supported in edge proxy mode
      return Promise.resolve(null);
    };
    this.channels.set(adapter.id, adapter);
    log.info(`Registered channel: ${adapter.name}`);
  }

  setGroupBatcher(
    batcher: GroupBatcher,
    intervals: Map<string, number>,
    instantGroupIds?: Set<string>,
    listeningGroupIds?: Set<string>,
  ): void {
    this.groupBatcher = batcher;
    this.groupIntervals = intervals;
    if (instantGroupIds) this.instantGroupIds = instantGroupIds;
    if (listeningGroupIds) this.listeningGroupIds = listeningGroupIds;
    log.info('Group batcher configured');
  }

  processGroupBatch(msg: InboundMessage, adapter: ChannelAdapter): void {
    const count = msg.batchedMessages?.length || 0;
    log.info(`Group batch: ${count} messages from ${msg.channel}:${msg.chatId}`);
    const effective = (count === 1 && msg.batchedMessages)
      ? msg.batchedMessages[0]
      : msg;
    this.handleMessage(effective, adapter);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // Health-check upstream (warn on failure, don't block)
    try {
      const res = await fetch(`${this.config.upstreamUrl}/api/v1/status`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        log.info(`Upstream reachable: ${this.config.upstreamUrl}`);
      } else {
        log.warn(`Upstream returned ${res.status}: ${this.config.upstreamUrl}`);
      }
    } catch (err) {
      log.warn(`Upstream unreachable: ${this.config.upstreamUrl} — will retry on first message`);
    }

    // Start all channel adapters
    const startPromises = Array.from(this.channels.entries()).map(async ([id, adapter]) => {
      try {
        log.info(`Starting channel: ${adapter.name}...`);
        await adapter.start();
        log.info(`Started channel: ${adapter.name}`);
      } catch (e) {
        log.error(`Failed to start channel ${id}:`, e);
      }
    });
    await Promise.all(startPromises);
  }

  async stop(): Promise<void> {
    if (this.groupBatcher) {
      this.groupBatcher.stop();
    }
    for (const adapter of this.channels.values()) {
      try {
        await adapter.stop();
      } catch (e) {
        log.error(`Failed to stop channel ${adapter.id}:`, e);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Agent communication (forwarded to upstream)
  // ---------------------------------------------------------------------------

  async sendToAgent(text: string, context?: TriggerContext): Promise<string> {
    const userId = context?.sourceUserId || context?.sourceChatId || 'unknown';
    log.info({ userId, text: text.slice(0, 50) }, 'sendToAgent');
    const res = await fetch(`${this.config.upstreamUrl}/api/v1/chat`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify({ message: text, userId }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Upstream error ${res.status}: ${body}`);
    }

    const data = await res.json() as { success: boolean; response?: string; error?: string };
    if (!data.success) throw new Error(data.error || 'Upstream returned failure');
    return data.response || '';
  }

  async *streamToAgent(text: string, context?: TriggerContext): AsyncGenerator<StreamMsg> {
    const userId = context?.sourceUserId || context?.sourceChatId || 'unknown';
    const res = await fetch(`${this.config.upstreamUrl}/api/v1/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...this.authHeaders(),
      },
      body: JSON.stringify({ message: text, userId }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Upstream error ${res.status}: ${body}`);
    }

    // Parse SSE stream into StreamMsg objects
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on SSE double-newline boundaries
        const parts = buffer.split('\n\n');
        buffer = parts.pop()!; // keep incomplete part

        for (const part of parts) {
          const dataLine = part.split('\n').find(line => line.startsWith('data: '));
          if (!dataLine) continue;
          const json = dataLine.slice(6);
          try {
            const msg: StreamMsg = JSON.parse(json);
            yield msg;
            if (msg.type === 'result') return;
          } catch {
            // skip malformed SSE events
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Channel delivery (local — edge owns channels)
  // ---------------------------------------------------------------------------

  async deliverToChannel(
    channelId: string,
    chatId: string,
    options: { text?: string; filePath?: string; kind?: 'image' | 'file' | 'audio' },
  ): Promise<string | undefined> {
    const adapter = this.channels.get(channelId);
    if (!adapter) throw new Error(`Channel not found: ${channelId}`);

    if (options.filePath) {
      if (typeof adapter.sendFile !== 'function') {
        throw new Error(`Channel ${channelId} does not support file sending`);
      }
      const result = await adapter.sendFile({
        chatId,
        filePath: options.filePath,
        caption: options.text,
        kind: options.kind,
      });
      return result.messageId;
    }

    if (options.text) {
      const text = this.prefixResponse(options.text);
      const result = await adapter.sendMessage({ chatId, text });
      return result.messageId;
    }

    throw new Error('Either text or filePath must be provided');
  }

  // ---------------------------------------------------------------------------
  // Status & state
  // ---------------------------------------------------------------------------

  getStatus(): { agentId: string | null; conversationId: string | null; channels: string[] } {
    return {
      agentId: `edge-proxy:${this.config.name}`,
      conversationId: null,
      channels: Array.from(this.channels.keys()),
    };
  }

  setAgentId(_agentId: string): void {
    // no-op — agent ID is upstream's concern
  }

  reset(): void {
    // no-op — no local state to reset
  }

  getLastMessageTarget(): { channel: string; chatId: string } | null {
    return this.lastMessageTarget;
  }

  getLastUserMessageTime(): Date | null {
    return this.lastUserMessageTime;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    log.info({ channel: msg.channel, chatId: msg.chatId, userId: msg.userId, text: msg.text?.slice(0, 50) }, 'handleMessage called');
    // Group batching
    if (msg.isGroup && this.groupBatcher) {
      const isInstant = this.instantGroupIds.has(`${msg.channel}:${msg.chatId}`)
        || (msg.serverId && this.instantGroupIds.has(`${msg.channel}:${msg.serverId}`));
      const debounceMs = isInstant ? 0 : (this.groupIntervals.get(msg.channel) ?? 5000);
      this.groupBatcher.enqueue(msg, adapter, debounceMs);
      return;
    }

    // Track for heartbeat delivery
    this.lastUserMessageTime = new Date();
    this.lastMessageTarget = { channel: msg.channel, chatId: msg.chatId };

    // Typing indicator
    const typing = new TypingHeartbeat();
    typing.start(adapter, msg.chatId);

    try {
      const context: TriggerContext = {
        type: 'user_message',
        outputMode: msg.isListeningMode ? 'silent' : 'responsive',
        sourceChannel: msg.channel,
        sourceChatId: msg.chatId,
        sourceUserId: msg.userId,
      };

      const response = await this.sendToAgent(msg.text, context);

      if (response?.trim() && !msg.isListeningMode) {
        const text = this.prefixResponse(response);
        await adapter.sendMessage({ chatId: msg.chatId, text, threadId: msg.threadId });
      }
    } catch (err) {
      log.error(`Edge proxy error (${msg.channel}:${msg.chatId}):`, err);
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: 'Sorry, I encountered an error connecting to the server.',
      }).catch(() => {});
    } finally {
      typing.stop();
    }
  }

  private prefixResponse(text: string): string {
    if (!this.config.displayName) return text;
    return `${this.config.displayName}: ${text}`;
  }

  private authHeaders(): Record<string, string> {
    if (!this.config.apiKey) return {};
    return { 'X-Api-Key': this.config.apiKey };
  }
}
