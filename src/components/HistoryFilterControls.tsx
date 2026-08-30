import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';

export type HistoryFilterOption = {
  id: string;
  label: string;
  color?: string;
  detail?: string;
  icon?: string;
};

export function CommitSearch({ value, onChange, onSubmit, onClear }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  onClear?: () => void;
}) {
  const { t } = useI18n();
  const clear = () => {
    onChange('');
    onClear?.();
  };
  return <label className="commit-search">
    <Codicon name="search" />
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSubmit?.();
        if (event.key === 'Escape' && value) {
          clear();
          event.currentTarget.blur();
        }
      }}
      placeholder={t('Search commits…')}
    />
    {value && <button type="button" aria-label={t('Clear')} onClick={clear}><Codicon name="close" /></button>}
  </label>;
}

export function ToggleFilter({ icon, leading, label, active, open, onClick }: {
  icon?: string;
  leading?: ReactNode;
  label: string;
  active: boolean;
  open: boolean;
  onClick: () => void;
}) {
  return <button type="button" className={`filter-button ${active ? 'active' : ''} ${open ? 'open' : ''}`} onClick={onClick} aria-expanded={open}>
    {leading ?? (icon ? <Codicon name={icon} /> : null)}
    <span>{label}</span>
    {active && <i />}
    <Codicon name={open ? 'chevron-up' : 'chevron-down'} />
  </button>;
}

export function FilterPopover({ title, values, selected, onSelect, onClear, query, onQuery, allowCustom }: {
  title: string;
  values: HistoryFilterOption[];
  selected: string;
  onSelect: (value: string) => void;
  onClear: () => void;
  query?: string;
  onQuery?: (value: string) => void;
  allowCustom?: boolean;
}) {
  const { t } = useI18n();
  const displayed = query?.trim()
    ? values.filter((value) => `${value.label} ${value.detail ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    : values;
  const radioGroup = `filter-${title}`;
  const allLabel = title === t('Author') ? t('All authors') : title === t('Repository') ? t('All repositories') : t('All branches & tags');
  return <div className="filter-popover" data-selection-mode="single">
    <header><strong>{title}</strong><button type="button" disabled={!selected} onClick={onClear}>{t('Clear')}</button></header>
    {onQuery && <label className="popover-search"><Codicon name="search" /><input autoFocus value={query ?? ''} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => { if (allowCustom && event.key === 'Enter' && query?.trim()) onSelect(query.trim()); }} placeholder={allowCustom ? t('Type an author and press Enter…') : t('Filter…')} /></label>}
    <div className="filter-options">
      <label><input name={radioGroup} aria-label={allLabel} type="radio" checked={!selected} onChange={onClear} /><span>{allLabel}</span>{!selected && <Codicon name="check" />}</label>
      {displayed.map((value) => <label key={value.id} title={value.detail}>
        <input name={radioGroup} aria-label={`${value.label}${value.detail ?? ''}`} type="radio" checked={selected === value.id} onChange={() => onSelect(value.id)} />
        {value.color && <i style={{ background: value.color }} />}
        {value.icon && <Codicon name={value.icon} />}
        <span><span className="filter-option-name">{value.label}</span>{value.detail && <small>{value.detail}</small>}</span>
        {selected === value.id && <Codicon name="check" />}
      </label>)}
      {!displayed.length && <div className="filter-empty">{t('No matches')}</div>}
    </div>
  </div>;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function toYmd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseYmd(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function shiftMonth(value: { year: number; month: number }, delta: number) {
  const next = new Date(value.year, value.month + delta, 1);
  return { year: next.getFullYear(), month: next.getMonth() };
}

function CalendarMonth({ year, month, from, to, hovered, onDay, onHover }: {
  year: number;
  month: number;
  from: Date | null;
  to: Date | null;
  hovered: Date | null;
  onDay: (date: Date) => void;
  onHover: (date: Date | null) => void;
}) {
  const firstDay = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: Array<Date | null> = Array.from({ length: firstDay }, () => null);
  for (let day = 1; day <= days; day += 1) cells.push(new Date(year, month, day));
  const end = hovered ?? to;
  const low = from && end && from <= end ? from : end;
  const high = from && end && from <= end ? end : from;
  return <div className="calendar-month">
    <div className="calendar-weekdays">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>
    <div className="calendar-grid">
      {cells.map((date, index) => date ? (() => {
        const ymd = toYmd(date);
        const edge = ymd === (from && toYmd(from)) || ymd === (to && toYmd(to)) || ymd === (hovered && toYmd(hovered));
        const inRange = !!(low && high && date > low && date < high);
        return <button type="button" key={ymd} className={`${edge ? 'edge' : ''} ${inRange ? 'in-range' : ''}`} onClick={() => onDay(date)} onMouseEnter={() => onHover(date)} onMouseLeave={() => onHover(null)}>{date.getDate()}</button>;
      })() : <span key={`empty-${index}`} />)}
    </div>
  </div>;
}

export function DatePopover({ from, to, onChange, onClear }: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [horizontalOffset, setHorizontalOffset] = useState(0);
  const today = new Date();
  const fromDate = parseYmd(from);
  const toDate = parseYmd(to);
  const [left, setLeft] = useState(() => { const date = fromDate ?? new Date(today.getFullYear(), today.getMonth() - 1, 1); return { year: date.getFullYear(), month: date.getMonth() }; });
  const [right, setRight] = useState(() => { const date = toDate ?? new Date(today.getFullYear(), today.getMonth(), 1); return { year: date.getFullYear(), month: date.getMonth() }; });
  const [hovered, setHovered] = useState<Date | null>(null);
  useLayoutEffect(() => {
    const reposition = () => {
      const element = popoverRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const margin = 8;
      const shiftLeft = rect.right > window.innerWidth - margin ? window.innerWidth - margin - rect.right : 0;
      const shiftRight = rect.left < margin ? margin - rect.left : 0;
      const nextOffset = Math.round((shiftLeft || shiftRight) * 100) / 100;
      setHorizontalOffset((current) => current === nextOffset ? current : nextOffset);
    };
    reposition();
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, []);
  const choose = (date: Date) => {
    const value = toYmd(date);
    if (!from || to) { onChange(value, ''); return; }
    if (fromDate && date < fromDate) onChange(value, from);
    else onChange(from, value);
  };
  return <div ref={popoverRef} className="date-popover filter-popover" style={{ '--date-popover-offset': `${horizontalOffset}px` } as CSSProperties}>
    <header><strong>{t('Date range')}</strong><button type="button" disabled={!from && !to} onClick={onClear}>{t('Clear')}</button></header>
    <div className="calendar-panes">
      <div className="calendar-pane"><div className="calendar-nav"><button type="button" onClick={() => setLeft(shiftMonth(left, -1))}><Codicon name="chevron-left" /></button><strong>{MONTH_NAMES[left.month]} {left.year}</strong><button type="button" onClick={() => setLeft(shiftMonth(left, 1))}><Codicon name="chevron-right" /></button></div><CalendarMonth {...left} from={fromDate} to={toDate} hovered={hovered} onDay={choose} onHover={setHovered} /></div>
      <i className="calendar-divider" />
      <div className="calendar-pane"><div className="calendar-nav"><button type="button" onClick={() => setRight(shiftMonth(right, -1))}><Codicon name="chevron-left" /></button><strong>{MONTH_NAMES[right.month]} {right.year}</strong><button type="button" onClick={() => setRight(shiftMonth(right, 1))}><Codicon name="chevron-right" /></button></div><CalendarMonth {...right} from={fromDate} to={toDate} hovered={hovered} onDay={choose} onHover={setHovered} /></div>
    </div>
  </div>;
}
