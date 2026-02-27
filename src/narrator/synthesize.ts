/**
 * Synthesis Trigger
 *
 * Sends a temporally-framed synthesis prompt to the Narrator agent.
 * The Narrator then autonomously searches reference material,
 * reads conversations, and updates shared blocks.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sendAgentMessage, getBlock, type BlockInfo } from '../tools/letta-api.js';
import { loadNarratorCache } from './setup.js';
import { getDataDir } from '../utils/paths.js';

export interface SynthesisOptions {
  /** If true, ask the Narrator to describe changes without applying them */
  dryRun?: boolean;
  /** Additional context to include in the synthesis prompt */
  context?: string;
}

/**
 * Load shared block IDs from the cache so the Narrator knows which blocks to update.
 */
function loadSharedBlockIds(): Record<string, string> {
  const cachePath = resolve(getDataDir(), 'multi-tenant-shared-blocks.json');
  if (!existsSync(cachePath)) return {};
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
    return data.blockIds || {};
  } catch {
    return {};
  }
}

/**
 * Build the synthesis prompt with temporal framing.
 */
function buildSynthesisPrompt(options: SynthesisOptions & {
  narratorState?: string;
  narratorReflection?: string;
  sharedBlocks?: Record<string, string>;
}): string {
  const now = new Date();
  const timestamp = now.toISOString();
  const formatted = now.toLocaleString();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const dryRunNote = options.dryRun
    ? `\n\n**DRY RUN MODE**: Describe what you WOULD change in each block, but do NOT call update_shared_block. Show your reasoning and proposed changes as text output only.`
    : '';

  const contextNote = options.context
    ? `\n\nAdditional context from the Author:\n${options.context}`
    : '';

  // Include the Narrator's last state for temporal continuity
  const stateSection = options.narratorState
    ? `\nYour narrator/state block currently says:\n---\n${options.narratorState}\n---\n`
    : '\nThis appears to be your first synthesis run.\n';

  const reflectionSection = options.narratorReflection
    ? `\nYour narrator/reflection block currently says:\n---\n${options.narratorReflection}\n---\n`
    : '';

  // Include shared block IDs so the Narrator can call update_shared_block directly
  const blockIds = options.sharedBlocks || {};
  const blockSection = Object.keys(blockIds).length > 0
    ? `\nShared persona blocks (use these IDs with update_shared_block):\n${Object.entries(blockIds).map(([label, id]) => `- ${label}: ${id}`).join('\n')}\n`
    : '';

  return `
SYNTHESIS REQUESTED
Time: ${formatted} (${timezone})
Timestamp: ${timestamp}
${stateSection}
${reflectionSection}
${blockSection}

It's time to synthesize. Follow your system instructions for the synthesis process:

1. Orient temporally — review your state. How long since last synthesis? What were you watching for?

2. Re-read reference material — search your archival memory for principles that feel relevant now. Remember: the same passage says different things at different points.

3. Read coaching conversations — use list_coaching_agents to find active agents, then read their recent conversations. Look for patterns, tensions, moments of success and struggle.

4. Read current shared blocks — use get_current_blocks on a coaching agent to see the current coaching identity.

5. Reflect — what should evolve? What's been validated? What's incomplete?

6. Update shared blocks — use update_shared_block to evolve existing blocks. You can update both content and description to repurpose a block's meaning. Every change affects all coaching agents instantly.

7. Update your own memory — use core_memory_replace to update narrator/state with what you did and what to watch for next. Update narrator/reflection with longer-term observations.
${dryRunNote}${contextNote}

Begin.
`.trim();
}

/**
 * Trigger a synthesis run on the Narrator agent.
 *
 * @returns The Narrator's text response (reasoning/output)
 */
export async function triggerSynthesis(options: SynthesisOptions = {}): Promise<string> {
  const cache = loadNarratorCache();
  if (!cache) {
    throw new Error('Narrator not set up. Run ensureNarrator() first.');
  }

  console.log(`[Narrator Synthesis] Triggering${options.dryRun ? ' (DRY RUN)' : ''}...`);

  // Read the Narrator's current state blocks for temporal context
  let narratorState: string | undefined;
  let narratorReflection: string | undefined;

  // We can't read the Narrator's own blocks directly by label via the API
  // without knowing the block IDs. Instead, we pass the prompt and let the
  // Narrator read its own core memory via the built-in core_memory tools.
  // But we CAN include a hint about temporal context.

  // Load shared block IDs so the Narrator can update blocks even without coaching agents
  const sharedBlocks = loadSharedBlockIds();

  const prompt = buildSynthesisPrompt({
    ...options,
    narratorState,
    narratorReflection,
    sharedBlocks,
  });

  const response = await sendAgentMessage(cache.agentId, prompt);

  console.log(`[Narrator Synthesis] Complete. Response length: ${response.length} chars`);
  if (options.dryRun) {
    console.log('[Narrator Synthesis] DRY RUN — no blocks were updated');
  }

  return response;
}
