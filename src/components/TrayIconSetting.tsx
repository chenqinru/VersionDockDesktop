import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { SettingToggle } from './SettingsControls';

export function TrayIconSetting() {
  const { t } = useI18n();
  const keepOnClose = useAppStore(state => state.bootstrap?.state.settings?.closeToTray ?? false);
  const checked = useAppStore(state => state.bootstrap?.state.settings?.showTrayIcon ?? true);
  const status = useAppStore(state => state.bootstrap?.runtime?.trayIcon ?? state.bootstrap?.capabilities.availability?.trayIcon);
  const updateSettings = useAppStore(state => state.updateSettings);
  const browserDemo = status?.reasonCode === 'BROWSER_DEMO';
  const unavailable = status?.reasonCode === 'TRAY_ICON_UNAVAILABLE';
  const description = browserDemo
    ? t('Tray shortcuts are unavailable in browser demo mode.')
    : unavailable
      ? t('Tray shortcuts could not be initialized. Turn this setting off and on to retry.')
      : keepOnClose
        ? t('The tray icon stays visible while closing windows to the tray is enabled.')
        : t('Show shortcuts in the system tray while the app is running.');
  return <SettingToggle setting="showTrayIcon" label={t('Show tray icon')} description={description} checked={checked || keepOnClose} disabled={browserDemo || keepOnClose} onChange={value => void updateSettings({ showTrayIcon: value })} />;
}

export function CloseToTraySetting() {
  const { t } = useI18n();
  const checked = useAppStore(state => state.bootstrap?.state.settings?.closeToTray ?? false);
  const status = useAppStore(state => state.bootstrap?.runtime?.trayIcon ?? state.bootstrap?.capabilities.availability?.trayIcon);
  const updateSettings = useAppStore(state => state.updateSettings);
  const browserDemo = status?.reasonCode === 'BROWSER_DEMO';
  const description = browserDemo
    ? t('Tray shortcuts are unavailable in browser demo mode.')
    : status?.reasonCode === 'TRAY_ICON_UNAVAILABLE'
      ? t('The tray is unavailable. Windows will close normally.')
      : t('Hide closed windows and keep project sessions in the tray. Automatically enables the tray icon. Use Quit to exit (Cmd+Q on macOS).');
  return <SettingToggle setting="closeToTray" label={t('Keep in tray when closing windows')} description={description} checked={checked} disabled={browserDemo} onChange={value => void updateSettings(value ? { closeToTray: true, showTrayIcon: true } : { closeToTray: false })} />;
}
