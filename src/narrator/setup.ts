/**
 * Narrator Setup
 *
 * Creates the Narrator agent on Letta with its system prompt,
 * custom tools, memory blocks, and reference material folder.
 * Idempotent — safe to call on every startup.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getDataDir } from '../utils/paths.js';
import {
  findAgentByName,
  createAgentWithBlocks,
  upsertToolFromSource,
  attachToolsToAgent,
  createFolder,
  findFolderByName,
  attachFolderToAgent,
  listFolderFiles,
  ensureNoToolApprovals,
  type CompactionConfig,
} from '../tools/letta-api.js';
import { NARRATOR_SYSTEM_PROMPT } from './system-prompt.js';
import { makeToolSources } from './tools.js';

const NARRATOR_CACHE_FILE = 'narrator-state.json';
const NARRATOR_AGENT_NAME = 'Wally-Narrator';
const REFERENCE_FOLDER_NAME = 'coaching-reference-material';

export interface NarratorState {
  agentId: string;
  folderId: string;
  toolIds: string[];
  createdAt: string;
}

function getCachePath(): string {
  return resolve(getDataDir(), NARRATOR_CACHE_FILE);
}

export function loadNarratorCache(): NarratorState | null {
  const path = getCachePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function saveNarratorCache(state: NarratorState): void {
  const path = getCachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Ensure the Narrator agent exists on Letta. Creates it if missing.
 * Returns the Narrator's agent ID and folder ID.
 */
export async function ensureNarrator(options: {
  lettaBaseUrl: string;
  model: string;
  compaction?: CompactionConfig;
}): Promise<NarratorState> {
  // Check cache first — but re-run setup if folderId is missing
  const cached = loadNarratorCache();
  if (cached && cached.folderId) {
    console.log(`[Narrator] Using cached Narrator agent: ${cached.agentId}`);
    return cached;
  }
  if (cached && !cached.folderId) {
    console.log(`[Narrator] Cached state has no folderId — re-running folder setup`);
  }

  // Check if agent already exists on server (by name)
  const existing = await findAgentByName(NARRATOR_AGENT_NAME);
  if (existing) {
    console.log(`[Narrator] Found existing Narrator agent: ${existing.id}`);
    // Recreate cache with existing agent — we'll re-register tools below
  }

  // Register custom tools
  console.log('[Narrator] Registering custom tools...');
  const toolSources = makeToolSources(options.lettaBaseUrl);
  const toolIds: string[] = [];
  for (const [name, { source, description }] of Object.entries(toolSources)) {
    try {
      const tool = await upsertToolFromSource({
        source_code: source,
        description,
        tags: ['narrator'],
      });
      toolIds.push(tool.id);
      console.log(`[Narrator] Registered tool: ${name} → ${tool.id}`);
    } catch (e) {
      console.error(`[Narrator] Failed to register tool "${name}":`, e);
    }
  }

  // Create or find reference folder
  let folderId = cached?.folderId || '';
  if (!folderId) {
    try {
      folderId = await createFolder(REFERENCE_FOLDER_NAME, 'Coaching reference material — books, excerpts, notes');
      console.log(`[Narrator] Created reference folder: ${folderId}`);
    } catch (e) {
      console.warn(`[Narrator] Folder creation failed — searching for existing:`, e instanceof Error ? e.message : e);
      const existing = await findFolderByName(REFERENCE_FOLDER_NAME);
      if (existing) {
        folderId = existing;
        console.log(`[Narrator] Found existing folder: ${folderId}`);
      } else {
        console.error(`[Narrator] Could not create or find reference folder`);
      }
    }
  }

  let agentId: string;

  if (existing) {
    agentId = existing.id;
    // Attach any new tools to existing agent
    if (toolIds.length > 0) {
      await attachToolsToAgent(agentId, toolIds);
    }
    // Attach folder if we have one
    if (folderId) {
      try {
        await attachFolderToAgent(agentId, folderId);
      } catch {
        // May already be attached
      }
    }
  } else {
    // Create the Narrator agent
    console.log('[Narrator] Creating Narrator agent...');
    agentId = await createAgentWithBlocks({
      name: NARRATOR_AGENT_NAME,
      system: NARRATOR_SYSTEM_PROMPT,
      model: options.model,
      blockIds: [], // No shared persona blocks — Narrator reads/writes them via tools
      memoryBlocks: [
        {
          label: 'narrator/state',
          value: 'No synthesis has been performed yet. This is a fresh start.',
          limit: 20000,
          description: 'Temporal working memory. Last synthesis timestamp, what changed, what to watch for next. Updated at the start and end of each synthesis run.',
        },
        {
          label: 'narrator/reflection',
          value: 'No reflections yet. This block will contain meta-observations: tensions being tracked, patterns across agents, what to explore on next re-read.',
          limit: 50000,
          description: 'Longer-term coaching journal. Tensions, patterns across synthesis runs, evolving understanding. Entries should be timestamped.',
        },
        {
          label: 'narrator/reference_index',
          value: 'No reference material has been reviewed yet.',
          limit: 20000,
          description: 'Index of reference materials. Tracks which sources exist, what has been extracted, what feels under-explored, when each was last read.',
        },
      ],
      compaction: options.compaction,
    });
    console.log(`[Narrator] Created Narrator agent: ${agentId}`);

    // Attach tools
    if (toolIds.length > 0) {
      await attachToolsToAgent(agentId, toolIds);
    }

    // Attach folder
    if (folderId) {
      try {
        await attachFolderToAgent(agentId, folderId);
      } catch (e) {
        console.warn(`[Narrator] Failed to attach folder:`, e instanceof Error ? e.message : e);
      }
    }

    // Disable tool approvals for headless operation
    await ensureNoToolApprovals(agentId);
  }

  const state: NarratorState = {
    agentId,
    folderId,
    toolIds,
    createdAt: new Date().toISOString(),
  };
  saveNarratorCache(state);
  console.log(`[Narrator] Setup complete. Agent: ${agentId}, Folder: ${folderId}, Tools: ${toolIds.length}`);

  return state;
}
