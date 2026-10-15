import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { Codicon } from './Codicon';
import { useFieldAttributes } from './formFieldContext';
import { scrollbarContains } from '../scrollbars/ownership';

export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'children' | 'type'> {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  controlSize?: 'xs' | 'sm' | 'md';
  containerClassName?: string;
  invalid?: boolean;
  required?: boolean;
}

/** A single visible, keyboard-accessible control. Selection and persistence stay with the caller. */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  { value, options, onChange, controlSize = 'sm', containerClassName = '', className = '', disabled, invalid, required, onKeyDown, onBlur, name, ...props }, ref,
) {
  const generatedId = useId();
  const field = useFieldAttributes({ ...props, required, 'aria-invalid': invalid ?? props['aria-invalid'] });
  const id = field.id ?? `select-${generatedId}`;
  const menuId = `${id}-options`;
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', time: 0 });
  const initialFocus = useRef<'first' | 'last' | 'selected'>('selected');
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ above: false, maxHeight: 220, left: 0, maxWidth: 360 });
  const enabled = options.filter(option => !option.disabled);
  const unavailable = disabled || !enabled.length;
  const visible = open && !unavailable;
  const selected = options.find(option => option.value === value);
  useImperativeHandle(ref, () => trigger.current!, []);

  const close = (restoreFocus = false) => {
    setOpen(false);
    typeahead.current = { text: '', time: 0 };
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  const focusOption = (index: number) => {
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)');
    const target = items?.[index];
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  useLayoutEffect(() => {
    if (!visible) return;
    const update = () => {
      const root = container.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      let top = 6, bottom = window.innerHeight - 6, left = 6, right = window.innerWidth - 6;
      for (let parent = root.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
          const bounds = parent.getBoundingClientRect();
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowX)) {
          const bounds = parent.getBoundingClientRect();
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
      }
      const above = Math.max(0, rect.top - top - 4);
      const below = Math.max(0, bottom - rect.bottom - 4);
      const height = Math.min(220, menu.current?.scrollHeight || 220);
      const openAbove = below < height && above > below;
      const maxWidth = Math.max(0, Math.min(360, right - left));
      const width = Math.max(rect.width, Math.min(maxWidth, menu.current?.scrollWidth || rect.width));
      const menuLeft = Math.max(left - rect.left, Math.min(0, right - rect.left - width));
      setPosition({ above: openAbove, maxHeight: Math.min(220, openAbove ? above : below), left: menuLeft, maxWidth });
    };
    update();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
    const target = initialFocus.current === 'first' ? items[0] : initialFocus.current === 'last' ? items.at(-1) : items.find(item => item.value === value) ?? items[0];
    target?.focus({ preventScroll: true });
    initialFocus.current = 'selected';
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [visible, options, value]);

  useLayoutEffect(() => { if (open && unavailable) setOpen(false); }, [open, unavailable]);

  useEffect(() => {
    // Fieldsets can disable the control without changing its own disabled prop.
    const observer = new MutationObserver(() => { if (trigger.current?.matches(':disabled')) setOpen(false); });
    for (let parent = container.current?.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLFieldSetElement) observer.observe(parent, { attributes: true, attributeFilter: ['disabled'] });
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const outside = (event: MouseEvent) => {
      if (!scrollbarContains(container.current, event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [visible]);

  return <div ref={container} className={`vd-select ${containerClassName}`.trim()} data-control-size={controlSize}
    onBlur={event => { if (!scrollbarContains(container.current, event.relatedTarget)) close(); }}>
    {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
    <button {...props} {...field} id={id} ref={trigger} type="button" role="combobox" value={value}
      aria-required={field.required || undefined} disabled={unavailable} aria-expanded={visible} aria-haspopup="listbox" aria-controls={visible ? menuId : undefined}
      className={`vd-select-trigger ${className}`.trim()} data-control-size={controlSize} data-invalid={field['aria-invalid']}
      onBlur={onBlur} onClick={event => { props.onClick?.(event); if (!event.defaultPrevented && !event.currentTarget.matches(':disabled')) setOpen(!visible); }}
      onKeyDown={event => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.currentTarget.matches(':disabled')) return;
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          initialFocus.current = event.key === 'Home' ? 'first' : event.key === 'End' || event.key === 'ArrowUp' && !selected ? 'last' : 'selected';
          setOpen(true);
        }
        if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); close(true); }
      }}>
      <span className="vd-select-value">{selected?.label ?? value}</span><Codicon name={visible ? 'chevron-up' : 'chevron-down'} />
    </button>
    {visible && <div ref={menu} id={menuId} className="vd-select-menu" role="listbox" aria-label={props['aria-label']}
      aria-labelledby={props['aria-label'] ? undefined : id} data-placement={position.above ? 'above' : 'below'} style={{ maxHeight: position.maxHeight, left: position.left, right: 'auto', maxWidth: position.maxWidth }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Tab') { close(!event.defaultPrevented); return; }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : event.key === 'ArrowUp' ? (current - 1 + items.length) % items.length : undefined;
        if (next !== undefined) { event.preventDefault(); focusOption(next); return; }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
          const now = Date.now();
          const previous = now - typeahead.current.time < 700 ? typeahead.current.text : '';
          const key = event.key.toLocaleLowerCase();
          const text = previous === key ? key : previous + key;
          typeahead.current = { text, time: now };
          const match = items.findIndex((_, offset) => enabled[(current + 1 + offset) % items.length]?.label.toLocaleLowerCase().startsWith(text));
          if (match >= 0) { event.preventDefault(); focusOption((current + 1 + match) % items.length); }
        }
      }}>
      {options.map(option => <button type="button" role="option" key={option.value} value={option.value} disabled={option.disabled}
        aria-selected={option.value === value} tabIndex={-1} className="vd-select-option"
        onClick={() => { if (!trigger.current?.matches(':disabled') && !option.disabled) { onChange(option.value); close(true); } }}>
        <span>{option.label}</span>{option.value === value && <Codicon name="check" />}
      </button>)}
    </div>}
  </div>;
});
