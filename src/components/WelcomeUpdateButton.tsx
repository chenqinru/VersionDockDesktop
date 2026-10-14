import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { useAppUpdateStore } from '../store/appUpdateStore';
import { Codicon } from './Codicon';

export function WelcomeUpdateButton() {
  const { t } = useI18n();
  const available = useAppStore(state => state.updateAvailableInfo);
  const openAbout = useAppStore(state => state.openAbout);
  const { phase, targetVersion, progress, error, install, restart } = useAppUpdateStore();
  const latestVersion = phase !== 'idle' || error
    ? targetVersion
    : available?.available ? available.latestVersion : undefined;
  if (!latestVersion) return null;

  const busy = phase === 'downloading' || phase === 'restarting';
  const ready = phase === 'ready' || phase === 'restarting';
  const label = phase === 'restarting' ? t('Restarting…')
    : error ? t(ready ? 'Restart failed, retry' : 'Update failed, retry')
    : ready ? t('Restart and Update')
    : phase === 'downloading' ? progress && progress.totalBytes > 0
      ? t('Updating… {0}%', progress.percent) : t('Updating…')
    : t('Update to v{0}', latestVersion);
  const title = error ? t(ready ? 'Restart failed: {0}' : 'Update download failed: {0}', error)
    : phase === 'downloading' ? t('Updating to v{0}…', latestVersion)
    : ready ? t('Restart to Install Update')
    : t('New version v{0} available — click to update', latestVersion);

  const activate = () => {
    if (!ready && !error) {
      openAbout('about');
      return;
    }
    void (ready ? restart() : install(latestVersion)).catch(() => {
      // The shared update store keeps failures visible and retryable here.
    });
  };

  return <button
    type="button"
    className="welcome-update-button"
    data-update-error={Boolean(error) || undefined}
    title={title}
    aria-label={label}
    disabled={busy}
    onClick={activate}
  >
    {busy && <Codicon name="loading codicon-modifier-spin" />}
    <span aria-live="polite">{label}</span>
  </button>;
}
