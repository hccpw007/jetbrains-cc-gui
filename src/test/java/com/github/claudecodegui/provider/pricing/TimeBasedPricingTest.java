package com.github.claudecodegui.provider.pricing;

import org.junit.Test;

import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.List;

import static org.junit.Assert.assertEquals;

/**
 * Window boundary rules for the runtime time-of-day pricing used by the DeepSeek-style
 * peak/off-peak schedules (peak = Mon–Fri 01–04 & 06–10 UTC).
 */
public class TimeBasedPricingTest {

    private static final ClaudePricing PEAK = new ClaudePricing(0.30, 1.20, 0.30, 0.006);
    private static final ClaudePricing OFF_PEAK = new ClaudePricing(0.15, 0.60, 0.15, 0.003);

    /** DeepSeek-style schedule: Mon–Fri (ISO 1–5) 01:00–04:00 and 06:00–10:00 UTC. */
    private static TimeBasedPricing deepSeekSchedule() {
        return new TimeBasedPricing(
                List.of(
                        new TimeBasedPricing.PeakWindow(List.of(1, 2, 3, 4, 5), 1, 4),
                        new TimeBasedPricing.PeakWindow(List.of(1, 2, 3, 4, 5), 6, 10)),
                PEAK,
                OFF_PEAK);
    }

    /** Build an epoch-millis instant from UTC wall-clock parts. */
    private static long utc(int year, int month, int day, int hour, int minute) {
        return ZonedDateTime.of(year, month, day, hour, minute, 0, 0, ZoneOffset.UTC)
                .toInstant()
                .toEpochMilli();
    }

    @Test
    public void billsPeakInsideWindowOnWeekdays() {
        // 2026-10-12 is a Monday.
        assertEquals(PEAK, deepSeekSchedule().pricingAt(utc(2026, 10, 12, 2, 0)));
        assertEquals(PEAK, deepSeekSchedule().pricingAt(utc(2026, 10, 12, 6, 30)));
    }

    @Test
    public void billsOffPeakOutsideWindows() {
        // 05:00 falls in the 04:00–06:00 gap between the two peak windows.
        assertEquals(OFF_PEAK, deepSeekSchedule().pricingAt(utc(2026, 10, 12, 5, 0)));
        assertEquals(OFF_PEAK, deepSeekSchedule().pricingAt(utc(2026, 10, 12, 12, 0)));
        assertEquals(OFF_PEAK, deepSeekSchedule().pricingAt(utc(2026, 10, 12, 0, 30)));
    }

    @Test
    public void treatsWindowBoundsAsHalfOpen() {
        // start hour is inside, end hour is outside
        assertEquals(PEAK, deepSeekSchedule().pricingAt(utc(2026, 10, 12, 1, 0)));
        assertEquals(OFF_PEAK, deepSeekSchedule().pricingAt(utc(2026, 10, 12, 4, 0)));
        assertEquals(OFF_PEAK, deepSeekSchedule().pricingAt(utc(2026, 10, 12, 10, 0)));
    }

    @Test
    public void neverBillsPeakOnWeekends() {
        // 2026-10-10 is a Saturday, 2026-10-11 a Sunday.
        assertEquals(OFF_PEAK, deepSeekSchedule().pricingAt(utc(2026, 10, 10, 2, 0)));
        assertEquals(OFF_PEAK, deepSeekSchedule().pricingAt(utc(2026, 10, 11, 8, 0)));
    }

    @Test
    public void wrappingWindowExtendsIntoTheNextDayOwnedByTheStartWeekday() {
        // Friday (2026-10-09) 22:00 → Saturday 02:00.
        TimeBasedPricing fridayNight = new TimeBasedPricing(
                List.of(new TimeBasedPricing.PeakWindow(List.of(5), 22, 2)),
                PEAK,
                OFF_PEAK);

        assertEquals(PEAK, fridayNight.pricingAt(utc(2026, 10, 9, 23, 0)));
        assertEquals(PEAK, fridayNight.pricingAt(utc(2026, 10, 10, 1, 0)));
        // Saturday 23:00 is not started by Friday and Saturday is not in the weekday list.
        assertEquals(OFF_PEAK, fridayNight.pricingAt(utc(2026, 10, 10, 23, 0)));
        assertEquals(OFF_PEAK, fridayNight.pricingAt(utc(2026, 10, 11, 1, 0)));
    }
}
