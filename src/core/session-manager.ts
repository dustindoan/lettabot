/**
 * SessionManager - Owns CLI subprocess lifecycle, session creation,
 * LRU eviction, invalidation, and message send+stream.
 *
 * Extracted from bot.ts to isolate session concerns from message
 * routing, channel management, and directive execution.
 */

import { createAgent, createSession, resumeSession, type Session, type SendMessage, type CanUseToolCallback } from '@letta-ai/letta-code-sdk';
import type { BotConfig, StreamMsg } from './types.js';
import { isApprovalConflictError, isConversationMissingError, isAgentMissingFromInitError } from './errors.js';
import { Store } from './store.js';
import { updateAgentName, setAgentSecrets, getAgentSecrets, createLettaUser, recoverOrphanedConversationApproval, getMcpServerByName, attachToolsToAgent, filterMcpTools, ensureNoToolApprovals, getAdminApiKey, findAgentByName } from '../tools/letta-api.js';
import { installSkillsToAgent, prependSkillDirsToPath } from '../skills/loader.js';
import { loadMemoryBlocks } from './memory.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { createManageTodoTool } from '../tools/todo.js';
import { syncTodosFromTool } from '../todo/store.js';
import { createLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Global mutex for subprocess spawning.
// The letta-code-sdk inherits process.env at spawn time. We mutate
// process.env.LETTA_API_KEY to inject the per-user key, then restore it
// after initialize() spawns the subprocess. This mutex serializes the
// mutation + spawn window so concurrent sessions don't interleave.
// ---------------------------------------------------------------------------
let _spawnLockPromise: Promise<void> = Promise.resolve();

async function withSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chain onto the previous lock holder
  let release: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  const prev = _spawnLockPromise;
  _spawnLockPromise = next;

  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
}

const log = createLogger('Session');

export class SessionManager {
  private readonly store: Store;
  private readonly config: BotConfig;

  // Active processing keys -- owned by LettaBot, read here for LRU eviction safety.
  private readonly processingKeys: ReadonlySet<string>;
  // Stale-result fingerprints -- owned by LettaBot, cleaned here on invalidation/eviction.
  private readonly lastResultRunFingerprints: Map<string, string>;

  // Persistent sessions: reuse CLI subprocesses across messages.
  private sessions: Map<string, Session> = new Map();
  private sessionLastUsed: Map<string, number> = new Map();
  private sessionCreationLocks: Map<string, { promise: Promise<Session>; generation: number }> = new Map();
  private sessionGenerations: Map<string, number> = new Map();

  // In-memory cache of per-user secrets (LETTA_USER_ID + LETTA_API_KEY),
  // keyed by chat key. Populated on first use per restart.
  private secretsCache: Map<string, { userId: string; apiKey: string }> = new Map();

  // Track agent IDs that have had MCP tools audited this restart.
  // Prevents redundant API calls on every session resume.
  private mcpToolsAudited: Set<string> = new Set();

  // Per-message tool callback. Updated before each send() so the Session
  // options (which hold a stable wrapper) route to the current handler.
  private currentCanUseTool: CanUseToolCallback | undefined;

  // Stable callback wrapper so the Session options never change, but we can
  // swap out the per-message handler before each send().
  private readonly sessionCanUseTool: CanUseToolCallback = async (toolName, toolInput) => {
    if (this.currentCanUseTool) {
      return this.currentCanUseTool(toolName, toolInput);
    }
    return { behavior: 'allow' as const };
  };

  constructor(
    store: Store,
    config: BotConfig,
    processingKeys: ReadonlySet<string>,
    lastResultRunFingerprints: Map<string, string>,
  ) {
    this.store = store;
    this.config = config;
    this.processingKeys = processingKeys;
    this.lastResultRunFingerprints = lastResultRunFingerprints;

    // Validate: subAgents requires per-chat mode
    if (config.subAgents && config.conversationMode !== 'per-chat') {
      log.warn('subAgents config requires conversations.mode: per-chat — ignoring subAgents');
      this.config = { ...config, subAgents: undefined };
    }
  }

  /** Whether sub-agent mode is active (subAgents + per-chat). */
  private get useSubAgents(): boolean {
    return !!this.config.subAgents;
  }

  /** Generate a sub-agent name from the naming pattern. */
  private subAgentName(chatKey: string): string {
    const pattern = this.config.subAgents?.naming || '{name}-{shortId}';
    // Use first 7 chars of a simple hash for shortId
    let hash = 0;
    for (let i = 0; i < chatKey.length; i++) {
      hash = ((hash << 5) - hash + chatKey.charCodeAt(i)) | 0;
    }
    const shortId = Math.abs(hash).toString(36).slice(0, 7).padEnd(7, '0');
    return pattern
      .replace('{name}', this.config.agentName || 'LettaBot')
      .replace('{shortId}', shortId);
  }

  // =========================================================================
  // Todo sync (stream utility)
  // =========================================================================

  private getTodoAgentKey(): string {
    return this.store.agentId || this.config.agentName || 'LettaBot';
  }

  /** Sync TodoWrite tool calls to the persistent heartbeat store. */
  syncTodoToolCall(streamMsg: StreamMsg): void {
    if (streamMsg.type !== 'tool_call') return;

    const normalizedToolName = (streamMsg.toolName || '').toLowerCase();
    const isBuiltInTodoTool = normalizedToolName === 'todowrite'
      || normalizedToolName === 'todo_write'
      || normalizedToolName === 'writetodos'
      || normalizedToolName === 'write_todos';
    if (!isBuiltInTodoTool) return;

    const input = (streamMsg.toolInput && typeof streamMsg.toolInput === 'object')
      ? streamMsg.toolInput as Record<string, unknown>
      : null;
    if (!input || !Array.isArray(input.todos)) return;

    const incoming: Array<{
      content?: string;
      description?: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    }> = [];
    for (const item of input.todos) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const statusRaw = typeof obj.status === 'string' ? obj.status : '';
      if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(statusRaw)) continue;
      incoming.push({
        content: typeof obj.content === 'string' ? obj.content : undefined,
        description: typeof obj.description === 'string' ? obj.description : undefined,
        status: statusRaw as 'pending' | 'in_progress' | 'completed' | 'cancelled',
      });
    }
    if (incoming.length === 0) return;

    try {
      const summary = syncTodosFromTool(this.getTodoAgentKey(), incoming);
      if (summary.added > 0 || summary.updated > 0) {
        log.info(`Synced ${summary.totalIncoming} todo(s) from ${streamMsg.toolName} into heartbeat store (added=${summary.added}, updated=${summary.updated})`);
      }
    } catch (err) {
      log.warn('Failed to sync TodoWrite todos:', err instanceof Error ? err.message : err);
    }
  }

  // =========================================================================
  // Session options & timeout
  // =========================================================================

  private getSessionTimeoutMs(): number {
    const envTimeoutMs = Number(process.env.LETTA_SESSION_TIMEOUT_MS);
    if (Number.isFinite(envTimeoutMs) && envTimeoutMs > 0) {
      return envTimeoutMs;
    }
    return 60000;
  }

  async withSessionTimeout<T>(
    promise: Promise<T>,
    label: string,
  ): Promise<T> {
    const timeoutMs = this.getSessionTimeoutMs();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private baseSessionOptions(canUseTool?: CanUseToolCallback) {
    return {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      disallowedTools: [
        // Block built-in TodoWrite -- it requires interactive approval (fails
        // silently during heartbeats) and writes to the CLI's own store rather
        // than lettabot's persistent heartbeat store.  The agent should use the
        // custom manage_todo tool instead.
        'TodoWrite',
        ...(this.config.disallowedTools || []),
      ],
      cwd: this.config.workingDir,
      tools: [createManageTodoTool(this.getTodoAgentKey())],
      // Memory filesystem (context repository): true -> --memfs, false -> --no-memfs, undefined -> leave unchanged
      ...(this.config.memfs !== undefined ? { memfs: this.config.memfs } : {}),
      // In bypassPermissions mode, canUseTool is only called for interactive
      // tools (AskUserQuestion, ExitPlanMode). When no callback is provided
      // (background triggers), the SDK auto-denies interactive tools.
      ...(canUseTool ? { canUseTool } : {}),
    };
  }

  // =========================================================================
  // Session lifecycle (per-key)
  // =========================================================================

  /**
   * Return the persistent session for the given conversation key,
   * creating and initializing it if needed.
   *
   * After initialization, calls bootstrapState() to detect pending approvals.
   * If an orphaned approval is found, recovers proactively before returning
   * the session -- preventing the first send() from hitting a 409 CONFLICT.
   */
  async ensureSessionForKey(key: string, bootstrapRetried = false): Promise<Session> {
    const generation = this.sessionGenerations.get(key) ?? 0;

    // Fast path: session already exists
    const existing = this.sessions.get(key);
    if (existing) {
      this.sessionLastUsed.set(key, Date.now());
      return existing;
    }

    // Coalesce concurrent callers: if another call is already creating this
    // key (e.g. warmSession running while first message arrives), wait for
    // it instead of creating a duplicate session.
    const pending = this.sessionCreationLocks.get(key);
    if (pending && pending.generation === generation) return pending.promise;

    const promise = this._createSessionForKey(key, bootstrapRetried, generation);
    this.sessionCreationLocks.set(key, { promise, generation });
    try {
      return await promise;
    } finally {
      const current = this.sessionCreationLocks.get(key);
      if (current?.promise === promise) {
        this.sessionCreationLocks.delete(key);
      }
    }
  }

  /** Internal session creation -- called via ensureSessionForKey's lock. */
  private async _createSessionForKey(
    key: string,
    bootstrapRetried: boolean,
    generation: number,
  ): Promise<Session> {
    // Session was invalidated while this creation path was queued.
    if ((this.sessionGenerations.get(key) ?? 0) !== generation) {
      return this.ensureSessionForKey(key, bootstrapRetried);
    }

    // Re-read the store file from disk so we pick up agent/conversation ID
    // changes made by other processes (e.g. after a restart or container deploy).
    this.store.refresh();

    const opts = this.baseSessionOptions(this.sessionCanUseTool);
    let session: Session;
    let sessionAgentId: string | undefined;

    // Resolve the per-user API key.
    // In sub-agent mode, each chat user has a scoped Store entry + secrets on Letta server.
    // In shared/disabled mode, use the admin key (original behavior).
    const isSubAgent = this.useSubAgents && key !== 'shared' && key !== 'default';
    let userApiKey: string | undefined;
    let subStore: Store | undefined;
    if (isSubAgent) {
      const subName = this.subAgentName(key);
      subStore = new Store('lettabot-agent.json', subName);

      // If agent exists, fetch secrets from cache or Letta server.
      // Secrets are REQUIRED for sub-agents — without them, tool calls would
      // run under the admin user context, breaking MCP OAuth and leaking privileges.
      if (subStore.agentId) {
        let cached = this.secretsCache.get(key);
        if (!cached) {
          try {
            const secrets = await getAgentSecrets(subStore.agentId);
            if (secrets.LETTA_USER_ID && secrets.LETTA_API_KEY) {
              cached = { userId: secrets.LETTA_USER_ID, apiKey: secrets.LETTA_API_KEY };
              this.secretsCache.set(key, cached);
            } else {
              log.error(`Sub-agent ${subName} missing LETTA_USER_ID/LETTA_API_KEY secrets — refusing to start session with admin key`);
              throw new Error(`Sub-agent ${subName} has no user secrets. Delete the agent and let it be recreated.`);
            }
          } catch (e) {
            if (e instanceof Error && e.message.includes('has no user secrets')) throw e;
            log.error(`Failed to fetch secrets for sub-agent ${subName}:`, e instanceof Error ? e.message : e);
            throw new Error(`Cannot load secrets for sub-agent ${subName}. Delete the agent and let it be recreated.`);
          }
        }
        userApiKey = cached.apiKey;
      }
    }

    // Look up conversation from the appropriate store.
    const convId = isSubAgent
      ? subStore!.getConversationId(key)
      : key === 'default'
        ? null
        : key === 'shared'
          ? this.store.conversationId
          : this.store.getConversationId(key);

    // Wrap env mutation + subprocess spawn in a global mutex.
    // The letta-code-sdk subprocess inherits process.env at spawn time,
    // so we must prevent interleaving between setting LETTA_API_KEY and
    // the actual child_process.spawn() inside session.initialize().
    const { createdSession, initError } = await withSpawnLock(async () => {
      const savedApiKey = process.env.LETTA_API_KEY;
      if (userApiKey) {
        process.env.LETTA_API_KEY = userApiKey;
      }

      // Propagate per-agent cron store path to CLI subprocesses (lettabot-schedule)
      if (this.config.cronStorePath) {
        process.env.CRON_STORE_PATH = this.config.cronStorePath;
      }

      let localSession!: Session;

      // ---------------------------------------------------------------
      // Sub-agent path: scoped Store is the source of truth for agent + conversation.
      // Each chat user gets their own Letta agent with isolated identity.
      // ---------------------------------------------------------------
      if (isSubAgent && subStore) {
        const subAgentId = subStore.agentId;

        if (subAgentId && convId) {
          // Resume existing conversation on user's sub-agent
          process.env.LETTA_AGENT_ID = subAgentId;
          installSkillsToAgent(subAgentId, this.config.skills);
          sessionAgentId = subAgentId;
          prependSkillDirsToPath(sessionAgentId);
          localSession = resumeSession(convId, opts);
        } else if (subAgentId) {
          // Agent exists but no conversation — start a new one
          process.env.LETTA_AGENT_ID = subAgentId;
          installSkillsToAgent(subAgentId, this.config.skills);
          sessionAgentId = subAgentId;
          prependSkillDirsToPath(sessionAgentId);
          localSession = createSession(subAgentId, opts);
        } else {
          const agentName = this.subAgentName(key);

          // Guard: check Letta for an existing agent with this name before creating.
          // Prevents duplicates when Store lost the agent ID (crash, restart, file deletion).
          const existingAgent = await findAgentByName(agentName);
          if (existingAgent) {
            log.info(`Recovered existing sub-agent "${agentName}" (${existingAgent.id}) from Letta`);
            try {
              const secrets = await getAgentSecrets(existingAgent.id);
              if (secrets.LETTA_USER_ID && secrets.LETTA_API_KEY) {
                userApiKey = secrets.LETTA_API_KEY;
                process.env.LETTA_API_KEY = userApiKey;
                this.secretsCache.set(key, { userId: secrets.LETTA_USER_ID, apiKey: userApiKey });

                const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
                subStore.setAgent(existingAgent.id, currentBaseUrl);

                installSkillsToAgent(existingAgent.id, this.config.skills);
                sessionAgentId = existingAgent.id;
                prependSkillDirsToPath(sessionAgentId);

                if (!this.mcpToolsAudited.has(existingAgent.id)) {
                  await this.attachFilteredMcpTools(existingAgent.id);
                  this.mcpToolsAudited.add(existingAgent.id);
                }

                localSession = createSession(existingAgent.id, opts);
              }
            } catch (e) {
              log.warn(`Failed to recover agent ${agentName} — will create fresh:`, e instanceof Error ? e.message : e);
            }
          }

          // Create per-user sub-agent + Letta user (if recovery didn't succeed)
          if (!sessionAgentId) {
            log.info(`Creating sub-agent "${agentName}" for chat key "${key}"`);

            // Provision Letta user + API key
            const { userId, apiKey } = await createLettaUser(`chat-${key}`);
            userApiKey = apiKey;
            process.env.LETTA_API_KEY = apiKey;

            const newAgentId = await createAgent({
              systemPrompt: SYSTEM_PROMPT,
              memory: loadMemoryBlocks(this.config.agentName),
              tags: ['origin:lettabot', 'sub-agent'],
              ...(this.config.memfs !== undefined ? { memfs: this.config.memfs } : {}),
            });

            // Name the sub-agent
            updateAgentName(newAgentId, agentName).catch(() => {});

            // Store both LETTA_USER_ID and LETTA_API_KEY as agent secrets
            await setAgentSecrets(newAgentId, { LETTA_USER_ID: userId, LETTA_API_KEY: apiKey });

            // Cache secrets in memory
            this.secretsCache.set(key, { userId, apiKey });

            // Save agent ID to scoped Store
            const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
            subStore.setAgent(newAgentId, currentBaseUrl);
            log.info(`Sub-agent created: ${newAgentId} for user ${userId}`);

            installSkillsToAgent(newAgentId, this.config.skills);
            sessionAgentId = newAgentId;
            prependSkillDirsToPath(sessionAgentId);

            // Attach MCP server tools to sub-agent (config-driven, filtered)
            await this.attachFilteredMcpTools(newAgentId);
            this.mcpToolsAudited.add(newAgentId);

            localSession = createSession(newAgentId, opts);
          }
        }

      // ---------------------------------------------------------------
      // Store-based path: shared/disabled/per-channel modes (original behavior).
      // ---------------------------------------------------------------
      } else if (key === 'default' && this.store.agentId) {
        process.env.LETTA_AGENT_ID = this.store.agentId;
        installSkillsToAgent(this.store.agentId, this.config.skills);
        sessionAgentId = this.store.agentId;
        prependSkillDirsToPath(sessionAgentId);
        localSession = resumeSession('default', opts);
      } else if (convId) {
        process.env.LETTA_AGENT_ID = this.store.agentId || undefined;
        if (this.store.agentId) {
          installSkillsToAgent(this.store.agentId, this.config.skills);
          sessionAgentId = this.store.agentId;
          prependSkillDirsToPath(sessionAgentId);
        }
        localSession = resumeSession(convId, opts);
      } else if (this.store.agentId) {
        process.env.LETTA_AGENT_ID = this.store.agentId;
        installSkillsToAgent(this.store.agentId, this.config.skills);
        sessionAgentId = this.store.agentId;
        prependSkillDirsToPath(sessionAgentId);
        localSession = resumeSession(this.store.agentId, opts);
      } else {
        // Create new shared agent
        log.info('Creating new agent');
        const newAgentId = await createAgent({
          systemPrompt: SYSTEM_PROMPT,
          memory: loadMemoryBlocks(this.config.agentName),
          tags: ['origin:lettabot'],
          ...(this.config.memfs !== undefined ? { memfs: this.config.memfs } : {}),
        });
        const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
        this.store.setAgent(newAgentId, currentBaseUrl);
        log.info('Saved new agent ID:', newAgentId);

        if (this.config.agentName) {
          updateAgentName(newAgentId, this.config.agentName).catch(() => {});
        }
        installSkillsToAgent(newAgentId, this.config.skills);
        sessionAgentId = newAgentId;
        prependSkillDirsToPath(sessionAgentId);

        // Attach MCP server tools to new agent (config-driven, filtered)
        await this.attachFilteredMcpTools(newAgentId);
        this.mcpToolsAudited.add(newAgentId);

        localSession = key === 'default'
          ? resumeSession('default', opts)
          : createSession(newAgentId, opts);
      }

      // Initialize eagerly so the subprocess is ready before the first send().
      // This is where child_process.spawn() happens — MUST be inside the lock.
      log.info(`Initializing session subprocess (key=${key})...`);
      let error: unknown = undefined;
      try {
        await this.withSessionTimeout(localSession.initialize(), `Session initialize (key=${key})`);
        log.info(`Session subprocess ready (key=${key})`);
      } catch (e) {
        error = e;
      }

      // Restore the original API key BEFORE releasing the lock
      process.env.LETTA_API_KEY = savedApiKey;

      return { createdSession: localSession, initError: error };
    });

    session = createdSession;

    // Handle initialization errors outside the lock
    if (initError) {
      session.close();

      const staleAgentId = sessionAgentId || this.store.agentId;
      if (staleAgentId && !bootstrapRetried && isAgentMissingFromInitError(initError)) {
        log.warn(
          `Agent ${staleAgentId} appears missing from server, ` +
          `clearing stale agent ID and recreating...`,
        );
        if (isSubAgent && subStore) {
          subStore.clearAgent();
          this.secretsCache.delete(key);
        } else {
          this.store.clearAgent();
        }
        return this._createSessionForKey(key, /* bootstrapRetried */ true, generation);
      }

      throw initError;
    }

    // reset/invalidate can happen while initialize() is in-flight.
    if ((this.sessionGenerations.get(key) ?? 0) !== generation) {
      log.info(`Discarding stale initialized session (key=${key})`);
      session.close();
      return this.ensureSessionForKey(key, bootstrapRetried);
    }

    // Proactive MCP tool attach: ensure filtered tools are present on existing
    // agents (e.g., after restart, or if MCP config changed). Runs once per
    // agent ID per lettabot session. Skips agents that were just created above
    // (they already called attachFilteredMcpTools during creation).
    if (sessionAgentId && this.config.mcpServers?.length && !this.mcpToolsAudited.has(sessionAgentId)) {
      this.mcpToolsAudited.add(sessionAgentId);
      try {
        await this.attachFilteredMcpTools(sessionAgentId);
      } catch (e) {
        log.warn(`Proactive MCP tool attach failed for ${sessionAgentId}:`, e instanceof Error ? e.message : e);
      }
    }

    // Proactive approval detection via bootstrapState().
    const effectiveAgentId = sessionAgentId || this.store.agentId;
    if (!bootstrapRetried && effectiveAgentId) {
      try {
        const bootstrap = await this.withSessionTimeout(
          session.bootstrapState(),
          `Session bootstrapState (key=${key})`,
        );
        if (bootstrap.hasPendingApproval) {
          const convId = bootstrap.conversationId || session.conversationId;
          log.warn(`Pending approval detected at session startup (key=${key}, conv=${convId}), recovering...`);
          session.close();
          if (convId) {
            const result = await recoverOrphanedConversationApproval(
              effectiveAgentId,
              convId,
              true, /* deepScan */
            );
            if (result.recovered) {
              log.info(`Proactive approval recovery succeeded: ${result.details}`);
            } else {
              log.warn(`Proactive approval recovery did not find resolvable approvals: ${result.details}`);
            }
          }
          return this._createSessionForKey(key, true, generation);
        }
      } catch (err) {
        // bootstrapState failure is non-fatal -- the reactive 409 handler in
        // runSession() will catch stuck approvals.
        log.warn(`bootstrapState check failed (key=${key}), continuing:`, err instanceof Error ? err.message : err);
      }
    }

    if ((this.sessionGenerations.get(key) ?? 0) !== generation) {
      log.info(`Discarding stale session after bootstrapState (key=${key})`);
      session.close();
      return this.ensureSessionForKey(key, bootstrapRetried);
    }

    // LRU eviction: in per-chat mode, limit concurrent sessions to avoid
    // unbounded subprocess growth.
    const maxSessions = this.config.maxSessions ?? 10;
    if (this.config.conversationMode === 'per-chat' && this.sessions.size >= maxSessions) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, ts] of this.sessionLastUsed) {
        if (k === key) continue;
        if (!this.sessions.has(k)) continue;
        // Never evict an active/in-flight key (can close a live stream).
        if (this.processingKeys.has(k) || this.sessionCreationLocks.has(k)) continue;
        if (ts < oldestTime) {
          oldestKey = k;
          oldestTime = ts;
        }
      }
      if (oldestKey) {
        log.info(`LRU session eviction: closing session for key="${oldestKey}" (${this.sessions.size} active, max=${maxSessions})`);
        const evicted = this.sessions.get(oldestKey);
        evicted?.close();
        this.sessions.delete(oldestKey);
        this.sessionLastUsed.delete(oldestKey);
        this.sessionGenerations.delete(oldestKey);
        this.sessionCreationLocks.delete(oldestKey);
        this.lastResultRunFingerprints.delete(oldestKey);
      } else {
        // All existing sessions are active; allow temporary overflow.
        log.debug(`LRU session eviction skipped: all ${this.sessions.size} sessions are active/in-flight`);
      }
    }

    this.sessions.set(key, session);
    this.sessionLastUsed.set(key, Date.now());
    return session;
  }

  /** Get an active session by key (for abort/cancel). */
  getSession(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  /**
   * Destroy session(s). If key provided, destroys only that key.
   * If key is undefined, destroys ALL sessions.
   */
  invalidateSession(key?: string): void {
    if (key) {
      const nextGeneration = (this.sessionGenerations.get(key) ?? 0) + 1;
      this.sessionGenerations.set(key, nextGeneration);
      this.sessionCreationLocks.delete(key);

      const session = this.sessions.get(key);
      if (session) {
        log.info(`Invalidating session (key=${key})`);
        session.close();
        this.sessions.delete(key);
        this.sessionLastUsed.delete(key);
      }
      this.lastResultRunFingerprints.delete(key);
    } else {
      const keys = new Set<string>([
        ...this.sessions.keys(),
        ...this.sessionCreationLocks.keys(),
      ]);
      for (const k of keys) {
        const nextGeneration = (this.sessionGenerations.get(k) ?? 0) + 1;
        this.sessionGenerations.set(k, nextGeneration);
      }

      for (const [k, session] of this.sessions) {
        log.info(`Invalidating session (key=${k})`);
        session.close();
      }
      this.sessions.clear();
      this.sessionCreationLocks.clear();
      this.sessionLastUsed.clear();
      this.lastResultRunFingerprints.clear();
    }
  }

  /**
   * Attach filtered MCP server tools to an agent.
   * For each configured MCP server, looks it up by name, applies
   * allowedTools/excludeTools filter, and attaches the result.
   */
  private async attachFilteredMcpTools(agentId: string): Promise<void> {
    for (const serverConfig of (this.config.mcpServers || [])) {
      try {
        const server = await getMcpServerByName(serverConfig.name);
        if (!server || server.toolIds.length === 0) {
          log.warn(`MCP server "${serverConfig.name}" not found or has no tools`);
          continue;
        }
        const filtered = filterMcpTools(
          server.toolIds, server.toolNames,
          serverConfig.allowedTools, serverConfig.excludeTools,
        );
        if (filtered.toolIds.length > 0) {
          await attachToolsToAgent(agentId, filtered.toolIds);
          log.info(`Attached ${serverConfig.name} tools (${filtered.toolNames.length}/${server.toolNames.length}): ${filtered.toolNames.join(', ')}`);
        }
      } catch (e) {
        log.warn(`Failed to attach MCP tools from "${serverConfig.name}":`, e instanceof Error ? e.message : e);
      }
    }
    if (this.config.mcpServers?.length) {
      await ensureNoToolApprovals(agentId);
    }
  }

  /**
   * Clear the conversation for a sub-agent's scoped Store.
   * Called by bot.ts on /reset in sub-agent mode.
   */
  clearSubAgentConversation(chatKey: string): void {
    const subName = this.subAgentName(chatKey);
    const subStore = new Store('lettabot-agent.json', subName);
    subStore.clearConversation(chatKey);
  }

  /**
   * Pre-warm the session subprocess at startup.
   */
  async warmSession(): Promise<void> {
    this.store.refresh();
    if (!this.store.agentId && !this.store.conversationId) return;
    try {
      const mode = this.config.conversationMode || 'shared';
      if (mode === 'shared') {
        await this.ensureSessionForKey('shared');
      }
    } catch (err) {
      log.warn('Session pre-warm failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Persist conversation ID after a successful session result.
   * Agent ID and first-run setup are handled eagerly in ensureSessionForKey().
   */
  persistSessionState(session: Session, convKey?: string): void {
    // Sub-agent mode: save conversation ID to scoped Store.
    if (this.useSubAgents && convKey && convKey !== 'shared' && convKey !== 'default') {
      if (session.conversationId && session.conversationId !== 'default') {
        const subName = this.subAgentName(convKey);
        const subStore = new Store('lettabot-agent.json', subName);
        subStore.setConversationId(convKey, session.conversationId);
      }
      return;
    }

    // Store-based path (shared/disabled/per-channel modes).
    // Agent ID already persisted in ensureSessionForKey() on creation.
    // Here we only update if the server returned a different one (shouldn't happen).
    if (session.agentId && session.agentId !== this.store.agentId) {
      const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
      this.store.setAgent(session.agentId, currentBaseUrl, session.conversationId || undefined);
      log.info('Agent ID updated:', session.agentId);
    } else if (session.conversationId && session.conversationId !== 'default' && convKey !== 'default') {
      // In per-channel mode, persist per-key. In shared mode, use legacy field.
      // Skip saving "default" -- it's an API alias, not a real conversation ID.
      // In disabled mode (convKey === 'default'), skip -- always use the built-in default.
      if (convKey && convKey !== 'shared') {
        const existing = this.store.getConversationId(convKey);
        if (session.conversationId !== existing) {
          this.store.setConversationId(convKey, session.conversationId);
          log.info(`Conversation ID updated (key=${convKey}):`, session.conversationId);
        }
      } else if (session.conversationId !== this.store.conversationId) {
        this.store.conversationId = session.conversationId;
        log.info('Conversation ID updated:', session.conversationId);
      }
    }
  }

  // =========================================================================
  // Send + stream
  // =========================================================================

  /**
   * Send a message and return a deduplicated stream.
   *
   * Handles:
   * - Persistent session reuse (subprocess stays alive across messages)
   * - CONFLICT recovery from orphaned approvals (retry once)
   * - Conversation-not-found fallback (create new conversation)
   * - Tool call deduplication
   * - Session persistence after result
   */
  async runSession(
    message: SendMessage,
    options: { retried?: boolean; canUseTool?: CanUseToolCallback; convKey?: string } = {},
  ): Promise<{ session: Session; stream: () => AsyncGenerator<StreamMsg> }> {
    const { retried = false, canUseTool, convKey = 'shared' } = options;

    // Update the per-message callback before sending
    this.currentCanUseTool = canUseTool;

    let session = await this.ensureSessionForKey(convKey);

    // Resolve the agent ID and conversation ID for this key (for error recovery)
    let recoveryAgentId: string | null;
    let convId: string | null;
    if (this.useSubAgents && convKey !== 'shared' && convKey !== 'default') {
      const subName = this.subAgentName(convKey);
      const subStore = new Store('lettabot-agent.json', subName);
      recoveryAgentId = subStore.agentId;
      convId = subStore.getConversationId(convKey);
    } else {
      recoveryAgentId = this.store.agentId;
      convId = convKey === 'shared'
        ? this.store.conversationId
        : this.store.getConversationId(convKey);
    }

    // Send message with fallback chain
    try {
      await this.withSessionTimeout(session.send(message), `Session send (key=${convKey})`);
    } catch (error) {
      // 409 CONFLICT from orphaned approval
      if (!retried && isApprovalConflictError(error) && recoveryAgentId && convId) {
        log.info('CONFLICT detected - attempting orphaned approval recovery...');
        this.invalidateSession(convKey);
        const result = await recoverOrphanedConversationApproval(
          recoveryAgentId,
          convId
        );
        if (result.recovered) {
          log.info(`Recovery succeeded (${result.details}), retrying...`);
          return this.runSession(message, { retried: true, canUseTool, convKey });
        }
        log.error(`Orphaned approval recovery failed: ${result.details}`);
        throw error;
      }

      // Conversation/agent not found - try creating a new conversation.
      if (recoveryAgentId && isConversationMissingError(error)) {
        log.warn(`Conversation not found (key=${convKey}), creating a new conversation...`);
        this.invalidateSession(convKey);
        if (this.useSubAgents && convKey !== 'shared' && convKey !== 'default') {
          this.clearSubAgentConversation(convKey);
        } else if (convKey !== 'shared') {
          this.store.clearConversation(convKey);
        } else {
          this.store.conversationId = null;
        }
        session = await this.ensureSessionForKey(convKey);
        try {
          await this.withSessionTimeout(session.send(message), `Session send retry (key=${convKey})`);
        } catch (retryError) {
          this.invalidateSession(convKey);
          throw retryError;
        }
      } else {
        // Unknown error -- invalidate so we get a fresh subprocess next time
        this.invalidateSession(convKey);
        throw error;
      }
    }

    // Persist conversation ID immediately after successful send, before streaming.
    this.persistSessionState(session, convKey);

    // Return session and a stream generator that buffers tool_call chunks and
    // flushes them with fully accumulated arguments on the next type boundary.
    const pendingToolCalls = new Map<string, { msg: StreamMsg; accumulatedArgs: string }>();
    const self = this;
    const capturedConvKey = convKey; // Capture for closure

    /** Merge tool argument strings, handling both delta and cumulative chunking. */
    function mergeToolArgs(existing: string, incoming: string): string {
      if (!incoming) return existing;
      if (!existing) return incoming;
      if (incoming === existing) return existing;
      // Cumulative: latest chunk includes all prior text
      if (incoming.startsWith(existing)) return incoming;
      if (existing.endsWith(incoming)) return existing;
      // Delta: each chunk is an append
      return `${existing}${incoming}`;
    }

    function* flushPending(): Generator<StreamMsg> {
      for (const [, pending] of pendingToolCalls) {
        if (!pending.accumulatedArgs) {
          // No rawArguments accumulated (old SDK or single complete chunk) --
          // preserve the original toolInput from the first chunk as-is.
          yield pending.msg;
          continue;
        }
        let toolInput: Record<string, unknown> = {};
        try { toolInput = JSON.parse(pending.accumulatedArgs); }
        catch { toolInput = { raw: pending.accumulatedArgs }; }
        yield { ...pending.msg, toolInput };
      }
      pendingToolCalls.clear();
      lastPendingToolCallId = null;
    }

    let anonToolCallCounter = 0;
    let lastPendingToolCallId: string | null = null;

    async function* dedupedStream(): AsyncGenerator<StreamMsg> {
      for await (const raw of session.stream()) {
        const msg = raw as StreamMsg;

        if (msg.type === 'tool_call') {
          let id = msg.toolCallId;
          if (!id) {
            // Tool calls without IDs (e.g., from models that don't emit
            // tool_call_id on subsequent argument chunks) still need to be
            // accumulated. Assign a synthetic ID so they enter the buffer.
            // If tool name matches the most recent pending call, treat this as
            // a continuation even when the first chunk had a real toolCallId.
            const currentPending = lastPendingToolCallId ? pendingToolCalls.get(lastPendingToolCallId) : null;
            if (lastPendingToolCallId && currentPending && (currentPending.msg.toolName || 'unknown') === (msg.toolName || 'unknown')) {
              id = lastPendingToolCallId;
            } else {
              id = `__anon_${++anonToolCallCounter}__`;
            }
          }

          const incoming = (msg as StreamMsg & { rawArguments?: string }).rawArguments || '';
          const existing = pendingToolCalls.get(id);
          if (existing) {
            existing.accumulatedArgs = mergeToolArgs(existing.accumulatedArgs, incoming);
          } else {
            pendingToolCalls.set(id, { msg, accumulatedArgs: incoming });
          }
          lastPendingToolCallId = id;
          continue; // buffer, don't yield yet
        }

        // Flush pending tool calls on semantic type boundary (not stream_event)
        if (pendingToolCalls.size > 0 && msg.type !== 'stream_event') {
          yield* flushPending();
        }

        if (msg.type === 'result') {
          // Flush any remaining before result
          yield* flushPending();
          self.persistSessionState(session, capturedConvKey);
        }

        yield msg;

        if (msg.type === 'result') {
          break;
        }
      }

      // Flush remaining at generator end (shouldn't normally happen)
      yield* flushPending();
    }

    return { session, stream: dedupedStream };
  }
}
