/**
 * Commit Message Generation Service — "provider ask" mode.
 *
 * Routes to:
 *   - Claude: Anthropic SDK messages.stream (stateless)
 *   - Codex:  Codex SDK one-shot thread
 *   - Grok / Kimi / OpenCode / PI: headless CLI ask (session-less)
 *
 * stdin JSON: { prompt, provider, model }
 *   - prompt:   the full commit prompt (spec + git diff), assembled by Java
 *   - provider: 'claude' | 'codex' | 'grok' | 'kimi' | 'opencode' | 'pi'
 *   - model:    resolved model id (mapped to the real provider model at runtime)
 *
 * stdout markers:
 *   [CONTENT_DELTA] <json-text>  — streamed token chunk
 *   [COMMIT]<text>               — success (newlines encoded as {{NEWLINE}})
 *   [COMMIT_ERROR]<msg>          — failure
 */

import { pathToFileURL } from 'node:url';

import { loadCodexSdk, isCodexSdkAvailable } from '../utils/sdk-loader.js';
import { setupApiKey, loadClaudeSettings, getCliUserAgent } from '../config/api-config.js';
import { resolveModelFromSettings } from '../utils/model-utils.js';
import { getRealHomeDir } from '../utils/path-utils.js';
import { ensureAnthropicSdk } from './claude/message-utils.js';
import { buildCodexCliEnvironment } from './codex/codex-utils.js';
import { askCliProvider, isCliAskProvider } from './cli-ask.js';

let codexSdk = null;

async function ensureCodexSdk() {
  if (!codexSdk) {
    if (!isCodexSdkAvailable()) {
      const error = new Error('Codex SDK not installed. Please install via Settings > Dependencies.');
      error.code = 'SDK_NOT_INSTALLED';
      throw error;
    }
    codexSdk = await loadCodexSdk();
  }
  return codexSdk;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function extractAppendedDelta(previousText, nextText) {
  const previous = typeof previousText === 'string' ? previousText : '';
  const next = typeof nextText === 'string' ? nextText : '';
  if (!next.trim()) return '';
  if (!previous) return next;
  if (next === previous) return '';
  if (!next.startsWith(previous)) return next;
  return next.slice(previous.length);
}

/**
 * Claude path: direct "ask" via the Anthropic SDK messages.stream().
 * Stateless (no session persisted) + native token streaming.
 */
async function generateWithClaude(prompt, model) {
  const anthropicModule = await ensureAnthropicSdk();
  const Anthropic = anthropicModule.default || anthropicModule.Anthropic || anthropicModule;

  const config = setupApiKey();
  if (!config.apiKey) {
    throw new Error('No API key configured for the active Claude provider (commit "ask" needs an API key).');
  }

  // Resolve the real model id from the user's model mapping (e.g. claude-sonnet-4-7 -> GLM-5.2).
  const settings = loadClaudeSettings();
  const modelId = resolveModelFromSettings(model, settings && settings.env);
  console.log(`[CommitMessage] Claude model resolved: ${model} -> ${modelId}`);
  console.log(`[CommitMessage] Base URL: ${config.baseUrl || 'https://api.anthropic.com'}`);
  console.log(`[CommitMessage] Auth type: ${config.authType || 'api_key'}`);

  const clientOpts = {
    baseURL: config.baseUrl || undefined,
    defaultHeaders: { 'x-app': 'cli', 'User-Agent': getCliUserAgent() },
  };
  if (config.authType === 'auth_token') {
    clientOpts.authToken = config.apiKey;
    clientOpts.apiKey = null; // Bearer auth, no x-api-key
  } else {
    clientOpts.apiKey = config.apiKey;
  }
  const client = new Anthropic(clientOpts);

  console.log('[MESSAGE_START]');
  console.log('[CommitMessage] Streaming via Anthropic SDK messages.stream()...');

  let streamedText = '';
  const stream = client.messages.stream({
    model: modelId,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  stream.on('text', (text) => {
    if (text) {
      process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(text)}\n`);
      streamedText += text;
    }
  });

  const finalMessage = await stream.finalMessage();
  console.log('[MESSAGE_END]');

  // Fallback: assemble from the final message content blocks if streaming yielded nothing.
  if (!streamedText.trim() && finalMessage && Array.isArray(finalMessage.content)) {
    for (const block of finalMessage.content) {
      if (block && block.type === 'text' && block.text) {
        streamedText += block.text;
      }
    }
  }

  console.log(`[CommitMessage] Claude response text length: ${streamedText.length}`);
  if (streamedText.trim()) {
    return streamedText.trim();
  }
  throw new Error('Claude commit response is empty');
}

async function generateWithCodex(prompt, model) {
  const sdk = await ensureCodexSdk();
  const Codex = sdk.Codex || sdk.default || sdk;
  const { cliEnv } = buildCodexCliEnvironment(process.env);
  const codex = new Codex({ env: cliEnv });

  const workingDirectory = getRealHomeDir();
  const fullPrompt = [
    prompt,
    '',
    'Remember: output only the commit message, wrapped in <commit></commit>, with no explanation.',
  ].join('\n');

  // Stateless one-shot thread.
  const thread = codex.startThread({
    skipGitRepoCheck: true,
    maxTurns: 1,
    workingDirectory,
    model,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
  });

  console.log(`[CommitMessage] Calling Codex SDK with model: ${model}`);

  const { events } = await thread.runStreamed(fullPrompt);
  let responseText = '';
  let lastAgentMessage = '';

  for await (const event of events) {
    console.log(`[CommitMessage] Codex event: ${event.type}`);
    if (event.type === 'item.updated' || event.type === 'item.completed') {
      const item = event.item;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        const delta = extractAppendedDelta(lastAgentMessage, item.text);
        if (delta) {
          responseText += delta;
        }
        lastAgentMessage = item.text;
      }
    }
  }

  console.log(`[CommitMessage] Codex response text length: ${responseText.length}`);
  if (responseText.trim()) {
    return responseText.trim();
  }
  throw new Error('Codex commit response is empty');
}

function emitContentDelta(text) {
  if (typeof text !== 'string' || !text) return;
  process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(text)}\n`);
}

/**
 * Headless CLI path (Grok / Kimi / OpenCode / PI) — session-less ask.
 */
async function generateWithCli(provider, prompt, model) {
  const fullPrompt = [
    prompt,
    '',
    'Remember: output only the commit message, wrapped in <commit></commit>, with no explanation. Do not run tools.',
  ].join('\n');

  console.log(`[CommitMessage] CLI ask provider=${provider}, model=${model || '(default)'}`);

  return askCliProvider({
    provider,
    prompt: fullPrompt,
    model,
    cwd: getRealHomeDir(),
    onDelta: emitContentDelta,
  });
}

async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);
    const { prompt, provider, model } = data;

    if (!prompt) {
      console.log('[COMMIT]');
      process.exit(0);
    }

    console.log(`[CommitMessage] provider=${provider}, model=${model || '(default)'}`);

    let text;
    if (provider === 'codex') {
      text = await generateWithCodex(prompt, model);
    } else if (isCliAskProvider(provider)) {
      text = await generateWithCli(provider, prompt, model);
    } else {
      text = await generateWithClaude(prompt, model);
    }

    const encoded = text.replace(/\n/g, '{{NEWLINE}}');
    console.log(`[COMMIT]${encoded}`);
    process.exit(0);
  } catch (error) {
    console.error('[CommitMessage] Error:', error && error.message ? error.message : String(error));
    console.log(`[COMMIT_ERROR]${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
