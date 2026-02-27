#!/usr/bin/env node
/**
 * lettabot-narrator - Trigger and monitor Narrator synthesis
 *
 * Usage:
 *   lettabot-narrator synthesize                         # Full synthesis
 *   lettabot-narrator synthesize --dry-run               # Dry-run (no block updates)
 *   lettabot-narrator synthesize --context "Focus on X"  # With author context
 *   lettabot-narrator status                             # Show scheduler state
 */

import { loadAppConfigOrExit, applyConfigToEnv } from '../config/index.js';
const config = loadAppConfigOrExit();
applyConfigToEnv(config);

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ───────────────────────────────────────────────────────────────────────
// API connection
// ───────────────────────────────────────────────────────────────────────

function getApiKey(): string {
  if (process.env.LETTABOT_API_KEY) {
    return process.env.LETTABOT_API_KEY;
  }
  const filePath = resolve(process.cwd(), 'lettabot-api.json');
  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (data.apiKey) return data.apiKey;
    } catch {
      // Fall through
    }
  }
  console.error('Error: No API key found. Set LETTABOT_API_KEY or ensure lettabot-api.json exists.');
  process.exit(1);
}

function getApiBaseUrl(): string {
  const port = process.env.PORT || '8080';
  const host = process.env.API_HOST || '127.0.0.1';
  return `http://${host}:${port}`;
}

async function apiRequest(method: string, path: string, body?: Record<string, unknown>): Promise<any> {
  const url = `${getApiBaseUrl()}${path}`;
  const apiKey = getApiKey();

  const options: RequestInit = {
    method,
    headers: {
      'X-Api-Key': apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text();
    let msg = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      msg = parsed.error || parsed.message || msg;
    } catch {
      msg = text || msg;
    }
    throw new Error(msg);
  }

  return response.json();
}

// ───────────────────────────────────────────────────────────────────────
// Commands
// ───────────────────────────────────────────────────────────────────────

async function synthesize(dryRun: boolean, context?: string): Promise<void> {
  console.log(`Triggering Narrator synthesis${dryRun ? ' (dry-run)' : ''}...`);
  if (context) {
    console.log(`Context: ${context}`);
  }
  console.log();

  const startTime = Date.now();

  try {
    const result = await apiRequest('POST', '/api/v1/narrator/synthesize', {
      dryRun,
      ...(context ? { context } : {}),
    });

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`Synthesis complete (${durationSec}s)`);
    console.log(`  Dry run:         ${result.dryRun}`);
    console.log(`  Response length: ${result.responseLength} chars`);
    if (result.preview) {
      console.log();
      console.log('Preview:');
      console.log('─'.repeat(60));
      console.log(result.preview);
      if (result.responseLength > 500) {
        console.log(`... (${result.responseLength - 500} more chars)`);
      }
      console.log('─'.repeat(60));
    }
  } catch (error) {
    console.error(`Synthesis failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

async function status(): Promise<void> {
  try {
    const result = await apiRequest('GET', '/api/v1/narrator/status');

    console.log('Narrator Scheduler Status');
    console.log('─'.repeat(40));
    console.log(`  Enabled:          ${result.enabled}`);
    console.log(`  Running:          ${result.running}`);
    console.log(`  Last synthesis:   ${result.lastSynthesisAt || 'never'}`);
    console.log(`  Conversations:    ${result.conversationsSinceSynthesis}`);
    console.log();
    console.log('Configuration:');
    console.log(`  Interval:         ${result.config.intervalMinutes}m`);
    console.log(`  Conv. threshold:  ${result.config.conversationThreshold || 'disabled'}`);
    console.log(`  Min spacing:      ${result.config.minIntervalMinutes}m`);
  } catch (error) {
    console.error(`Failed to get status: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

// ───────────────────────────────────────────────────────────────────────
// CLI parsing
// ───────────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
lettabot-narrator - Trigger and monitor Narrator synthesis

Commands:
  synthesize   Trigger a Narrator synthesis run
  status       Show scheduler state

Options for 'synthesize':
  --dry-run              Describe changes without applying them
  --context <text>       Additional context for the synthesis prompt

Examples:
  lettabot-narrator synthesize
  lettabot-narrator synthesize --dry-run
  lettabot-narrator synthesize --context "Focus on recovery principles"
  lettabot-narrator status
`.trim());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
  }

  if (command === 'synthesize') {
    const dryRun = args.includes('--dry-run');
    let context: string | undefined;
    const contextIdx = args.indexOf('--context');
    if (contextIdx !== -1 && args[contextIdx + 1]) {
      context = args[contextIdx + 1];
    }
    await synthesize(dryRun, context);
  } else if (command === 'status') {
    await status();
  } else {
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
