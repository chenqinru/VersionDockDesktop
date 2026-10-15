import { useId } from 'react';
import { Select } from './Select';
import { SettingLabel } from './SettingsMetadata';
import { useSettingState } from '../settings/SettingsStateContext';
import type { SettingPath } from '../settings/defaults';

export function SettingSelect({ setting, label, description = '', value, options, onChange, disabled = false }: {
  setting?: SettingPath;
  label: string;
  description?: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const info = useSettingState(setting);
  return <div className="settings-row" data-setting={setting} data-setting-modified={info?.modified}>
    <SettingLabel label={label} description={description} descriptionId={`${id}-description`} setting={setting} htmlFor={id} />
    <Select id={id} aria-label={label} aria-describedby={description ? `${id}-description` : undefined}
      containerClassName="settings-custom-select" className="settings-custom-select-trigger"
      value={value} options={options.map(([value, label]) => ({ value, label }))} onChange={onChange} disabled={disabled} />
  </div>;
}
