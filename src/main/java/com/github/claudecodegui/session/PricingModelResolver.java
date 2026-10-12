package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.provider.ModelProviderHandler;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Resolves the model ID a turn is actually billed under.
 *
 * <p>The active provider's env maps Claude slot IDs (e.g. {@code claude-sonnet-5}) to real
 * model IDs (e.g. {@code deepseek-flash}) before the request reaches the API. Pricing must
 * use the real ID — otherwise a custom price configured for the mapped model is never
 * matched and the turn is billed at built-in Claude rates. Resolution prefers the
 * {@code *_MODEL_NAME} entry (real routed model), falling back to the {@code *_MODEL} slot
 * mapping, so local settings written by proxies (cc-switch) that keep the slot id in
 * {@code *_MODEL} still bill at the custom real-model rate.
 *
 * <p>Shared by the live turn settlement ({@code ClaudeMessageHandler.handleResult}) and the
 * history reload backfill ({@link TurnPricingBackfill}) so both paths price the same model.
 */
public final class PricingModelResolver {

    private static final Logger LOG = Logger.getInstance(PricingModelResolver.class);

    private static volatile CodemossSettingsService defaultSettingsService;

    private PricingModelResolver() {
    }

    /**
     * Resolve {@code model} against the default config service (production path).
     */
    public static String resolve(String model) {
        return resolve(model, defaultSettingsService());
    }

    /**
     * Resolve {@code model} against an injected config service, or return it unchanged when
     * the service, the model id, or the claude settings env is unavailable.
     */
    public static String resolve(String model, CodemossSettingsService settingsService) {
        if (model == null || model.isEmpty() || settingsService == null) {
            return model;
        }
        try {
            JsonObject claudeSettings = settingsService.readClaudeSettings();
            if (claudeSettings != null && claudeSettings.has("env") && claudeSettings.get("env").isJsonObject()) {
                return ModelProviderHandler.resolveConfiguredClaudeModelForPricing(
                        model, claudeSettings.getAsJsonObject("env"));
            }
        } catch (Exception e) {
            LOG.warn("[PricingModelResolver] Failed to resolve pricing model: " + e.getMessage());
        }
        return model;
    }

    private static CodemossSettingsService defaultSettingsService() {
        CodemossSettingsService service = defaultSettingsService;
        if (service == null) {
            synchronized (PricingModelResolver.class) {
                service = defaultSettingsService;
                if (service == null) {
                    service = new CodemossSettingsService();
                    defaultSettingsService = service;
                }
            }
        }
        return service;
    }
}
