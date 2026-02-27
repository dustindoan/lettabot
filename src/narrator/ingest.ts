/**
 * Reference Material Ingestion
 *
 * Uploads markdown and PDF files from lettabot/reference/ to the
 * Narrator's Letta folder. Letta handles chunking, embedding, and
 * indexing automatically. Tracks uploaded files to avoid re-uploading.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { getDataDir } from '../utils/paths.js';
import { uploadFileToFolder, listFolderFiles } from '../tools/letta-api.js';

const MANIFEST_FILE = 'narrator-uploads.json';
const SUPPORTED_EXTENSIONS = ['.md', '.pdf', '.txt'];

interface UploadManifest {
  uploads: Record<string, { uploadedAt: string; fileSize: number }>;
}

function getManifestPath(): string {
  return resolve(getDataDir(), MANIFEST_FILE);
}

function loadManifest(): UploadManifest {
  const path = getManifestPath();
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      // Corrupted — start fresh
    }
  }
  return { uploads: {} };
}

function saveManifest(manifest: UploadManifest): void {
  const path = getManifestPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

/**
 * Ingest reference material from the reference/ directory into the Narrator's folder.
 * Only uploads files that haven't been uploaded before (tracked by manifest).
 *
 * @param referenceDir - Path to the reference/ directory
 * @param folderId - Letta folder ID for reference material
 * @returns Number of files uploaded
 */
export async function ingestReferenceFiles(referenceDir: string, folderId: string): Promise<number> {
  if (!folderId) {
    console.warn('[Narrator Ingest] No folder ID — skipping ingestion');
    return 0;
  }

  if (!existsSync(referenceDir)) {
    console.log(`[Narrator Ingest] Reference directory not found: ${referenceDir}`);
    return 0;
  }

  const files = readdirSync(referenceDir).filter(f => {
    const ext = f.substring(f.lastIndexOf('.'));
    return SUPPORTED_EXTENSIONS.includes(ext);
  });

  if (files.length === 0) {
    console.log('[Narrator Ingest] No reference files found');
    return 0;
  }

  const manifest = loadManifest();

  // Check what's already on the server
  let serverFiles: Array<{ id: string; file_name: string }> = [];
  try {
    serverFiles = await listFolderFiles(folderId);
  } catch {
    // Folder may be new — no files yet
  }
  const serverFileNames = new Set(serverFiles.map(f => f.file_name));

  let uploaded = 0;

  for (const file of files) {
    const filePath = resolve(referenceDir, file);

    // Skip empty files (placeholders with no content yet)
    const content = readFileSync(filePath, 'utf-8');
    if (content.trim().length < 50) {
      console.log(`[Narrator Ingest] Skipping "${file}" — too short (placeholder?)`);
      continue;
    }

    // Skip if already uploaded (check manifest AND server)
    const fileSize = Buffer.byteLength(content, 'utf-8');
    const manifestEntry = manifest.uploads[file];
    if (manifestEntry && manifestEntry.fileSize === fileSize && serverFileNames.has(file)) {
      continue; // Already uploaded, same size, still on server
    }

    // Upload
    try {
      console.log(`[Narrator Ingest] Uploading "${file}" (${fileSize} bytes)...`);
      await uploadFileToFolder(folderId, filePath, file);
      manifest.uploads[file] = {
        uploadedAt: new Date().toISOString(),
        fileSize,
      };
      uploaded++;
    } catch (e) {
      console.error(`[Narrator Ingest] Failed to upload "${file}":`, e instanceof Error ? e.message : e);
    }
  }

  if (uploaded > 0) {
    saveManifest(manifest);
    console.log(`[Narrator Ingest] Uploaded ${uploaded} reference file(s)`);
  } else {
    console.log(`[Narrator Ingest] All ${files.length} reference file(s) already ingested`);
  }

  return uploaded;
}
