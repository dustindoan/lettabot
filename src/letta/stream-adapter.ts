/**
 * StreamAdapter — Layer 2
 *
 * Stateless transform from Letta server streaming events (LettaStreamingResponse)
 * to app-level StreamMsg types. Pure functions, no side effects.
 */

import type { LettaStreamingResponse } from '@letta-ai/letta-client/resources/agents/messages';
import type { StreamMsg } from './types.js';

/**
 * Extract the text content from an AssistantMessage's content field.
 * The content can be a string or an array of content parts.
 */
function extractAssistantContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Extract text parts from the content union array
    return content
      .filter((part: { type?: string }) => part.type === 'text' || !part.type)
      .map((part: { text?: string }) => part.text || '')
      .join('');
  }
  return '';
}

/**
 * Extract tool call info from a ToolCallMessage.
 * Handles both the deprecated `tool_call` field and the new `tool_calls` array.
 */
function extractToolCall(event: Record<string, unknown>): {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
} | null {
  // Try tool_calls array first (newer API)
  const toolCalls = event.tool_calls as Array<{ tool_call_id: string; name: string; arguments: string }> | undefined;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const tc = toolCalls[0];
    return {
      toolCallId: tc.tool_call_id,
      toolName: tc.name,
      toolInput: safeParseJson(tc.arguments),
    };
  }

  // Fall back to deprecated tool_call field
  const toolCall = event.tool_call as { tool_call_id?: string; name?: string; arguments?: string } | undefined;
  if (toolCall?.tool_call_id && toolCall?.name) {
    return {
      toolCallId: toolCall.tool_call_id,
      toolName: toolCall.name,
      toolInput: safeParseJson(toolCall.arguments || '{}'),
    };
  }

  return null;
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Convert a single LettaStreamingResponse event to a StreamMsg (or null to skip).
 */
export function adaptEvent(event: LettaStreamingResponse): StreamMsg | null {
  // Discriminate on message_type
  const messageType = (event as { message_type?: string }).message_type;

  switch (messageType) {
    case 'assistant_message': {
      const e = event as { id: string; content: unknown };
      const content = extractAssistantContent(e.content);
      return { type: 'assistant', content, uuid: e.id };
    }

    case 'tool_call_message': {
      const tc = extractToolCall(event as Record<string, unknown>);
      if (!tc) return null;
      return {
        type: 'tool_call',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        toolInput: tc.toolInput,
      };
    }

    case 'tool_return_message': {
      const e = event as { tool_call_id: string; tool_return: string; status: string };
      return {
        type: 'tool_result',
        toolCallId: e.tool_call_id,
        content: typeof e.tool_return === 'string' ? e.tool_return : JSON.stringify(e.tool_return),
        isError: e.status === 'error',
      };
    }

    case 'reasoning_message': {
      const e = event as { reasoning: string };
      return { type: 'reasoning', content: e.reasoning || '' };
    }

    case 'hidden_reasoning_message': {
      // Skip hidden reasoning — not exposed to consumers
      return null;
    }

    case 'approval_request_message': {
      // Approval requests are handled by ClientToolExecutor (Layer 3).
      // Pass through so the executor can intercept them.
      const e = event as Record<string, unknown>;
      const tc = extractToolCall(e);
      return {
        type: 'approval_request',
        toolCallId: tc?.toolCallId,
        toolName: tc?.toolName,
        toolInput: tc?.toolInput,
      };
    }

    case 'approval_response_message': {
      // Skip — these are server-side confirmations of our approval responses
      return null;
    }

    case 'stop_reason': {
      const e = event as { stop_reason: string };
      const stopReason = e.stop_reason;
      const success = stopReason === 'end_turn';
      return {
        type: 'result',
        success,
        stopReason,
        result: '', // Will be populated by AgentSession from accumulated assistant content
      };
    }

    case 'error_message': {
      const e = event as { message: string; detail?: string; error_type?: string };
      return {
        type: 'result',
        success: false,
        error: e.message || e.detail || 'Unknown error',
        stopReason: 'error',
        result: '',
      };
    }

    case 'usage_statistics': {
      // Log for diagnostics but don't yield to consumers
      const e = event as { step_count?: number; total_tokens?: number };
      if (process.env.DEBUG_LETTA) {
        console.log(`[StreamAdapter] Usage: steps=${e.step_count} tokens=${e.total_tokens}`);
      }
      return null;
    }

    case 'ping': {
      // Keepalive — skip
      return null;
    }

    case 'system_message':
    case 'user_message': {
      // Echo-back messages from the server — skip
      return null;
    }

    default: {
      // Unknown message type — skip with debug log
      if (process.env.DEBUG_LETTA) {
        console.log(`[StreamAdapter] Unknown message_type: ${messageType}`);
      }
      return null;
    }
  }
}

/**
 * Wraps a raw Stream<LettaStreamingResponse> and yields StreamMsg events.
 * Tracks run_id and seq_id for resume support.
 */
export async function* adaptStream(
  rawStream: AsyncIterable<LettaStreamingResponse>,
  conversationId?: string,
): AsyncGenerator<StreamMsg> {
  for await (const event of rawStream) {
    const msg = adaptEvent(event);
    if (msg) {
      // Inject conversationId into result messages
      if (msg.type === 'result' && conversationId) {
        msg.conversationId = conversationId;
      }
      yield msg;
    }
  }
}
