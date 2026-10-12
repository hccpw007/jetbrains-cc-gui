package com.github.claudecodegui.session;

import com.github.claudecodegui.util.UsageCostCalculator;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Rebuilds the per-turn token/cost metadata (raw.turnUsage / raw.turnCostUsd) on a
 * history reload.
 *
 * <p>Both fields are stamped only while a turn settles live: turnUsage comes from the
 * SDK result message and turnCostUsd from the backend pricing tables. Neither is
 * persisted in the transcript, so after reopening a session every historical turn lost
 * its token footer and its cost. The frontend reconstruction
 * (turnMetadataReconstruction.ts) rebuilds duration/tokens from the transported raw
 * fields, but the cost needs the backend pricing tables (including user-configured
 * time-of-day rates such as DeepSeek peak/off-peak) and can only be rebuilt here.
 *
 * <p>Grouping mirrors the frontend reconstruction: a turn starts at a real user prompt
 * (not a tool_result carrier, meta caveat, synthetic message, or task notification) and
 * covers the assistant messages up to the next real prompt. The LAST assistant message of
 * each settled turn gets
 * <ul>
 *   <li>{@code raw.turnUsage} — message.usage summed across the turn's assistant messages
 *       (deduped by message.id: one API response can span several transcript lines that
 *       share the id and carry identical usage), in the exact shape
 *       {@code MessageDurationFooter.extractTokenUsage} expects;</li>
 *   <li>{@code raw.turnCostUsd} — priced at the turn's billing instant (the last assistant
 *       raw timestamp, UTC) so time-of-day tiers resolve to the same tier the live
 *       settlement used.</li>
 * </ul>
 *
 * <p>Existing values are never overwritten (live-settled turns keep theirs), and models
 * without a usable price stay token-only: the footer shows no cost rather than a guess.
 */
public final class TurnPricingBackfill {

    private static final Logger LOG = Logger.getInstance(TurnPricingBackfill.class);

    private static final String TASK_NOTIFICATION_TAG = "<task-notification>";
    private static final String TOOL_RESULT_PLACEHOLDER = "[tool_result]";

    private TurnPricingBackfill() {
    }

    /**
     * Backfill turnUsage/turnCostUsd in place. Only Claude transcripts are handled: other
     * providers persist different raw shapes that this grouping would misread.
     */
    public static void backfill(List<ClaudeSession.Message> messages, String provider, String pricingModel) {
        if (messages == null || messages.isEmpty() || !"claude".equalsIgnoreCase(provider)) {
            return;
        }
        int index = 0;
        while (index < messages.size()) {
            if (!isRealUserPrompt(messages.get(index))) {
                index++;
                continue;
            }
            int turnEnd = index + 1;
            int lastAssistantIndex = -1;
            while (turnEnd < messages.size() && !isRealUserPrompt(messages.get(turnEnd))) {
                if (messages.get(turnEnd).type == ClaudeSession.Message.Type.ASSISTANT) {
                    lastAssistantIndex = turnEnd;
                }
                turnEnd++;
            }
            if (lastAssistantIndex >= 0) {
                backfillTurn(messages.subList(index + 1, turnEnd), messages.get(lastAssistantIndex), pricingModel);
            }
            index = turnEnd;
        }
    }

    private static void backfillTurn(List<ClaudeSession.Message> turnMessages,
                                     ClaudeSession.Message lastAssistant,
                                     String pricingModel) {
        JsonObject raw = lastAssistant.raw;
        if (raw == null) {
            return;
        }

        if (!raw.has("turnUsage") || raw.get("turnUsage").isJsonNull()) {
            JsonObject turnUsage = sumTurnUsage(turnMessages);
            if (turnUsage != null) {
                raw.add("turnUsage", turnUsage);
            }
        }

        if (raw.has("turnCostUsd") && !raw.get("turnCostUsd").isJsonNull()) {
            // Live-settled turn: its cost is authoritative.
            return;
        }
        JsonElement usageElement = raw.get("turnUsage");
        if (usageElement == null || !usageElement.isJsonObject()) {
            return;
        }

        long billingInstant = resolveBillingInstant(raw);
        Double costUsd = UsageCostCalculator.calculateTurnCostUsd(
                "claude", usageElement.getAsJsonObject(), pricingModel, billingInstant);
        if (costUsd != null) {
            raw.addProperty("turnCostUsd", costUsd);
        }
    }

    /**
     * Sum message.usage across the turn's assistant messages, counted once per unique
     * message.id. Returns null when no assistant message carries usage.
     */
    private static JsonObject sumTurnUsage(List<ClaudeSession.Message> turnMessages) {
        long inputTokens = 0;
        long cacheCreationTokens = 0;
        long cacheReadTokens = 0;
        long outputTokens = 0;
        boolean found = false;
        Set<String> seenIds = new HashSet<>();

        for (ClaudeSession.Message message : turnMessages) {
            if (message.type != ClaudeSession.Message.Type.ASSISTANT || message.raw == null) {
                continue;
            }
            JsonObject nested = asObject(message.raw.get("message"));
            JsonObject usage = nested == null ? null : asObject(nested.get("usage"));
            if (usage == null) {
                continue;
            }
            String id = stringValue(nested.get("id"));
            if (id != null && !seenIds.add(id)) {
                continue;
            }
            inputTokens += positiveLong(usage, "input_tokens");
            cacheCreationTokens += positiveLong(usage, "cache_creation_input_tokens");
            cacheReadTokens += positiveLong(usage, "cache_read_input_tokens");
            outputTokens += positiveLong(usage, "output_tokens");
            found = true;
        }

        if (!found || inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens <= 0) {
            return null;
        }
        JsonObject turnUsage = new JsonObject();
        turnUsage.addProperty("input_tokens", inputTokens);
        turnUsage.addProperty("cache_creation_input_tokens", cacheCreationTokens);
        turnUsage.addProperty("cache_read_input_tokens", cacheReadTokens);
        turnUsage.addProperty("output_tokens", outputTokens);
        return turnUsage;
    }

    /**
     * A turn starts at a REAL user prompt: not a tool_result carrier, not a meta caveat,
     * not a synthetic (non-human origin) message, not a task notification. Mirrors
     * isRealUserPrompt in turnMetadataReconstruction.ts so both layers group identically.
     */
    private static boolean isRealUserPrompt(ClaudeSession.Message message) {
        if (message.type != ClaudeSession.Message.Type.USER) {
            return false;
        }
        JsonObject raw = message.raw;
        if (raw == null) {
            return false;
        }
        if (TOOL_RESULT_PLACEHOLDER.equals(message.content == null ? "" : message.content.trim())
                || hasToolResultBlock(raw)) {
            return false;
        }
        JsonElement isMeta = raw.get("isMeta");
        if (isMeta != null && isMeta.isJsonPrimitive() && isMeta.getAsJsonPrimitive().isBoolean()
                && isMeta.getAsBoolean()) {
            return false;
        }
        JsonObject origin = asObject(raw.get("origin"));
        if (origin != null && !"human".equals(stringValue(origin.get("kind")))) {
            return false;
        }
        return !containsTaskNotification(message);
    }

    /** True when any content block is a tool_result (mirrors turnScope.isToolResultOnlyUserMessage). */
    private static boolean hasToolResultBlock(JsonObject raw) {
        JsonArray content = findContentArray(raw);
        if (content == null) {
            return false;
        }
        for (JsonElement block : content) {
            JsonObject blockObject = asObject(block);
            if (blockObject != null && "tool_result".equals(stringValue(blockObject.get("type")))) {
                return true;
            }
        }
        return false;
    }

    /** The message content array, preferring raw.content over raw.message.content. */
    private static JsonArray findContentArray(JsonObject raw) {
        JsonElement content = raw.get("content");
        if (content == null || content.isJsonNull()) {
            JsonObject nested = asObject(raw.get("message"));
            content = nested == null ? null : nested.get("content");
        }
        return content != null && content.isJsonArray() ? content.getAsJsonArray() : null;
    }

    /** Mirrors hasTaskNotificationTag: any user-visible text of the message containing the tag. */
    private static boolean containsTaskNotification(ClaudeSession.Message message) {
        if (textContains(message.content)) {
            return true;
        }
        JsonObject raw = message.raw;
        if (raw == null) {
            return false;
        }
        if (textsContain(raw.get("content"))) {
            return true;
        }
        JsonObject nested = asObject(raw.get("message"));
        return nested != null && textsContain(nested.get("content"));
    }

    private static boolean textsContain(JsonElement content) {
        if (content == null) {
            return false;
        }
        if (content.isJsonPrimitive() && content.getAsJsonPrimitive().isString()) {
            return textContains(content.getAsString());
        }
        if (content.isJsonArray()) {
            for (JsonElement block : content.getAsJsonArray()) {
                JsonObject blockObject = asObject(block);
                if (blockObject != null && "text".equals(stringValue(blockObject.get("type")))) {
                    JsonElement text = blockObject.get("text");
                    if (text != null && text.isJsonPrimitive() && textContains(text.getAsString())) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private static boolean textContains(String text) {
        return text != null && text.contains(TASK_NOTIFICATION_TAG);
    }

    /**
     * The turn's billing instant: the last assistant raw timestamp parsed as UTC. Falls
     * back to the current time when the timestamp is missing or unparsable, matching the
     * live settlement's "price at settlement time" behavior.
     */
    private static long resolveBillingInstant(JsonObject raw) {
        JsonElement timestamp = raw.get("timestamp");
        if (timestamp != null && timestamp.isJsonPrimitive()) {
            try {
                if (timestamp.getAsJsonPrimitive().isString()) {
                    return OffsetDateTime.parse(timestamp.getAsString()).toInstant().toEpochMilli();
                }
                if (timestamp.getAsJsonPrimitive().isNumber()) {
                    return timestamp.getAsLong();
                }
            } catch (DateTimeParseException e) {
                LOG.debug("[TurnPricingBackfill] Unparsable transcript timestamp: "
                        + timestamp.getAsString());
            }
        }
        return System.currentTimeMillis();
    }

    private static JsonObject asObject(JsonElement element) {
        return element != null && element.isJsonObject() ? element.getAsJsonObject() : null;
    }

    private static String stringValue(JsonElement element) {
        return element != null && element.isJsonPrimitive() && element.getAsJsonPrimitive().isString()
                ? element.getAsString()
                : null;
    }

    private static long positiveLong(JsonObject object, String key) {
        JsonElement value = object.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            return 0;
        }
        return Math.max(0, value.getAsLong());
    }
}
