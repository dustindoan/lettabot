/**
 * Letta API Client
 *
 * Uses the official @letta-ai/letta-client SDK for all API interactions.
 */

import { Letta } from '@letta-ai/letta-client';

const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'https://api.letta.com';

function getClient(): Letta {
  const apiKey = process.env.LETTA_API_KEY;
  // Local servers may not require an API key
  return new Letta({ 
    apiKey: apiKey || '', 
    baseURL: LETTA_BASE_URL,
    defaultHeaders: { "X-Letta-Source": "lettabot" },
  });
}

/**
 * Test connection to Letta server (silent, no error logging)
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = getClient();
    // Use a simple endpoint that doesn't have pagination issues
    await client.agents.list({ limit: 1 });
    return true;
  } catch {
    return false;
  }
}

// Re-export types that callers use
export type LettaTool = Awaited<ReturnType<Letta['tools']['upsert']>>;

/**
 * Upsert a tool to the Letta API
 */
export async function upsertTool(params: {
  source_code: string;
  description?: string;
  tags?: string[];
}): Promise<LettaTool> {
  const client = getClient();
  return client.tools.upsert({
    source_code: params.source_code,
    description: params.description,
    tags: params.tags,
  });
}

/**
 * List all tools
 */
export async function listTools(): Promise<LettaTool[]> {
  const client = getClient();
  const page = await client.tools.list();
  const tools: LettaTool[] = [];
  for await (const tool of page) {
    tools.push(tool);
  }
  return tools;
}

/**
 * Get a tool by name
 */
export async function getToolByName(name: string): Promise<LettaTool | null> {
  try {
    const client = getClient();
    const page = await client.tools.list({ name });
    for await (const tool of page) {
      if (tool.name === name) return tool;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Add a tool to an agent
 */
export async function addToolToAgent(agentId: string, toolId: string): Promise<void> {
  const client = getClient();
  await client.agents.tools.attach(toolId, { agent_id: agentId });
}

/**
 * Check if an agent exists
 */
export async function agentExists(agentId: string): Promise<boolean> {
  try {
    const client = getClient();
    await client.agents.retrieve(agentId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get an agent's current model handle
 */
export async function getAgentModel(agentId: string): Promise<string | null> {
  try {
    const client = getClient();
    const agent = await client.agents.retrieve(agentId);
    return agent.model ?? null;
  } catch (e) {
    console.error('[Letta API] Failed to get agent model:', e);
    return null;
  }
}

/**
 * Update an agent's model
 */
export async function updateAgentModel(agentId: string, model: string): Promise<boolean> {
  try {
    const client = getClient();
    await client.agents.update(agentId, { model });
    return true;
  } catch (e) {
    console.error('[Letta API] Failed to update agent model:', e);
    return false;
  }
}

/**
 * Update an agent's name
 */
export async function updateAgentName(agentId: string, name: string): Promise<boolean> {
  try {
    const client = getClient();
    await client.agents.update(agentId, { name });
    return true;
  } catch (e) {
    console.error('[Letta API] Failed to update agent name:', e);
    return false;
  }
}

/**
 * List available models
 */
export async function listModels(options?: { providerName?: string; providerCategory?: 'base' | 'byok' }): Promise<Array<{ handle: string; name: string; display_name?: string; tier?: string }>> {
  try {
    const client = getClient();
    const params: Record<string, unknown> = {};
    if (options?.providerName) params.provider_name = options.providerName;
    if (options?.providerCategory) params.provider_category = [options.providerCategory];
    const page = await client.models.list(Object.keys(params).length > 0 ? params : undefined);
    const models: Array<{ handle: string; name: string; display_name?: string; tier?: string }> = [];
    for await (const model of page) {
      if (model.handle && model.name) {
        models.push({ 
          handle: model.handle, 
          name: model.name,
          display_name: model.display_name ?? undefined,
          tier: (model as { tier?: string }).tier ?? undefined,
        });
      }
    }
    return models;
  } catch (e) {
    console.error('[Letta API] Failed to list models:', e);
    return [];
  }
}

/**
 * Get the most recent run time for an agent
 */
export async function getLastRunTime(agentId: string): Promise<Date | null> {
  try {
    const client = getClient();
    const page = await client.runs.list({ agent_id: agentId, limit: 1 });
    for await (const run of page) {
      if (run.created_at) {
        return new Date(run.created_at);
      }
    }
    return null;
  } catch (e) {
    console.error('[Letta API] Failed to get last run time:', e);
    return null;
  }
}

/**
 * List agents, optionally filtered by name search
 */
export async function listAgents(query?: string): Promise<Array<{ id: string; name: string; description?: string | null; created_at?: string | null }>> {
  try {
    const client = getClient();
    const page = await client.agents.list({ query_text: query, limit: 50 });
    const agents: Array<{ id: string; name: string; description?: string | null; created_at?: string | null }> = [];
    for await (const agent of page) {
      agents.push({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        created_at: agent.created_at,
      });
    }
    return agents;
  } catch (e) {
    console.error('[Letta API] Failed to list agents:', e);
    return [];
  }
}

/**
 * Find an agent by exact name match
 * Returns the most recently created agent if multiple match
 */
export async function findAgentByName(name: string): Promise<{ id: string; name: string } | null> {
  try {
    const client = getClient();
    const page = await client.agents.list({ query_text: name, limit: 50 });
    let bestMatch: { id: string; name: string; created_at?: string | null } | null = null;
    
    for await (const agent of page) {
      // Exact name match only
      if (agent.name === name) {
        // Keep the most recently created if multiple match
        if (!bestMatch || (agent.created_at && bestMatch.created_at && agent.created_at > bestMatch.created_at)) {
          bestMatch = { id: agent.id, name: agent.name, created_at: agent.created_at };
        }
      }
    }
    
    return bestMatch ? { id: bestMatch.id, name: bestMatch.name } : null;
  } catch (e) {
    console.error('[Letta API] Failed to find agent by name:', e);
    return null;
  }
}

// ============================================================================
// Tool Approval Management
// ============================================================================

export interface PendingApproval {
  runId: string;
  toolCallId: string;
  toolName: string;
  messageId: string;
}

/**
 * Check for pending approval requests on an agent's conversation.
 * Returns details of any tool calls waiting for approval.
 */
export async function getPendingApprovals(
  agentId: string,
  conversationId?: string
): Promise<PendingApproval[]> {
  try {
    const client = getClient();

    // Prefer agent-level pending approval to avoid scanning stale history.
    // IMPORTANT: Must include 'agent.pending_approval' or the field won't be returned.
    try {
      const agentState = await client.agents.retrieve(agentId, {
        include: ['agent.pending_approval'],
      });
      if ('pending_approval' in agentState) {
        const pending = agentState.pending_approval;
        if (!pending) {
          console.log('[Letta API] No pending approvals on agent');
          return [];
        }
        console.log(`[Letta API] Found pending approval: ${pending.id}, run_id=${pending.run_id}`);
        
        // Extract tool calls - handle both Array<ToolCall> and ToolCallDelta formats
        const rawToolCalls = pending.tool_calls;
        const toolCallsList: Array<{ tool_call_id: string; name: string }> = [];
        
        if (Array.isArray(rawToolCalls)) {
          for (const tc of rawToolCalls) {
            if (tc && 'tool_call_id' in tc && tc.tool_call_id) {
              toolCallsList.push({ tool_call_id: tc.tool_call_id, name: tc.name || 'unknown' });
            }
          }
        } else if (rawToolCalls && typeof rawToolCalls === 'object' && 'tool_call_id' in rawToolCalls && rawToolCalls.tool_call_id) {
          // ToolCallDelta case
          toolCallsList.push({ tool_call_id: rawToolCalls.tool_call_id, name: rawToolCalls.name || 'unknown' });
        }
        
        // Fallback to deprecated singular tool_call field
        if (toolCallsList.length === 0 && pending.tool_call) {
          const tc = pending.tool_call;
          if ('tool_call_id' in tc && tc.tool_call_id) {
            toolCallsList.push({ tool_call_id: tc.tool_call_id, name: tc.name || 'unknown' });
          }
        }
        
        const seen = new Set<string>();
        const approvals: PendingApproval[] = [];
        for (const tc of toolCallsList) {
          if (seen.has(tc.tool_call_id)) continue;
          seen.add(tc.tool_call_id);
          approvals.push({
            runId: pending.run_id || 'unknown',
            toolCallId: tc.tool_call_id,
            toolName: tc.name || 'unknown',
            messageId: pending.id,
          });
        }
        console.log(`[Letta API] Extracted ${approvals.length} pending approval(s): ${approvals.map(a => a.toolName).join(', ')}`);
        return approvals;
      }
    } catch (e) {
      console.warn('[Letta API] Failed to retrieve agent pending_approval, falling back to run scan:', e);
    }
    
    // First, check for runs with 'requires_approval' stop reason
    const runsPage = await client.runs.list({
      agent_id: agentId,
      conversation_id: conversationId,
      stop_reason: 'requires_approval',
      limit: 10,
    });
    
    const pendingApprovals: PendingApproval[] = [];
    
    for await (const run of runsPage) {
      if (run.status === 'running' || run.stop_reason === 'requires_approval') {
        // Get recent messages to find approval_request_message
        const messagesPage = await client.agents.messages.list(agentId, {
          conversation_id: conversationId,
          limit: 100,
        });
        
        const messages: Array<{ message_type?: string }> = [];
        for await (const msg of messagesPage) {
          messages.push(msg as { message_type?: string });
        }
        
        const resolvedToolCalls = new Set<string>();
        for (const msg of messages) {
          if ('message_type' in msg && msg.message_type === 'approval_response_message') {
            const approvalMsg = msg as {
              approvals?: Array<{ tool_call_id?: string | null }>;
            };
            const approvals = approvalMsg.approvals || [];
            for (const approval of approvals) {
              if (approval.tool_call_id) {
                resolvedToolCalls.add(approval.tool_call_id);
              }
            }
          }
        }
        
        const seenToolCalls = new Set<string>();
        for (const msg of messages) {
          // Check for approval_request_message type
          if ('message_type' in msg && msg.message_type === 'approval_request_message') {
            const approvalMsg = msg as {
              id: string;
              tool_calls?: Array<{ tool_call_id: string; name: string }>;
              tool_call?: { tool_call_id: string; name: string };
              run_id?: string;
            };
            
            // Extract tool call info
            const toolCalls = approvalMsg.tool_calls || (approvalMsg.tool_call ? [approvalMsg.tool_call] : []);
            for (const tc of toolCalls) {
              if (resolvedToolCalls.has(tc.tool_call_id)) {
                continue;
              }
              if (seenToolCalls.has(tc.tool_call_id)) {
                continue;
              }
              seenToolCalls.add(tc.tool_call_id);
              pendingApprovals.push({
                runId: approvalMsg.run_id || run.id,
                toolCallId: tc.tool_call_id,
                toolName: tc.name,
                messageId: approvalMsg.id,
              });
            }
          }
        }
      }
    }
    
    return pendingApprovals;
  } catch (e) {
    console.error('[Letta API] Failed to get pending approvals:', e);
    return [];
  }
}

/**
 * Reject a pending tool approval request.
 * Sends an approval response with approve: false.
 */
export async function rejectApproval(
  agentId: string,
  approval: {
    toolCallId: string;
    reason?: string;
  },
  conversationId?: string
): Promise<boolean> {
  try {
    const client = getClient();
    
    // Send approval response via messages.create
    await client.agents.messages.create(agentId, {
      messages: [{
        type: 'approval',
        approvals: [{
          approve: false,
          tool_call_id: approval.toolCallId,
          type: 'approval',
          reason: approval.reason || 'Session was interrupted - please retry your request',
        }],
      }],
      streaming: false,
    });
    
    console.log(`[Letta API] Rejected approval for tool call ${approval.toolCallId}`);
    return true;
  } catch (e) {
    const err = e as { status?: number; error?: { detail?: string } };
    const detail = err?.error?.detail || '';
    if (err?.status === 400 && detail.includes('No tool call is currently awaiting approval')) {
      console.warn(`[Letta API] Approval already resolved for tool call ${approval.toolCallId}`);
      return true;
    }
    console.error('[Letta API] Failed to reject approval:', e);
    return false;
  }
}

/**
 * Cancel active runs for an agent.
 * Optionally specify specific run IDs to cancel.
 * Note: Requires Redis on the server for canceling active runs.
 */
export async function cancelRuns(
  agentId: string,
  runIds?: string[]
): Promise<boolean> {
  try {
    const client = getClient();
    await client.agents.messages.cancel(agentId, {
      run_ids: runIds,
    });
    console.log(`[Letta API] Cancelled runs for agent ${agentId}${runIds ? ` (${runIds.join(', ')})` : ''}`);
    return true;
  } catch (e) {
    console.error('[Letta API] Failed to cancel runs:', e);
    return false;
  }
}

/**
 * Disable tool approval requirement for a specific tool on an agent.
 * This sets requires_approval: false at the server level.
 */
export async function disableToolApproval(
  agentId: string,
  toolName: string
): Promise<boolean> {
  try {
    const client = getClient();
    // Note: API expects 'requires_approval' but client types say 'body_requires_approval'
    // This is a bug in @letta-ai/letta-client - filed issue, using workaround
    await client.agents.tools.updateApproval(toolName, {
      agent_id: agentId,
      requires_approval: false,
    } as unknown as Parameters<typeof client.agents.tools.updateApproval>[1]);
    console.log(`[Letta API] Disabled approval requirement for tool ${toolName} on agent ${agentId}`);
    return true;
  } catch (e) {
    console.error(`[Letta API] Failed to disable tool approval for ${toolName}:`, e);
    return false;
  }
}

/**
 * Get tools attached to an agent with their approval settings.
 */
export async function getAgentTools(agentId: string): Promise<Array<{
  name: string;
  id: string;
  requiresApproval?: boolean;
}>> {
  try {
    const client = getClient();
    const toolsPage = await client.agents.tools.list(agentId);
    const tools: Array<{ name: string; id: string; requiresApproval?: boolean }> = [];
    
    for await (const tool of toolsPage) {
      tools.push({
        name: tool.name ?? 'unknown',
        id: tool.id,
        // Note: The API might not return this field directly on list
        // We may need to check each tool individually
        requiresApproval: (tool as { requires_approval?: boolean }).requires_approval,
      });
    }
    
    return tools;
  } catch (e) {
    console.error('[Letta API] Failed to get agent tools:', e);
    return [];
  }
}

/**
 * Ensure no tools on the agent require approval.
 * Call on startup to proactively prevent stuck approval states.
 */
export async function ensureNoToolApprovals(agentId: string): Promise<void> {
  try {
    const tools = await getAgentTools(agentId);
    const approvalTools = tools.filter(t => t.requiresApproval);
    if (approvalTools.length > 0) {
      console.log(`[Letta API] Found ${approvalTools.length} tool(s) requiring approval: ${approvalTools.map(t => t.name).join(', ')}`);
      console.log('[Letta API] Disabling tool approvals for headless operation...');
      await disableAllToolApprovals(agentId);
    }
  } catch (e) {
    console.warn('[Letta API] Failed to check/disable tool approvals:', e);
  }
}

/**
 * Disable approval requirement for ALL tools on an agent.
 * Useful for ensuring a headless deployment doesn't get stuck.
 */
/**
 * Recover from orphaned approval_request_messages by directly inspecting the conversation.
 * 
 * Unlike getPendingApprovals() which relies on agent.pending_approval or run stop_reason,
 * this function looks at the actual conversation messages to find unresolved approval requests
 * from terminated (failed/cancelled) runs.
 * 
 * Returns { recovered: true } if orphaned approvals were found and resolved.
 */
export async function recoverOrphanedConversationApproval(
  agentId: string,
  conversationId: string
): Promise<{ recovered: boolean; details: string }> {
  try {
    const client = getClient();
    
    // List recent messages from the conversation to find orphaned approvals
    const messagesPage = await client.conversations.messages.list(conversationId, { limit: 50 });
    const messages: Array<Record<string, unknown>> = [];
    for await (const msg of messagesPage) {
      messages.push(msg as unknown as Record<string, unknown>);
    }
    
    if (messages.length === 0) {
      return { recovered: false, details: 'No messages in conversation' };
    }
    
    // Build set of tool_call_ids that already have approval responses
    const resolvedToolCalls = new Set<string>();
    for (const msg of messages) {
      if (msg.message_type === 'approval_response_message') {
        const approvals = (msg.approvals as Array<{ tool_call_id?: string }>) || [];
        for (const a of approvals) {
          if (a.tool_call_id) resolvedToolCalls.add(a.tool_call_id);
        }
      }
    }
    
    // Find unresolved approval_request_messages
    interface UnresolvedApproval {
      toolCallId: string;
      toolName: string;
      runId: string;
    }
    const unresolvedByRun = new Map<string, UnresolvedApproval[]>();
    
    for (const msg of messages) {
      if (msg.message_type !== 'approval_request_message') continue;
      
      const toolCalls = (msg.tool_calls as Array<{ tool_call_id: string; name: string }>) 
        || (msg.tool_call ? [msg.tool_call as { tool_call_id: string; name: string }] : []);
      const runId = msg.run_id as string | undefined;
      
      for (const tc of toolCalls) {
        if (!tc.tool_call_id || resolvedToolCalls.has(tc.tool_call_id)) continue;
        
        const key = runId || 'unknown';
        if (!unresolvedByRun.has(key)) unresolvedByRun.set(key, []);
        unresolvedByRun.get(key)!.push({
          toolCallId: tc.tool_call_id,
          toolName: tc.name || 'unknown',
          runId: key,
        });
      }
    }
    
    if (unresolvedByRun.size === 0) {
      return { recovered: false, details: 'No unresolved approval requests found' };
    }
    
    // Check each run's status - only resolve orphaned approvals from terminated runs
    let recoveredCount = 0;
    const details: string[] = [];
    
    for (const [runId, approvals] of unresolvedByRun) {
      if (runId === 'unknown') {
        // No run_id on the approval message - can't verify, skip
        details.push(`Skipped ${approvals.length} approval(s) with no run_id`);
        continue;
      }
      
      try {
        const run = await client.runs.retrieve(runId);
        const status = run.status;
        const stopReason = run.stop_reason;
        const isTerminated = status === 'failed' || status === 'cancelled';
        const isAbandonedApproval = status === 'completed' && stopReason === 'requires_approval';
        // Active runs stuck on approval block the entire conversation.
        // No client is going to approve them -- reject and cancel so
        // lettabot can proceed.
        const isStuckApproval = status === 'running' && stopReason === 'requires_approval';
        
        if (isTerminated || isAbandonedApproval || isStuckApproval) {
          console.log(`[Letta API] Found ${approvals.length} blocking approval(s) from ${status}/${stopReason} run ${runId}`);
          
          // Send denial for each unresolved tool call
          const approvalResponses = approvals.map(a => ({
            approve: false as const,
            tool_call_id: a.toolCallId,
            type: 'approval' as const,
            reason: `Auto-denied: originating run was ${status}/${stopReason}`,
          }));
          
          await client.conversations.messages.create(conversationId, {
            messages: [{
              type: 'approval',
              approvals: approvalResponses,
            }],
            streaming: false,
          });
          
          // Cancel active stuck runs after rejecting their approvals
          let cancelled = false;
          if (isStuckApproval) {
            cancelled = await cancelRuns(agentId, [runId]);
            if (cancelled) {
              console.log(`[Letta API] Cancelled stuck run ${runId}`);
            } else {
              console.warn(`[Letta API] Failed to cancel stuck run ${runId}`);
            }
          }
          
          recoveredCount += approvals.length;
          const suffix = isStuckApproval ? (cancelled ? ' (cancelled)' : ' (cancel failed)') : '';
          details.push(`Denied ${approvals.length} approval(s) from ${status} run ${runId}${suffix}`);
        } else {
          details.push(`Run ${runId} is ${status}/${stopReason} - not orphaned`);
        }
      } catch (runError) {
        console.warn(`[Letta API] Failed to check run ${runId}:`, runError);
        details.push(`Failed to check run ${runId}`);
      }
    }
    
    const detailStr = details.join('; ');
    if (recoveredCount > 0) {
      console.log(`[Letta API] Recovered ${recoveredCount} orphaned approval(s): ${detailStr}`);
      return { recovered: true, details: detailStr };
    }
    
    return { recovered: false, details: detailStr };
  } catch (e) {
    console.error('[Letta API] Failed to recover orphaned conversation approval:', e);
    return { recovered: false, details: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ============================================================================
// Multi-Tenant Helpers
// ============================================================================

/**
 * Create a standalone block on the Letta server.
 * Used for shared blocks (persona, coaching philosophy) that are attached
 * by reference to multiple agents.
 */
export async function createBlock(params: {
  label: string;
  value: string;
  limit?: number;
  description?: string;
}): Promise<string> {
  const client = getClient();
  const block = await client.blocks.create({
    label: params.label,
    value: params.value,
    limit: params.limit,
    description: params.description,
  });
  return block.id;
}

/**
 * Compaction settings for context window summarization.
 * Passed to agent create/update calls.
 */
export interface CompactionConfig {
  model: string;                          // Required: provider/model-name
  mode?: 'all' | 'sliding_window';       // Default: sliding_window
  clip_chars?: number;                    // Default: 50000
  sliding_window_percentage?: number;     // Default: 0.3 (keep 70%, evict 30%)
  prompt?: string;
}

/**
 * Create a new agent with shared blocks (by reference) and per-user memory blocks.
 * Shared blocks are attached via block_ids — updating one updates all agents.
 * Per-user blocks are created as copies via memory_blocks.
 */
export async function createAgentWithBlocks(params: {
  name: string;
  system: string;
  model: string;
  blockIds: string[];
  memoryBlocks: Array<{ label: string; value: string; limit?: number; description?: string }>;
  compaction?: CompactionConfig;
  toolRules?: Array<{ tool_name: string; type?: string }>;
}): Promise<string> {
  const client = getClient();

  const createParams: Parameters<typeof client.agents.create>[0] = {
    name: params.name,
    system: params.system,
    model: params.model,
    block_ids: params.blockIds,
    memory_blocks: params.memoryBlocks.map(b => ({
      label: b.label,
      value: b.value,
      limit: b.limit,
      description: b.description,
    })),
    include_base_tools: true,
  };

  if (params.compaction) {
    createParams.compaction_settings = {
      model: params.compaction.model,
      mode: params.compaction.mode,
      clip_chars: params.compaction.clip_chars,
      sliding_window_percentage: params.compaction.sliding_window_percentage,
      prompt: params.compaction.prompt,
    };
  }

  if (params.toolRules && params.toolRules.length > 0) {
    createParams.tool_rules = params.toolRules as Parameters<typeof client.agents.create>[0]['tool_rules'];
  }

  const agent = await client.agents.create(createParams);
  return agent.id;
}

/**
 * Update compaction settings on an existing agent.
 */
export async function updateAgentCompaction(agentId: string, compaction: CompactionConfig): Promise<boolean> {
  try {
    const client = getClient();
    await client.agents.update(agentId, {
      compaction_settings: {
        model: compaction.model,
        mode: compaction.mode,
        clip_chars: compaction.clip_chars,
        sliding_window_percentage: compaction.sliding_window_percentage,
        prompt: compaction.prompt,
      },
    });
    console.log(`[Letta API] Updated compaction settings for agent ${agentId}`);
    return true;
  } catch (e) {
    console.error('[Letta API] Failed to update compaction settings:', e);
    return false;
  }
}

// ============================================================================
// MCP Server Management
// ============================================================================

export interface McpServerConfig {
  name: string;
  url: string;
  type?: 'sse' | 'streamable_http';  // default: streamable_http
  customHeaders?: Record<string, string>;  // e.g. { "X-User-Id": "{{ LETTA_USER_ID }}" }
}

/**
 * Register an MCP server with Letta (idempotent — skips if name already exists).
 * Returns the server ID and list of tool IDs from the server.
 */
export async function ensureMcpServer(config: McpServerConfig): Promise<{
  serverId: string;
  toolIds: string[];
  toolNames: string[];
}> {
  const client = getClient();

  // Check if already registered
  const existing = await client.mcpServers.list();
  const found = existing.find(s => s.server_name === config.name);
  if (found && found.id) {
    // Refresh tools to pick up any changes
    try { await client.mcpServers.refresh(found.id); } catch { /* ignore */ }
    const tools = await getMcpServerTools(found.id);
    console.log(`[Letta API] MCP server "${config.name}" already registered (${found.id}), ${tools.length} tool(s)`);
    return { serverId: found.id, toolIds: tools.map(t => t.id), toolNames: tools.map(t => t.name) };
  }

  // Register new server
  const serverType = config.type || 'streamable_http';

  const createConfig: Record<string, unknown> = {
    server_url: config.url,
    mcp_server_type: serverType,
  };
  if (config.customHeaders && Object.keys(config.customHeaders).length > 0) {
    createConfig.custom_headers = config.customHeaders;
  }

  const server = await client.mcpServers.create({
    server_name: config.name,
    config: createConfig as { server_url: string; mcp_server_type: 'sse' | 'streamable_http' },
  });

  const serverId = server.id || '';
  const tools = await getMcpServerTools(serverId);
  console.log(`[Letta API] Registered MCP server "${config.name}" (${serverId}), ${tools.length} tool(s)`);
  return { serverId, toolIds: tools.map(t => t.id), toolNames: tools.map(t => t.name) };
}

/**
 * Get tools from an MCP server.
 */
export async function getMcpServerTools(serverId: string): Promise<Array<{ id: string; name: string }>> {
  try {
    const client = getClient();
    const tools = await client.mcpServers.tools.list(serverId);
    return tools.map(t => ({ id: t.id, name: t.name ?? 'unknown' }));
  } catch (e) {
    console.error(`[Letta API] Failed to list MCP server tools:`, e);
    return [];
  }
}

/**
 * Filter MCP tool IDs/names by an allowlist or excludelist.
 *
 * - If `allowedTools` is provided, only tools whose name is in the list are kept.
 * - Else if `excludeTools` is provided, tools whose name is in the list are removed.
 * - If neither is provided, all tools are returned unchanged.
 */
export function filterMcpTools(
  toolIds: string[],
  toolNames: string[],
  allowedTools?: string[],
  excludeTools?: string[],
): { toolIds: string[]; toolNames: string[] } {
  const pairs = toolIds.map((id, i) => ({ id, name: toolNames[i] }));

  if (allowedTools && allowedTools.length > 0) {
    const allowed = new Set(allowedTools);
    const filtered = pairs.filter(p => allowed.has(p.name));
    const missing = allowedTools.filter(t => !pairs.some(p => p.name === t));
    if (missing.length > 0) {
      console.warn(`[MCP Filter] allowedTools not found on server: ${missing.join(', ')}`);
    }
    return { toolIds: filtered.map(p => p.id), toolNames: filtered.map(p => p.name) };
  }

  if (excludeTools && excludeTools.length > 0) {
    const excluded = new Set(excludeTools);
    const filtered = pairs.filter(p => !excluded.has(p.name));
    return { toolIds: filtered.map(p => p.id), toolNames: filtered.map(p => p.name) };
  }

  return { toolIds, toolNames };
}

/**
 * Attach multiple tools to an agent (idempotent — skips already-attached tools).
 */
export async function attachToolsToAgent(agentId: string, toolIds: string[]): Promise<number> {
  const client = getClient();
  const existingTools = await getAgentTools(agentId);
  const existingIds = new Set(existingTools.map(t => t.id));

  let attached = 0;
  for (const toolId of toolIds) {
    if (existingIds.has(toolId)) continue;
    try {
      await client.agents.tools.attach(toolId, { agent_id: agentId });
      attached++;
    } catch (e) {
      console.warn(`[Letta API] Failed to attach tool ${toolId} to agent ${agentId}:`, e);
    }
  }

  if (attached > 0) {
    console.log(`[Letta API] Attached ${attached} tool(s) to agent ${agentId}`);
  }
  return attached;
}

// ============================================================================
// User Management
// ============================================================================

const DEFAULT_ORG_ID = 'org-00000000-0000-4000-8000-000000000000';

/**
 * Create a Letta user for per-user MCP OAuth scoping.
 * Uses the REST API directly since the TS SDK doesn't expose the users endpoint.
 * Returns the new user's ID (e.g. "user-<uuid>").
 */
export async function createLettaUser(name: string): Promise<string> {
  const baseUrl = LETTA_BASE_URL.replace(/\/+$/, '');
  const apiKey = process.env.LETTA_API_KEY || '';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Letta-Source': 'lettabot',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(`${baseUrl}/v1/admin/users/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, organization_id: DEFAULT_ORG_ID }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create Letta user "${name}": ${resp.status} ${text}`);
  }

  const user = await resp.json() as { id: string };
  console.log(`[Letta API] Created Letta user "${name}" → ${user.id}`);
  return user.id;
}

/**
 * Delete a Letta agent permanently.
 * This removes the agent and all its conversations from the server.
 */
export async function deleteAgent(agentId: string): Promise<void> {
  const client = getClient();
  await client.agents.delete(agentId);
  console.log(`[Letta API] Deleted agent ${agentId}`);
}

/**
 * Delete a Letta user. Used when hard-deleting a social-self to clean up
 * the per-user OAuth scoping identity.
 * Uses the REST API directly since the TS SDK doesn't expose admin user deletion.
 */
export async function deleteLettaUser(userId: string): Promise<void> {
  const baseUrl = LETTA_BASE_URL.replace(/\/+$/, '');
  const apiKey = process.env.LETTA_API_KEY || '';

  const headers: Record<string, string> = {
    'X-Letta-Source': 'lettabot',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(`${baseUrl}/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to delete Letta user ${userId}: ${resp.status} ${text}`);
  }

  console.log(`[Letta API] Deleted Letta user ${userId}`);
}

/**
 * Set secrets (encrypted env vars) on an agent.
 * Used for per-agent identity (e.g., LETTA_USER_ID for MCP OAuth scoping).
 * Template variables like {{ LETTA_USER_ID }} in MCP server custom_headers
 * are resolved from these secrets at tool execution time.
 */
export async function setAgentSecrets(
  agentId: string,
  secrets: Record<string, string>,
): Promise<boolean> {
  try {
    const client = getClient();
    await client.agents.update(agentId, { secrets });
    console.log(`[Letta API] Set ${Object.keys(secrets).length} secret(s) on agent ${agentId}`);
    return true;
  } catch (e) {
    console.error(`[Letta API] Failed to set secrets on agent ${agentId}:`, e);
    return false;
  }
}

// ============================================================================
// Narrator / Block Management
// ============================================================================

export interface BlockInfo {
  id: string;
  label: string;
  value: string;
  limit: number;
  description?: string;
}

/**
 * Get a block by ID.
 */
export async function getBlock(blockId: string): Promise<BlockInfo> {
  const client = getClient();
  const block = await client.blocks.retrieve(blockId);
  return {
    id: block.id,
    label: block.label ?? '',
    value: block.value ?? '',
    limit: block.limit ?? 5000,
    description: block.description ?? undefined,
  };
}

/**
 * Update a block's value (and optionally description/limit).
 */
export async function updateBlock(blockId: string, updates: {
  value?: string;
  description?: string;
  limit?: number;
}): Promise<BlockInfo> {
  const client = getClient();
  const block = await client.blocks.update(blockId, updates);
  return {
    id: block.id,
    label: block.label ?? '',
    value: block.value ?? '',
    limit: block.limit ?? 5000,
    description: block.description ?? undefined,
  };
}

/**
 * List all core memory blocks for an agent.
 */
export async function listAgentCoreBlocks(agentId: string): Promise<BlockInfo[]> {
  const client = getClient();
  const page = await client.agents.blocks.list(agentId);
  const blocks: BlockInfo[] = [];
  for await (const block of page) {
    blocks.push({
      id: block.id,
      label: block.label ?? '',
      value: block.value ?? '',
      limit: block.limit ?? 5000,
      description: block.description ?? undefined,
    });
  }
  return blocks;
}

/**
 * Attach a block to an agent by ID (idempotent).
 */
export async function attachBlockToAgent(agentId: string, blockId: string): Promise<void> {
  const client = getClient();
  try {
    await client.agents.blocks.attach(blockId, { agent_id: agentId });
  } catch (e) {
    // Ignore if already attached
    const err = e as { status?: number };
    if (err.status !== 409) throw e;
  }
}

/**
 * Send a message to an agent (non-streaming). Returns the agent's text response.
 */
export async function sendAgentMessage(agentId: string, message: string): Promise<string> {
  const client = getClient();
  const response = await client.agents.messages.create(agentId, {
    messages: [{ role: 'user', content: message }],
    streaming: false,
  });

  // Extract text from response messages
  const texts: string[] = [];
  const messages = (response as { messages?: Array<{ message_type?: string; content?: string }> }).messages || [];
  for (const msg of messages) {
    if (msg.message_type === 'assistant_message' && msg.content) {
      texts.push(msg.content);
    }
  }
  return texts.join('\n');
}

/**
 * Create a custom tool from Python source code.
 * Returns the tool ID. Idempotent via upsert.
 */
export async function upsertToolFromSource(params: {
  source_code: string;
  description?: string;
  tags?: string[];
}): Promise<{ id: string; name: string }> {
  const client = getClient();
  const tool = await client.tools.upsert({
    source_code: params.source_code,
    description: params.description,
    tags: params.tags,
  });
  return { id: tool.id, name: tool.name ?? 'unknown' };
}

// ============================================================================
// Folder / File Management (for reference material)
// ============================================================================

/**
 * Create a folder (source container) for reference material.
 * Returns the folder ID.
 */
export async function createFolder(name: string, description?: string): Promise<string> {
  const baseUrl = LETTA_BASE_URL.replace(/\/+$/, '');
  const apiKey = process.env.LETTA_API_KEY || '';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Letta-Source': 'lettabot',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // Use Ollama nomic-embed-text for embeddings (local, free)
  const ollamaBase = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const embeddingConfig: Record<string, unknown> = {
    handle: 'ollama/nomic-embed-text',
    provider_name: 'ollama',
    embedding_endpoint_type: 'openai',
    embedding_endpoint: `${ollamaBase}/v1/`,
    embedding_model: 'nomic-embed-text',
    embedding_dim: 768,
    embedding_chunk_size: 300,
    batch_size: 32,
  };

  const body: Record<string, unknown> = { name, description };
  if (embeddingConfig) {
    body.embedding_config = embeddingConfig;
  }

  const resp = await fetch(`${baseUrl}/v1/folders/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create folder "${name}": ${resp.status} ${text}`);
  }

  const folder = await resp.json() as { id: string };
  console.log(`[Letta API] Created folder "${name}" → ${folder.id}`);
  return folder.id;
}

/**
 * Find a folder by name (returns first match, or null).
 */
export async function findFolderByName(name: string): Promise<string | null> {
  const baseUrl = LETTA_BASE_URL.replace(/\/+$/, '');
  const apiKey = process.env.LETTA_API_KEY || '';

  const headers: Record<string, string> = {
    'X-Letta-Source': 'lettabot',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(`${baseUrl}/v1/folders/`, { method: 'GET', headers });
  if (!resp.ok) return null;

  const folders = await resp.json() as Array<{ id: string; name: string }>;
  const match = folders.find(f => f.name === name);
  return match?.id ?? null;
}

/**
 * Upload a file to a folder. Letta auto-chunks, embeds, and indexes.
 */
export async function uploadFileToFolder(folderId: string, filePath: string, fileName: string): Promise<void> {
  const { readFileSync } = await import('node:fs');
  const baseUrl = LETTA_BASE_URL.replace(/\/+$/, '');
  const apiKey = process.env.LETTA_API_KEY || '';

  const fileBuffer = readFileSync(filePath);
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);

  const headers: Record<string, string> = {
    'X-Letta-Source': 'lettabot',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(`${baseUrl}/v1/folders/${folderId}/upload`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to upload "${fileName}" to folder ${folderId}: ${resp.status} ${text}`);
  }

  console.log(`[Letta API] Uploaded "${fileName}" to folder ${folderId}`);
}

/**
 * Attach a folder to an agent so it can search the folder's documents.
 */
export async function attachFolderToAgent(agentId: string, folderId: string): Promise<void> {
  const baseUrl = LETTA_BASE_URL.replace(/\/+$/, '');
  const apiKey = process.env.LETTA_API_KEY || '';

  const headers: Record<string, string> = {
    'X-Letta-Source': 'lettabot',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(`${baseUrl}/v1/agents/${agentId}/folders/attach/${folderId}`, {
    method: 'PATCH',
    headers,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to attach folder ${folderId} to agent ${agentId}: ${resp.status} ${text}`);
  }

  console.log(`[Letta API] Attached folder ${folderId} to agent ${agentId}`);
}

/**
 * List files in a folder.
 */
export async function listFolderFiles(folderId: string): Promise<Array<{ id: string; file_name: string }>> {
  const baseUrl = LETTA_BASE_URL.replace(/\/+$/, '');
  const apiKey = process.env.LETTA_API_KEY || '';

  const headers: Record<string, string> = {
    'X-Letta-Source': 'lettabot',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(`${baseUrl}/v1/folders/${folderId}/files`, {
    method: 'GET',
    headers,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to list files in folder ${folderId}: ${resp.status} ${text}`);
  }

  return (await resp.json()) as Array<{ id: string; file_name: string }>;
}

/**
 * List agent messages (conversation history).
 */
export async function listAgentMessages(agentId: string, limit = 200): Promise<Array<{
  message_type: string;
  content?: string;
  created_at?: string;
  role?: string;
}>> {
  const client = getClient();
  const page = await client.agents.messages.list(agentId, { limit });
  const messages: Array<{
    message_type: string;
    content?: string;
    created_at?: string;
    role?: string;
  }> = [];
  for await (const msg of page) {
    const m = msg as unknown as Record<string, unknown>;
    messages.push({
      message_type: (m.message_type as string) || 'unknown',
      content: (m.content as string) || undefined,
      created_at: (m.created_at as string) || undefined,
      role: (m.role as string) || undefined,
    });
  }
  return messages;
}

export async function disableAllToolApprovals(agentId: string): Promise<number> {
  try {
    const tools = await getAgentTools(agentId);
    let disabled = 0;
    
    for (const tool of tools) {
      const success = await disableToolApproval(agentId, tool.name);
      if (success) disabled++;
    }
    
    console.log(`[Letta API] Disabled approval for ${disabled}/${tools.length} tools on agent ${agentId}`);
    return disabled;
  } catch (e) {
    console.error('[Letta API] Failed to disable all tool approvals:', e);
    return 0;
  }
}
