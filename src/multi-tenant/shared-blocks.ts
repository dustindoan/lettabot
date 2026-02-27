/**
 * Shared Block Management
 *
 * Creates and caches shared persona/coaching blocks that are attached
 * by reference to all user agents. Updating a shared block once
 * propagates to every agent instantly.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getDataDir } from '../utils/paths.js';
import { loadMemoryBlocks, type MemoryBlock } from '../core/memory.js';
import { createBlock } from '../tools/letta-api.js';

const CACHE_FILE = 'multi-tenant-shared-blocks.json';

interface SharedBlocksCache {
  blockIds: Record<string, string>; // label → blockId
}

function getCachePath(): string {
  return resolve(getDataDir(), CACHE_FILE);
}

function loadCache(): SharedBlocksCache {
  const path = getCachePath();
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      // Corrupted cache — start fresh
    }
  }
  return { blockIds: {} };
}

function saveCache(cache: SharedBlocksCache): void {
  const path = getCachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2));
}

/**
 * Ensure shared blocks exist on the Letta server. Creates them if missing,
 * reuses cached block IDs if already created.
 *
 * Shared blocks are persona/* blocks from .mdx files — they define who the
 * agent is and are identical across all user agents.
 *
 * @param agentName - Name to substitute for {{AGENT_NAME}} in block values
 * @param extraBlocks - Additional shared blocks to create (e.g., training_knowledge)
 * @returns Array of shared block IDs
 */
export async function ensureSharedBlocks(
  agentName: string,
  extraBlocks: MemoryBlock[] = [],
): Promise<string[]> {
  const cache = loadCache();
  const allBlocks = loadMemoryBlocks(agentName);

  // Shared blocks = persona/* labels (agent identity, shared across all users)
  const sharedBlocks = allBlocks.filter(b => b.label.startsWith('persona/'));

  // Add any extra shared blocks (e.g., training_knowledge)
  const toCreate = [...sharedBlocks, ...extraBlocks];

  const blockIds: string[] = [];
  let created = 0;

  for (const block of toCreate) {
    // Check cache first
    if (cache.blockIds[block.label]) {
      blockIds.push(cache.blockIds[block.label]);
      continue;
    }

    // Create on server
    console.log(`[SharedBlocks] Creating shared block: ${block.label}`);
    const blockId = await createBlock({
      label: block.label,
      value: block.value,
      limit: block.limit,
      description: block.description,
    });
    cache.blockIds[block.label] = blockId;
    blockIds.push(blockId);
    created++;
    console.log(`[SharedBlocks] Created: ${block.label} → ${blockId}`);
  }

  if (created > 0) {
    saveCache(cache);
    console.log(`[SharedBlocks] Created ${created} new shared block(s)`);
  } else {
    console.log(`[SharedBlocks] All ${blockIds.length} shared block(s) already exist`);
  }

  return blockIds;
}

/**
 * Get per-user memory blocks — these are created fresh for each new agent.
 * By default, all human/* blocks from .mdx files.
 */
export function getPerUserBlocks(
  agentName: string,
  labels?: string[],
): MemoryBlock[] {
  const allBlocks = loadMemoryBlocks(agentName);

  if (labels && labels.length > 0) {
    return allBlocks.filter(b => labels.some(l => b.label.startsWith(l)));
  }

  // Default: human/* blocks
  return allBlocks.filter(b => b.label.startsWith('human/'));
}
