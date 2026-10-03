import { useEffect, useRef, useState } from 'react';
import { Codicon } from './Codicon';

export function SettingSelect({
  label,
  description = '',
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | globalThis.MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedOption = options.find(([k]) => k === value);
  const selectedText = selectedOption ? selectedOption[1] : value;

  return (
    <div className="settings-row">
      <span className="settings-label">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>

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
          <div className="settings-custom-select-menu" role="listbox" aria-label={label} onKeyDown={(event) => {
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

