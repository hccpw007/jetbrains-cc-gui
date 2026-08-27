import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import { useVisionMcpSettings, type VisionMcpTransmission } from './useVisionMcpSettings';

const TRANSMISSION_OPTIONS: Array<{ value: VisionMcpTransmission; labelKey: string }> = [
  // Transmission options: path (send the temp file path) / base64 (inline image data).
  { value: 'path', labelKey: 'settings.visionMcp.transmissionPath' },
  { value: 'base64', labelKey: 'settings.visionMcp.transmissionBase64' },
];

/**
 * Vision MCP settings section.
 * Lets the user toggle image-recognition-via-MCP and configure which MCP server
 * handles attached images plus how the image is transmitted (path vs base64).
 */
export default function VisionMcpSection() {
  const { t } = useTranslation();
  const { enabled, mcpName, transmission, handleEnabledChange, handleMcpNameChange, handleTransmissionChange } =
    useVisionMcpSettings();

  return (
    <div className={styles.configSection}>
      {/* Page title for the vision MCP settings block. */}
      <h2 className={styles.sectionTitle}>{t('settings.visionMcp.title')}</h2>
      {/* Explains that this feature routes images when the proxied backend lacks vision. */}
      <p className={styles.sectionDesc}>{t('settings.visionMcp.desc')}</p>

      {/* Enable toggle for routing images through the vision MCP. */}
      <div className={styles.fieldRow}>
        <div className={styles.fieldLabel}>
          <span>{t('settings.visionMcp.enabled')}</span>
          {/* When on, all attached images go through the MCP regardless of model. */}
          <span className={styles.fieldHint}>{t('settings.visionMcp.enabledDesc')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={enabled}
            onChange={(e) => handleEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
        </label>
      </div>

      {/* MCP server name, matching the configured MCP list entry. */}
      <div className={styles.fieldRow}>
        <div className={styles.fieldLabel}>
          <span>{t('settings.visionMcp.mcpName')}</span>
          <span className={styles.fieldHint}>{t('settings.visionMcp.mcpNameDesc')}</span>
        </div>
        <input
          className={styles.textInput}
          value={mcpName}
          placeholder={t('settings.visionMcp.mcpNamePlaceholder')}
          onChange={(e) => handleMcpNameChange(e.target.value)}
        />
      </div>

      {/* Transmission mode: path / base64. */}
      <div className={styles.fieldRow}>
        <div className={styles.fieldLabel}>
          <span>{t('settings.visionMcp.transmission')}</span>
          <span className={styles.fieldHint}>{t('settings.visionMcp.transmissionDesc')}</span>
        </div>
        <select
          className={styles.selectInput}
          value={transmission}
          onChange={(e) => handleTransmissionChange(e.target.value as VisionMcpTransmission)}
        >
          {TRANSMISSION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
