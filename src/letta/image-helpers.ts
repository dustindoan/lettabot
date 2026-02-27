/**
 * Image helper utilities.
 *
 * These replace imageFromFile/imageFromURL from @letta-ai/letta-code-sdk.
 * Node-specific (uses fs, fetch). For Expo, these would use a different
 * implementation (e.g., expo-file-system).
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { MessageContentItem } from './types.js';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

/**
 * Create a MessageContentItem from a local file path.
 * Reads the file synchronously and base64-encodes it.
 */
export function imageFromFile(path: string): MessageContentItem {
  const ext = extname(path).toLowerCase();
  const mediaType = MIME_TYPES[ext] || 'image/png';
  const data = readFileSync(path).toString('base64');
  return {
    type: 'image',
    source: { type: 'base64', mediaType, data },
  };
}

/**
 * Create a MessageContentItem from a URL.
 * Fetches the image and base64-encodes it.
 */
export async function imageFromURL(url: string): Promise<MessageContentItem> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${url}: ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || 'image/png';
  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer).toString('base64');
  return {
    type: 'image',
    source: { type: 'base64', mediaType: contentType, data },
  };
}
