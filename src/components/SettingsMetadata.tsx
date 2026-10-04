import { useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { SettingsStateContext, useSettingState } from '../settings/SettingsStateContext';
import { isSettingModified, settingValue, type SettingPath } from '../settings/defaults';
import { settingDefinitions, settingsCategories } from '../settings/catalog';
import { formatSettingValue } from '../settings/format';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';

export function SettingMetadata({ setting, label, onBeforeRestore }: { setting?: SettingPath; label: string; onBeforeRestore?: () => void }) {
  const { t } = useI18n();
  const info = useSettingState(setting);
  const [restoring, setRestoring] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!info) return null;
  const formatted = formatSettingValue(info.path, info.defaultValue, t);
  const restore = async () => {
    const row = button.current?.closest('[data-setting]');
    onBeforeRestore?.();
    setRestoring(true);
    try { await info.state.restore(info.path); }
    finally {
      setRestoring(false);
      // The reset button disappears when the value matches its default.
      const target = row?.isConnected ? row.querySelector<HTMLElement>('.settings-stepper-input, .settings-custom-select-trigger, input[type="checkbox"], .settings-text-input, .settings-tag-input, .editor-dropdown-trigger, [role="radio"][aria-checked="true"]') : null;
      (target ?? document.querySelector<HTMLElement>('.settings-modified-filter'))?.focus();
    }
  };
  return <span className="setting-metadata">
    <span className="setting-default" title={t('Default: {0}', formatted)}>{t('Default: {0}', formatted)}</span>
    {info.modified && <>
      <span className="setting-modified-badge">{t('Setting modified')}</span>
      <IconButton ref={button} className="setting-reset" title={t('Restore default: {0}', label)} aria-label={t('Restore default: {0}', label)} disabled={restoring}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); void restore(); }}><Codicon name="discard" /></IconButton>
    </>}
  </span>;
}
export function SettingLabel({ label, description, setting, htmlFor, onBeforeRestore }: { label: string; description?: string; setting?: SettingPath; htmlFor?: string; onBeforeRestore?: () => void }) {
  return <span className="settings-label">
    {htmlFor ? <label htmlFor={htmlFor}><strong>{label}</strong></label> : <strong>{label}</strong>}
    {description && <small>{description}</small>}
    <SettingMetadata setting={setting} label={label} onBeforeRestore={onBeforeRestore} />
  </span>;
}
export function SettingSummary({ setting, label, children }: { setting: SettingPath; label: string; children?: ReactNode }) {
  const info = useSettingState(setting);
  return <div className="setting-summary" data-setting={setting} data-setting-modified={info?.modified ?? false}>
    <SettingLabel label={label} setting={setting} />{children}
  </div>;
}
export function ModifiedSettings({ query, onEdit }: { query: string; onEdit: (path: SettingPath, label: string) => void }) {
  const { t } = useI18n();
  const state = useContext(SettingsStateContext);
  if (!state) return null;
  const modified = settingDefinitions.filter(definition => {
    if (!isSettingModified(definition.path, state.settings, state.layout)) return false;
    const category = settingsCategories.find(item => item.id === definition.category)!;
    const value = formatSettingValue(definition.path, settingValue(definition.path, state.settings, state.layout), t);
    return [t(definition.label), definition.path, t(category.label), value].join(' ').toLowerCase().includes(query.trim().toLowerCase());
  });
  return <div className="settings-modified-results">
    {settingsCategories.map(category => {
      const items = modified.filter(item => item.category === category.id);
      if (!items.length) return null;
      return <section className="settings-card" key={category.id}>
        <div className="settings-card-header"><span className="settings-card-title">{t(category.label)}</span></div>
        <div className="settings-card-body">{items.map(item => <div className="settings-row" data-setting={item.path} data-setting-modified="true" key={item.path}>
          <SettingLabel label={t(item.label)} setting={item.path} />
          <span className="setting-current-value" title={formatSettingValue(item.path, settingValue(item.path, state.settings, state.layout), t)}>
            {formatSettingValue(item.path, settingValue(item.path, state.settings, state.layout), t)}
          </span>
          <IconButton className="setting-edit" title={t('Edit setting: {0}', t(item.label))} aria-label={t('Edit setting: {0}', t(item.label))}
            onClick={() => onEdit(item.path, t(item.label))}><Codicon name="edit" /></IconButton>
        </div>)}</div>
      </section>;
    })}
    {!modified.length && <div className="settings-empty-hint" role="status">{t(query.trim() ? 'No modified settings match your search.' : 'All settings use their default values.')}</div>}
  </div>;
}
