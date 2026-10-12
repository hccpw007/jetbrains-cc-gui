package com.github.claudecodegui.provider.pricing;

import com.github.claudecodegui.provider.CustomPricingProvider;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

/**
 * Contract tests for the shared pricing tables that back both Usage Statistics and the
 * per-turn footer. {@code resolve} stays silent (null) for unknown models; {@code resolveOrDefault}
 * always returns a price.
 */
public class PricingTableTest {

    @Test
    public void claudeResolveReturnsNullForUnknownButDefaultOtherwise() {
        assertNull(ClaudePricingTable.resolve("custom-claude-without-pricing"));
        assertNull(ClaudePricingTable.resolve(null));
        // resolveOrDefault falls back to the default-model pricing (sonnet-4-6).
        assertNotNull(ClaudePricingTable.resolveOrDefault("custom-claude-without-pricing"));
        assertEquals(3.0, ClaudePricingTable.resolveOrDefault("totally-unknown").inputCostPer1M(), 1e-9);
    }

    @Test
    public void claudeNormalizesCaseAndProviderPrefix() {
        // Upper-case and a provider route prefix both normalize to claude-opus-4-8 (opus 4.5 tier).
        assertEquals(5.0, ClaudePricingTable.resolve("anthropic/CLAUDE-OPUS-5").inputCostPer1M(), 1e-9);
        assertEquals(5.0, ClaudePricingTable.resolve("anthropic/CLAUDE-OPUS-4-8").inputCostPer1M(), 1e-9);
        assertEquals(3.0, ClaudePricingTable.resolve("anthropic/CLAUDE-SONNET-4-7").inputCostPer1M(), 1e-9);
    }

    @Test
    public void claudeResolvesOpus55AboveTheBareOpus5Prefix() {
        // "claude-opus-5-5" has its own rate ($4/$20), so it must outrank the shorter
        // "claude-opus-5" prefix ($5/$25) and survive dated snapshots instead of losing to it.
        assertEquals(4.0, ClaudePricingTable.resolve("claude-opus-5-5").inputCostPer1M(), 1e-9);
        assertEquals(20.0, ClaudePricingTable.resolve("claude-opus-5-5").outputCostPer1M(), 1e-9);
        assertEquals(5.0, ClaudePricingTable.resolve("claude-opus-5-5-2026-03-01").cacheWriteCostPer1M(), 1e-9);
        assertEquals(0.40, ClaudePricingTable.resolve("claude-opus-5-5").cacheReadCostPer1M(), 1e-9);
        assertEquals(5.0, ClaudePricingTable.resolve("claude-opus-5").inputCostPer1M(), 1e-9);
    }

    @Test
    public void claudeResolvesSonnet55AboveTheBareSonnet5Prefix() {
        // "claude-sonnet-5-5" is the newer point release and keeps the Sonnet 5 default rate
        // ($3/$15), so it must outrank the shorter "claude-sonnet-5" prefix and survive
        // dated snapshots instead of losing to it.
        assertEquals(3.0, ClaudePricingTable.resolve("claude-sonnet-5-5").inputCostPer1M(), 1e-9);
        assertEquals(15.0, ClaudePricingTable.resolve("claude-sonnet-5-5").outputCostPer1M(), 1e-9);
        assertEquals(3.0, ClaudePricingTable.resolve("claude-sonnet-5-5-2026-04-01").inputCostPer1M(), 1e-9);
        assertEquals(3.0, ClaudePricingTable.resolve("claude-sonnet-5").inputCostPer1M(), 1e-9);
    }

    @Test
    public void claudeAppliesAbove200KTierForSonnet4() {
        ClaudePricing pricing = ClaudePricingTable.resolve("claude-sonnet-4");
        assertNotNull(pricing);
        // Under the 200K request threshold uses the base input rate (3.0); above it uses 6.0.
        double under = pricing.costUsd(1_000, 0, 0, 0);
        double over = pricing.costUsd(300_000, 0, 0, 0);
        assertEquals(1_000 / 1_000_000.0 * 3.0, under, 1e-9);
        assertEquals(300_000 / 1_000_000.0 * 6.0, over, 1e-9);
    }

    @Test
    public void codexResolveReturnsNullForUnknownButDefaultOtherwise() {
        assertNull(CodexPricingTable.resolve("custom-codex-without-pricing"));
        assertNull(CodexPricingTable.resolve(null));
        assertEquals(1.25, CodexPricingTable.resolveOrDefault("totally-unknown").inputCostPer1M(), 1e-9);
    }

    @Test
    public void codexAliasesBareGpt56ToSol() {
        // Bare "gpt-5.6" and a dated snapshot both resolve to gpt-5.6-sol pricing.
        assertEquals(5.0, CodexPricingTable.resolve("gpt-5.6").inputCostPer1M(), 1e-9);
        assertEquals(5.0, CodexPricingTable.resolve("gpt-5.6-sol-2026-01-15").inputCostPer1M(), 1e-9);
    }

    @Test
    public void codexResolvesGpt6SolAndLunaBeforeTheBareGpt6Prefix() {
        // "gpt-6" itself still aliases to gpt-6-astra, but the newer Sol / Luna ids must win
        // over that prefix match (prefix order in CodexPricingTable) and survive snapshots.
        // GPT-6 Sol is $2/$10 and GPT-6 Luna is $0.1/$0.5 per 1M tokens (cache read = 10% of input).
        assertEquals(2.0, CodexPricingTable.resolve("gpt-6-sol").inputCostPer1M(), 1e-9);
        assertEquals(10.0, CodexPricingTable.resolve("gpt-6-sol").outputCostPer1M(), 1e-9);
        assertEquals(0.2, CodexPricingTable.resolve("gpt-6-sol").cacheReadCostPer1M(), 1e-9);
        assertEquals(2.0, CodexPricingTable.resolve("gpt-6-sol-2026-02-01").inputCostPer1M(), 1e-9);
        assertEquals(0.1, CodexPricingTable.resolve("gpt-6-luna").inputCostPer1M(), 1e-9);
        assertEquals(0.5, CodexPricingTable.resolve("gpt-6-luna").outputCostPer1M(), 1e-9);
        assertEquals(0.01, CodexPricingTable.resolve("gpt-6-luna").cacheReadCostPer1M(), 1e-9);
        assertEquals(10.0, CodexPricingTable.resolve("gpt-6").inputCostPer1M(), 1e-9);
    }

    @Test
    public void codexResolvesGpt61SolBeforeTheBareGpt6Prefix() {
        // "gpt-6.1-sol" is the newer point release and keeps the GPT-6 Sol rate ($2/$10).
        // Because its id starts with "gpt-6" it must be matched before that bare prefix
        // (which aliases to the $10/$50 gpt-6-astra) and survive dated snapshots.
        assertEquals(2.0, CodexPricingTable.resolve("gpt-6.1-sol").inputCostPer1M(), 1e-9);
        assertEquals(10.0, CodexPricingTable.resolve("gpt-6.1-sol").outputCostPer1M(), 1e-9);
        assertEquals(0.2, CodexPricingTable.resolve("gpt-6.1-sol").cacheReadCostPer1M(), 1e-9);
        assertEquals(2.0, CodexPricingTable.resolve("gpt-6.1-sol-2026-04-01").inputCostPer1M(), 1e-9);
    }

    @Test
    public void claudeResolveScheduleBuildsTiersAndFallsBackToBaseRates() throws Exception {
        Path config = Files.createTempFile("pricing-schedule", ".json");
        Files.writeString(config, """
                {"customModelPricing":{"claude":{"deepseek-v4-flash":{
                  "inputCostPer1M":0.14,"outputCostPer1M":0.28,"cacheWriteCostPer1M":0.14,"cacheReadCostPer1M":0.0028,
                  "timeBasedPricing":{
                    "peakWindowsUtc":[{"weekdays":[1,2,3,4,5],"startHour":1,"endHour":4},
                                      {"weekdays":[1,2,3,4,5],"startHour":6,"endHour":10}],
                    "peak":{"inputCostPer1M":0.30,"outputCostPer1M":1.20},
                    "offPeak":{"inputCostPer1M":0.15}}},
                  "deepseek-v4-pro":{"inputCostPer1M":1.0}}}}
                """);
        CustomPricingProvider.setInstanceForTests(CustomPricingProvider.createForTests(config));
        try {
            TimeBasedPricing schedule = ClaudePricingTable.resolveSchedule("deepseek-v4-flash");
            assertNotNull(schedule);

            // Monday 02:00 UTC is inside the first peak window; Monday 12:00 is off-peak.
            ClaudePricing peak = schedule.pricingAt(utc(2026, 10, 12, 2, 0));
            ClaudePricing offPeak = schedule.pricingAt(utc(2026, 10, 12, 12, 0));
            assertEquals(0.30, peak.inputCostPer1M(), 1e-9);
            assertEquals(1.20, peak.outputCostPer1M(), 1e-9);
            assertEquals(0.15, offPeak.inputCostPer1M(), 1e-9);
            // Unset tier dimensions fall back to the model's base rates, not the other tier's.
            assertEquals(0.14, peak.cacheWriteCostPer1M(), 1e-9);
            assertEquals(0.0028, peak.cacheReadCostPer1M(), 1e-9);
            assertEquals(0.28, offPeak.outputCostPer1M(), 1e-9);

            // Models without a timeBasedPricing block keep the single-rate path.
            assertNull(ClaudePricingTable.resolveSchedule("deepseek-v4-pro"));
            assertNull(ClaudePricingTable.resolveSchedule("claude-sonnet-5"));
        } finally {
            CustomPricingProvider.setInstanceForTests(null);
            Files.deleteIfExists(config);
        }
    }

    /** Build an epoch-millis instant from UTC wall-clock parts. */
    private static long utc(int year, int month, int day, int hour, int minute) {
        return ZonedDateTime.of(year, month, day, hour, minute, 0, 0, ZoneOffset.UTC)
                .toInstant()
                .toEpochMilli();
    }
}
