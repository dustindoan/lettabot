/**
 * Tool helper utilities.
 *
 * These are thin replacements for the same-named exports from
 * @letta-ai/letta-code-sdk. Used by tools/todo.ts.
 */

import type { AgentToolResult } from './types.js';

/**
 * Wrap an object as a structured tool result.
 * Matches the letta-code-sdk format: { content: [{type: 'text', text: json}], details: payload }
 *
 * The ClientToolExecutor extracts the text content to send to the Letta server.
 */
export function jsonResult(data: object): AgentToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * Read a string parameter from a tool args object.
 * Throws if required and missing.
 */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean },
): string {
  const val = params[key];
  if (val === undefined || val === null) {
    if (opts?.required) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    return '';
  }
  return String(val);
}
