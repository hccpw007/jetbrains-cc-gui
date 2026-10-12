package com.github.claudecodegui.util;

import com.github.claudecodegui.provider.pricing.ClaudePricing;
import com.github.claudecodegui.provider.pricing.ClaudePricingTable;
import com.github.claudecodegui.provider.pricing.CodexPricing;
import com.github.claudecodegui.provider.pricing.CodexPricingTable;
import com.github.claudecodegui.provider.pricing.TimeBasedPricing;
import com.google.gson.JsonObject;

/**
 * Calculates estimated per-turn usage cost using the shared pricing tables
 * ({@link ClaudePricingTable} / {@link CodexPricingTable}) that also back Usage Statistics,
 * so the per-turn footer and the statistics panel can never disagree on a model's price.
 *
 * <p>Unlike the statistics panel, an unknown model yields {@code null} (no cost shown) instead
 * of a default-priced estimate: a per-turn footer should stay silent rather than guess.
 *
 * <p>Models with a user-configured {@code timeBasedPricing} block (time-of-day rates such as
 * DeepSeek peak/off-peak) are billed at the tier of the billing instant, evaluated in UTC.
 */
public final class UsageCostCalculator {

    private UsageCostCalculator() {
    }

    /**
     * Price a turn billed at the current wall-clock time.
     */
    public static Double calculateTurnCostUsd(String provider, JsonObject turnUsage, String model) {
        return calculateTurnCostUsd(provider, turnUsage, model, System.currentTimeMillis());
    }

    /**
     * Price a turn billed at {@code epochMillisUtc}. The instant matters for models
     * configured with time-of-day pricing ({@code timeBasedPricing}): the peak/off-peak
     * window is evaluated in UTC against this timestamp. Callers price a finished turn,
     * so passing the end-of-turn time is equivalent to when the request was billed.
     */
    public static Double calculateTurnCostUsd(String provider, JsonObject turnUsage, String model, long epochMillisUtc) {
        if (turnUsage == null) {
            return null;
        }
        long inputTokens = readLong(turnUsage, "input_tokens");
        long outputTokens = readLong(turnUsage, "output_tokens");
        long cacheWriteTokens = readLong(turnUsage, "cache_creation_input_tokens");
        long cacheReadTokens = readLong(turnUsage, "cache_read_input_tokens", "cached_input_tokens");
        if ("codex".equalsIgnoreCase(provider)) {
            // turnUsage.input_tokens is already normalized to exclude cached input.
            CodexPricing pricing = CodexPricingTable.resolve(model);
            return pricing == null ? null : pricing.costUsd(inputTokens, outputTokens, cacheReadTokens);
        }
        ClaudePricing pricing = ClaudePricingTable.resolve(model);
        if (pricing == null) {
            return null;
        }
        // Time-based models (DeepSeek peak/off-peak) resolve the tier for the billing instant;
        // all other models keep the single resolved rate.
        TimeBasedPricing schedule = ClaudePricingTable.resolveSchedule(model);
        ClaudePricing billedPricing = schedule != null ? schedule.pricingAt(epochMillisUtc) : pricing;
        return billedPricing.costUsd(inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens);
    }

    private static long readLong(JsonObject json, String... keys) {
        if (json == null) {
            return 0;
        }
        for (String key : keys) {
            if (json.has(key) && !json.get(key).isJsonNull()) {
                return Math.max(0, json.get(key).getAsLong());
            }
        }
        return 0;
    }
}
