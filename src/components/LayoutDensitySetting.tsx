import { useLayoutDensity } from '../layoutDensity';
import type { LayoutDensity } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { SettingSelect } from './SettingSelect';

export function LayoutDensitySetting() {
  const { t } = useI18n();
  const value = useLayoutDensity();
  const update = useAppStore(state => state.updateSettings);
  return <SettingSelect
    label={t('Layout density')}
    description={t('Comfortable uses rounded cards and inset rows; compact maximizes working space.')}
    value={value}
    options={[["comfortable", t('Comfortable')], ["compact", t('Compact')]]}
    onChange={layoutDensity => void update({ layoutDensity: layoutDensity as LayoutDensity })}
  />;
}
