/**
 * LettaTransport — Layer 1
 *
 * Wraps @letta-ai/letta-client for HTTP I/O. One transport per user
 * (for user_id header scoping). Expo-compatible (pure fetch).
 *
 * Responsibilities:
 *   - Create/manage Letta client with per-user headers
 *   - Create conversations
 *   - Send messages and return raw SSE streams
 *   - Send approval/tool-return responses
 *   - Cancel runs
 */

import { Letta } from '@letta-ai/letta-client';
import type { Stream } from '@letta-ai/letta-client/core/streaming';
import type { LettaStreamingResponse, ApprovalCreate, ToolReturn as LettaToolReturn } from '@letta-ai/letta-client/resources/agents/messages';
import type { TransportOptions, ClientToolDef, MessageContentItem } from './types.js';

const DEFAULT_BASE_URL = process.env.LETTA_BASE_URL || 'http://localhost:8283';

export class LettaTransport {
  private client: Letta;

  constructor(options: TransportOptions = {}) {
    const baseURL = options.baseURL || DEFAULT_BASE_URL;
    const apiKey = options.apiKey || process.env.LETTA_API_KEY || '';
    const headers: Record<string, string> = { 'X-Letta-Source': 'lettabot' };
    if (options.userId) {
      headers['user_id'] = options.userId;
    }
    this.client = new Letta({ apiKey, baseURL, defaultHeaders: headers });
  }

  /**
   * Create a new conversation for an agent. Returns the conversation ID.
   */
  async createConversation(agentId: string): Promise<string> {
    const conversation = await this.client.conversations.create({ agent_id: agentId });
    return conversation.id;
  }

  /**
   * Send a user message and return the raw SSE stream.
   *
   * The stream yields LettaStreamingResponse events until the run completes
   * (stop_reason event) or errors.
   */
  async sendMessage(
    conversationId: string,
    input: string | MessageContentItem[],
    clientTools?: ClientToolDef[],
  ): Promise<Stream<LettaStreamingResponse>> {
    // Normalize multimodal input for the API
    const normalizedInput = typeof input === 'string'
      ? input
      : input.map(item => {
          if (item.type === 'text') {
            return { type: 'text' as const, text: item.text };
          }
          // Image content: map to Letta's ImageContent format
          return {
            type: 'image' as const,
            source: {
              type: item.source.type,
              media_type: item.source.mediaType,
              data: item.source.data,
            },
          };
        });

    return this.client.conversations.messages.create(conversationId, {
      input: normalizedInput as Parameters<typeof this.client.conversations.messages.create>[1]['input'],
      streaming: true,
      stream_tokens: true,
      background: true,
      include_pings: true,
      client_tools: clientTools?.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })) ?? undefined,
    });
  }

  /**
   * Send approval responses (tool execution results) and return the continuation stream.
   *
   * After executing client-side tools, send the results back so the server
   * can resume the agent's run.
   */
  async sendApprovalResponse(
    conversationId: string,
    approvals: Array<LettaToolReturn | { approve: boolean; tool_call_id: string; reason?: string; type?: 'approval' }>,
  ): Promise<Stream<LettaStreamingResponse>> {
    const approvalMessage: ApprovalCreate = {
      type: 'approval',
      approvals: approvals as ApprovalCreate['approvals'],
    };

    return this.client.conversations.messages.create(conversationId, {
      messages: [approvalMessage],
      streaming: true,
      stream_tokens: true,
      background: true,
      include_pings: true,
    });
  }

  /**
   * Resume/reconnect to an active background stream.
   * Used for recovery after network interruptions.
   */
  async resumeStream(
    conversationId: string,
    afterSeqId?: number,
  ): Promise<Stream<LettaStreamingResponse>> {
    return this.client.conversations.messages.stream(conversationId, {
      starting_after: afterSeqId,
      include_pings: true,
    });
  }

  /**
   * Cancel all runs on a conversation.
   * Note: Requires Redis on the server for canceling active runs.
   */
  async cancelRuns(conversationId: string): Promise<void> {
    try {
      await this.client.conversations.cancel(conversationId);
    } catch (err) {
      // Swallow if conversation doesn't exist or no active runs
      console.warn(`[LettaTransport] Failed to cancel runs on ${conversationId}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Access the underlying Letta client for admin operations
   * (agent creation, tool management, etc.)
   */
  get rawClient(): Letta {
    return this.client;
  }
}
