import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadVisionMcpConfig,
  resolveVisionMcpToolName,
  buildVisionMcpPrompt,
  DEFAULT_VISION_MCP_ENABLED,
  DEFAULT_VISION_MCP_NAME,
  DEFAULT_VISION_MCP_TRANSMISSION,
} from './vision-mcp-config.js';

// A config object shape matching what the plugin writes to ~/.codemoss/config.json.
const CONFIG = {
  visionMcpEnabled: true,
  visionMcpName: 'my-image-mcp',
  visionMcpImageTransmission: 'path',
};

// Defaults (no config.json / empty object) must keep a neutral state: toggle on,
// empty MCP name (user picks their own server), path transmission.
test('loadVisionMcpConfig: defaults apply when no config present', () => {
  const cfg = loadVisionMcpConfig(null);
  assert.equal(cfg.enabled, DEFAULT_VISION_MCP_ENABLED);
  assert.equal(cfg.mcpName, DEFAULT_VISION_MCP_NAME);
  assert.equal(cfg.transmission, DEFAULT_VISION_MCP_TRANSMISSION);
});

// Empty object -> all defaults (partial config never leaves required keys undefined).
test('loadVisionMcpConfig: empty config falls back to defaults', () => {
  const cfg = loadVisionMcpConfig({});
  assert.equal(cfg.enabled, DEFAULT_VISION_MCP_ENABLED);
  assert.equal(cfg.mcpName, DEFAULT_VISION_MCP_NAME);
  assert.equal(cfg.transmission, DEFAULT_VISION_MCP_TRANSMISSION);
});

// A user-set toggle-off must be honored (that is the escape hatch to native vision).
test('loadVisionMcpConfig: respects explicit enabled=false', () => {
  const cfg = loadVisionMcpConfig({ ...CONFIG, visionMcpEnabled: false });
  assert.equal(cfg.enabled, false);
});

// Invalid transmission value degrades to the default path mode rather than crashing.
test('loadVisionMcpConfig: invalid transmission falls back to default', () => {
  const cfg = loadVisionMcpConfig({ ...CONFIG, visionMcpImageTransmission: 'weird' });
  assert.equal(cfg.transmission, DEFAULT_VISION_MCP_TRANSMISSION);
});

// The resolver must ask the configured server only (never scan the fleet) and
// return its exposed tool name. Injectable resolver proves the flow end to end.
test('resolveVisionMcpToolName: returns the tool exposed by the configured server', async () => {
  const probe = (name) => ({ toolName: name === 'x-image' ? 'x_image' : null });
  const { toolName } = await resolveVisionMcpToolName('x-image', null, probe);
  assert.equal(toolName, 'x_image');
});

// Unknown/unreachable server -> null tool name; the prompt must stay generic.
test('resolveVisionMcpToolName: unknown server resolves to null', async () => {
  const probe = () => ({ toolName: null });
  const { toolName } = await resolveVisionMcpToolName('nope', null, probe);
  assert.equal(toolName, null);
});

const IMG = { path: '/tmp/cc-gui-images/1.png', mediaType: 'image/png', data: 'abc' };

// Known tool name: prompt must reference the fully-qualified mcp__<server>__<tool>.
test('buildVisionMcpPrompt: known tool name is referenced as mcp__server__tool', () => {
  const text = buildVisionMcpPrompt([IMG], 'x-image', 'x_image', 'path');
  assert.match(text, /\[Image #1: \/tmp\/cc-gui-images\/1\.png\]/);
  assert.match(text, /mcp__x-image__x_image/);
  assert.match(text, /use the Read tool to load the image files from disk/);
});

// Unknown tool name: prompt must stay generic and never invent a tool.
test('buildVisionMcpPrompt: unknown tool name keeps prompt generic', () => {
  const text = buildVisionMcpPrompt([IMG], 'my-vision-server', null, 'path');
  assert.match(text, /\[Image #1: \/tmp\/cc-gui-images\/1\.png\]/);
  assert.ok(!text.includes('mcp__'), 'must not invent a tool name');
  assert.match(text, /your configured image-recognition MCP tool/);
  assert.match(text, /use the Read tool to load the image files from disk/);
});

// base64 mode inlines the data URI regardless of the server; a path-only server
// would reject local paths so base64 keeps the image usable.
test('buildVisionMcpPrompt: base64 mode inlines data URI', () => {
  const text = buildVisionMcpPrompt([IMG], 'x-image', 'x_image', 'base64');
  assert.match(text, /\[Image #1: data:image\/png;base64,abc\]/);
  assert.match(text, /mcp__x-image__x_image/);
  assert.ok(!text.includes('Read tool'), 'base64 mode must not suggest a Read hint');
});

// No images -> null prompt (caller falls back to its own text handling).
test('buildVisionMcpPrompt: empty refs returns null', () => {
  assert.equal(buildVisionMcpPrompt([], 'my-image-mcp', 'x_image', 'path'), null);
});
