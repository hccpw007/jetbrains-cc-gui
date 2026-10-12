package com.github.claudecodegui.provider.pricing;

import com.github.claudecodegui.provider.CustomPricingProvider;
import com.github.claudecodegui.settings.ModelPricing;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Single source of truth for Claude built-in pricing, model normalization, and
 * user-configured pricing resolution. Usage-cost consumers (Usage
 * Statistics) and {@code UsageCostCalculator} (per-turn footer) resolve pricing
 * through here so the two can never disagree.
 */
public final class ClaudePricingTable {

    public static final String DEFAULT_MODEL = "claude-sonnet-5";

    private static final ClaudePricing DEFAULT_PRICING = new ClaudePricing(3.0, 15.0, 3.75, 0.30);
    private static final ClaudePricing TIERED_SONNET_PRICING = new ClaudePricing(3.0, 15.0, 3.75, 0.30, 6.0, 22.5, 7.5, 0.60);
    private static final ClaudePricing LEGACY_OPUS_PRICING = new ClaudePricing(15.0, 75.0, 18.75, 1.50);
    private static final ClaudePricing OPUS_4_5_PRICING = new ClaudePricing(5.0, 25.0, 6.25, 0.50);
    private static final ClaudePricing OPUS_5_5_PRICING = new ClaudePricing(4.0, 20.0, 5.0, 0.40);
    private static final ClaudePricing FABLE_5_PRICING = new ClaudePricing(10.0, 50.0, 12.5, 1.0);
    private static final ClaudePricing HAIKU_4_5_PRICING = new ClaudePricing(1.0, 5.0, 1.25, 0.10);

    private static final Map<String, ClaudePricing> MODEL_PRICING = Map.ofEntries(
            Map.entry("claude-opus-4", LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-1", LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-20250514", LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-5", OPUS_4_5_PRICING),
            Map.entry("claude-opus-4-6", OPUS_4_5_PRICING),
            Map.entry("claude-opus-4-7", OPUS_4_5_PRICING),
            Map.entry("claude-opus-4-8", OPUS_4_5_PRICING),
            Map.entry("claude-opus-5-5", OPUS_5_5_PRICING),
            Map.entry("claude-opus-5", OPUS_4_5_PRICING),
            Map.entry("claude-fable-5-1", FABLE_5_PRICING),
            Map.entry("claude-fable-5", FABLE_5_PRICING),
            Map.entry("claude-sonnet-4", TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-20250514", TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-5", TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-6", DEFAULT_PRICING),
            Map.entry("claude-sonnet-4-7", DEFAULT_PRICING),
            Map.entry("claude-sonnet-5-5", DEFAULT_PRICING),
            Map.entry("claude-sonnet-5", DEFAULT_PRICING),
            Map.entry("claude-haiku-4", HAIKU_4_5_PRICING),
            Map.entry("claude-haiku-4-5", HAIKU_4_5_PRICING)
    );
    private static final List<String> MODEL_PREFIXES = List.of(
            "claude-fable-5-1",
            "claude-fable-5",
            "claude-opus-5-5",
            "claude-opus-5",
            "claude-opus-4-20250514",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-opus-4-5",
            "claude-opus-4-1",
            "claude-opus-4",
            "claude-sonnet-4-20250514",
            "claude-sonnet-5-5",
            "claude-sonnet-5",
            "claude-sonnet-4-7",
            "claude-sonnet-4-6",
            "claude-sonnet-4-5",
            "claude-sonnet-4",
            "claude-haiku-4-5",
            "claude-haiku-4"
    );

    private ClaudePricingTable() {
    }

    /**
     * Built-in or user-configured pricing for {@code model}, or {@code null} when the model
     * matches neither. Callers that must always show a number use {@link #resolveOrDefault}.
     */
    public static ClaudePricing resolve(String model) {
        ClaudePricing builtin = builtinFor(model);
        ClaudePricing custom = customFor(model, builtin);
        return custom != null ? custom : builtin;
    }

    /** Like {@link #resolve} but falls back to the default model's pricing when nothing matches. */
    public static ClaudePricing resolveOrDefault(String model) {
        ClaudePricing pricing = resolve(model);
        return pricing != null ? pricing : DEFAULT_PRICING;
    }

    /**
     * Time-of-day pricing rule for {@code model}, or {@code null} when the model has no
     * usable {@code timeBasedPricing} configuration (the common single-rate case).
     *
     * <p>Only user-configured pricing supports time tiers. A tier dimension left unset
     * falls back to the model's resolved base rate ({@link #resolve}: custom top-level
     * rate first, then its built-in rate). A config with no valid peak window, or with
     * neither tier carrying any rate, is treated as "no schedule" rather than silently
     * billing everything at off-peak.
     */
    public static TimeBasedPricing resolveSchedule(String model) {
        if (model == null || model.isBlank()) {
            return null;
        }
        ModelPricing custom = CustomPricingProvider.getInstance().getPricing("claude", model).orElse(null);
        ModelPricing.TimeBasedPricing config = custom == null ? null : custom.timeBasedPricing();
        if (config == null) {
            return null;
        }

        List<TimeBasedPricing.PeakWindow> windows = new ArrayList<>();
        if (config.peakWindowsUtc() != null) {
            for (ModelPricing.PeakWindow window : config.peakWindowsUtc()) {
                TimeBasedPricing.PeakWindow validated = toPeakWindow(window);
                if (validated != null) {
                    windows.add(validated);
                }
            }
        }
        if (windows.isEmpty() || (config.peak() == null && config.offPeak() == null)) {
            return null;
        }

        ClaudePricing base = resolve(model);
        if (base == null) {
            return null;
        }
        return new TimeBasedPricing(
                List.copyOf(windows),
                toTierPricing(config.peak(), base),
                toTierPricing(config.offPeak(), base));
    }

    /**
     * Validate and convert a configured peak window, or {@code null} when it is unusable
     * (no valid weekday, hour out of range, or an empty range). Unknown weekday values
     * are dropped; the window survives as long as at least one valid weekday remains.
     */
    private static TimeBasedPricing.PeakWindow toPeakWindow(ModelPricing.PeakWindow window) {
        if (window == null || window.weekdays() == null) {
            return null;
        }
        List<Integer> weekdays = new ArrayList<>();
        for (Integer day : window.weekdays()) {
            if (day != null && day >= 1 && day <= 7 && !weekdays.contains(day)) {
                weekdays.add(day);
            }
        }
        if (weekdays.isEmpty()
                || window.startHour() < 0 || window.startHour() > 23
                || window.endHour() < 0 || window.endHour() > 24
                || window.startHour() == window.endHour()) {
            return null;
        }
        return new TimeBasedPricing.PeakWindow(List.copyOf(weekdays), window.startHour(), window.endHour());
    }

    /** Convert a configured tier into a concrete price, filling unset dimensions from {@code base}. */
    private static ClaudePricing toTierPricing(ModelPricing.Rates rates, ClaudePricing base) {
        if (rates == null) {
            return base;
        }
        return new ClaudePricing(
                rates.inputCostPer1M() != null ? rates.inputCostPer1M() : base.inputCostPer1M(),
                rates.outputCostPer1M() != null ? rates.outputCostPer1M() : base.outputCostPer1M(),
                rates.cacheWriteCostPer1M() != null ? rates.cacheWriteCostPer1M() : base.cacheWriteCostPer1M(),
                rates.cacheReadCostPer1M() != null ? rates.cacheReadCostPer1M() : base.cacheReadCostPer1M());
    }

    private static ClaudePricing builtinFor(String model) {
        String normalized = normalize(model);
        return normalized == null ? null : MODEL_PRICING.get(normalized);
    }

    /**
     * User-configured pricing, or {@code null} if none. Unspecified dimensions fall back to the
     * overridden model's OWN built-in rate when it is a known model, otherwise 0 — never the
     * generic default model's rate, which would turn a partial custom price into an over-estimate.
     */
    private static ClaudePricing customFor(String model, ClaudePricing builtin) {
        if (model == null || model.isBlank()) {
            return null;
        }
        return CustomPricingProvider.getInstance().getPricing("claude", model)
                .map(p -> new ClaudePricing(
                        p.inputCostPer1M() != null ? p.inputCostPer1M() : (builtin != null ? builtin.inputCostPer1M() : 0.0),
                        p.outputCostPer1M() != null ? p.outputCostPer1M() : (builtin != null ? builtin.outputCostPer1M() : 0.0),
                        p.cacheWriteCostPer1M() != null ? p.cacheWriteCostPer1M() : (builtin != null ? builtin.cacheWriteCostPer1M() : 0.0),
                        p.cacheReadCostPer1M() != null ? p.cacheReadCostPer1M() : (builtin != null ? builtin.cacheReadCostPer1M() : 0.0),
                        null, null, null, null))
                .orElse(null);
    }

    private static String normalize(String model) {
        if (model == null || model.isBlank()) {
            return null;
        }

        String normalized = model.toLowerCase();
        int claudeIndex = normalized.indexOf("claude-");
        if (claudeIndex >= 0) {
            normalized = normalized.substring(claudeIndex);
        }

        final String candidate = normalized;
        return MODEL_PREFIXES.stream()
                .filter(candidate::startsWith)
                .findFirst()
                .orElse(candidate);
    }
}
