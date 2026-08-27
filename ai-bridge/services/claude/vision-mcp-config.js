/**
 * Vision MCP configuration module.
 *
 * Owns the settings for routing attached images through an image-recognition MCP
 * instead of native Anthropic vision blocks. Settings are persisted by the plugin
 * into ~/.codemoss/config.json (top-level keys) and read here by the daemon at
 * message time, so all vision-MCP decisions stay in one place.
 *
 * The MCP name is user-supplied (any server from their MCP list works) and the
 * real tool name can't be derived from the server name (a server named "x-image"
 * may expose a tool named "x_image", "analyze_image", or anything else). The tool
 * name is therefore discovered at runtime by asking the configured MCP server for
 * its tools/list. This keeps the feature generic — any image MCP works without
 * hard-coding a server-to-tool mapping table.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getCodemossDir } from '../../utils/path-utils.js';
import { loadMcpServersConfig } from './mcp-status/config-loader.js';
import { getMcpServerTools } from './mcp-status/index.js';

// Config keys persisted by the plugin (src/main/.../CodemossSettingsService).
const VISION_MCP_ENABLED_KEY = 'visionMcpEnabled';
const VISION_MCP_NAME_KEY = 'visionMcpName';
const VISION_MCP_TRANSMISSION_KEY = 'visionMcpImageTransmission';

// Defaults keep a neutral out-of-the-box state: the toggle is on (routing through
// a user-configured image MCP when one is set), the MCP name is empty until the
// user picks one of their servers, and transmission defaults to path mode.
export const DEFAULT_VISION_MCP_ENABLED = true;
export const DEFAULT_VISION_MCP_NAME = '';
export const DEFAULT_VISION_MCP_TRANSMISSION = 'path';

/** Supported image transmission modes (also the values persisted in config.json). */
const VISION_MCP_TRANSMISSION_PATH = 'path';
const VISION_MCP_TRANSMISSION_BASE64 = 'base64';

// Cache the discovered tool name per MCP server. Probing spawns/connects the MCP
// server (up to MCP_TOOLS_TIMEOUT), so doing it on every message would stall each
// send. The cache is keyed by server name; changing the configured name (or a
// daemon restart) invalidates it naturally.
const toolNameCache = new Map();

// Read the config file fresh each call; the daemon re-reads on every message so a
// settings change takes effect without a restart. Missing/invalid file -> defaults.
function loadCodemossConfigFile() {
  try {
    const configPath = join(getCodemossDir(), 'config.json');
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error('[VISION_MCP_CONFIG] Failed to read codemoss config:', e.message);
    return null;
  }
}

/**
 * Load the vision-MCP settings from ~/.codemoss/config.json.
 * Falls back to defaults when a key is missing, invalid, or the file is unreadable.
 *
 * @param {Object|null} [configOverride] - Parsed config object for tests; when given
 *        (including null, which simulates a missing file), the file is not read.
 *        Enables deterministic unit tests without touching the real ~/.codemoss/config.json.
 * @returns {{ enabled: boolean, mcpName: string, transmission: string }}
 */
export function loadVisionMcpConfig(configOverride = undefined) {
  // Only read the file when no override was passed at all; null is a legitimate
  // override meaning "no config" (defaults), not "read the real file".
  const config = configOverride === undefined ? loadCodemossConfigFile() : configOverride;

  let enabled = DEFAULT_VISION_MCP_ENABLED;
  if (config && typeof config[VISION_MCP_ENABLED_KEY] === 'boolean') {
    enabled = config[VISION_MCP_ENABLED_KEY];
  }

  let mcpName = DEFAULT_VISION_MCP_NAME;
  if (config && typeof config[VISION_MCP_NAME_KEY] === 'string' && config[VISION_MCP_NAME_KEY].trim()) {
    mcpName = config[VISION_MCP_NAME_KEY].trim();
  }

  let transmission = DEFAULT_VISION_MCP_TRANSMISSION;
  if (config && typeof config[VISION_MCP_TRANSMISSION_KEY] === 'string'
      && config[VISION_MCP_TRANSMISSION_KEY].trim()) {
    const value = config[VISION_MCP_TRANSMISSION_KEY].trim();
    if (value === VISION_MCP_TRANSMISSION_PATH || value === VISION_MCP_TRANSMISSION_BASE64) {
      transmission = value;
    }
  }

  return { enabled, mcpName, transmission };
}

/**
 * Resolve the actual MCP tool name exposed by the configured vision MCP server.
 *
 * The user configures a server name (e.g. "x-image"); the tool that server exposes
 * is discovered by connecting to it and asking for tools/list (only that server is
 * probed, never the whole fleet). Returns the bare tool name (e.g. "x_image") or
 * null when the server is not configured, unreachable, or exposes no tool.
 *
 * @param {string} mcpName - Configured vision MCP server name.
 * @param {string} [cwd] - Working directory used for project-scoped MCP config.
 * @param {Function} [resolveTool] - Injectable resolver for tests: called as
 *        `(mcpName, cwd)` and must return `{ toolName }` (null when unknown).
 * @returns {Promise<{ toolName: string|null }>}
 */
export async function resolveVisionMcpToolName(mcpName, cwd = null, resolveTool = null) {
  if (typeof resolveTool === 'function') {
    return resolveTool(mcpName, cwd);
  }

  if (!mcpName) return { toolName: null };
  if (toolNameCache.has(mcpName)) return { toolName: toolNameCache.get(mcpName) };

  let toolName = null;
  try {
    const servers = await loadMcpServersConfig(cwd);
    const server = servers.find((s) => s.name === mcpName);
    if (server) {
      const result = await getMcpServerTools(server.name, server.config);
      // The server exposes raw tool objects; pick the first one as the target —
      // a vision MCP normally wraps a single image tool. No tools -> unknown.
      const tool = Array.isArray(result.tools) && result.tools.length > 0 ? result.tools[0] : null;
      toolName = tool && typeof tool.name === 'string' && tool.name.trim() ? tool.name.trim() : null;
    }
  } catch (e) {
    console.error('[VISION_MCP_CONFIG] Failed to resolve tools for MCP:', mcpName, e.message);
    toolName = null;
  }

  // Cache even a null result so an unreachable server doesn't stall every message.
  toolNameCache.set(mcpName, toolName);
  return { toolName };
}

/**
 * Build the text block that steers the model to the selected vision MCP for
 * attached images.
 *
 * When a real tool name is known it is referenced as `mcp__<server>__<tool>` so the
 * model can call it directly. When it is not known (server missing/unreachable) the
 * prompt stays generic — it never invents a tool name that doesn't exist.
 *
 * @param {Array<{path: string, mediaType: string, data: string}>} imagePathRefs
 *        Saved image records (path + original mediaType/data).
 * @param {string} mcpName - Selected vision MCP server name.
 * @param {string|null} toolName - Resolved MCP tool name, or null when unknown.
 * @param {string} transmission - 'path' or 'base64'.
 * @returns {string} Injection prompt, or null when there are no images.
 */
export function buildVisionMcpPrompt(imagePathRefs, mcpName, toolName, transmission) {
  if (!Array.isArray(imagePathRefs) || imagePathRefs.length === 0) return null;

  // Path mode passes the temp file path (short text); base64 mode inlines the
  // image data so a server that cannot read local files still gets the image.
  const useBase64 = transmission === VISION_MCP_TRANSMISSION_BASE64;
  const imageRefs = imagePathRefs
    .map((img, idx) => useBase64
      ? `[Image #${idx + 1}: data:${img.mediaType};base64,${img.data}]`
      : `[Image #${idx + 1}: ${img.path}]`)
    .join('\n');

  // With a concrete tool name, steer to it; without one, stay generic so the model
  // picks whichever vision MCP tool is actually loaded.
  const steer = toolName
    ? `Use the mcp__${mcpName}__${toolName} MCP tool with its image parameter set to each image's value to read/analyze them`
    : `Use your configured image-recognition MCP tool (the one that can read local image files) to read/analyze them`;

  // A Read-tool fallback stays useful whenever we inject paths — if the MCP tool is
  // unavailable the model can still load the files itself.
  const readFallback = useBase64
    ? ''
    : '\n\nIf the MCP tool is unavailable, use the Read tool to load the image files from disk.';

  return `${imageRefs}\n\nThe user has attached the image(s) above. ${steer}, then answer the user's question based on what you see.${readFallback}`;
}
