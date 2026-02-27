/**
 * User Registry
 *
 * Manages the chatId → UserRecord mapping. Local cache with JSON persistence.
 * On cache miss, falls back to Letta API to find existing agents.
 *
 * Agent creation for new users is handled here: creates a Letta agent with
 * shared persona blocks (by reference) and fresh per-user human blocks.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getDataDir } from '../utils/paths.js';
import { createAgentWithBlocks, createLettaUser, setAgentSecrets, ensureNoToolApprovals, listAgents, attachToolsToAgent, type CompactionConfig } from '../tools/letta-api.js';
import { installSkillsToAgent } from '../skills/loader.js';
import { SYSTEM_PROMPT } from '../core/system-prompt.js';
import { getPerUserBlocks } from './shared-blocks.js';
import type { UserRecord, UserRegistryFile } from './types.js';
import type { SkillsConfig, LastMessageTarget } from '../core/types.js';

const REGISTRY_FILE = 'multi-tenant-users.json';

export class UserRegistry {
  private users: Map<string, UserRecord> = new Map();
  private sharedBlockIds: string[];
  private model: string;
  private agentPrefix: string;
  private skills?: SkillsConfig;
  private perUserBlockLabels?: string[];
  private compaction?: CompactionConfig;
  private mcpToolIds: string[];
  private assessToolId?: string;
  private toolRules?: Array<{ tool_name: string; type?: string }>;

  constructor(opts: {
    sharedBlockIds: string[];
    model: string;
    agentPrefix: string;
    skills?: SkillsConfig;
    perUserBlockLabels?: string[];
    compaction?: CompactionConfig;
    mcpToolIds?: string[];
    assessToolId?: string;
    toolRules?: Array<{ tool_name: string; type?: string }>;
  }) {
    this.sharedBlockIds = opts.sharedBlockIds;
    this.model = opts.model;
    this.agentPrefix = opts.agentPrefix;
    this.skills = opts.skills;
    this.perUserBlockLabels = opts.perUserBlockLabels;
    this.compaction = opts.compaction;
    this.mcpToolIds = opts.mcpToolIds || [];
    this.assessToolId = opts.assessToolId;
    this.toolRules = opts.toolRules;
    this.load();
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  private getFilePath(): string {
    return resolve(getDataDir(), REGISTRY_FILE);
  }

  private load(): void {
    const path = this.getFilePath();
    if (!existsSync(path)) return;

    try {
      const data: UserRegistryFile = JSON.parse(readFileSync(path, 'utf-8'));
      if (data.version === 1 && data.users) {
        for (const [chatId, record] of Object.entries(data.users)) {
          this.users.set(chatId, record);
        }
        console.log(`[UserRegistry] Loaded ${this.users.size} user(s) from cache`);
      }
    } catch (err) {
      console.warn('[UserRegistry] Failed to load cache:', err instanceof Error ? err.message : err);
    }
  }

  private save(): void {
    const path = this.getFilePath();
    mkdirSync(dirname(path), { recursive: true });

    const data: UserRegistryFile = {
      version: 1,
      sharedBlockIds: this.sharedBlockIds,
      users: Object.fromEntries(this.users),
    };

    writeFileSync(path, JSON.stringify(data, null, 2));
  }

  // =========================================================================
  // Lookup & Resolution
  // =========================================================================

  /**
   * Get a cached user record (no API calls).
   */
  get(chatId: string): UserRecord | undefined {
    return this.users.get(chatId);
  }

  /**
   * Resolve a chatId to a UserRecord. Creates a new agent if the user is unknown.
   */
  async resolve(chatId: string, opts?: {
    displayName?: string;
    channel?: string;
  }): Promise<UserRecord> {
    // Check local cache
    const cached = this.users.get(chatId);
    if (cached) {
      // Lazy backfill: create Letta user if missing (for records created before this feature)
      if (!cached.lettaUserId) {
        try {
          const agentName = `${this.agentPrefix}-${cached.chatId.slice(0, 8)}`;
          cached.lettaUserId = await createLettaUser(agentName);
          // Also set the agent secret for MCP OAuth identity propagation
          setAgentSecrets(cached.agentId, { LETTA_USER_ID: cached.lettaUserId }).catch(err => {
            console.warn(`[UserRegistry] Failed to set LETTA_USER_ID secret during backfill:`, err);
          });
          this.save();
          console.log(`[UserRegistry] Backfilled lettaUserId for ${chatId}: ${cached.lettaUserId}`);
        } catch (err) {
          console.warn(`[UserRegistry] Failed to backfill lettaUserId for ${chatId}:`, err instanceof Error ? err.message : err);
        }
      }
      return cached;
    }

    // Try to find an existing agent on the Letta server (cold cache recovery)
    const existing = await this.findExistingAgent(chatId);
    if (existing) {
      const record: UserRecord = {
        chatId,
        agentId: existing.id,
        displayName: opts?.displayName,
        channel: opts?.channel || 'unknown',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      };
      this.users.set(chatId, record);
      this.save();
      console.log(`[UserRegistry] Recovered existing agent for ${chatId}: ${existing.id}`);
      return record;
    }

    // Create new agent for this user
    return this.createUser(chatId, opts?.displayName, opts?.channel);
  }

  /**
   * Try to find an existing agent for this chatId on the Letta server.
   * Uses agent name prefix convention: "<agentPrefix>-<shortId>"
   */
  private async findExistingAgent(chatId: string): Promise<{ id: string; name: string } | null> {
    try {
      // Search by name prefix — agents are named "<prefix>-<shortId>"
      const agents = await listAgents(this.agentPrefix);
      // We can't reverse-map chatId from agent name (short IDs are random),
      // so cold cache recovery only works if the agent name contains chatId info.
      // For now, return null — cold recovery is a stretch goal.
      return null;
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Agent Creation
  // =========================================================================

  /**
   * Create a new Letta agent for a user with shared + per-user blocks.
   */
  private async createUser(
    chatId: string,
    displayName?: string,
    channel?: string,
  ): Promise<UserRecord> {
    const shortId = Math.random().toString(36).slice(2, 8);
    const agentName = `${this.agentPrefix}-${shortId}`;

    // Create a Letta user for per-user MCP OAuth scoping
    let lettaUserId: string | undefined;
    try {
      lettaUserId = await createLettaUser(agentName);
    } catch (err) {
      console.warn(`[UserRegistry] Failed to create Letta user for ${chatId}:`, err instanceof Error ? err.message : err);
      // Continue without lettaUserId — MCP OAuth won't be per-user but agent creation still works
    }

    // Load per-user block templates (human/* blocks)
    const perUserBlocks = getPerUserBlocks(
      this.agentPrefix,
      this.perUserBlockLabels,
    );

    console.log(`[UserRegistry] Creating agent "${agentName}" for ${chatId} with ${perUserBlocks.length} per-user blocks and ${this.sharedBlockIds.length} shared blocks`);
    if (this.compaction) {
      console.log(`[UserRegistry] Compaction: model=${this.compaction.model}, mode=${this.compaction.mode || 'sliding_window'}`);
    }

    const agentId = await createAgentWithBlocks({
      name: agentName,
      system: SYSTEM_PROMPT,
      model: this.model,
      blockIds: this.sharedBlockIds,
      memoryBlocks: perUserBlocks,
      compaction: this.compaction,
      toolRules: this.toolRules,
    });

    // Set LETTA_USER_ID agent secret for MCP OAuth identity propagation.
    // Template variables like {{ LETTA_USER_ID }} in MCP server custom_headers
    // are resolved from this secret at tool execution time.
    if (lettaUserId) {
      try {
        await setAgentSecrets(agentId, { LETTA_USER_ID: lettaUserId });
      } catch (err) {
        console.warn(`[UserRegistry] Failed to set LETTA_USER_ID secret on ${agentId}:`, err);
      }
    }

    // Install skills and disable tool approvals
    installSkillsToAgent(agentId, this.skills);
    try {
      await ensureNoToolApprovals(agentId);
    } catch (err) {
      console.warn(`[UserRegistry] Failed to disable tool approvals for ${agentId}:`, err);
    }

    // Attach OODA tool (coaching cognitive loop) and MCP tools in parallel
    const toolAttachments: Promise<void>[] = [];

    if (this.assessToolId) {
      toolAttachments.push(
        attachToolsToAgent(agentId, [this.assessToolId]).then(count => {
          if (count > 0) console.log(`[UserRegistry] Attached OODA tool to agent ${agentId}`);
        }).catch(err => {
          console.warn(`[UserRegistry] Failed to attach OODA tool to ${agentId}:`, err);
        }),
      );
    }

    if (this.mcpToolIds.length > 0) {
      toolAttachments.push(
        attachToolsToAgent(agentId, this.mcpToolIds).then(count => {
          console.log(`[UserRegistry] Attached ${count} MCP tool(s) to agent ${agentId}`);
        }).catch(err => {
          console.warn(`[UserRegistry] Failed to attach MCP tools to ${agentId}:`, err);
        }),
      );
    }

    await Promise.all(toolAttachments);

    const record: UserRecord = {
      chatId,
      agentId,
      lettaUserId,
      displayName,
      channel: channel || 'unknown',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };

    this.users.set(chatId, record);
    this.save();

    console.log(`[UserRegistry] Created agent ${agentId} for ${chatId}`);
    return record;
  }

  // =========================================================================
  // State Updates
  // =========================================================================

  /**
   * Update the conversation ID for a user after a successful session.
   */
  updateConversation(chatId: string, conversationId: string): void {
    const record = this.users.get(chatId);
    if (record && record.conversationId !== conversationId) {
      record.conversationId = conversationId;
      this.save();
    }
  }

  /**
   * Update last activity timestamp and message target for a user.
   */
  updateLastActive(chatId: string, target?: LastMessageTarget): void {
    const record = this.users.get(chatId);
    if (record) {
      record.lastActiveAt = new Date().toISOString();
      if (target) {
        record.lastMessageTarget = target;
      }
      this.save();
    }
  }

  // =========================================================================
  // Reset / Removal
  // =========================================================================

  /**
   * Clear the conversation ID for a user, forcing a new conversation on next message.
   */
  clearConversation(chatId: string): boolean {
    const record = this.users.get(chatId);
    if (record && record.conversationId) {
      record.conversationId = undefined;
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Remove a user from the registry entirely (for hard delete).
   */
  removeUser(chatId: string): boolean {
    const deleted = this.users.delete(chatId);
    if (deleted) this.save();
    return deleted;
  }

  // =========================================================================
  // Queries
  // =========================================================================

  /**
   * List all users active within the given time window.
   */
  listActive(withinHours = 24): UserRecord[] {
    const cutoff = Date.now() - withinHours * 60 * 60 * 1000;
    return Array.from(this.users.values()).filter(
      u => new Date(u.lastActiveAt).getTime() > cutoff,
    );
  }

  /**
   * List all known users.
   */
  listAll(): UserRecord[] {
    return Array.from(this.users.values());
  }

  /**
   * Get count of registered users.
   */
  get size(): number {
    return this.users.size;
  }
}
