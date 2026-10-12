package com.github.claudecodegui.provider.pricing;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.List;

/**
 * Runtime time-of-day pricing: UTC peak windows plus the two resolved rate tiers.
 *
 * <p>Built by {@link ClaudePricingTable#resolveSchedule(String)} from a user-configured
 * {@code timeBasedPricing} block; {@link TimeBasedPricing#pricingAt(long)} picks the tier
 * for a given instant. Windows are evaluated in UTC (providers that bill by time of day
 * publish their schedules in UTC); hour bounds are half-open and a window with
 * {@code startHour > endHour} wraps past midnight, its after-midnight part belonging to
 * the weekday that started it.
 */
public record TimeBasedPricing(
        List<PeakWindow> peakWindowsUtc,
        ClaudePricing peakPricing,
        ClaudePricing offPeakPricing
) {

    /** Pick the rate tier for a request billed at {@code epochMillisUtc}. */
    public ClaudePricing pricingAt(long epochMillisUtc) {
        return inPeakWindow(epochMillisUtc) ? peakPricing : offPeakPricing;
    }

    private boolean inPeakWindow(long epochMillisUtc) {
        ZonedDateTime utc = Instant.ofEpochMilli(epochMillisUtc).atZone(ZoneOffset.UTC);
        int weekday = utc.getDayOfWeek().getValue();
        int hour = utc.getHour();
        // A wrapping window's after-midnight hours belong to the previous weekday,
        // e.g. Friday 22→2 covers Saturday 00:00–02:00.
        int previousWeekday = weekday == 1 ? 7 : weekday - 1;
        for (PeakWindow window : peakWindowsUtc) {
            if (window.contains(weekday, previousWeekday, hour)) {
                return true;
            }
        }
        return false;
    }

    /**
     * A single peak window: the {@code [startHour, endHour)} UTC hours of the listed
     * weekdays (ISO numbering, 1 = Monday … 7 = Sunday). {@code startHour > endHour}
     * means the window wraps past midnight.
     */
    public record PeakWindow(
            List<Integer> weekdays,
            int startHour,
            int endHour
    ) {

        boolean contains(int weekday, int previousWeekday, int hour) {
            if (startHour <= endHour) {
                return weekdays.contains(weekday) && hour >= startHour && hour < endHour;
            }
            return (weekdays.contains(weekday) && hour >= startHour)
                    || (weekdays.contains(previousWeekday) && hour < endHour);
        }
    }
}
