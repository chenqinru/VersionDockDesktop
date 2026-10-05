import { useAppStore } from '../store/appStore';
import type { ScrollbarVisibility } from '../bindings/generated';
import { useI18n } from '../i18n';
import { SettingSelect } from './SettingSelect';

export function ScrollbarVisibilitySetting() {
  const visibility = useAppStore(state => state.bootstrap?.state.settings?.scrollbarVisibility ?? 'system');
  const update = useAppStore(state => state.updateSettings);
  const { t } = useI18n();
  return <SettingSelect setting="scrollbarVisibility" label={t('Scrollbar visibility')}
    description={t('Control scrollbars across all panels and pages. Changes take effect immediately.')}
    value={visibility} options={[
      ['system', t('Follow system')], ['auto', t('Auto-hide')], ['visible', t('Always visible')],
    ]} onChange={value => void update({ scrollbarVisibility: value as ScrollbarVisibility })} />;
}
