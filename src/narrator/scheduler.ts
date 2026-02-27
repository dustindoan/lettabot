/**
 * Narrator Scheduler
 *
 * Triggers periodic synthesis runs on the Narrator agent.
 * Supports schedule-based (setInterval), event-driven (conversation counting),
 * and manual triggers. Enforces minimum spacing between runs.
 *
 * The Narrator is a single agent — not per-user — so this service
 * calls triggerSynthesis() directly (Letta REST API), not through
 * the multi-tenant bot.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCronLogPath } from '../utils/paths.js';
import { triggerSynthesis, type SynthesisOptions } from './synthesize.js';

const LOG_PATH = getCronLogPath();

function logEvent(event: string, data: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    source: 'narrator',
    event,
    ...data,
  };
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // Ignore logging failures
  }
  console.log(`[Narrator Scheduler] ${event}:`, JSON.stringify(data));
}

export interface NarratorSchedulerConfig {
  enabled: boolean;
  /** Interval in minutes between scheduled synthesis runs (default: 1440 = daily) */
  intervalMinutes: number;
  /** Trigger after this many conversations since last synthesis (0 = disabled) */
  conversationThreshold: number;
  /** Minimum minutes between any two synthesis runs (default: 60) */
  minIntervalMinutes: number;
  /** Additional context for the synthesis prompt */
  context?: string;
}

export class NarratorScheduler {
  private config: NarratorSchedulerConfig;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastSynthesisAt: Date | null = null;
  private conversationsSinceSynthesis = 0;
  private running = false; // mutex to prevent concurrent synthesis

  constructor(config: NarratorSchedulerConfig) {
    this.config = config;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  start(): void {
    if (!this.config.enabled) {
      console.log('[Narrator Scheduler] Disabled');
      return;
    }

    if (this.intervalId) {
      console.log('[Narrator Scheduler] Already running');
      return;
    }

    // Cap at 24 hours — setInterval overflows at 2^31-1 ms (~24.8 days)
    const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const rawMs = this.config.intervalMinutes * 60 * 1000;
    const intervalMs = Math.min(rawMs, MAX_INTERVAL_MS);

    console.log(
      `[Narrator Scheduler] Starting (every ${this.config.intervalMinutes}m, ` +
        `conversation threshold: ${this.config.conversationThreshold || 'disabled'}, ` +
        `min spacing: ${this.config.minIntervalMinutes}m)`,
    );
    console.log(
      `[Narrator Scheduler] First scheduled synthesis in ${this.config.intervalMinutes} minutes`,
    );

    // When interval exceeds 24h, the timer fires daily but runSynthesis
    // checks lastSynthesisAt and skips if the configured interval hasn't elapsed
    this.intervalId = setInterval(() => this.runSynthesis('schedule'), intervalMs);
    // Allow process to exit even with timer running
    this.intervalId.unref?.();

    logEvent('scheduler_started', {
      intervalMinutes: this.config.intervalMinutes,
      conversationThreshold: this.config.conversationThreshold,
      minIntervalMinutes: this.config.minIntervalMinutes,
    });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Narrator Scheduler] Stopped');
    }
  }

  // =========================================================================
  // Manual trigger (for API endpoint and CLI testing)
  // =========================================================================

  async trigger(options?: SynthesisOptions): Promise<string> {
    console.log('[Narrator Scheduler] Manual trigger requested');
    return this.runSynthesis('manual', options);
  }

  // =========================================================================
  // Event-driven: conversation counter
  // =========================================================================

  /**
   * Called after each coaching conversation completes.
   * Increments the counter and triggers synthesis if threshold is reached.
   */
  recordConversation(): void {
    if (!this.config.enabled) return;

    this.conversationsSinceSynthesis++;
    const threshold = this.config.conversationThreshold;

    if (threshold > 0 && this.conversationsSinceSynthesis >= threshold) {
      console.log(
        `[Narrator Scheduler] Conversation threshold reached ` +
          `(${this.conversationsSinceSynthesis}/${threshold})`,
      );
      // Fire-and-forget — don't block the conversation
      this.runSynthesis('conversation_threshold').catch(err => {
        console.error('[Narrator Scheduler] Event-driven synthesis failed:', err);
      });
    }
  }

  // =========================================================================
  // Status (for API endpoint and debugging)
  // =========================================================================

  getStatus(): {
    enabled: boolean;
    running: boolean;
    lastSynthesisAt: string | null;
    conversationsSinceSynthesis: number;
    config: NarratorSchedulerConfig;
  } {
    return {
      enabled: this.config.enabled,
      running: this.running,
      lastSynthesisAt: this.lastSynthesisAt?.toISOString() ?? null,
      conversationsSinceSynthesis: this.conversationsSinceSynthesis,
      config: this.config,
    };
  }

  // =========================================================================
  // Core synthesis runner with debounce/spacing
  // =========================================================================

  private async runSynthesis(
    source: 'schedule' | 'conversation_threshold' | 'manual',
    options?: SynthesisOptions,
  ): Promise<string> {
    // Mutex: prevent concurrent synthesis runs
    if (this.running) {
      const msg = 'Synthesis already in progress — skipping';
      console.log(`[Narrator Scheduler] ${msg}`);
      logEvent('synthesis_skipped_concurrent', { source });
      return msg;
    }

    // Spacing check (manual triggers bypass this)
    // For scheduled triggers, use the full configured interval (handles capped timer wakeups).
    // For event-driven triggers, use the minimum spacing floor.
    if (source !== 'manual' && this.lastSynthesisAt) {
      const elapsed = Date.now() - this.lastSynthesisAt.getTime();
      const spacingMin = source === 'schedule'
        ? Math.max(this.config.intervalMinutes, this.config.minIntervalMinutes)
        : this.config.minIntervalMinutes;
      const minMs = spacingMin * 60 * 1000;
      if (elapsed < minMs) {
        const remainingMin = Math.ceil((minMs - elapsed) / 60000);
        const msg = `Too soon since last synthesis (${remainingMin}m remaining) — skipping`;
        console.log(`[Narrator Scheduler] ${msg}`);
        logEvent('synthesis_skipped_too_recent', {
          source,
          lastSynthesisAt: this.lastSynthesisAt.toISOString(),
          remainingMinutes: remainingMin,
        });
        return msg;
      }
    }

    this.running = true;
    const startTime = Date.now();

    logEvent('synthesis_starting', { source, dryRun: options?.dryRun ?? false });

    try {
      const response = await triggerSynthesis({
        dryRun: options?.dryRun,
        context: options?.context ?? this.config.context,
      });

      const durationMs = Date.now() - startTime;
      this.lastSynthesisAt = new Date();
      this.conversationsSinceSynthesis = 0;

      logEvent('synthesis_completed', {
        source,
        dryRun: options?.dryRun ?? false,
        durationMs,
        responseLength: response.length,
      });

      return response;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logEvent('synthesis_failed', {
        source,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.running = false;
    }
  }
}
