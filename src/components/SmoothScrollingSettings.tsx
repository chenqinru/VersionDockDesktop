import { useAppStore } from '../store/appStore';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import { useI18n } from '../i18n';
import { SettingToggle } from './SettingsControls';

export function SmoothScrollingSettings() {
  const settings = useAppStore(state => state.bootstrap?.state.settings);
  const update = useAppStore(state => state.updateSettings);
  const { t } = useI18n();
  return <>
    <SettingToggle setting="smoothScrolling" label={t('Smooth navigation scrolling')}
      description={t('Animate navigation to commits, search results and changes. Respects the system reduced motion preference.')}
      checked={settings?.smoothScrolling ?? DEFAULT_SETTINGS.smoothScrolling!}
      onChange={value => void update({ smoothScrolling: value })} />
    <SettingToggle setting="smoothMouseWheelScrolling" label={t('Smooth mouse wheel scrolling')}
      description={t('Smooth stepped mouse wheel input. Continuous touchpad input keeps native scrolling. Respects the system reduced motion preference.')}
      checked={settings?.smoothMouseWheelScrolling ?? DEFAULT_SETTINGS.smoothMouseWheelScrolling!}
      onChange={value => void update({ smoothMouseWheelScrolling: value })} />
  </>;
}
