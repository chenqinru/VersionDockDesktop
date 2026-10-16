import { useState } from 'react';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { Button } from './Button';
import { Codicon } from './Codicon';
import { SettingLabel } from './SettingsMetadata';

export function ResetLayoutSetting() {
  const { t } = useI18n();
  const resetLayout = useAppStore(state => state.resetLayout);
  const [resetting, setResetting] = useState(false);
  return <div className="settings-row">
    <SettingLabel label={t('Workbench layout')} description={t('Restore panel sizes and the current window to their default layout.')} />
    <Button loading={resetting} onClick={() => {
      setResetting(true);
      void resetLayout().catch(() => undefined).finally(() => setResetting(false));
    }}><Codicon name="discard" />{t('Reset layout')}</Button>
  </div>;
}
