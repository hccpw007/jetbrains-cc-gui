package com.github.claudecodegui.settings;

import java.util.List;

/**
 * Pricing configuration for a custom model.
 *
 * <p>All fields are nullable: a {@code null} field means "not configured, fall back to
 * the default pricing for that token kind". This keeps the structure backward-compatible
 * when new pricing dimensions are introduced and lets users specify only the rates they know.
 *
 * <p>Units are USD per 1,000,000 tokens, consistent with the {@code *CostPer1M}
 * fields used by the per-turn message footer cost calculator.
 *
 * <p>{@code timeBasedPricing} is optional: providers such as DeepSeek bill peak and
 * off-peak hours at different rates. When present, the four top-level rates act as the
 * base price and any dimension left unset inside a tier falls back to them.
 */
public record ModelPricing(
        Double inputCostPer1M,
        Double outputCostPer1M,
        Double cacheWriteCostPer1M,
        Double cacheReadCostPer1M,
        TimeBasedPricing timeBasedPricing
) {
    /**
     * Build a single-rate pricing (no time-based tiers), compatible with configs
     * written before {@code timeBasedPricing} existed.
     */
    public ModelPricing(
            Double inputCostPer1M,
            Double outputCostPer1M,
            Double cacheWriteCostPer1M,
            Double cacheReadCostPer1M
    ) {
        this(inputCostPer1M, outputCostPer1M, cacheWriteCostPer1M, cacheReadCostPer1M, null);
    }

    /**
     * Build a Claude-style pricing (all four dimensions).
     */
    public static ModelPricing claude(double input, double output, double cacheWrite, double cacheRead) {
        return new ModelPricing(input, output, cacheWrite, cacheRead);
    }

    /**
     * Build a Codex-style pricing (no cache-write dimension; Codex sessions do not track
     * cache-write tokens).
     */
    public static ModelPricing codex(double input, double output, double cacheRead) {
        return new ModelPricing(input, output, null, cacheRead);
    }

    /**
     * Time-of-day pricing: UTC peak windows plus the peak/off-peak rate tiers.
     *
     * <p>Windows are evaluated in UTC because providers that bill by time of day
     * (DeepSeek among them) publish their schedules in UTC. A request billed while
     * inside any window uses {@code peak}; everything else uses {@code offPeak}.
     */
    public record TimeBasedPricing(
            List<PeakWindow> peakWindowsUtc,
            Rates peak,
            Rates offPeak
    ) {
    }

    /**
     * A single peak window: the {@code [startHour, endHour)} UTC hours of the listed
     * weekdays, with hours in 0..24. A window whose {@code startHour} exceeds its
     * {@code endHour} wraps past midnight (for example 22 to 2), and its after-midnight
     * part belongs to the weekday that started it.
     *
     * <p>{@code weekdays} uses ISO numbering: 1 = Monday … 7 = Sunday
     * (matches {@code DayOfWeek.getValue()}).
     */
    public record PeakWindow(
            List<Integer> weekdays,
            int startHour,
            int endHour
    ) {
    }

    /**
     * One rate tier (peak or off-peak). Each dimension is nullable and falls back to
     * the model's base rate when unset.
     */
    public record Rates(
            Double inputCostPer1M,
            Double outputCostPer1M,
            Double cacheWriteCostPer1M,
            Double cacheReadCostPer1M
    ) {
    }
}
