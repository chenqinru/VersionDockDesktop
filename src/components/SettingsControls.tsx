import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';

export function SettingsCard({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-card">
      {title && (
        <div className="settings-card-header">
          <span className="settings-card-title">{title}</span>
          {description && <span className="settings-card-desc">{description}</span>}
        </div>
      )}
      <div className="settings-card-body">{children}</div>
    </div>
  );
}


export function SettingNumber({
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
}) {
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
    <div className="settings-row">
      <span className="settings-label">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>

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
  label,
  accessory,
  actions,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; accessory?: ReactNode; actions?: ReactNode }) {
  const id = useId();
  return (
    <div className="settings-row settings-text-row">
      <label className="settings-label" htmlFor={id}><strong>{label}</strong></label>
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
