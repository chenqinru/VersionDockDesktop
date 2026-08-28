import { Codicon } from '../Codicon';
import { useI18n } from '../../i18n';
import { useAppStore } from '../../store/appStore';

export function UpdateStatusBarItem() {
  const { t } = useI18n();
  const updateAvailableInfo = useAppStore((state) => state.updateAvailableInfo);
  const openAbout = useAppStore((state) => state.openAbout);

  if (!updateAvailableInfo?.available || !updateAvailableInfo.latestVersion) {
    return null;
  }

  return (
    <button
      type="button"
      className="statusbar-item statusbar-update-badge"
      aria-label={t('New version v{0} available — click to update', updateAvailableInfo.latestVersion)}
      title={t('New version v{0} available — click to update', updateAvailableInfo.latestVersion)}
      onClick={() => openAbout('about')}
    >
      <Codicon name="cloud-download" />
      <span className="statusbar-update-text">v{updateAvailableInfo.latestVersion}</span>
    </button>
  );
}
