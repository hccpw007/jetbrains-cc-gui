import { memo } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage } from '../../types';

function formatDurationMs(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

interface TokenUsageInfo {
  /** Total input-side tokens for the turn (non-cache input + cache write + cache read). */
  inputTokens: number;
  outputTokens: number;
  nonCacheInputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd?: number;
}

/**
 * Extract whole-turn token usage from a message's raw JSON.
 *
 * Reads the `turnUsage` field stamped by the backend when a turn completes
 * (ClaudeMessageHandler.handleResult / CodexMessageHandler.handleResultMessage).
 * It aggregates every API call in the turn, normalized to the Claude usage
 * schema (input_tokens excludes cache; cache fields are separate).
 *
 * Do NOT read `raw.message.usage` or `raw.usage` here: those carry per-API-call
 * and session-cumulative values that feed the context-usage status bar, and
 * would understate (Claude) or overstate (Codex) what this turn consumed.
 *
 * Returns null when no turn usage is available (aborted turns, history replay).
 */
function extractTokenUsage(raw: ClaudeMessage['raw']): TokenUsageInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const usageSrc = (raw as Record<string, unknown>).turnUsage;
  if (!usageSrc || typeof usageSrc !== 'object') return null;
  const usage = usageSrc as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const nonCacheInput = num(usage.input_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const output = num(usage.output_tokens);
  const input = nonCacheInput + cacheCreation + cacheRead;
  if (input === 0 && output === 0) return null;
  const rawCost = (raw as Record<string, unknown>).turnCostUsd;
  const costUsd = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost > 0 ? rawCost : undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    nonCacheInputTokens: nonCacheInput,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** Format a token count for compact display (e.g., 1234 → "1.2K"). */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function formatUsdCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return '<$0.0001';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** 格式化缓存命中率（两位小数）。无命中轮（如新会话首次请求）同样返回 "0.00%"，
 *  保证详细输出下每轮 footer 格式一致；inputTokens 为 0 时按 0% 处理，避免除零。 */
function formatCacheHitRatio(tokenInfo: TokenUsageInfo): string {
  // 用精确 token 数字计算，避免 "32.3K" 这类四舍五入值污染命中率
  const ratio = tokenInfo.inputTokens > 0
    ? (tokenInfo.cacheReadTokens / tokenInfo.inputTokens) * 100
    : 0;
  return `${Math.min(100, Math.max(0, ratio)).toFixed(2)}%`;
}

/** 格式化输出 token 生成速度（tokens/s）：输出 token 数 ÷ 耗时秒数，取整数。
 *  用精确 durationMs 与 outputTokens 计算，避免四舍五入前的近似污染速度值；
 *  durationMs 或输出 token 非正时返回 null（不显示，如无耗时的历史回放）；
 *  速度不足 1 token/s 时显示 "<1tokens/s" 下限，避免 "0tokens/s" 误导（实际有输出）。 */
function formatTokenSpeed(durationMs: number, outputTokens: number): string | null {
  if (durationMs <= 0 || outputTokens <= 0) return null;
  const seconds = durationMs / 1000;
  const rounded = Math.round(outputTokens / seconds);
  if (rounded <= 0) return '<1tokens/s';
  return `${rounded}tokens/s`;
}

interface MessageDurationFooterProps {
  message: ClaudeMessage;
  isMessageStreaming: boolean;
  detailedOutputEnabled: boolean;
  t: TFunction;
}

/** Duration and token display, rendered under every settled assistant message turn */
export const MessageDurationFooter = memo(function MessageDurationFooter({
  message,
  isMessageStreaming,
  detailedOutputEnabled,
  t,
}: MessageDurationFooterProps) {
  if (message.type !== 'assistant' || isMessageStreaming || typeof message.durationMs !== 'number') {
    return null;
  }

  const tokenInfo = extractTokenUsage(message.raw);
  const cacheHitRatio = detailedOutputEnabled && tokenInfo ? formatCacheHitRatio(tokenInfo) : null;
  // 输出 token 生成速度始终显示（只要有耗时与输出 token），与耗时/用量一致
  const tokenSpeed = tokenInfo ? formatTokenSpeed(message.durationMs, tokenInfo.outputTokens) : null;
  // 详细输出下始终附带缓存命中标签（无命中轮显示 0，保证每轮格式一致）
  const cacheHitLabel = tokenInfo && cacheHitRatio
    ? t('chat.cacheHitsWithRatio', {
      tokens: formatTokenCount(tokenInfo.cacheReadTokens),
      ratio: cacheHitRatio,
    })
    : '';

  return (
    <div className="message-duration">
      <div className="message-duration-inner">
        {/* 第一行：本次耗时、输出 token 生成速度，详细输出时附带本轮费用 */}
        <div className="message-duration-row">
          <span className="message-duration-flag codicon codicon-clock"></span>
          <span className="message-duration-cost">{t('chat.totalDuration')}</span>
          <span className="message-duration-value">{formatDurationMs(message.durationMs)}</span>
          {tokenSpeed && (
            <>
              <span className="message-duration-separator">·</span>
              <span className="message-duration-tokens">{tokenSpeed}</span>
            </>
          )}
          {detailedOutputEnabled && tokenInfo && tokenInfo.costUsd !== undefined && (
            <>
              <span className="message-duration-separator">·</span>
              <span className="message-duration-tokens">{formatUsdCost(tokenInfo.costUsd)}</span>
            </>
          )}
        </div>
        {/* Second row: whole-turn token usage (input incl. cache hits, output) */}
        {tokenInfo && (
          <div className="message-duration-row">
            <span
              className="message-duration-tokens"
              title={t('chat.tokenUsageDetail', {
                input: formatTokenCount(tokenInfo.nonCacheInputTokens),
                cacheWrite: formatTokenCount(tokenInfo.cacheCreationTokens),
                cacheRead: formatTokenCount(tokenInfo.cacheReadTokens),
                output: formatTokenCount(tokenInfo.outputTokens),
              })}
            >
              {t('chat.tokenUsage', {
                input: `${formatTokenCount(tokenInfo.inputTokens)}${cacheHitLabel}`,
                output: formatTokenCount(tokenInfo.outputTokens),
              })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});
