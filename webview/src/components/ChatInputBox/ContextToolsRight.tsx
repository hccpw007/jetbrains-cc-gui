import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useClaudePlanUsage } from '../../hooks/useClaudePlanUsage';
import { PlanUsageIndicator } from './PlanUsageIndicator';

interface ContextToolsRightProps {
  currentProvider: string;
  hasMessages: boolean;
  onRewind?: () => void;
  statusPanelExpanded: boolean;
  onToggleStatusPanel?: () => void;
  /** Insert a trigger symbol (/ @ !) at the cursor and open the matching dropdown */
  onTriggerInsert?: (trigger: '/' | '@' | '!') => void;
}

/** Right side tools: trigger symbols, plan usage, StatusPanel toggle and Rewind button. */
export const ContextToolsRight: React.FC<ContextToolsRightProps> = memo(({
  currentProvider,
  hasMessages,
  onRewind,
  statusPanelExpanded,
  onToggleStatusPanel,
  onTriggerInsert,
}) => {
  const { t } = useTranslation();
  const isClaude = currentProvider === 'claude';
  const claudePlanUsage = useClaudePlanUsage(currentProvider);

  return (
    <div className="context-tools-right">
      {/* Trigger symbol buttons - insert / @ ! at cursor to open the matching dropdown */}
      {onTriggerInsert && (
        <>
          {/* Insert "/" to open the slash-command list */}
          <button
            className="context-tool-btn has-tooltip trigger-symbol-btn"
            onClick={() => onTriggerInsert('/')}
            aria-label={t('chat.triggerSlashCommand')}
            data-tooltip={t('chat.triggerSlashCommand')}
          >
            <span className="trigger-symbol">/</span>
          </button>
          {/* Insert "@" to open the file-reference list */}
          <button
            className="context-tool-btn has-tooltip trigger-symbol-btn"
            onClick={() => onTriggerInsert('@')}
            aria-label={t('chat.triggerReferenceFile')}
            data-tooltip={t('chat.triggerReferenceFile')}
          >
            <span className="trigger-symbol">@</span>
          </button>
          {/* Insert "!" to open the prompt-snippet list */}
          <button
            className="context-tool-btn has-tooltip trigger-symbol-btn"
            onClick={() => onTriggerInsert('!')}
            aria-label={t('chat.triggerInsertPrompt')}
            data-tooltip={t('chat.triggerInsertPrompt')}
          >
            <span className="trigger-symbol">!</span>
          </button>
          <div className="context-tool-divider" />
        </>
      )}

      {isClaude && (
        <PlanUsageIndicator
          snapshot={claudePlanUsage.snapshot}
          status={claudePlanUsage.status}
        />
      )}

      {/* StatusPanel expand/collapse toggle - always visible */}
      {onToggleStatusPanel && (
        <button
          className={`context-tool-btn status-panel-toggle has-tooltip ${statusPanelExpanded ? 'expanded' : 'collapsed'}`}
          onClick={onToggleStatusPanel}
          data-tooltip={statusPanelExpanded ? t('statusPanel.collapse') : t('statusPanel.expand')}
          aria-label={statusPanelExpanded ? t('statusPanel.collapse') : t('statusPanel.expand')}
        >
          <span className={`codicon ${statusPanelExpanded ? 'codicon-chevron-down' : 'codicon-layers'}`} />
        </button>
      )}

      {/* Rewind button */}
      {currentProvider === 'claude' && onRewind && (
        <button
          className="context-tool-btn has-tooltip"
          onClick={onRewind}
          disabled={!hasMessages}
          data-tooltip={t('rewind.tooltip')}
          aria-label={t('rewind.tooltip')}
        >
          <span className="codicon codicon-discard" />
        </button>
      )}
    </div>
  );
});
