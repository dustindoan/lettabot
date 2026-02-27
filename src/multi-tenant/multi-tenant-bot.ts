/**
 * MultiTenantBot — Per-user agent routing for LettaBot
 *
 * Each user (identified by chatId) gets their own Letta agent with isolated
 * memory and archival storage. Messages from different users process in
 * parallel; messages from the same user process sequentially.
 *
 * Implements AgentSession so it plugs into existing channel adapters,
 * gateway, cron, heartbeat, and API server infrastructure.
 *
 * Ported from LettaBot (src/core/bot.ts) with per-user parameterization.
 */

import {
  createSession,
  resumeSession,
  imageFromFile,
  imageFromURL,
  type Session,
  type MessageContentItem,
  type SendMessage,
  type CanUseToolCallback,
} from '../letta/index.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { BotConfig, InboundMessage, TriggerContext, LastMessageTarget } from '../core/types.js';
import type { AgentSession } from '../core/interfaces.js';
import type { StreamMsg } from '../core/bot.js';
import { isResponseDeliverySuppressed } from '../core/bot.js';
import { recoverOrphanedConversationApproval, ensureNoToolApprovals } from '../tools/letta-api.js';
import { formatMessageEnvelope, formatGroupBatchEnvelope, type SessionContextOptions } from '../core/formatter.js';
import type { GroupBatcher } from '../core/group-batcher.js';
import { parseDirectives, stripActionsBlock, type Directive } from '../core/directives.js';
import { createManageTodoTool } from '../tools/todo.js';
import { syncTodosFromTool } from '../todo/store.js';
import type { UserRecord } from './types.js';
import type { UserRegistry } from './user-registry.js';

// ---------------------------------------------------------------------------
// Error detection helpers (copied from bot.ts)
// ---------------------------------------------------------------------------

function isApprovalConflictError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('waiting for approval')) return true;
    if (msg.includes('conflict') && msg.includes('approval')) return true;
  }
  const statusError = error as { status?: number };
  if (statusError?.status === 409) return true;
  return false;
}

function isConversationMissingError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('not found')) return true;
    if (msg.includes('conversation') && (msg.includes('missing') || msg.includes('does not exist'))) return true;
    if (msg.includes('agent') && msg.includes('not found')) return true;
  }
  const statusError = error as { status?: number };
  if (statusError?.status === 404) return true;
  return false;
}

const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

async function buildMultimodalMessage(
  formattedText: string,
  msg: InboundMessage,
): Promise<SendMessage> {
  if (process.env.INLINE_IMAGES === 'false') return formattedText;

  const imageAttachments = (msg.attachments ?? []).filter(
    (a) => a.kind === 'image'
      && (a.localPath || a.url)
      && (!a.mimeType || SUPPORTED_IMAGE_MIMES.has(a.mimeType)),
  );

  if (imageAttachments.length === 0) return formattedText;

  const content: MessageContentItem[] = [
    { type: 'text', text: formattedText },
  ];

  for (const attachment of imageAttachments) {
    try {
      if (attachment.localPath) {
        content.push(imageFromFile(attachment.localPath));
      } else if (attachment.url) {
        content.push(await imageFromURL(attachment.url));
      }
    } catch (err) {
      console.warn(`[MultiTenantBot] Failed to load image: ${err instanceof Error ? err.message : err}`);
    }
  }

  return content.length > 1 ? content : formattedText;
}

// ---------------------------------------------------------------------------
// MultiTenantBot config
// ---------------------------------------------------------------------------

export interface MultiTenantBotConfig extends BotConfig {
  registry: UserRegistry;
}

// ---------------------------------------------------------------------------
// MultiTenantBot
// ---------------------------------------------------------------------------

export class MultiTenantBot implements AgentSession {
  private config: MultiTenantBotConfig;
  private registry: UserRegistry;
  private channels: Map<string, ChannelAdapter> = new Map();

  // Per-user sessions (keyed by chatId)
  private sessions: Map<string, Session> = new Map();
  private currentCanUseTool: CanUseToolCallback | undefined;
  private readonly sessionCanUseTool: CanUseToolCallback = async (toolName, toolInput) => {
    if (this.currentCanUseTool) {
      return this.currentCanUseTool(toolName, toolInput);
    }
    return { behavior: 'allow' as const };
  };

  // Per-user message queues (parallel across users, serial within user)
  private processingUsers: Set<string> = new Set();
  private userQueues: Map<string, Array<{ msg: InboundMessage; adapter: ChannelAdapter }>> = new Map();

  // Per-user pending question resolvers (for AskUserQuestion)
  private pendingQuestionResolvers: Map<string, (text: string) => void> = new Map();

  // Group batching
  private groupBatcher?: GroupBatcher;
  private groupIntervals: Map<string, number> = new Map();
  private instantGroupIds: Set<string> = new Set();
  private listeningGroupIds: Set<string> = new Set();

  // Per-user last message timestamps (for heartbeat skip logic)
  private lastUserMessageTimes: Map<string, Date> = new Map();

  // Heartbeat callback
  public onTriggerHeartbeat?: () => Promise<void>;

  // Conversation complete callback (for Narrator conversation-driven trigger)
  public onConversationComplete?: () => void;

  constructor(config: MultiTenantBotConfig) {
    this.config = config;
    this.registry = config.registry;
    console.log(`[MultiTenantBot] Initialized with ${this.registry.size} cached user(s)`);
  }

  // =========================================================================
  // Display name prefix
  // =========================================================================

  private prefixResponse(text: string): string {
    if (!this.config.displayName) return text;
    return `${this.config.displayName}: ${text}`;
  }

  // =========================================================================
  // Session options
  // =========================================================================

  private getTodoAgentKey(user: UserRecord): string {
    return user.agentId || this.config.agentName || 'MultiTenantBot';
  }

  private syncTodoToolCall(streamMsg: StreamMsg, user: UserRecord): void {
    if (streamMsg.type !== 'tool_call') return;
    const normalizedToolName = (streamMsg.toolName || '').toLowerCase();
    const isBuiltInTodoTool = normalizedToolName === 'todowrite'
      || normalizedToolName === 'todo_write'
      || normalizedToolName === 'writetodos'
      || normalizedToolName === 'write_todos';
    if (!isBuiltInTodoTool) return;

    const input = (streamMsg.toolInput && typeof streamMsg.toolInput === 'object')
      ? streamMsg.toolInput as Record<string, unknown>
      : null;
    if (!input || !Array.isArray(input.todos)) return;

    const incoming: Array<{
      content?: string;
      description?: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    }> = [];
    for (const item of input.todos) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const statusRaw = typeof obj.status === 'string' ? obj.status : '';
      if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(statusRaw)) continue;
      incoming.push({
        content: typeof obj.content === 'string' ? obj.content : undefined,
        description: typeof obj.description === 'string' ? obj.description : undefined,
        status: statusRaw as 'pending' | 'in_progress' | 'completed' | 'cancelled',
      });
    }
    if (incoming.length === 0) return;

    try {
      const summary = syncTodosFromTool(this.getTodoAgentKey(user), incoming);
      if (summary.added > 0 || summary.updated > 0) {
        console.log(`[MultiTenantBot] Synced ${summary.totalIncoming} todo(s) for ${user.chatId}`);
      }
    } catch (err) {
      console.warn('[MultiTenantBot] Failed to sync TodoWrite:', err instanceof Error ? err.message : err);
    }
  }

  private baseSessionOptions(canUseTool?: CanUseToolCallback, user?: UserRecord) {
    return {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      disallowedTools: [
        'TodoWrite',
        ...(this.config.disallowedTools || []),
      ],
      cwd: this.config.workingDir,
      tools: [createManageTodoTool(user ? this.getTodoAgentKey(user) : this.config.agentName || 'MultiTenantBot')],
      ...(canUseTool ? { canUseTool } : {}),
      // Pass per-user Letta user ID for MCP OAuth scoping
      ...(user?.lettaUserId ? { transport: { userId: user.lettaUserId } } : {}),
    };
  }

  // =========================================================================
  // AskUserQuestion formatting
  // =========================================================================

  private formatQuestionsForChannel(questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>): string {
    const parts: string[] = [];
    for (const q of questions) {
      parts.push(`**${q.question}**`);
      parts.push('');
      for (let i = 0; i < q.options.length; i++) {
        parts.push(`${i + 1}. **${q.options[i].label}**`);
        parts.push(`   ${q.options[i].description}`);
      }
      if (q.multiSelect) {
        parts.push('');
        parts.push('_(You can select multiple options)_');
      }
    }
    parts.push('');
    parts.push('_Reply with your choice (number, name, or your own answer)._');
    return parts.join('\n');
  }

  // =========================================================================
  // Directive execution
  // =========================================================================

  private async executeDirectives(
    directives: Directive[],
    adapter: ChannelAdapter,
    chatId: string,
    fallbackMessageId?: string,
  ): Promise<boolean> {
    let acted = false;
    for (const directive of directives) {
      if (directive.type === 'react') {
        const targetId = directive.messageId || fallbackMessageId;
        if (!adapter.addReaction) continue;
        if (targetId) {
          try {
            await adapter.addReaction(chatId, targetId, directive.emoji);
            acted = true;
          } catch (err) {
            console.warn('[MultiTenantBot] Directive react failed:', err instanceof Error ? err.message : err);
          }
        }
      }
    }
    return acted;
  }

  // =========================================================================
  // Per-user session lifecycle
  // =========================================================================

  /**
   * Get or create a persistent SDK session for a user's agent.
   */
  private async ensureSessionForUser(user: UserRecord): Promise<Session> {
    const existing = this.sessions.get(user.chatId);
    if (existing) return existing;

    const opts = this.baseSessionOptions(this.sessionCanUseTool, user);
    let session: Session;

    if (user.conversationId) {
      session = resumeSession(user.conversationId, opts);
    } else {
      session = createSession(user.agentId, opts);
    }

    console.log(`[MultiTenantBot] Initializing session for ${user.chatId} (agent=${user.agentId})...`);
    await session.initialize();
    console.log(`[MultiTenantBot] Session ready for ${user.chatId}`);
    this.sessions.set(user.chatId, session);
    return session;
  }

  /**
   * Destroy a user's session so the next call creates a fresh one.
   */
  private invalidateSession(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      console.log(`[MultiTenantBot] Invalidating session for ${chatId}`);
      session.close();
      this.sessions.delete(chatId);
    }
  }

  /**
   * Persist conversation ID back to the user registry after a successful session.
   */
  private persistSessionState(session: Session, user: UserRecord): void {
    if (session.conversationId && session.conversationId !== user.conversationId) {
      this.registry.updateConversation(user.chatId, session.conversationId);
      user.conversationId = session.conversationId;
      console.log(`[MultiTenantBot] Conversation ID updated for ${user.chatId}: ${session.conversationId}`);
    }
  }

  // =========================================================================
  // runSession — send + stream with error recovery
  // =========================================================================

  private async runSession(
    message: SendMessage,
    user: UserRecord,
    options: { retried?: boolean; canUseTool?: CanUseToolCallback } = {},
  ): Promise<{ session: Session; stream: () => AsyncGenerator<StreamMsg> }> {
    const { retried = false, canUseTool } = options;
    this.currentCanUseTool = canUseTool;

    let session = await this.ensureSessionForUser(user);

    // Send with fallback chain
    try {
      await session.send(message);
    } catch (error) {
      // 409 CONFLICT from orphaned approval
      if (!retried && isApprovalConflictError(error) && user.conversationId) {
        console.log(`[MultiTenantBot] CONFLICT for ${user.chatId} - recovering...`);
        this.invalidateSession(user.chatId);
        const result = await recoverOrphanedConversationApproval(user.agentId, user.conversationId);
        if (result.recovered) {
          console.log(`[MultiTenantBot] Recovery succeeded for ${user.chatId}, retrying...`);
          return this.runSession(message, user, { retried: true, canUseTool });
        }
        throw error;
      }

      // Conversation/agent not found
      if (isConversationMissingError(error) && user.agentId) {
        console.warn(`[MultiTenantBot] Conversation not found for ${user.chatId}, creating new...`);
        this.invalidateSession(user.chatId);
        user.conversationId = undefined;
        this.registry.updateConversation(user.chatId, '');
        session = await this.ensureSessionForUser(user);
        await session.send(message);
      } else {
        this.invalidateSession(user.chatId);
        throw error;
      }
    }

    // Persist immediately after successful send
    this.persistSessionState(session, user);

    // Return deduplicated stream
    const seenToolCallIds = new Set<string>();
    const self = this;
    const capturedUser = user;

    async function* dedupedStream(): AsyncGenerator<StreamMsg> {
      for await (const raw of session.stream()) {
        const msg = raw as StreamMsg;
        if (msg.type === 'tool_call') {
          const id = msg.toolCallId;
          if (id && seenToolCallIds.has(id)) continue;
          if (id) seenToolCallIds.add(id);
        }
        yield msg;
        if (msg.type === 'result') {
          self.persistSessionState(session, capturedUser);
          break;
        }
      }
    }

    return { session, stream: dedupedStream };
  }

  // =========================================================================
  // Channel management
  // =========================================================================

  registerChannel(adapter: ChannelAdapter): void {
    adapter.onMessage = (msg) => this.handleMessage(msg, adapter);
    adapter.onCommand = (cmd) => this.handleCommand(cmd, msg => this.handleMessage(msg, adapter));
    this.channels.set(adapter.id, adapter);
    console.log(`[MultiTenantBot] Registered channel: ${adapter.name}`);
  }

  setGroupBatcher(batcher: GroupBatcher, intervals: Map<string, number>, instantGroupIds?: Set<string>, listeningGroupIds?: Set<string>): void {
    this.groupBatcher = batcher;
    this.groupIntervals = intervals;
    if (instantGroupIds) this.instantGroupIds = instantGroupIds;
    if (listeningGroupIds) this.listeningGroupIds = listeningGroupIds;
  }

  processGroupBatch(msg: InboundMessage, adapter: ChannelAdapter): void {
    const count = msg.batchedMessages?.length || 0;
    const effective = (count === 1 && msg.batchedMessages) ? msg.batchedMessages[0] : msg;
    if (effective.isListeningMode === undefined) {
      const isListening = this.listeningGroupIds.has(`${msg.channel}:${msg.chatId}`)
        || (msg.serverId && this.listeningGroupIds.has(`${msg.channel}:${msg.serverId}`));
      if (isListening && !msg.wasMentioned) {
        effective.isListeningMode = true;
      }
    }
    this.enqueueForUser(effective.chatId, effective, adapter);
  }

  // =========================================================================
  // Commands
  // =========================================================================

  private async handleCommand(
    command: string,
    _enqueue: (msg: InboundMessage) => void,
  ): Promise<string | null> {
    switch (command) {
      case 'status':
        return `*Multi-Tenant Mode*\nUsers: ${this.registry.size}\nChannels: ${Array.from(this.channels.keys()).join(', ')}`;
      default:
        return null;
    }
  }

  // =========================================================================
  // Start / Stop
  // =========================================================================

  async start(): Promise<void> {
    const startPromises = Array.from(this.channels.entries()).map(async ([id, adapter]) => {
      try {
        console.log(`Starting channel: ${adapter.name}...`);
        await adapter.start();
        console.log(`Started channel: ${adapter.name}`);
      } catch (e) {
        console.error(`Failed to start channel ${id}:`, e);
      }
    });
    await Promise.all(startPromises);
  }

  async stop(): Promise<void> {
    for (const adapter of this.channels.values()) {
      try {
        await adapter.stop();
      } catch (e) {
        console.error(`Failed to stop channel ${adapter.id}:`, e);
      }
    }
  }

  // =========================================================================
  // Message queue — per-user parallelism
  // =========================================================================

  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    // AskUserQuestion: intercept if this user has a pending question
    const resolver = this.pendingQuestionResolvers.get(msg.chatId);
    if (resolver) {
      console.log(`[MultiTenantBot] Intercepted answer from ${msg.chatId}`);
      resolver(msg.text || '');
      this.pendingQuestionResolvers.delete(msg.chatId);
      return;
    }

    console.log(`[${msg.channel}] Message from ${msg.userId}: ${msg.text}`);

    // Group batching
    if (msg.isGroup && this.groupBatcher) {
      const isInstant = this.instantGroupIds.has(`${msg.channel}:${msg.chatId}`)
        || (msg.serverId && this.instantGroupIds.has(`${msg.channel}:${msg.serverId}`));
      const debounceMs = isInstant ? 0 : (this.groupIntervals.get(msg.channel) ?? 5000);
      this.groupBatcher.enqueue(msg, adapter, debounceMs);
      return;
    }

    // Per-user queue
    this.enqueueForUser(msg.chatId, msg, adapter);
  }

  private enqueueForUser(chatId: string, msg: InboundMessage, adapter: ChannelAdapter): void {
    let queue = this.userQueues.get(chatId);
    if (!queue) {
      queue = [];
      this.userQueues.set(chatId, queue);
    }
    queue.push({ msg, adapter });

    if (!this.processingUsers.has(chatId)) {
      this.processUserQueue(chatId).catch(err =>
        console.error(`[Queue] Fatal error for user ${chatId}:`, err),
      );
    }
  }

  private async processUserQueue(chatId: string): Promise<void> {
    if (this.processingUsers.has(chatId)) return;
    this.processingUsers.add(chatId);

    const queue = this.userQueues.get(chatId);
    while (queue && queue.length > 0) {
      const { msg, adapter } = queue.shift()!;
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        console.error(`[Queue] Error processing message for ${chatId}:`, error);
      }
    }

    this.processingUsers.delete(chatId);
    this.userQueues.delete(chatId);
  }

  // =========================================================================
  // processMessage — the core message handling pipeline
  // =========================================================================

  private async processMessage(msg: InboundMessage, adapter: ChannelAdapter, retried = false): Promise<void> {
    const suppressDelivery = isResponseDeliverySuppressed(msg);
    this.lastUserMessageTimes.set(msg.chatId, new Date());

    // Resolve user → agent
    const user = await this.registry.resolve(msg.chatId, {
      displayName: msg.userName,
      channel: msg.channel,
    });

    // Update last message target (for heartbeat delivery)
    if (!suppressDelivery) {
      const target: LastMessageTarget = {
        channel: msg.channel,
        chatId: msg.chatId,
        messageId: msg.messageId,
        updatedAt: new Date().toISOString(),
      };
      this.registry.updateLastActive(msg.chatId, target);
    }

    // Typing indicator
    if (!suppressDelivery) {
      adapter.sendTypingIndicator(msg.chatId).catch(() => {});
    }

    // Format message envelope
    const sessionContext: SessionContextOptions | undefined = {
      agentId: user.agentId,
      serverUrl: process.env.LETTA_BASE_URL || 'https://api.letta.com',
    };
    const formattedText = msg.isBatch && msg.batchedMessages
      ? formatGroupBatchEnvelope(msg.batchedMessages, {}, msg.isListeningMode)
      : formatMessageEnvelope(msg, {}, sessionContext);
    const messageToSend = await buildMultimodalMessage(formattedText, msg);

    // AskUserQuestion callback (per-user)
    const canUseTool: CanUseToolCallback = async (toolName, toolInput) => {
      if (toolName === 'AskUserQuestion') {
        const questions = (toolInput.questions || []) as Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>;
        const questionText = this.formatQuestionsForChannel(questions);
        await adapter.sendMessage({ chatId: msg.chatId, text: questionText, threadId: msg.threadId });

        const answer = await new Promise<string>((resolve) => {
          this.pendingQuestionResolvers.set(msg.chatId, resolve);
        });

        const answers: Record<string, string> = {};
        for (const q of questions) {
          answers[q.question] = answer;
        }
        return { behavior: 'allow' as const, updatedInput: { ...toolInput, answers } };
      }
      return { behavior: 'allow' as const };
    };

    // Run session
    let session: Session | null = null;
    try {
      const run = await this.runSession(messageToSend, user, { retried, canUseTool });
      session = run.session;

      // Stream response
      let response = '';
      let lastUpdate = 0;
      let messageId: string | null = null;
      let lastMsgType: string | null = null;
      let lastAssistantUuid: string | null = null;
      let sentAnyMessage = false;
      let receivedAnyData = false;
      let sawNonAssistantSinceLastUuid = false;
      const msgTypeCounts: Record<string, number> = {};

      const finalizeMessage = async () => {
        if (response.trim() === '<no-reply/>') {
          sentAnyMessage = true;
          response = '';
          messageId = null;
          lastUpdate = Date.now();
          return;
        }
        if (response.trim()) {
          const { cleanText, directives } = parseDirectives(response);
          response = cleanText;
          if (await this.executeDirectives(directives, adapter, msg.chatId, msg.messageId)) {
            sentAnyMessage = true;
          }
        }
        if (!suppressDelivery && response.trim()) {
          try {
            const prefixed = this.prefixResponse(response);
            if (messageId) {
              await adapter.editMessage(msg.chatId, messageId, prefixed);
            } else {
              await adapter.sendMessage({ chatId: msg.chatId, text: prefixed, threadId: msg.threadId });
            }
            sentAnyMessage = true;
          } catch {
            if (messageId) sentAnyMessage = true;
          }
        }
        response = '';
        messageId = null;
        lastUpdate = Date.now();
      };

      const typingInterval = setInterval(() => {
        adapter.sendTypingIndicator(msg.chatId).catch(() => {});
      }, 4000);

      try {
        for await (const streamMsg of run.stream()) {
          receivedAnyData = true;
          msgTypeCounts[streamMsg.type] = (msgTypeCounts[streamMsg.type] || 0) + 1;
          console.log(`[Stream:${msg.chatId.slice(0, 8)}] type=${streamMsg.type} ${JSON.stringify(streamMsg).slice(0, 200)}`);

          // Finalize on type change
          if (lastMsgType && lastMsgType !== streamMsg.type && response.trim() && streamMsg.type !== 'result') {
            await finalizeMessage();
          }

          // Tool loop detection
          const maxToolCalls = this.config.maxToolCalls ?? 100;
          if (streamMsg.type === 'tool_call' && (msgTypeCounts['tool_call'] || 0) >= maxToolCalls) {
            console.error(`[MultiTenantBot] Tool loop for ${msg.chatId}, aborting`);
            session.abort().catch(() => {});
            response = '(Agent got stuck in a tool loop and was stopped.)';
            break;
          }

          // Logging
          if (streamMsg.type === 'tool_call') {
            this.syncTodoToolCall(streamMsg, user);
            sawNonAssistantSinceLastUuid = true;
          } else if (streamMsg.type === 'tool_result') {
            sawNonAssistantSinceLastUuid = true;
          } else if (streamMsg.type !== 'assistant') {
            sawNonAssistantSinceLastUuid = true;
          }
          lastMsgType = streamMsg.type;

          if (streamMsg.type === 'assistant') {
            const msgUuid = streamMsg.uuid;
            if (msgUuid && lastAssistantUuid && msgUuid !== lastAssistantUuid) {
              if (response.trim()) {
                await finalizeMessage();
              }
              sawNonAssistantSinceLastUuid = false;
            } else if (msgUuid && !lastAssistantUuid) {
              sawNonAssistantSinceLastUuid = false;
            }
            lastAssistantUuid = msgUuid || lastAssistantUuid;
            response += streamMsg.content || '';

            // Live-edit streaming
            const canEdit = adapter.supportsEditing?.() ?? true;
            const trimmed = response.trim();
            const mayBeHidden = '<no-reply/>'.startsWith(trimmed)
              || '<actions>'.startsWith(trimmed)
              || (trimmed.startsWith('<actions') && !trimmed.includes('</actions>'));
            const streamText = stripActionsBlock(response).trim();
            if (canEdit && !mayBeHidden && !suppressDelivery && streamText.length > 0 && Date.now() - lastUpdate > 500) {
              try {
                const prefixedStream = this.prefixResponse(streamText);
                if (messageId) {
                  await adapter.editMessage(msg.chatId, messageId, prefixedStream);
                } else {
                  const result = await adapter.sendMessage({ chatId: msg.chatId, text: prefixedStream, threadId: msg.threadId });
                  messageId = result.messageId;
                  sentAnyMessage = true;
                }
              } catch {
                // Streaming edit failed — will send as final message
              }
              lastUpdate = Date.now();
            }
          }

          if (streamMsg.type === 'result') {
            const resultText = typeof streamMsg.result === 'string' ? streamMsg.result : '';
            // Only use resultText as fallback when we haven't already streamed content.
            // Letta concatenates all assistant messages into one result string, which
            // would overwrite the current (correct) response buffer and cause duplicates
            // when multi-turn responses have already been finalized and sent.
            if (resultText.trim().length > 0 && !sentAnyMessage && !response.trim()) {
              response = resultText;
            }
            const hasResponse = response.trim().length > 0;
            const isTerminalError = streamMsg.success === false || !!streamMsg.error;

            // Retry on empty/error result
            const nothingDelivered = !hasResponse && !sentAnyMessage;
            if ((streamMsg.success && resultText === '' && nothingDelivered) || (isTerminalError && nothingDelivered)) {
              if (!retried && user.conversationId) {
                this.invalidateSession(user.chatId);
                session = null;
                clearInterval(typingInterval);
                const convResult = await recoverOrphanedConversationApproval(user.agentId, user.conversationId);
                if (convResult.recovered) {
                  return this.processMessage(msg, adapter, true);
                }
                if (isTerminalError) {
                  return this.processMessage(msg, adapter, true);
                }
              }
            }

            if (isTerminalError && !hasResponse && !sentAnyMessage) {
              response = `(Agent run failed: ${streamMsg.error || 'unknown error'}. Try again.)`;
            }
            break;
          }
        }
      } finally {
        clearInterval(typingInterval);
        adapter.stopTypingIndicator?.(msg.chatId)?.catch(() => {});
      }

      // Handle no-reply
      if (response.trim() === '<no-reply/>') {
        sentAnyMessage = true;
        response = '';
      }

      // Parse directives
      if (response.trim()) {
        const { cleanText, directives } = parseDirectives(response);
        response = cleanText;
        if (await this.executeDirectives(directives, adapter, msg.chatId, msg.messageId)) {
          sentAnyMessage = true;
        }
      }

      // Listening mode suppression
      if (suppressDelivery) {
        console.log(`[MultiTenantBot] Listening mode for ${msg.chatId} (response suppressed)`);
        return;
      }

      // Send final response
      if (response.trim()) {
        const prefixedFinal = this.prefixResponse(response);
        try {
          if (messageId) {
            await adapter.editMessage(msg.chatId, messageId, prefixedFinal);
          } else {
            await adapter.sendMessage({ chatId: msg.chatId, text: prefixedFinal, threadId: msg.threadId });
          }
          sentAnyMessage = true;
        } catch {
          try {
            await adapter.sendMessage({ chatId: msg.chatId, text: prefixedFinal, threadId: msg.threadId });
            sentAnyMessage = true;
          } catch (retryError) {
            console.error('[MultiTenantBot] Retry send also failed:', retryError);
          }
        }
      }

      // Handle no response
      if (!sentAnyMessage) {
        if (!receivedAnyData) {
          await adapter.sendMessage({ chatId: msg.chatId, text: '(Session interrupted. Try again.)', threadId: msg.threadId });
        }
      }

      // Notify listeners that a conversation completed (e.g., Narrator scheduler)
      try { this.onConversationComplete?.(); } catch { /* non-critical */ }

    } catch (error) {
      console.error(`[MultiTenantBot] Error for ${msg.chatId}:`, error);
      try {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          threadId: msg.threadId,
        });
      } catch {
        // Failed to send error message
      }
    }
  }

  // =========================================================================
  // sendToAgent — for heartbeat / cron / API
  // =========================================================================

  async sendToAgent(text: string, context?: TriggerContext): Promise<string> {
    const targetChatId = context?.targetChatId;
    if (!targetChatId) {
      throw new Error('Multi-tenant sendToAgent requires targetChatId in context');
    }

    const user = await this.registry.resolve(targetChatId);

    // Acquire per-user lock
    while (this.processingUsers.has(targetChatId)) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    this.processingUsers.add(targetChatId);

    try {
      const { stream } = await this.runSession(text, user);
      let response = '';
      for await (const msg of stream()) {
        if (msg.type === 'tool_call') this.syncTodoToolCall(msg, user);
        if (msg.type === 'assistant') response += msg.content || '';
        if (msg.type === 'result') {
          if (msg.success === false || msg.error) {
            throw new Error(`Agent run failed: ${msg.error || 'error'}`);
          }
          break;
        }
      }
      return response;
    } catch (error) {
      this.invalidateSession(targetChatId);
      throw error;
    } finally {
      this.processingUsers.delete(targetChatId);
    }
  }

  async *streamToAgent(text: string, context?: TriggerContext): AsyncGenerator<StreamMsg> {
    const targetChatId = context?.targetChatId;
    if (!targetChatId) {
      throw new Error('Multi-tenant streamToAgent requires targetChatId in context');
    }

    const user = await this.registry.resolve(targetChatId);
    while (this.processingUsers.has(targetChatId)) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    this.processingUsers.add(targetChatId);

    try {
      const { stream } = await this.runSession(text, user);
      yield* stream();
    } catch (error) {
      this.invalidateSession(targetChatId);
      throw error;
    } finally {
      this.processingUsers.delete(targetChatId);
    }
  }

  // =========================================================================
  // Channel delivery + status
  // =========================================================================

  async deliverToChannel(
    channelId: string,
    chatId: string,
    options: { text?: string; filePath?: string; kind?: 'image' | 'file' },
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
      const result = await adapter.sendMessage({ chatId, text: this.prefixResponse(options.text) });
      return result.messageId;
    }

    throw new Error('Either text or filePath must be provided');
  }

  getStatus(): { agentId: string | null; conversationId: string | null; channels: string[] } {
    return {
      agentId: null, // Multi-tenant: no single agent
      conversationId: null,
      channels: Array.from(this.channels.keys()),
    };
  }

  setAgentId(_agentId: string): void {
    console.warn('[MultiTenantBot] setAgentId ignored in multi-tenant mode');
  }

  reset(): void {
    console.warn('[MultiTenantBot] reset() clears all sessions');
    for (const [chatId] of this.sessions) {
      this.invalidateSession(chatId);
    }
  }

  getLastMessageTarget(): { channel: string; chatId: string } | null {
    // Return the most recently active user's target
    let latest: UserRecord | null = null;
    for (const user of this.registry.listAll()) {
      if (!latest || user.lastActiveAt > latest.lastActiveAt) {
        latest = user;
      }
    }
    return latest?.lastMessageTarget || null;
  }

  getLastUserMessageTime(): Date | null {
    let latest: Date | null = null;
    for (const time of this.lastUserMessageTimes.values()) {
      if (!latest || time > latest) latest = time;
    }
    return latest;
  }
}
