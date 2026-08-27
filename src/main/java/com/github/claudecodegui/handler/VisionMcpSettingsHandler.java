package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Vision-MCP settings handler.
 * Persists the image-recognition MCP configuration (enable toggle, MCP name, and
 * image transmission mode) as top-level keys in ~/.codemoss/config.json. The Node
 * bridge reads the same keys at message time (ai-bridge/services/claude/vision-mcp-config.js),
 * so a settings change takes effect without restarting the daemon.
 */
public class VisionMcpSettingsHandler {

    private static final Logger LOG = Logger.getInstance(VisionMcpSettingsHandler.class);
    private static final String KEY_ENABLED = "visionMcpEnabled";
    private static final String KEY_MCP_NAME = "visionMcpName";
    private static final String KEY_TRANSMISSION = "visionMcpImageTransmission";
    private static final String TRANSMISSION_PATH = "path";
    private static final String TRANSMISSION_BASE64 = "base64";

    private final HandlerContext context;
    private final CodemossSettingsService settingsService;
    private final Gson gson = new Gson();

    public VisionMcpSettingsHandler(HandlerContext context) {
        this.context = context;
        this.settingsService = context.getSettingsService();
    }

    /**
     * Push a JSON payload to the webview callback on the EDT.
     */
    private void pushJson(String jsCallback, JsonObject payload) {
        ApplicationManager.getApplication().invokeLater(() ->
            context.callJavaScript(jsCallback, context.escapeJs(gson.toJson(payload))));
    }

    public void handleGetVisionMcpEnabled() {
        try {
            JsonObject config = settingsService.readConfig();
            // Mirror the Node default (vision-mcp-config.js): a missing or non-boolean
            // value keeps the MCP path enabled, so the settings UI and the daemon
            // never disagree the first time the page opens.
            boolean enabled = true;
            JsonElement value = config.get(KEY_ENABLED);
            if (value != null && !value.isJsonNull() && value.isJsonPrimitive()
                    && value.getAsJsonPrimitive().isBoolean()) {
                enabled = value.getAsBoolean();
            }
            pushJson("window.updateVisionMcpEnabled", jsonOf(KEY_ENABLED, enabled));
        } catch (Exception e) {
            LOG.error("[VisionMcpSettingsHandler] Failed to get vision MCP enabled: " + e.getMessage(), e);
            pushJson("window.updateVisionMcpEnabled", jsonOf(KEY_ENABLED, true));
        }
    }

    public void handleSetVisionMcpEnabled(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean enabled = json != null && json.has(KEY_ENABLED) && !json.get(KEY_ENABLED).isJsonNull()
                    && json.get(KEY_ENABLED).getAsBoolean();
            JsonObject config = settingsService.readConfig();
            config.addProperty(KEY_ENABLED, enabled);
            settingsService.writeConfig(config);
            LOG.info("[VisionMcpSettingsHandler] Set vision MCP enabled: " + enabled);
            pushJson("window.updateVisionMcpEnabled", jsonOf(KEY_ENABLED, enabled));
        } catch (Exception e) {
            LOG.error("[VisionMcpSettingsHandler] Failed to set vision MCP enabled: " + e.getMessage(), e);
            showError("Failed to save vision MCP setting");
        }
    }

    public void handleGetVisionMcpName() {
        try {
            JsonObject config = settingsService.readConfig();
            // Default is empty: the user picks one of their own MCP servers. Never
            // default to a specific model so the feature stays provider-agnostic.
            String name = config.has(KEY_MCP_NAME) && !config.get(KEY_MCP_NAME).isJsonNull()
                    ? config.get(KEY_MCP_NAME).getAsString() : "";
            pushJson("window.updateVisionMcpName", jsonOf(KEY_MCP_NAME, name));
        } catch (Exception e) {
            LOG.error("[VisionMcpSettingsHandler] Failed to get vision MCP name: " + e.getMessage(), e);
            pushJson("window.updateVisionMcpName", jsonOf(KEY_MCP_NAME, ""));
        }
    }

    public void handleSetVisionMcpName(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            // Trim and allow empty: an empty name means "no image MCP configured",
            // which the daemon handles with a generic prompt rather than failing.
            String name = json != null && json.has(KEY_MCP_NAME) && !json.get(KEY_MCP_NAME).isJsonNull()
                    ? json.get(KEY_MCP_NAME).getAsString().trim() : "";
            JsonObject config = settingsService.readConfig();
            config.addProperty(KEY_MCP_NAME, name);
            settingsService.writeConfig(config);
            LOG.info("[VisionMcpSettingsHandler] Set vision MCP name: " + name);
            pushJson("window.updateVisionMcpName", jsonOf(KEY_MCP_NAME, name));
        } catch (Exception e) {
            LOG.error("[VisionMcpSettingsHandler] Failed to set vision MCP name: " + e.getMessage(), e);
            showError("Failed to save vision MCP name");
        }
    }

    public void handleGetVisionMcpImageTransmission() {
        try {
            JsonObject config = settingsService.readConfig();
            String transmission = config.has(KEY_TRANSMISSION) && !config.get(KEY_TRANSMISSION).isJsonNull()
                    ? config.get(KEY_TRANSMISSION).getAsString() : TRANSMISSION_PATH;
            pushJson("window.updateVisionMcpImageTransmission", jsonOf(KEY_TRANSMISSION, transmission));
        } catch (Exception e) {
            LOG.error("[VisionMcpSettingsHandler] Failed to get vision MCP transmission: " + e.getMessage(), e);
            pushJson("window.updateVisionMcpImageTransmission", jsonOf(KEY_TRANSMISSION, TRANSMISSION_PATH));
        }
    }

    public void handleSetVisionMcpImageTransmission(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String transmission = json != null && json.has(KEY_TRANSMISSION) && !json.get(KEY_TRANSMISSION).isJsonNull()
                    ? json.get(KEY_TRANSMISSION).getAsString() : TRANSMISSION_PATH;
            // Only accept the two known modes; anything else falls back to path.
            if (!TRANSMISSION_PATH.equals(transmission) && !TRANSMISSION_BASE64.equals(transmission)) {
                transmission = TRANSMISSION_PATH;
            }
            JsonObject config = settingsService.readConfig();
            config.addProperty(KEY_TRANSMISSION, transmission);
            settingsService.writeConfig(config);
            LOG.info("[VisionMcpSettingsHandler] Set vision MCP transmission: " + transmission);
            pushJson("window.updateVisionMcpImageTransmission", jsonOf(KEY_TRANSMISSION, transmission));
        } catch (Exception e) {
            LOG.error("[VisionMcpSettingsHandler] Failed to set vision MCP transmission: " + e.getMessage(), e);
            showError("Failed to save vision MCP transmission mode");
        }
    }

    private void showError(String message) {
        ApplicationManager.getApplication().invokeLater(() ->
            context.callJavaScript("window.showError", context.escapeJs(message)));
    }

    private static JsonObject jsonOf(String key, boolean value) {
        JsonObject obj = new JsonObject();
        obj.addProperty(key, value);
        return obj;
    }

    private static JsonObject jsonOf(String key, String value) {
        JsonObject obj = new JsonObject();
        obj.addProperty(key, value);
        return obj;
    }
}
