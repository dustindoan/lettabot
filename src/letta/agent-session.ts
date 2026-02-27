/**
 * AgentSession — Layer 4
 *
 * Composes Transport + StreamAdapter + ClientToolExecutor into the same
 * send()/stream()/close()/abort() interface that bot.ts and
 * multi-tenant-bot.ts consume.
 *
 * Drop-in replacement for @letta-ai/letta-code-sdk Session.
 */

import type { Stream } from '@letta-ai/letta-client/core/streaming';
import type { LettaStreamingResponse } from '@letta-ai/letta-client/resources/agents/messages';
import { LettaTransport } from './transport.js';
import { ClientToolExecutor } from './client-tool-executor.js';
import type {
  StreamMsg,
  SendMessage,
  SessionOptions,
  TransportOptions,
  InitResult,
  MessageContentItem,
} from './types.js';

export class AgentSession {
  private transport: LettaTransport;
  private toolExecutor: ClientToolExecutor;
  private options: SessionOptions;
  private _agentId: string | null;
  private _conversationId: string | null;
  private pendingStream: Stream<LettaStreamingResponse> | null = null;
  private initialized = false;

  constructor(
    agentId: string,
    transportOpts: TransportOptions,
    sessionOpts: SessionOptions,
    conversationId?: string,
  ) {
    this._agentId = agentId || null;
    this._conversationId = conversationId || null;
    this.options = sessionOpts;
    this.transport = new LettaTransport(transportOpts);
    this.toolExecutor = new ClientToolExecutor(
      sessionOpts.tools || [],
      sessionOpts.canUseTool,
    );
  }

  /**
   * Initialize the session. Creates a conversation if needed.
   * Near-instant compared to the subprocess spawn of letta-code-sdk.
   */
  async initialize(): Promise<InitResult> {
    if (this.initialized) {
      return {
        type: 'init',
        agentId: this._agentId,
        conversationId: this._conversationId,
      };
    }

    // If we don't have a conversation, create one
    if (!this._conversationId && this._agentId) {
      this._conversationId = await this.transport.createConversation(this._agentId);
    }

    this.initialized = true;

    return {
      type: 'init',
      agentId: this._agentId,
      conversationId: this._conversationId,
    };
  }

  /**
   * Send a message to the agent. Prepares the stream but does not consume it.
   * Call stream() to iterate over the response.
   */
  async send(message: SendMessage): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this._conversationId) {
      throw new Error('No conversation ID — call initialize() first');
    }

    // Normalize the message for the transport
    let input: string | MessageContentItem[];
    if (typeof message === 'string') {
      input = message;
    } else {
      input = message;
    }

    // Get client tool definitions for the request
    const clientTools = this.toolExecutor.getClientToolDefs();

    this.pendingStream = await this.transport.sendMessage(
      this._conversationId,
      input,
      clientTools.length > 0 ? clientTools : undefined,
    );
  }

  /**
   * Consume the stream from the last send().
   * Yields StreamMsg events. Handles client tool execution transparently.
   */
  async *stream(): AsyncGenerator<StreamMsg> {
    if (!this.pendingStream) {
      throw new Error('No pending stream — call send() first');
    }

    if (!this._conversationId) {
      throw new Error('No conversation ID');
    }

    const rawStream = this.pendingStream;
    this.pendingStream = null;

    // Pipe through the tool executor which handles the approval loop
    yield* this.toolExecutor.processWithToolLoop(
      this.transport,
      this._conversationId,
      rawStream,
    );
  }

  /**
   * Close the session. Clears internal state.
   * No subprocess to kill — this is lightweight.
   */
  close(): void {
    this.pendingStream = null;
    this.initialized = false;
  }

  /**
   * Abort the current run. Cancels active runs on the conversation.
   */
  async abort(): Promise<void> {
    if (this._conversationId) {
      await this.transport.cancelRuns(this._conversationId);
    }
    this.pendingStream = null;
  }

  get agentId(): string | null {
    return this._agentId;
  }

  get conversationId(): string | null {
    return this._conversationId;
  }
}
