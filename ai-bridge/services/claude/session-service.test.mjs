import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSessionMessagesPayload } from './session-service.js';

test('buildSessionMessagesPayload returns an empty history when the session file is missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-session-'));
  try {
    const missing = path.join(tempDir, 'does-not-exist.jsonl');
    assert.deepEqual(buildSessionMessagesPayload(missing), {
      success: true,
      messages: [],
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPayload rewrites a queued_command attachment carrier into a user message', () => {
  // A background Agent's terminal report can land as a queued_command
  // attachment rather than a user message. Java's MessageParser drops
  // non-user/assistant rows, so the reader must reshape it into a user message
  // or the subagent card stays stuck on the launch ack text after a reload.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-session-'));
  try {
    const file = path.join(tempDir, 'session.jsonl');
    const xml = '<task-notification>\n<tool-use-id>toolu_att</tool-use-id>\n<status>completed</status>\n<result>the report</result>\n</task-notification>';
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: xml },
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }),
    ].join('\n') + '\n');

    const { success, messages } = buildSessionMessagesPayload(file);
    assert.equal(success, true);
    // The attachment row is reshaped into a user message carrying the XML, so
    // it survives MessageParser's user/assistant-only filter and reaches the
    // frontend's collectTaskEventsFromMessages.
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[1], {
      type: 'user',
      message: { role: 'user', content: xml },
    });
    // User-message and assistant rows pass through unchanged.
    assert.equal(messages[0].type, 'user');
    assert.equal(messages[2].type, 'assistant');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPayload leaves a non-task-notification queued_command attachment untouched', () => {
  // An enqueued user prompt is also a queued_command attachment but not a
  // task-notification carrier; it must not be rewritten into a user message.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-session-'));
  try {
    const file = path.join(tempDir, 'session.jsonl');
    const queuedPrompt = {
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'user-prompt', prompt: 'do something' },
    };
    fs.writeFileSync(file, JSON.stringify(queuedPrompt) + '\n');

    const { messages } = buildSessionMessagesPayload(file);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'attachment');
    assert.equal(messages[0].attachment.commandMode, 'user-prompt');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
