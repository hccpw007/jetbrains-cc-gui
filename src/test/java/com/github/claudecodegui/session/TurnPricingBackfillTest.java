package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.CustomPricingProvider;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * History-reload backfill of the per-turn token/cost metadata: the transcript persists
 * neither raw.turnUsage nor raw.turnCostUsd, so reopening a session must rebuild them
 * (token footer + amount) from the assistant message.usage entries.
 */
public class TurnPricingBackfillTest {

    private Path isolationConfig;

    /**
     * Isolate the pricing provider from the developer's real ~/.codemoss config and pin a
     * time-based price for {@code deepseek-flash}: off-peak 0.15/0.60/0/0.003,
     * peak 0.30/1.20/0/0.006, peak = Mon-Fri 01-04 & 06-10 UTC.
     */
    @Before
    public void isolateCustomPricing() throws IOException {
        isolationConfig = Files.createTempFile("backfill-pricing", ".json");
        Files.writeString(isolationConfig, """
                {"customModelPricing":{"claude":{"deepseek-flash":{
                  "inputCostPer1M":0.15,"outputCostPer1M":0.60,"cacheWriteCostPer1M":0,"cacheReadCostPer1M":0.003,
                  "timeBasedPricing":{
                    "peakWindowsUtc":[{"weekdays":[1,2,3,4,5],"startHour":1,"endHour":4}],
                    "peak":{"inputCostPer1M":0.30,"outputCostPer1M":1.20,"cacheWriteCostPer1M":0,"cacheReadCostPer1M":0.006},
                    "offPeak":{"inputCostPer1M":0.15,"outputCostPer1M":0.60,"cacheWriteCostPer1M":0,"cacheReadCostPer1M":0.003}}}}}}
                """);
        CustomPricingProvider.setInstanceForTests(CustomPricingProvider.createForTests(isolationConfig));
    }

    @After
    public void restoreCustomPricing() throws IOException {
        CustomPricingProvider.setInstanceForTests(null);
        Files.deleteIfExists(isolationConfig);
    }

    @Test
    public void stampsWholeTurnUsageAndCostOnTheLastAssistantOfEachTurn() {
        List<ClaudeSession.Message> messages = List.of(
                user("question"),
                assistant("id-1", "2026-10-12T12:00:00.000Z", 1_000_000, 0, 0),
                // Same API response split across transcript lines: same id, counted once.
                assistant("id-1", "2026-10-12T12:00:01.000Z", 1_000_000, 0, 0),
                assistant("id-2", "2026-10-12T12:00:05.000Z", 0, 1_000_000, 1_000_000));

        TurnPricingBackfill.backfill(messages, "claude", "deepseek-flash");

        JsonObject raw = messages.get(3).raw;
        JsonObject turnUsage = raw.getAsJsonObject("turnUsage");
        assertEquals(1_000_000, turnUsage.get("input_tokens").getAsLong());
        assertEquals(1_000_000, turnUsage.get("cache_read_input_tokens").getAsLong());
        assertEquals(1_000_000, turnUsage.get("output_tokens").getAsLong());
        // Monday 12:00 UTC is off-peak: 1M×0.15 + 1M×0.003 + 1M×0.60 = 0.753
        assertEquals(0.753, raw.get("turnCostUsd").getAsDouble(), 1e-9);

        // Only the last assistant of the turn is stamped.
        assertNull(messages.get(1).raw.get("turnUsage"));
        assertNull(messages.get(2).raw.get("turnUsage"));
    }

    @Test
    public void pricesEachTurnAtItsOwnBillingInstant() {
        List<ClaudeSession.Message> messages = List.of(
                // Monday 02:00 UTC → peak window [01,04)
                user("peak question"),
                assistant("p-1", "2026-10-12T02:00:00.000Z", 1_000_000, 1_000_000, 1_000_000),
                // Monday 12:00 UTC → off-peak
                user("off-peak question"),
                assistant("o-1", "2026-10-12T12:00:00.000Z", 1_000_000, 1_000_000, 1_000_000));

        TurnPricingBackfill.backfill(messages, "claude", "deepseek-flash");

        // Peak: 1M×0.30 + 1M×0.006 + 1M×1.20 = 1.506
        assertEquals(1.506, messages.get(1).raw.get("turnCostUsd").getAsDouble(), 1e-9);
        // Off-peak: 1M×0.15 + 1M×0.003 + 1M×0.60 = 0.753
        assertEquals(0.753, messages.get(3).raw.get("turnCostUsd").getAsDouble(), 1e-9);
    }

    @Test
    public void keepsExistingSettlementValues() {
        ClaudeSession.Message settled = assistant("s-1", "2026-10-12T12:00:00.000Z", 100, 0, 10);
        JsonObject existingUsage = new JsonObject();
        existingUsage.addProperty("input_tokens", 42);
        settled.raw.add("turnUsage", existingUsage);
        settled.raw.addProperty("turnCostUsd", 9.99);
        List<ClaudeSession.Message> messages = List.of(user("question"), settled);

        TurnPricingBackfill.backfill(messages, "claude", "deepseek-flash");

        assertEquals(42, settled.raw.getAsJsonObject("turnUsage").get("input_tokens").getAsLong());
        assertEquals(9.99, settled.raw.get("turnCostUsd").getAsDouble(), 1e-9);
    }

    @Test
    public void pricesExistingTurnUsageWhenOnlyTheCostIsMissing() {
        ClaudeSession.Message assistant = assistant("c-1", "2026-10-12T12:00:00.000Z", 100, 0, 10);
        JsonObject existingUsage = new JsonObject();
        existingUsage.addProperty("input_tokens", 1_000_000);
        existingUsage.addProperty("cache_creation_input_tokens", 0);
        existingUsage.addProperty("cache_read_input_tokens", 0);
        existingUsage.addProperty("output_tokens", 0);
        assistant.raw.add("turnUsage", existingUsage);
        List<ClaudeSession.Message> messages = List.of(user("question"), assistant);

        TurnPricingBackfill.backfill(messages, "claude", "deepseek-flash");

        // Off-peak input only: 1M × 0.15
        assertEquals(0.15, assistant.raw.get("turnCostUsd").getAsDouble(), 1e-9);
    }

    @Test
    public void toolResultCarriersDoNotStartANewTurn() {
        List<ClaudeSession.Message> messages = List.of(
                user("question"),
                assistant("t-1", "2026-10-12T12:00:00.000Z", 1_000_000, 0, 0),
                toolResultUser(),
                assistant("t-2", "2026-10-12T12:00:02.000Z", 0, 0, 1_000_000));

        TurnPricingBackfill.backfill(messages, "claude", "deepseek-flash");

        // One turn: usage summed across both assistant fragments, stamped on the last one.
        JsonObject turnUsage = messages.get(3).raw.getAsJsonObject("turnUsage");
        assertEquals(1_000_000, turnUsage.get("input_tokens").getAsLong());
        assertEquals(1_000_000, turnUsage.get("output_tokens").getAsLong());
        assertNull(messages.get(1).raw.get("turnUsage"));
        // Off-peak: 1M×0.15 + 1M×0.60 = 0.75
        assertEquals(0.75, messages.get(3).raw.get("turnCostUsd").getAsDouble(), 1e-9);
    }

    @Test
    public void taskNotificationUserMessagesDoNotStartANewTurn() {
        List<ClaudeSession.Message> messages = List.of(
                user("question"),
                assistant("n-1", "2026-10-12T12:00:00.000Z", 1_000_000, 0, 0),
                user("<task-notification>subagent finished</task-notification>"),
                assistant("n-2", "2026-10-12T12:00:02.000Z", 0, 0, 1_000_000));

        TurnPricingBackfill.backfill(messages, "claude", "deepseek-flash");

        JsonObject turnUsage = messages.get(3).raw.getAsJsonObject("turnUsage");
        assertEquals(1_000_000, turnUsage.get("input_tokens").getAsLong());
        assertEquals(1_000_000, turnUsage.get("output_tokens").getAsLong());
    }

    @Test
    public void leavesUnknownModelsTokenOnly() {
        List<ClaudeSession.Message> messages = List.of(
                user("question"),
                assistant("u-1", "2026-10-12T12:00:00.000Z", 1_000_000, 0, 0));

        TurnPricingBackfill.backfill(messages, "claude", "no-pricing-configured-model");

        assertTrue(messages.get(1).raw.has("turnUsage"));
        assertFalse(messages.get(1).raw.has("turnCostUsd"));
    }

    @Test
    public void skipsNonClaudeProviders() {
        List<ClaudeSession.Message> messages = List.of(
                user("question"),
                assistant("x-1", "2026-10-12T12:00:00.000Z", 1_000_000, 0, 0));

        TurnPricingBackfill.backfill(messages, "codex", "deepseek-flash");

        assertFalse(messages.get(1).raw.has("turnUsage"));
        assertFalse(messages.get(1).raw.has("turnCostUsd"));
    }

    // ---------------------------------------------------------------------------
    // Message builders
    // ---------------------------------------------------------------------------

    private static ClaudeSession.Message user(String text) {
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        raw.add("content", content);
        return new ClaudeSession.Message(ClaudeSession.Message.Type.USER, text, raw);
    }

    private static ClaudeSession.Message toolResultUser() {
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", "tool-1");
        content.add(block);
        raw.add("content", content);
        return new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "[tool_result]", raw);
    }

    private static ClaudeSession.Message assistant(String id, String timestamp,
                                                  long inputTokens, long cacheReadTokens, long outputTokens) {
        JsonObject message = new JsonObject();
        message.addProperty("id", id);
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", inputTokens);
        usage.addProperty("cache_creation_input_tokens", 0);
        usage.addProperty("cache_read_input_tokens", cacheReadTokens);
        usage.addProperty("output_tokens", outputTokens);
        message.add("usage", usage);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        raw.addProperty("timestamp", timestamp);
        raw.add("message", message);
        return new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "answer", raw);
    }
}
