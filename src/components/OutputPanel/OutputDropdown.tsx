import { useEffect, useId, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { useI18n } from '../../i18n';

export function OutputDropdown<T extends string>({ value, options, onChange, ariaLabel, className = '' }: {
  value: T; options: Array<{ id: T; label: string }>; onChange: (value: T) => void; ariaLabel: string; className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const selectedIndex = Math.max(0, options.findIndex((item) => item.id === value));
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    items.current[selectedIndex]?.focus();
    const outside = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, selectedIndex]);
  return <div ref={container} className={`output-dropdown-container ${className} ${open ? 'open' : ''}`}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className={`output-dropdown-trigger ${open ? 'active' : ''}`}
      onClick={() => setOpen(!open)} aria-label={ariaLabel} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? menuId : undefined}
      onKeyDown={(event) => {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); }
        if (event.key === 'Escape') close();
      }}>
      <span className="output-dropdown-label">{t(options[selectedIndex].label)}</span>
      <Codicon name={open ? 'chevron-up' : 'chevron-down'} />
    </button>
    {open && <div id={menuId} className="output-dropdown-menu" role="listbox" aria-label={ariaLabel}
      onKeyDown={(event) => {
        const index = items.current.indexOf(document.activeElement as HTMLButtonElement);
        let next: number | undefined;
        if (event.key === 'ArrowDown') next = (index + 1) % options.length;
        if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = options.length - 1;
        if (next !== undefined) { event.preventDefault(); items.current[next]?.focus(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      {options.map((option, index) => <button key={option.id} ref={(element) => { items.current[index] = element; }}
        type="button" role="option" aria-selected={option.id === value} tabIndex={option.id === value ? 0 : -1}
        className={`output-dropdown-item ${option.id === value ? 'selected' : ''}`}
        onClick={() => { onChange(option.id); close(); }}>
        <span className="output-dropdown-item-text">{t(option.label)}</span>
        {option.id === value && <Codicon name="check" className="output-dropdown-check" />}
      </button>)}
    </div>}
  </div>;
}
