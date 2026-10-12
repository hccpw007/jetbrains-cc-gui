/**
 * Attachment handling service module.
 * Responsible for loading and processing attachments.
 */

import fs from 'fs';
import { mkdir, writeFile, readdir, stat as statAsync, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {
  loadVisionMcpConfig,
  resolveVisionMcpToolName,
  buildVisionMcpPrompt,
} from './vision-mcp-config.js';

// Temp image directory shared by the vision-MCP path mode; also retained for
// cleanup of image files written by older plugin versions.
const TEMP_IMAGE_SUBDIR = 'cc-gui-images';
// Files older than 24h are removed at daemon startup to bound disk growth.
const TEMP_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read attachment JSON (path specified via CLAUDE_ATTACHMENTS_FILE environment variable).
 * @deprecated Use loadAttachmentsFromStdin instead to avoid file I/O.
 */
export function loadAttachmentsFromEnv() {
  try {
    const filePath = process.env.CLAUDE_ATTACHMENTS_FILE;
    if (!filePath) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const arr = JSON.parse(content);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch (e) {
    console.error('[ATTACHMENTS] Failed to load attachments:', e.message);
    return [];
  }
}

/**
 * Read attachment data from stdin (async).
 * The Java side sends a JSON-formatted attachment array via stdin, avoiding temporary files.
 * Format: { "attachments": [...], "message": "user message" }
 */
export async function readStdinData() {
  return new Promise((resolve) => {
    // Check if the environment variable indicates stdin should be used
    if (process.env.CLAUDE_USE_STDIN !== 'true') {
      resolve(null);
      return;
    }

    let data = '';
    const timeout = setTimeout(() => {
      resolve(null);
    }, 5000); // 5-second timeout

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      if (data.trim()) {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          console.error('[STDIN] Failed to parse stdin JSON:', e.message);
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[STDIN] Error reading stdin:', err.message);
      resolve(null);
    });

    // Start reading
    process.stdin.resume();
  });
}

/**
 * Load attachments from stdin or environment variable file (supports both methods).
 * Prefers stdin; falls back to file-based loading if stdin data is not available.
 *
 * Supported stdinData formats:
 * 1. Direct array format: [{fileName, mediaType, data}, ...]
 * 2. Wrapped object format: { attachments: [...] }
 */
export async function loadAttachments(stdinData) {
  // Prefer data passed via stdin
  if (stdinData) {
    // Format 1: Direct array format (sent from Java side)
    if (Array.isArray(stdinData)) {
      return stdinData;
    }
    // Format 2: Wrapped object format
    if (Array.isArray(stdinData.attachments)) {
      return stdinData.attachments;
    }
  }

  // Fall back to file-based loading (backward compatible with older versions)
  return loadAttachmentsFromEnv();
}

/**
 * Save base64 image data to a temporary file (vision-MCP path transmission).
 *
 * Vision-MCP mode hands the model a local path instead of a structured image
 * block, so the configured image-recognition MCP tool (or the Read tool) can
 * load the bytes from disk regardless of proxy image support.
 *
 * @param {string} base64Data - Base64-encoded image data (no "data:" prefix)
 * @param {string} mediaType - MIME type (e.g. "image/png")
 * @param {string} fileName - Original file name (optional)
 * @returns {string|null} Absolute path to the saved file, or null on failure
 */
async function saveImageToTemp(base64Data, mediaType, fileName) {
  try {
    if (!base64Data || typeof base64Data !== 'string') {
      return null;
    }
    const ext = (typeof mediaType === 'string' && mediaType.split('/')[1])
      ? mediaType.split('/')[1].toLowerCase()
      : 'png';
    const tempDir = path.join(os.tmpdir(), TEMP_IMAGE_SUBDIR);
    await mkdir(tempDir, { recursive: true });

    let safeName;
    const uniqueId = crypto.randomUUID();
    if (fileName && typeof fileName === 'string') {
      const baseName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
      safeName = `${uniqueId}-${baseName}`;
    } else {
      safeName = `image-${uniqueId}.${ext}`;
    }

    const filePath = path.join(tempDir, safeName);
    await writeFile(filePath, Buffer.from(base64Data, 'base64'));
    return filePath;
  } catch (e) {
    console.error('[ATTACHMENTS] Failed to save image to temp:', e.message);
    return null;
  }
}

/**
 * Best-effort cleanup of old temp image files (>24h old). Called at daemon
 * startup so failed/abandoned writes from previous sessions don't accumulate.
 * Errors are swallowed — cleanup is non-critical.
 */
export async function cleanupStaleTempImages() {
  try {
    const tempDir = path.join(os.tmpdir(), TEMP_IMAGE_SUBDIR);
    const entries = await readdir(tempDir).catch(() => null);
    if (!entries) return;
    const now = Date.now();
    await Promise.all(entries.map(async (name) => {
      const filePath = path.join(tempDir, name);
      try {
        const info = await statAsync(filePath);
        if (info.isFile() && now - info.mtimeMs > TEMP_IMAGE_TTL_MS) {
          await unlink(filePath);
        }
      } catch {
        // Ignore individual cleanup failures (file may be in use or already gone).
      }
    }));
  } catch {
    // Cleanup is best-effort.
  }
}

/**
 * Build user message content blocks (supports images and text).
 *
 * Image transmission strategy depends on the vision-MCP settings (loaded from
 * ~/.codemoss/config.json via vision-mcp-config.js):
 * - enabled on: images are saved to temp files and injected as references the
 *   model is asked to resolve via the selected vision MCP tool (or the Read
 *   tool when no MCP server name is configured yet). Native vision blocks are
 *   never produced, so a `claude-*` name served by a non-vision proxy
 *   (DeepSeek et al.) no longer yields "[Unsupported Image]".
 * - enabled off: every image stays an inline base64 vision content block.
 *   Provider aliases do not describe vision capabilities, and replacing images
 *   with file paths loses visual input on endpoints that only accept images in
 *   user content blocks (#1725: large images failed through third-party APIs).
 *
 * @param {Array} attachments - Attachment array
 * @param {string} message - User message text
 * @param {string|null} modelId - Unused placeholder kept for call-site
 *                                  compatibility; the image strategy no longer
 *                                  depends on the model name.
 * @param {Object} [opts] - Optional overrides (kept internal so the three call
 *        sites in message-sender.js stay untouched):
 *        - cwd: working directory for project-scoped MCP config.
 *        - loadVisionMcpConfig: injectable config loader for tests.
 *        - resolveVisionMcpToolName: injectable tool resolver for tests.
 * @returns {Array} Content block array
 */
export async function buildContentBlocks(attachments, message, modelId = null, opts = {}) {
  const visionConfig = (opts.loadVisionMcpConfig || loadVisionMcpConfig)();
  const contentBlocks = [];
  const imagePathRefs = [];

  for (const a of attachments) {
    const mt = typeof a.mediaType === 'string' ? a.mediaType : '';
    if (mt.startsWith('image/')) {
      // Vision-MCP mode gives the model a local path to resolve; otherwise the
      // image stays a structured block the endpoint receives directly.
      if (visionConfig.enabled) {
        const tempPath = await saveImageToTemp(a.data, mt, a.fileName);
        if (tempPath) {
          // Carry mediaType/data alongside the path rather than a bare path:
          // with mixed attachments (image + text + image) indexing the original
          // array by ref-index would alias across the text entry, so record the
          // image's own info at save time.
          imagePathRefs.push({ path: tempPath, mediaType: mt, data: a.data });
          console.log('[ATTACHMENTS] Saved image to temp for vision MCP:', tempPath);
        } else {
          contentBlocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mt || 'image/png', data: a.data }
          });
        }
      } else {
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mt || 'image/png', data: a.data }
        });
      }
    } else {
      const name = a.fileName || 'Attachment';
      contentBlocks.push({ type: 'text', text: `[Attachment: ${name}]` });
    }
  }

  let userText = message;
  if (!userText || userText.trim() === '') {
    // Count both structured blocks and vision-MCP path refs: the latter never
    // enter contentBlocks, so an image-only upload would otherwise look empty.
    const totalImages = contentBlocks.filter(b => b.type === 'image').length + imagePathRefs.length;
    const textCount = contentBlocks.filter(b => b.type === 'text').length;
    if (totalImages > 0) {
      userText = `[Uploaded ${totalImages} image(s)]`;
    } else if (textCount > 0) {
      userText = `[Uploaded attachment(s)]`;
    } else {
      userText = '[Empty message]';
    }
  }

  if (imagePathRefs.length > 0) {
    // Vision MCP is on here (off never produces path refs). When a server name
    // is configured, steer the model to that MCP tool; the tool name is
    // discovered at runtime (only the configured server is probed) so any image
    // MCP works without a hard-coded server-to-tool mapping. With no server
    // name set yet, keep the path + Read-tool hint so images still resolve.
    let mcpPrompt = null;
    if (visionConfig.mcpName) {
      const { toolName } = await resolveVisionMcpToolName(
        visionConfig.mcpName, opts.cwd, opts.resolveVisionMcpToolName);
      mcpPrompt = buildVisionMcpPrompt(
        imagePathRefs, visionConfig.mcpName, toolName, visionConfig.transmission);
    }
    userText = mcpPrompt
      ? `${mcpPrompt}\n\n${userText}`
      : `${imagePathRefs
          .map((img, idx) => `[Image #${idx + 1}: ${img.path}]`)
          .join('\n')}\n\nThe user has attached the image(s) above. Please use the Read tool to view them.\n\n${userText}`;
  }

  contentBlocks.push({ type: 'text', text: userText });

  return contentBlocks;
}
