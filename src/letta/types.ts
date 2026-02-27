/**
 * Shared types for the Letta direct client layer.
 *
 * These types define the interface surface that bot.ts and multi-tenant-bot.ts
 * consume. They replace the equivalent types from @letta-ai/letta-code-sdk.
 */

// ============================================================================
// Stream Messages
// ============================================================================

/**
 * A message yielded by the stream() async generator.
 * Discriminated by `type`. Consumers switch on this field.
 */
export interface StreamMsg {
  type: string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  uuid?: string;
  isError?: boolean;
  result?: string;
  success?: boolean;
  error?: string;
  stopReason?: string;
  durationMs?: number;
  conversationId?: string;
  [key: string]: unknown;
}

// ============================================================================
// Message Content
// ============================================================================

/** A text content item in a multimodal message. */
export interface TextContentItem {
  type: 'text';
  text: string;
}

/** An image content item in a multimodal message. */
export interface ImageContentItem {
  type: 'image';
  source: {
    type: 'base64';
    mediaType: string;
    data: string;
  };
}

/** A single content item in a multimodal message. */
export type MessageContentItem = TextContentItem | ImageContentItem;

/** What can be sent as a message — plain text or multimodal array. */
export type SendMessage = string | MessageContentItem[];

// ============================================================================
// Tools
// ============================================================================

/** JSON Schema for tool parameters. */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

/** Content block in a tool result (matches letta-code-sdk AgentToolResultContent). */
export interface AgentToolResultContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Structured tool result (matches letta-code-sdk AgentToolResult). */
export interface AgentToolResult<T = unknown> {
  content: AgentToolResultContent[];
  details?: T;
}

/** A client-side tool definition (registered with AgentSession). */
export interface AnyAgentTool {
  label: string;
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  execute: (toolCallId: string, args: unknown) => Promise<AgentToolResult>;
}

/** Tool definition sent to the Letta server in client_tools. */
export interface ClientToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

// ============================================================================
// Permission / Approval
// ============================================================================

/** Result of a canUseTool callback. */
export type CanUseToolResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string };

/**
 * Callback invoked when a tool needs permission.
 * Used for AskUserQuestion interception and tool gating.
 */
export type CanUseToolCallback = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<CanUseToolResult>;

// ============================================================================
// Session Options
// ============================================================================

/** Transport configuration for per-user scoping. */
export interface TransportOptions {
  baseURL?: string;
  apiKey?: string;
  userId?: string;
}

/** Options passed to createSession / resumeSession. */
export interface SessionOptions {
  permissionMode: 'bypassPermissions';
  tools?: AnyAgentTool[];
  canUseTool?: CanUseToolCallback;
  allowedTools?: string[];
  disallowedTools?: string[];
  cwd?: string;
  transport?: TransportOptions;
}

/** Result of session.initialize(). */
export interface InitResult {
  type: 'init';
  agentId: string | null;
  conversationId: string | null;
}
