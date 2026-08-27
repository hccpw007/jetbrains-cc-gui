import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { buildContentBlocks } from './attachment-service.js';

// Base64 of a 1x1 red PNG — valid image data, tiny.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const IMAGE_ATTACHMENT = {
  fileName: 'test.png',
  mediaType: 'image/png',
  data: PNG_BASE64,
};

const TEXT_ONLY_ATTACHMENT = {
  fileName: 'notes.txt',
  mediaType: 'text/plain',
  data: 'hello',
};

// Realistic injected resolver: the configured vision MCP (x-image) exposes the
// x_image tool. Keeps tests deterministic without spawning real MCP servers.
const RESOLVER_X_IMAGE = async () => ({ toolName: 'x_image' });

// Deterministic vision-MCP config: neutral name, path transmission. Injected so
// tests never depend on the real ~/.codemoss/config.json.
const CONFIG_PATH = () => ({
  enabled: true,
  mcpName: 'my-image-mcp',
  transmission: 'path',
});

// Path mode with a resolved tool name: images are injected as bare local temp
// paths and the prompt references the fully-qualified MCP tool.
test('vision MCP path mode: image injected as local path + tool name', async () => {
  const blocks = await buildContentBlocks(
    [IMAGE_ATTACHMENT], 'describe this', 'deepseek-v4-flash',
    { loadVisionMcpConfig: CONFIG_PATH, resolveVisionMcpToolName: RESOLVER_X_IMAGE });
  const textBlock = blocks.find((b) => b.type === 'text');
  const text = textBlock.text;

  // Path-based injection: temp file under os.tmpdir()/cc-gui-images, no base64 inline
  assert.match(text, /\[Image #1: .*cc-gui-images.*test\.png\]/);
  assert.ok(!text.includes(PNG_BASE64), 'path mode must not inline base64');
  // Must direct the model to the MCP tool by its fully-qualified name
  assert.match(text, /mcp__my-image-mcp__x_image/);
});

// Non-image attachments must not be treated as vision images.
test('vision MCP: non-image attachment keeps plain text label', async () => {
  const blocks = await buildContentBlocks(
    [TEXT_ONLY_ATTACHMENT], 'hello', 'deepseek-v4-flash',
    { loadVisionMcpConfig: CONFIG_PATH, resolveVisionMcpToolName: RESOLVER_X_IMAGE });
  const textBlock = blocks.find((b) => b.type === 'text');
  assert.match(textBlock.text, /\[Attachment: notes\.txt\]/);
  assert.ok(!textBlock.text.includes('mcp__'), 'no image -> no MCP prompt');
});

// With the vision-MCP toggle on (default), even a Claude model bypasses
// native vision blocks and routes through the vision MCP — this is the escape
// hatch for `claude-*` names served by non-vision proxies (DeepSeek et al.).
test('vision-MCP toggle on: claude model also routed to vision MCP', async () => {
  const blocks = await buildContentBlocks(
    [IMAGE_ATTACHMENT], 'look', 'claude-sonnet-4-6',
    { loadVisionMcpConfig: CONFIG_PATH, resolveVisionMcpToolName: RESOLVER_X_IMAGE });
  // No native image block — the image goes to a temp file + MCP prompt instead
  assert.ok(!blocks.some((b) => b.type === 'image'), 'claude must not get native image block when toggle on');
  const textBlock = blocks.find((b) => b.type === 'text');
  assert.match(textBlock.text, /mcp__my-image-mcp__x_image/, 'claude also steered to vision MCP when toggle on');
});

// Empty message + image only: placeholder text must still be present.
test('empty message with image: placeholder text appended', async () => {
  const blocks = await buildContentBlocks(
    [IMAGE_ATTACHMENT], '', 'deepseek-v4-flash',
    { loadVisionMcpConfig: CONFIG_PATH, resolveVisionMcpToolName: RESOLVER_X_IMAGE });
  const textBlock = blocks.find((b) => b.type === 'text');
  assert.match(textBlock.text, /\[Uploaded 1 image\(s\)\]/);
});

// Mixed attachments (image + text + image): path refs must carry their own
// mediaType/data so base64 injection does not alias across the text attachment.
// Regression guard for the index-misalignment fix.
test('mixed image/text attachments: each path ref keeps its own image data', async () => {
  const blocks = await buildContentBlocks(
    [IMAGE_ATTACHMENT, TEXT_ONLY_ATTACHMENT, IMAGE_ATTACHMENT], 'mixed', 'deepseek-v4-flash',
    { loadVisionMcpConfig: CONFIG_PATH, resolveVisionMcpToolName: RESOLVER_X_IMAGE });
  const textBlock = blocks.filter((b) => b.type === 'text').at(-1);
  const text = textBlock.text;

  // Both image refs present with correct index labels
  assert.match(text, /\[Image #1: .*test\.png\]/);
  assert.match(text, /\[Image #2: .*test\.png\]/);
  // Text attachment is NOT turned into an image ref
  assert.ok(!text.includes('notes.txt'));
  // In path mode, both refs are paths, no base64 inline
  assert.ok(!text.includes(PNG_BASE64), 'path mode must not inline base64');
});

// Path mode carries a real local path in the message, so the Read-tool fallback
// hint is meaningful and must be present.
test('vision MCP path mode includes Read-tool fallback hint', async () => {
  const blocks = await buildContentBlocks(
    [IMAGE_ATTACHMENT], 'hi', 'deepseek-v4-flash',
    { loadVisionMcpConfig: CONFIG_PATH, resolveVisionMcpToolName: RESOLVER_X_IMAGE });
  const textBlock = blocks.filter((b) => b.type === 'text').at(-1);
  assert.match(textBlock.text, /use the Read tool to load the image files from disk/);
});

// When the tool resolver finds nothing (server missing/unreachable), the prompt
// stays generic and never invents a tool name the model cannot call.
test('vision MCP with unresolved tool: generic prompt, no invented tool', async () => {
  const blocks = await buildContentBlocks(
    [IMAGE_ATTACHMENT], 'look', 'deepseek-v4-flash',
    { loadVisionMcpConfig: CONFIG_PATH, resolveVisionMcpToolName: async () => ({ toolName: null }) });
  const textBlock = blocks.find((b) => b.type === 'text');
  assert.ok(!textBlock.text.includes('mcp__'), 'must not reference a tool name that does not exist');
  assert.match(textBlock.text, /your configured image-recognition MCP tool/);
});

// base64 transmission against a path-capable server inlines the data URI so the
// image still reaches the MCP even without a local file path.
test('vision MCP base64 mode inlines image data', async () => {
  const blocks = await buildContentBlocks(
    [IMAGE_ATTACHMENT], 'hi', 'deepseek-v4-flash',
    { loadVisionMcpConfig: () => ({ enabled: true, mcpName: 'my-image-mcp', transmission: 'base64' }),
      resolveVisionMcpToolName: RESOLVER_X_IMAGE });
  const textBlock = blocks.filter((b) => b.type === 'text').at(-1);
  assert.match(textBlock.text, /\[Image #1: data:image\/png;base64,/);
  assert.match(textBlock.text, /mcp__my-image-mcp__x_image/);
});
