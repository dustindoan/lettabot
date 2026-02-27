/**
 * ClientToolExecutor — Layer 3
 *
 * Registry of client-side tools (e.g., manage_todo). Handles the
 * approval loop: when the Letta server pauses for client tool execution,
 * this layer runs the tool locally and sends results back.
 *
 * Protocol:
 *   1. Stream yields events until stop_reason: 'requires_approval'
 *   2. Executor runs the tool via tool.execute()
 *   3. Sends approval response with tool return via transport
 *   4. Gets continuation stream, repeats until stop_reason: 'end_turn'
 */

import type { LettaStreamingResponse } from '@letta-ai/letta-client/resources/agents/messages';
import type { AnyAgentTool, ClientToolDef, CanUseToolCallback, StreamMsg } from './types.js';
import type { LettaTransport } from './transport.js';
import { adaptEvent } from './stream-adapter.js';

/** Maximum tool executions per message to prevent infinite loops. */
const MAX_TOOL_LOOP_COUNT = 50;

export class ClientToolExecutor {
  private tools: Map<string, AnyAgentTool>;
  private canUseTool?: CanUseToolCallback;

  constructor(tools: AnyAgentTool[], canUseTool?: CanUseToolCallback) {
    this.tools = new Map();
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
    this.canUseTool = canUseTool;
  }

  /** Check if a tool name is a registered client tool. */
  isClientTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /** Get tool definitions for the transport's client_tools param. */
  getClientToolDefs(): ClientToolDef[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    }));
  }

  /**
   * Execute a single tool call. Handles canUseTool callback for permission gating.
   * Returns a ToolReturn-compatible object for sending back to the server.
   */
  private async executeToolCall(
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<{
    tool_call_id: string;
    tool_return: string;
    status: 'success' | 'error';
    type: 'tool';
  }> {
    // Check permission via canUseTool callback
    let effectiveInput = toolInput;
    if (this.canUseTool) {
      try {
        const result = await this.canUseTool(toolName, toolInput);
        if (result.behavior === 'deny') {
          return {
            tool_call_id: toolCallId,
            tool_return: `Tool denied: ${result.message || 'Permission denied'}`,
            status: 'error',
            type: 'tool',
          };
        }
        if (result.updatedInput) {
          effectiveInput = result.updatedInput;
        }
      } catch (err) {
        return {
          tool_call_id: toolCallId,
          tool_return: `Permission check error: ${err instanceof Error ? err.message : String(err)}`,
          status: 'error',
          type: 'tool',
        };
      }
    }

    // Execute the tool
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        tool_call_id: toolCallId,
        tool_return: `Unknown client tool: ${toolName}`,
        status: 'error',
        type: 'tool',
      };
    }

    try {
      const result = await tool.execute(toolCallId, effectiveInput);
      // Extract text from AgentToolResult content array
      let resultStr: string;
      if (result && typeof result === 'object' && 'content' in result && Array.isArray(result.content)) {
        const textParts = result.content
          .filter((c: { type?: string }) => c.type === 'text')
          .map((c: { text?: string }) => c.text || '');
        resultStr = textParts.join('') || JSON.stringify(result);
      } else if (typeof result === 'string') {
        resultStr = result;
      } else {
        resultStr = JSON.stringify(result);
      }
      return {
        tool_call_id: toolCallId,
        tool_return: resultStr,
        status: 'success',
        type: 'tool',
      };
    } catch (err) {
      return {
        tool_call_id: toolCallId,
        tool_return: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        type: 'tool',
      };
    }
  }

  /**
   * Process a stream with automatic client tool execution.
   *
   * Yields StreamMsg events to consumers. When the stream stops for
   * 'requires_approval' with a client tool, executes the tool locally,
   * sends the result back, and continues with the continuation stream.
   *
   * This transparently handles the pause-execute-resume loop.
   */
  async *processWithToolLoop(
    transport: LettaTransport,
    conversationId: string,
    initialStream: AsyncIterable<LettaStreamingResponse>,
  ): AsyncGenerator<StreamMsg> {
    let currentStream = initialStream;
    let toolCallCount = 0;
    let lastAssistantContent = '';
    const startTime = Date.now();

    // Pending approval info collected during stream
    let pendingApprovals: Array<{
      toolCallId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
    }> = [];

    while (true) {
      let stopReason: string | null = null;

      for await (const event of currentStream) {
        const msg = adaptEvent(event);
        if (!msg) continue;

        // Track approvals
        if (msg.type === 'approval_request') {
          if (msg.toolCallId && msg.toolName) {
            pendingApprovals.push({
              toolCallId: msg.toolCallId,
              toolName: msg.toolName,
              toolInput: (msg.toolInput as Record<string, unknown>) || {},
            });
          }
          // Don't yield approval_request to consumers — handled internally
          continue;
        }

        // Accumulate assistant content for the final result
        if (msg.type === 'assistant') {
          lastAssistantContent += msg.content || '';
        }

        // Track stop reason
        if (msg.type === 'result') {
          stopReason = msg.stopReason || null;

          // For terminal stop reasons, emit to consumer
          if (stopReason !== 'requires_approval') {
            // Enrich the result message
            msg.result = msg.result || lastAssistantContent;
            msg.durationMs = Date.now() - startTime;
            msg.conversationId = conversationId;
            yield msg;
            return; // Stream complete
          }

          // requires_approval — don't yield yet, handle below
          continue;
        }

        // Yield all other messages (assistant, tool_call, tool_result, reasoning) to consumer
        yield msg;
      }

      // Stream ended — check if we need to handle approvals
      if (stopReason === 'requires_approval' && pendingApprovals.length > 0) {
        // Check tool loop limit
        toolCallCount += pendingApprovals.length;
        if (toolCallCount > MAX_TOOL_LOOP_COUNT) {
          yield {
            type: 'result',
            success: false,
            error: `Tool loop detected: ${toolCallCount} tool calls exceeded limit of ${MAX_TOOL_LOOP_COUNT}`,
            stopReason: 'tool_loop',
            result: lastAssistantContent,
            durationMs: Date.now() - startTime,
            conversationId,
          };
          return;
        }

        // Execute all pending tool calls
        const approvalResults = [];
        for (const pending of pendingApprovals) {
          const result = await this.executeToolCall(
            pending.toolCallId,
            pending.toolName,
            pending.toolInput,
          );
          approvalResults.push(result);

          // Yield tool_result to consumer for visibility
          yield {
            type: 'tool_result',
            toolCallId: pending.toolCallId,
            content: result.tool_return,
            isError: result.status === 'error',
          };
        }

        // Send results back to server and get continuation stream
        pendingApprovals = [];
        try {
          currentStream = await transport.sendApprovalResponse(conversationId, approvalResults);
        } catch (err) {
          yield {
            type: 'result',
            success: false,
            error: `Failed to send tool results: ${err instanceof Error ? err.message : String(err)}`,
            stopReason: 'error',
            result: lastAssistantContent,
            durationMs: Date.now() - startTime,
            conversationId,
          };
          return;
        }

        // Continue the loop with the new stream
        continue;
      }

      // Stream ended without a result/stop_reason — unexpected
      yield {
        type: 'result',
        success: false,
        error: 'Stream ended unexpectedly without a stop reason',
        stopReason: 'error',
        result: lastAssistantContent,
        durationMs: Date.now() - startTime,
        conversationId,
      };
      return;
    }
  }
}
