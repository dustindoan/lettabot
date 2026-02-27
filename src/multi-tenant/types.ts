/**
 * Multi-Tenant Types
 *
 * Data structures for per-user agent routing. Each user (identified by chatId)
 * gets their own Letta agent with isolated memory and archival storage.
 */

import type { LastMessageTarget } from '../core/types.js';

/**
 * Per-user record: maps a chatId to their dedicated Letta agent.
 */
export interface UserRecord {
  chatId: string;             // Canonical user identifier (phone, Telegram ID, etc.)
  agentId: string;            // This user's Letta agent ID
  lettaUserId?: string;       // Letta-side user ID (user-<uuid>) for per-user MCP OAuth scoping
  conversationId?: string;    // Current conversation ID
  displayName?: string;       // User's display name (from first message)
  channel: string;            // Primary channel (where first contact was made)
  createdAt: string;          // ISO timestamp
  lastActiveAt: string;       // ISO timestamp
  lastMessageTarget?: LastMessageTarget;
}

/**
 * Persisted state for the user registry.
 */
export interface UserRegistryFile {
  version: 1;
  sharedBlockIds: string[];
  users: Record<string, UserRecord>; // keyed by chatId
}

/**
 * Multi-tenant configuration (from config.yaml).
 */
export interface TenancyConfig {
  mode: 'single' | 'multi-user';
  agentPrefix?: string;
  perUserBlockLabels?: string[];    // default: labels starting with 'human/'
  heartbeat?: {
    enabled: boolean;
    intervalMin?: number;           // default: 60
    activeWindowHours?: number;     // only heartbeat users active within this window
    prompt?: string;
    promptFile?: string;
  };
}
