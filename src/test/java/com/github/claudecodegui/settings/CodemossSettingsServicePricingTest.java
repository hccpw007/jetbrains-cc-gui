package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Persistence behavior of {@link CodemossSettingsService#setCustomModelPricing}.
 *
 * <p>The frontend syncs the full pricing map carrying only the four base rates, so a
 * hand-edited {@code timeBasedPricing} block in the config must survive that rewrite
 * (inherited when the payload omits it) and round-trip when the payload carries one.
 */
public class CodemossSettingsServicePricingTest {

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    @Test
    public void keepsHandEditedTimeBasedPricingWhenSyncOmitsIt() throws IOException {
        Path config = newConfigFile();
        Files.writeString(config, """
                {"customModelPricing":{"claude":{"deepseek-v4-flash":{
                  "inputCostPer1M":0.14,
                  "timeBasedPricing":{
                    "peakWindowsUtc":[{"weekdays":[1,2,3,4,5],"startHour":1,"endHour":4}],
                    "peak":{"inputCostPer1M":0.30},
                    "offPeak":{"inputCostPer1M":0.15}}},
                  "other-model":{"inputCostPer1M":1.0}}}}
                """, StandardCharsets.UTF_8);

        CapturingConfigService service = new CapturingConfigService(config);
        service.setCustomModelPricing("claude", Map.of(
                "deepseek-v4-flash", new ModelPricing(0.2, 0.4, null, null),
                "other-model", new ModelPricing(1.5, 3.0, null, null)));

        JsonObject claude = service.writtenConfig
                .getAsJsonObject("customModelPricing")
                .getAsJsonObject("claude");
        JsonObject flash = claude.getAsJsonObject("deepseek-v4-flash");
        assertEquals(0.2, flash.get("inputCostPer1M").getAsDouble(), 1e-9);
        // The stored block keeps its window and both tiers intact.
        JsonObject inherited = flash.getAsJsonObject("timeBasedPricing");
        assertEquals(1, inherited.getAsJsonArray("peakWindowsUtc").size());
        assertEquals(0.30, inherited.getAsJsonObject("peak").get("inputCostPer1M").getAsDouble(), 1e-9);
        assertEquals(0.15, inherited.getAsJsonObject("offPeak").get("inputCostPer1M").getAsDouble(), 1e-9);
        // A model without a stored block is written without one.
        assertTrue(!claude.getAsJsonObject("other-model").has("timeBasedPricing"));
    }

    @Test
    public void writesTimeBasedPricingCarriedByThePayload() throws IOException {
        Path config = newConfigFile();
        Files.writeString(config, "{}", StandardCharsets.UTF_8);

        CapturingConfigService service = new CapturingConfigService(config);
        ModelPricing.TimeBasedPricing schedule = new ModelPricing.TimeBasedPricing(
                List.of(new ModelPricing.PeakWindow(List.of(1, 2, 3, 4, 5), 1, 4)),
                new ModelPricing.Rates(0.30, 1.20, null, null),
                new ModelPricing.Rates(0.15, 0.60, null, null));
        service.setCustomModelPricing("claude", Map.of(
                "deepseek-v4-flash", new ModelPricing(0.14, 0.28, null, null, schedule)));

        JsonObject written = service.writtenConfig
                .getAsJsonObject("customModelPricing")
                .getAsJsonObject("claude")
                .getAsJsonObject("deepseek-v4-flash")
                .getAsJsonObject("timeBasedPricing");
        assertEquals(1, written.getAsJsonArray("peakWindowsUtc").size());
        assertEquals(5, written.getAsJsonArray("peakWindowsUtc").get(0).getAsJsonObject()
                .getAsJsonArray("weekdays").size());
        assertEquals(0.30, written.getAsJsonObject("peak").get("inputCostPer1M").getAsDouble(), 1e-9);
        assertEquals(0.15, written.getAsJsonObject("offPeak").get("inputCostPer1M").getAsDouble(), 1e-9);
        // Unset tier dimensions stay absent instead of being stored as null.
        assertTrue(!written.getAsJsonObject("peak").has("cacheWriteCostPer1M"));
    }

    private Path newConfigFile() throws IOException {
        return temp.newFolder().toPath().resolve("config.json");
    }

    /** Redirects read + capture write so tests never touch the real ~/.codemoss config. */
    private static final class CapturingConfigService extends CodemossSettingsService {
        private final Path configPath;
        private JsonObject writtenConfig;

        private CapturingConfigService(Path configPath) {
            this.configPath = configPath;
        }

        @Override
        public String getConfigPath() {
            return configPath.toString();
        }

        @Override
        public void writeConfig(JsonObject config) {
            this.writtenConfig = config;
        }
    }
}
