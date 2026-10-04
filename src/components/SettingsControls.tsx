import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';
import { SettingLabel, SettingMetadata } from './SettingsMetadata';
import { useSettingState } from '../settings/SettingsStateContext';
import type { SettingPath } from '../settings/defaults';

export function SettingsCard({
  title,
  description,
  children,
  setting,
}: {
  setting?: SettingPath;
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  const info = useSettingState(setting);
  return (
    <div className="settings-card" data-setting={setting} data-setting-modified={info?.modified}>
      {title && (
        <div className="settings-card-header">
          <span className="settings-card-title">{title}</span>
          {description && <span className="settings-card-desc">{description}</span>}
          <SettingMetadata setting={setting} label={title} />
        </div>
      )}
      <div className="settings-card-body">{children}</div>
    </div>
  );
}


export function SettingNumber({
  setting,
  label,
  description,
  value,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  description?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
  setting?: SettingPath;
}) {
  const info = useSettingState(setting);
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const localText = draft ?? String(value);

  const handleStep = (delta: number) => {
    const next = Math.min(max, Math.max(min, value + delta));
    onChange(next);
  };

  const handleBlur = () => {
    const parsed = Number(localText);
    if (isNaN(parsed)) {
      setDraft(null);
    } else {
      const clamped = Math.min(max, Math.max(min, parsed));
      setDraft(null);
      if (clamped !== value) {
        onChange(clamped);
      }
    }
  };

  return (
    <div className="settings-row" data-setting={setting} data-setting-modified={info?.modified}>
      <SettingLabel label={label} description={description} setting={setting} onBeforeRestore={() => setDraft(null)} />

      {/* 原生隐藏 input 保持测试与无障碍访问兼容 */}
      <input
        aria-label={label}
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.target.value))}
        className="settings-hidden-native-input"
        tabIndex={-1}
      />

      {/* 现代 macOS 风格自定义数字调节步进器 */}
      <div className="settings-custom-stepper">
        <IconButton
          type="button"
          className="settings-stepper-btn"
          disabled={value <= min}
          aria-label={t('Decrease')}
          onClick={() => handleStep(-step)}
        >
          <Codicon name="remove" />
        </IconButton>

        <div className="settings-stepper-input-wrapper">
          <input
            type="text"
            inputMode="numeric"
            className="settings-stepper-input"
            style={{ width: `${Math.max(3, localText.length + 1)}ch` }}
            value={localText}
            onFocus={() => setDraft(String(value))}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleBlur();
              else if (e.key === 'ArrowUp') {
                e.preventDefault();
                handleStep(step);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                handleStep(-step);
              }
            }}
          />
          {suffix && <span className="settings-stepper-suffix">{suffix}</span>}
        </div>

        <IconButton
          type="button"
          className="settings-stepper-btn"
          disabled={value >= max}
          aria-label={t('Increase')}
          onClick={() => handleStep(step)}
        >
          <Codicon name="add" />
        </IconButton>
      </div>
    </div>
  );
}

export function SettingText({
  setting,
  label,
  accessory,
  actions,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; setting?: SettingPath; accessory?: ReactNode; actions?: ReactNode }) {
  const id = useId();
  const info = useSettingState(setting);
  return (
    <div className="settings-row settings-text-row" data-setting={setting} data-setting-modified={info?.modified}>
      <SettingLabel label={label} htmlFor={id} setting={setting} />
      <div className="settings-text-control">
        <div className="settings-text-input-group">
          <input {...input} id={id} className="settings-text-input" />
          {accessory}
        </div>
        {actions && <div className="settings-control-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function SettingToggle({ label, description, checked, onChange, setting, disabled = false }: {
  label: string; description: string; checked: boolean; onChange: (value: boolean) => void; setting?: SettingPath; disabled?: boolean;
}) {
  const id = useId();
  const info = useSettingState(setting);
  return <div className="settings-toggle settings-row" data-setting={setting} data-setting-modified={info?.modified}>
    <SettingLabel label={label} description={description} setting={setting} htmlFor={id} />
    <label className="settings-switch">
      <input id={id} aria-label={label} type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span className="settings-switch-track"><span className="settings-switch-thumb" /></span>
    </label>
  </div>;
}
