import { Codicon } from '../Codicon';
import { useAppStore } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { useBridge } from '../../platform/context';

export function LogStatusBarItem() {
  const { t } = useI18n();
  const bridge = useBridge();
  const platform = bridge.platform();
  const logPanelOpen = useAppStore((state) => state.logPanelOpen);
  const unreadErrorCount = useAppStore((state) => state.unreadErrorCount);
  const toggleLogPanel = useAppStore((state) => state.toggleLogPanel);

  const shortcut = platform === 'macos' ? '⌘⇧U' : 'Ctrl+Shift+U';
  const tooltip = unreadErrorCount > 0
    ? `${t('Output and Logs')} (${t('{0} error(s)', unreadErrorCount)}) · ${shortcut}`
    : `${t('Output and Logs')} · ${shortcut}`;

  return (
    <button
      type="button"
      className={`statusbar-item log-status-item ${logPanelOpen ? 'active' : ''} ${unreadErrorCount > 0 ? 'has-errors' : ''}`}
      title={tooltip}
      aria-label={t('Output and Logs')}
      aria-expanded={logPanelOpen}
      onClick={toggleLogPanel}
    >
      <div className="log-icon-wrap">
        <Codicon name="output" />
        {unreadErrorCount > 0 && (
          <span className="log-error-badge">
            {unreadErrorCount > 99 ? '99+' : unreadErrorCount}
          </span>
        )}
      </div>
    </button>
  );
}
