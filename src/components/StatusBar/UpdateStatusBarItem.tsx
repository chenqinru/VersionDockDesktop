import { Codicon } from '../Codicon';
import { useI18n } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import { useAppUpdateStore } from '../../store/appUpdateStore';

export function UpdateStatusBarItem() {
  const { t } = useI18n();
  const updateAvailableInfo = useAppStore((state) => state.updateAvailableInfo);
  const { phase, targetVersion, progress, error, install, restart } = useAppUpdateStore();
  const latestVersion = phase === 'idle' ? updateAvailableInfo?.latestVersion : targetVersion;
  const busy = phase === 'downloading' || phase === 'restarting';
  const ready = phase === 'ready' || phase === 'restarting';

  if (!latestVersion || (phase === 'idle' && !updateAvailableInfo?.available)) {
    return null;
  }

  const label = phase === 'restarting'
    ? t('Restarting…')
    : ready
      ? t('Restart to Install Update')
      : phase === 'downloading'
        ? progress && progress.totalBytes > 0
          ? t('Updating to v{0}… {1}%', latestVersion, progress.percent)
          : t('Updating to v{0}…', latestVersion)
        : error
          ? t('Update failed — click to retry')
          : `v${latestVersion}`;
  const title = error
    ? t(ready ? 'Restart failed: {0}' : 'Update download failed: {0}', error)
    : phase === 'idle'
      ? t('New version v{0} available — click to update', latestVersion)
      : label;

  return (
    <button
      type="button"
      className="statusbar-item statusbar-update-badge"
      aria-label={phase === 'idle' && !error ? title : label}
      title={title}
      disabled={busy}
      onClick={() => void (ready ? restart() : install(latestVersion)).catch(() => {
        // The shared state exposes the error and keeps this entry retryable.
      })}
    >
      <Codicon name={busy ? 'loading codicon-modifier-spin' : error ? 'warning' : ready ? 'refresh' : 'cloud-download'} />
      <span className="statusbar-update-text" aria-live="polite">{label}</span>
    </button>
  );
}
