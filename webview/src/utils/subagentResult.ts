import type { ToolResultBlock } from '../types';
import type { GetToolResultRawFn } from '../contexts/SubagentContext';

/**
 * Extract concatenated text content from a tool_result block.
 *
 * Shared by useSubagents, AgentGroupBlock, and TaskExecutionBlock so the
 * extraction logic (string vs array content, text-block filtering) stays in
 * one place. Returns undefined when there is no text to show.
 */
export function extractResultText(result?: ToolResultBlock | null): string | undefined {
  if (!result) return undefined;
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }
  return undefined;
}

/**
 * Whether an Agent/Task tool input launches a background (async) subagent.
 *
 * Claude Code triggers async via the `run_in_background: true` input parameter
 * (AgentTool schema), NOT via the tool name. normalizeToolInput preserves the
 * snake_case field via spread for the Agent/Task tools, so both the StatusPanel
 * list (useSubagents, normalized input) and the inline Agent cards
 * (AgentGroupBlock/TaskExecutionBlock, raw block.input) read the same field.
 *
 * Strict === true avoids truthy strings (e.g. "false") flipping the flag. The
 * camelCase `runInBackground` form is also checked as a guard against future
 * normalization changes. Shared by all three call sites so they cannot drift.
 */
export function isAsyncAgentInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const record = input as Record<string, unknown>;
  return record.run_in_background === true || record.runInBackground === true;
}

/**
 * Per-agent usage metadata the SDK stamps on the tool_result's toolUseResult
 * field (agentId, totalDurationMs, totalTokens, totalToolUseCount). Shared by
 * AgentGroupBlock and TaskExecutionBlock so the field extraction stays single-
 * sourced. Returns an empty object when there is no usable metadata.
 */
export function parseAgentToolMeta(
  getToolResultRaw: GetToolResultRawFn,
  toolUseId?: string,
): { agentId?: string; totalDurationMs?: number; totalTokens?: number; totalToolUseCount?: number } {
  if (!toolUseId) return {};
  const rawMessage = getToolResultRaw(toolUseId);
  const metadata = rawMessage?.toolUseResult;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const record = metadata as Record<string, unknown>;
  const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const getNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  return {
    agentId: getString(record.agentId),
    totalDurationMs: getNumber(record.totalDurationMs),
    totalTokens: getNumber(record.totalTokens),
    totalToolUseCount: getNumber(record.totalToolUseCount),
  };
}

/**
 * Fallback async detection using the Agent tool's result metadata.
 *
 * When the SDK launches a background agent it returns a launch-acknowledgment
 * tool_result whose toolUseResult contains only an {@code agentId} — no usage
 * stats yet (those arrive later via {@code task_notification}). A sync agent
 * that has already completed has {@code totalTokens} / {@code totalDurationMs}
 * in the same metadata.
 *
 * This check catches agents that the SDK launched without setting the
 * {@code run_in_background} input flag but that are genuinely background
 * (have only {@code agentId} in their toolUseResult). Calling code should
 * prefer {@link isAsyncAgentInput} when the raw input is available and use
 * this as a fallback.
 *
 * @returns true when the tool result has an agentId but no completion stats,
 *   or when the toolUseResult metadata is absent (serialization dropped it).
 */
export function isAsyncByAgentMetadata(
  getToolResultRaw: GetToolResultRawFn,
  toolUseId: string,
): boolean {
  const rawMessage = getToolResultRaw(toolUseId);
  if (!rawMessage) return false;
  const metadata = rawMessage.toolUseResult;
  // If toolUseResult is absent or empty, the metadata was likely dropped
  // during serialization (e.g. history replay loses the field). Since we
  // know the tool launched (non-error result exists upstream), assume this
  // is a launch ack for a still-running background agent.
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return true;
  const record = metadata as Record<string, unknown>;
  const hasAgentId = typeof record.agentId === 'string' && record.agentId.trim().length > 0;
  // No agentId but we do have some metadata object — assume async.
  if (!hasAgentId) return true;
  const hasCompletionStats = typeof record.totalDurationMs === 'number'
    || typeof record.totalTokens === 'number';
  // Has agentId but no completion stats → launch ack, agent still running.
  return !hasCompletionStats;
}
