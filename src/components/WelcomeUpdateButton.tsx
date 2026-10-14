import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { useAppUpdateStore } from '../store/appUpdateStore';
import { APP_CURRENT_VERSION } from '../version';
import type { CSSProperties } from 'react';

export function WelcomeUpdateButton() {
  const { t } = useI18n();
  const available = useAppStore(state => state.updateAvailableInfo);
  const { phase, targetVersion, progress, error, install, restart } = useAppUpdateStore();
  const latestVersion = phase !== 'idle' || error
    ? targetVersion
    : available?.available ? available.latestVersion : undefined;
  if (!latestVersion) return <span className="welcome-version-badge" data-current-version={`v${APP_CURRENT_VERSION}`}><span>v{APP_CURRENT_VERSION}</span></span>;

  const busy = phase === 'downloading' || phase === 'restarting';
  const ready = phase === 'ready' || phase === 'restarting';
  const label = phase === 'restarting' ? t('Restarting…')
    : error ? t(ready ? 'Restart failed, retry' : 'Update failed, retry')
    : ready ? t('Restart and Update')
    : phase === 'downloading' ? progress && progress.totalBytes > 0
      ? t('Updating… {0}%', progress.percent) : t('Updating…')
    : t('Update to v{0}', latestVersion);
  const title = error ? t(ready ? 'Restart failed: {0}' : 'Update download failed: {0}', error)
    : phase === 'restarting' ? t('Restarting…')
    : phase === 'downloading' ? t('Updating to v{0}…', latestVersion)
    : ready ? t('Restart to Install Update')
    : t('New version v{0} available — click to update', latestVersion);

  const activate = () => {
    void (ready ? restart() : install(latestVersion)).catch(() => {
      // The shared update store keeps failures visible and retryable here.
    });
  };

  return <button
    type="button"
    className="welcome-version-badge welcome-update-button"
    data-current-version={`v${APP_CURRENT_VERSION}`}
    data-update-state={error ? 'error' : phase === 'idle' ? 'available' : phase}
    data-update-error={Boolean(error) || undefined}
    data-update-progress={phase === 'downloading' && progress?.totalBytes ? true : undefined}
    style={phase === 'downloading' && progress?.totalBytes ? { '--update-progress': `${progress.percent}%` } as CSSProperties : undefined}
    title={title}
    aria-label={label}
    disabled={busy}
    onClick={activate}
  >
    <span aria-live="polite">{phase === 'downloading'
      ? progress && progress.totalBytes > 0 ? `${progress.percent}%` : t('Update in progress')
      : phase === 'restarting' ? t('Restart in progress') : `v${latestVersion}`}</span>
  </button>;
}
