/**
 * Letta Direct Client — Public API
 *
 * Drop-in replacement for @letta-ai/letta-code-sdk.
 * Uses @letta-ai/letta-client directly (pure HTTP, no subprocess).
 *
 * Import from '../letta/index.js' instead of '@letta-ai/letta-code-sdk'.
 */

// Re-export types
export type {
  StreamMsg,
  MessageContentItem,
  SendMessage,
  CanUseToolCallback,
  CanUseToolResult,
  AnyAgentTool,
  AgentToolResult,
  AgentToolResultContent,
  ClientToolDef,
  SessionOptions,
  TransportOptions,
  InitResult,
} from './types.js';

// Session class (aliased as Session for backward compat)
export { AgentSession } from './agent-session.js';
export type { AgentSession as Session } from './agent-session.js';

// Image helpers
export { imageFromFile, imageFromURL } from './image-helpers.js';

// Tool helpers
export { jsonResult, readStringParam } from './tool-helpers.js';

// ============================================================================
// Factory functions — match letta-code-sdk signatures
// ============================================================================

import { AgentSession } from './agent-session.js';
import type { SessionOptions, TransportOptions } from './types.js';

const DEFAULT_BASE_URL = process.env.LETTA_BASE_URL || 'http://localhost:8283';

function defaultTransportOptions(overrides?: TransportOptions): TransportOptions {
  return {
    baseURL: overrides?.baseURL || DEFAULT_BASE_URL,
    apiKey: overrides?.apiKey || process.env.LETTA_API_KEY,
    userId: overrides?.userId,
  };
}

/**
 * Create a new session for an agent (new conversation).
 * Matches the letta-code-sdk createSession() signature.
 */
export function createSession(
  agentId: string,
  options: SessionOptions,
): AgentSession {
  const transportOpts = defaultTransportOptions(options.transport);
  return new AgentSession(agentId, transportOpts, options);
}

/**
 * Resume an existing session by conversation ID.
 * Matches the letta-code-sdk resumeSession() signature.
 */
export function resumeSession(
  conversationId: string,
  options: SessionOptions,
): AgentSession {
  const transportOpts = defaultTransportOptions(options.transport);
  // When resuming, we pass empty agentId — the conversation already knows its agent
  return new AgentSession('', transportOpts, options, conversationId);
}

/**
 * Create a new agent on the Letta server.
 * Matches the letta-code-sdk createAgent() signature.
 *
 * Note: This is a compatibility shim. The multi-tenant path uses
 * createAgentWithBlocks() from letta-api.ts instead, which is more
 * full-featured (shared blocks, compaction, etc.).
 */
export async function createAgent(opts: {
  systemPrompt: string;
  memory: unknown;
  model?: string;
}): Promise<string> {
  // Import Letta client lazily to avoid circular deps
  const { Letta } = await import('@letta-ai/letta-client');
  const client = new Letta({
    apiKey: process.env.LETTA_API_KEY || '',
    baseURL: DEFAULT_BASE_URL,
    defaultHeaders: { 'X-Letta-Source': 'lettabot' },
  });

  // Convert memory blocks format
  const memoryBlocks = Array.isArray(opts.memory)
    ? (opts.memory as Array<{ label: string; value: string; limit?: number }>)
    : [];

  const agent = await client.agents.create({
    system: opts.systemPrompt,
    model: opts.model,
    memory_blocks: memoryBlocks,
    include_base_tools: true,
  });

  return agent.id;
}
