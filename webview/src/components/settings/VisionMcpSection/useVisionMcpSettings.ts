import { useCallback, useEffect, useState } from 'react';

export type VisionMcpTransmission = 'path' | 'base64';

const sendToJava = (message: string) => {
  window.sendToJava?.(message);
};

/**
 * Vision MCP settings hook.
 * Owns the three settings (enable toggle, MCP name, transmission mode) and their
 * bridge round-trips. Registers the Java->webview callbacks and fires the initial
 * get_* requests on mount. All state stays local to this section — nothing is
 * added to the shared useSettingsBasicActions / useSettingsWindowCallbacks.
 */
export function useVisionMcpSettings() {
  const [enabled, setEnabled] = useState(true);
  const [mcpName, setMcpName] = useState('');
  const [transmission, setTransmission] = useState<VisionMcpTransmission>('path');

  useEffect(() => {
    // Register callbacks for the persisted values pushed back from Java.
    const previousEnabled = window.updateVisionMcpEnabled;
    window.updateVisionMcpEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setEnabled(data.visionMcpEnabled ?? true);
      } catch (e) {
        console.error('[VisionMcpSection] Failed to parse vision MCP enabled:', e);
      }
    };
    const previousName = window.updateVisionMcpName;
    window.updateVisionMcpName = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setMcpName(data.visionMcpName ?? '');
      } catch (e) {
        console.error('[VisionMcpSection] Failed to parse vision MCP name:', e);
      }
    };
    const previousTransmission = window.updateVisionMcpImageTransmission;
    window.updateVisionMcpImageTransmission = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const value = data.visionMcpImageTransmission;
        setTransmission(value === 'base64' ? 'base64' : 'path');
      } catch (e) {
        console.error('[VisionMcpSection] Failed to parse vision MCP transmission:', e);
      }
    };

    // Load the persisted values (fired once; subsequent updates come via callbacks).
    sendToJava('get_vision_mcp_enabled:');
    sendToJava('get_vision_mcp_name:');
    sendToJava('get_vision_mcp_image_transmission:');

    return () => {
      // Restore the previous handlers so a remount does not accumulate stale ones.
      window.updateVisionMcpEnabled = previousEnabled;
      window.updateVisionMcpName = previousName;
      window.updateVisionMcpImageTransmission = previousTransmission;
    };
  }, []);

  const handleEnabledChange = useCallback((value: boolean) => {
    setEnabled(value);
    sendToJava(`set_vision_mcp_enabled:${JSON.stringify({ visionMcpEnabled: value })}`);
  }, []);

  const handleMcpNameChange = useCallback((value: string) => {
    setMcpName(value);
    sendToJava(`set_vision_mcp_name:${JSON.stringify({ visionMcpName: value })}`);
  }, []);

  const handleTransmissionChange = useCallback((value: VisionMcpTransmission) => {
    setTransmission(value);
    sendToJava(`set_vision_mcp_image_transmission:${JSON.stringify({ visionMcpImageTransmission: value })}`);
  }, []);

  return {
    enabled,
    mcpName,
    transmission,
    handleEnabledChange,
    handleMcpNameChange,
    handleTransmissionChange,
  };
}
