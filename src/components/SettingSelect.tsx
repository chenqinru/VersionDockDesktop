import { scrollbarContains } from '../scrollbars/ownership';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { SettingLabel } from './SettingsMetadata';
import { useSettingState } from '../settings/SettingsStateContext';
import type { SettingPath } from '../settings/defaults';

export function SettingSelect({
  setting,
  label,
  description = '',
  value,
  options,
  onChange,
  disabled = false,
}: {
  setting?: SettingPath;
  label: string;
  description?: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const info = useSettingState(setting);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ above: boolean; maxHeight: number }>({ above: false, maxHeight: 220 });

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | globalThis.MouseEvent) => {
      if (dropdownRef.current && !scrollbarContains(dropdownRef.current, event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const dropdown = dropdownRef.current;
    const menu = dropdown?.querySelector<HTMLElement>('[role="listbox"]');
    if (!dropdown || !menu) return;
    const rect = dropdown.getBoundingClientRect();
    let top = 6;
    let bottom = window.innerHeight - 6;
    for (let parent = dropdown.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) {
        const bounds = parent.getBoundingClientRect();
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    const above = Math.max(0, rect.top - top - 4);
    const below = Math.max(0, bottom - rect.bottom - 4);
    const height = Math.min(220, menu.scrollHeight || menu.offsetHeight);
    const openAbove = below < height && above > below;
    setMenuPosition({ above: openAbove, maxHeight: Math.min(220, openAbove ? above : below) });
  }, [isOpen, options]);

  const selectedOption = options.find(([k]) => k === value);
  const selectedText = selectedOption ? selectedOption[1] : value;

  return (
    <div className="settings-row" data-setting={setting} data-setting-modified={info?.modified}>
      <SettingLabel label={label} description={description} setting={setting} />

      {/* 原生隐藏 select 保持测试与无障碍访问兼容 */}
      <select
        disabled={disabled}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="settings-hidden-native-select"
        tabIndex={-1}
      >
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>

      {/* 现代 macOS 风格自定义下拉菜单 */}
      <div className="settings-custom-select" ref={dropdownRef}>
        <button
          type="button"
          className={`settings-custom-select-trigger ${isOpen ? 'open' : ''}`}
          disabled={disabled}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((prev) => !prev)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { setIsOpen(false); event.stopPropagation(); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setIsOpen(true);
              requestAnimationFrame(() => dropdownRef.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus());
            }
          }}
        >
          <span className="settings-custom-select-val">{selectedText}</span>
          <Codicon name={isOpen ? 'chevron-up' : 'chevron-down'} />
        </button>

        {isOpen && (
          <div className="settings-custom-select-menu" data-placement={menuPosition.above ? 'above' : 'below'} style={{ maxHeight: menuPosition.maxHeight }} role="listbox" aria-label={label} onKeyDown={(event) => {
            if (event.key === 'Escape') { event.stopPropagation(); setIsOpen(false); dropdownRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
          }}>
            {options.map(([key, text]) => {
              const isSelected = key === value;
              return (
                <button
                  key={key}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`settings-custom-select-option ${isSelected ? 'active' : ''}`}
                  onClick={() => {
                    onChange(key);
                    setIsOpen(false);
                    dropdownRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
                  }}
                >
                  <span className="settings-custom-select-option-text">{text}</span>
                  {isSelected && <Codicon name="check" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

