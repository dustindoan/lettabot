/**
 * Multi-Tenant Heartbeat Service
 *
 * Iterates all recently-active users and sends a heartbeat to each user's
 * agent. Errors for one user don't stop the iteration.
 *
 * SILENT MODE: Agent text output is NOT auto-delivered. The agent must use
 * the `lettabot-message` CLI via Bash to contact the user.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { MultiTenantBot } from './multi-tenant-bot.js';
import type { UserRegistry } from './user-registry.js';
import type { TriggerContext } from '../core/types.js';
import { buildHeartbeatPrompt, buildCustomHeartbeatPrompt, type HeartbeatToolContext } from '../core/prompts.js';
import { getCronLogPath } from '../utils/paths.js';
import { listActionableTodos } from '../todo/store.js';

const LOG_PATH = getCronLogPath();

function logEvent(event: string, data: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...data,
  };

  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // Ignore
  }

  console.log(`[MT-Heartbeat] ${event}:`, JSON.stringify(data));
}

export interface MultiTenantHeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  activeWindowHours: number;   // Only heartbeat users active within this window
  workingDir: string;
  agentPrefix: string;

  // Custom heartbeat prompt (optional)
  prompt?: string;

  // Path to prompt file (re-read each tick for live editing)
  promptFile?: string;

  // MCP tool names available to agents (for integration awareness in prompts)
  mcpToolNames?: string[];
}

export class MultiTenantHeartbeatService {
  private bot: MultiTenantBot;
  private registry: UserRegistry;
  private config: MultiTenantHeartbeatConfig;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(bot: MultiTenantBot, registry: UserRegistry, config: MultiTenantHeartbeatConfig) {
    this.bot = bot;
    this.registry = registry;
    this.config = config;
  }

  start(): void {
    if (!this.config.enabled) {
      console.log('[MT-Heartbeat] Disabled');
      return;
    }

    if (this.intervalId) {
      console.log('[MT-Heartbeat] Already running');
      return;
    }

    const intervalMs = this.config.intervalMinutes * 60 * 1000;

    console.log(`[MT-Heartbeat] Starting in SILENT MODE (every ${this.config.intervalMinutes}m, active window: ${this.config.activeWindowHours}h)`);
    console.log(`[MT-Heartbeat] First heartbeat in ${this.config.intervalMinutes} minutes`);

    this.intervalId = setInterval(() => this.runHeartbeat(), intervalMs);

    logEvent('heartbeat_started', {
      intervalMinutes: this.config.intervalMinutes,
      activeWindowHours: this.config.activeWindowHours,
      mode: 'silent',
    });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[MT-Heartbeat] Stopped');
    }
  }

  /**
   * Manually trigger a heartbeat for all active users.
   */
  async trigger(): Promise<void> {
    console.log('[MT-Heartbeat] Manual trigger requested');
    await this.runHeartbeat();
  }

  /**
   * Run heartbeat for all recently-active users.
   * Each user gets their own heartbeat prompt sent to their own agent.
   * Errors per-user don't stop the iteration.
   */
  private async runHeartbeat(): Promise<void> {
    const now = new Date();
    const formattedTime = now.toLocaleString();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const activeUsers = this.registry.listActive(this.config.activeWindowHours);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[MT-Heartbeat] RUNNING at ${formattedTime} [SILENT MODE]`);
    console.log(`[MT-Heartbeat] Active users: ${activeUsers.length} (within ${this.config.activeWindowHours}h window)`);
    console.log(`${'='.repeat(60)}\n`);

    if (activeUsers.length === 0) {
      logEvent('heartbeat_skipped_no_active_users', {
        activeWindowHours: this.config.activeWindowHours,
      });
      return;
    }

    let succeeded = 0;
    let failed = 0;

    for (const user of activeUsers) {
      try {
        console.log(`[MT-Heartbeat] Sending heartbeat to ${user.chatId} (agent=${user.agentId})`);

        // Build heartbeat prompt
        const todoAgentKey = user.agentId || this.config.agentPrefix;
        const actionableTodos = listActionableTodos(todoAgentKey, now);

        // Build tool context from available MCP tool names
        const tools: HeartbeatToolContext | undefined = this.config.mcpToolNames?.length
          ? { toolNames: this.config.mcpToolNames }
          : undefined;

        let customPrompt = this.config.prompt;
        if (!customPrompt && this.config.promptFile) {
          try {
            const promptPath = resolve(this.config.workingDir, this.config.promptFile);
            customPrompt = readFileSync(promptPath, 'utf-8').trim();
          } catch (err) {
            console.error(`[MT-Heartbeat] Failed to read promptFile:`, err);
          }
        }

        const message = customPrompt
          ? buildCustomHeartbeatPrompt(customPrompt, formattedTime, timezone, this.config.intervalMinutes, actionableTodos, now, tools)
          : buildHeartbeatPrompt(formattedTime, timezone, this.config.intervalMinutes, actionableTodos, now, tools);

        // Build context targeting this user's agent
        const triggerContext: TriggerContext = {
          type: 'heartbeat',
          outputMode: 'silent',
          sourceChannel: user.lastMessageTarget?.channel,
          sourceChatId: user.chatId,
          targetChatId: user.chatId,
        };

        const response = await this.bot.sendToAgent(message, triggerContext);

        console.log(`[MT-Heartbeat] Done for ${user.chatId} (${response?.length || 0} chars, not delivered)`);
        succeeded++;

      } catch (error) {
        console.error(`[MT-Heartbeat] Error for ${user.chatId}:`, error instanceof Error ? error.message : error);
        failed++;
      }
    }

    logEvent('heartbeat_completed', {
      mode: 'silent',
      totalUsers: activeUsers.length,
      succeeded,
      failed,
    });
  }
}
