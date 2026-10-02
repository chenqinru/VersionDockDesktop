import { IconButton } from './IconButton';
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { AuthorAvatar } from './AuthorAvatar';

export type HistoryFilterOption = {
  id: string;
  label: string;
  sublabel?: string;
  count?: number;
  color?: string;
  icon?: string;
  avatarName?: string;
  avatarEmail?: string;
  avatarRepoId?: string;
  group?: string;
};

export function CommitSearch({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState({ external: value, text: value });
  if (draft.external !== value) setDraft({ external: value, text: value });
  const local = draft.external === value ? draft.text : value;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composing = useRef(false);
  const changeHandler = useRef(onChange);
  useEffect(() => { changeHandler.current = onChange; }, [onChange]);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const submitNow = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setDraft({ external: value, text: next });
    changeHandler.current(next);
  };
  const change = (next: string) => {
    setDraft({ external: value, text: next });
    if (timer.current) clearTimeout(timer.current);
    if (composing.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      changeHandler.current(next);
    }, 250);
  };
  return <label className="commit-search">
    <Codicon name="search" />
    <input
      value={local}
      aria-label={t('Search commits…')}
      onChange={(event) => change(event.target.value)}
      onCompositionStart={() => { composing.current = true; if (timer.current) clearTimeout(timer.current); }}
      onCompositionEnd={(event) => { composing.current = false; change(event.currentTarget.value); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || composing.current) return;
        if (event.key === 'Enter') { event.preventDefault(); submitNow(local); }
        if (event.key === 'Escape') {
          event.stopPropagation();
          submitNow('');
          event.currentTarget.blur();
        }
      }}
      placeholder={t('Search commits…')}
    />
    {local && <IconButton type="button" title={t('Clear')} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => submitNow('')}><Codicon name="close" /></IconButton>}
  </label>;
}

export function ToggleFilter({ icon, leading, label, title, active, open, onClick, onClear }: {
  icon?: string;
  leading?: ReactNode;
  label: string;
  title?: string;
  active: boolean;
  open: boolean;
  onClick: () => void;
  onClear?: () => void;
}) {
  const { t } = useI18n();
  return <div className="filter-trigger">
    <button type="button" className={`filter-button ${active ? 'active' : ''} ${open ? 'open' : ''}`} title={title} onClick={onClick} aria-expanded={open} aria-haspopup="dialog">
    {leading ?? (icon ? <Codicon name={icon} /> : null)}
    <span className="filter-label">{label}</span>
    {onClear && active && <span className="filter-clear-slot" aria-hidden="true" />}
    <Codicon name={open ? 'chevron-up' : 'chevron-down'} />
    </button>
    {onClear && active && <IconButton className="filter-trigger-clear" title={t('Clear date range')} onClick={onClear}><Codicon name="close" /></IconButton>}
  </div>;
}

export function DateFilter({ from, to, open, onClick, onClear }: {
  from: string;
  to: string;
  open: boolean;
  onClick: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const label = from || to ? `${from || '...'}  →  ${to || '...'}` : t('From → To');
  return <ToggleFilter icon="calendar" label={label} title={from || to ? label : t('From YYYY-MM-DD')} active={Boolean(from || to)} open={open} onClick={onClick} onClear={onClear} />;
}

export function FilterPopover({
  values,
  selected,
  onSelect,
  allLabel: customAllLabel,
  kind,
}: {
  values: HistoryFilterOption[];
  selected: string;
  onSelect: (value: string) => void;
  allLabel?: string;
  kind: 'author' | 'repo' | 'ref';
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const resolvedKind = kind;
  const isSearchable = kind !== 'repo';

  const allLabel = customAllLabel ?? (
    resolvedKind === 'author'
      ? t('All authors')
      : resolvedKind === 'repo'
        ? t('All repositories')
        : t('All branches & tags')
  );

  const active = values.find((value) => value.id === selected || (kind === 'author' && (value.label === selected || value.sublabel === selected)));
  const mergedValues = kind === 'author' && selected && !active
    ? [{ id: selected, label: selected, avatarName: selected }, ...values]
    : values;

  const normalizedQuery = query.trim().toLowerCase();
  const displayed = normalizedQuery
    ? mergedValues.filter((value) => {
        const text = `${value.label} ${value.sublabel ?? ''}`.toLowerCase();
        return text.includes(normalizedQuery);
      })
    : mergedValues;

  const radioGroup = useId();

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      if (kind === 'author' && !event.nativeEvent.isComposing && displayed.length > 0) {
        event.preventDefault();
        onSelect(displayed[0].id);
      }
    }
  };

  const renderLeading = (option?: HistoryFilterOption) => {
    if (resolvedKind === 'author') {
      return <div className="filter-option-leading filter-leading-avatar" aria-hidden="true">
        {option?.avatarName ? (
          <AuthorAvatar name={option.avatarName} email={option.avatarEmail ?? ''} repoId={option.avatarRepoId} size={20} />
        ) : option ? (
          <Codicon name={option.icon || 'person'} />
        ) : (
          <Codicon name="organization" />
        )}
      </div>;
    }
    if (resolvedKind === 'repo') {
      if (!option) return null;
      return <span className="filter-option-dot" style={{ background: option.color }} aria-hidden="true" />;
    }
    if (resolvedKind === 'ref') {
      if (!option) return null;
      return <div className="filter-option-leading filter-leading-icon" aria-hidden="true">
        <Codicon name={option?.icon || 'git-branch'} />
      </div>;
    }
    return null;
  };

  return <div className="filter-popover" data-selection-mode="single" role="dialog" aria-label={allLabel}>
    {isSearchable && (
      <div className="popover-search">
        <Codicon name="search" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('Filter…')}
          aria-label={t('Filter…')}
        />
      </div>
    )}
    <div className="filter-options">
      <label className="filter-option-all" data-selected={!selected} onClick={(event) => { if (!(event.target instanceof HTMLInputElement)) { event.preventDefault(); onSelect(''); } }}>
        <input name={radioGroup} aria-label={allLabel} type="radio" checked={!selected} onClick={() => { if (!selected) onSelect(''); }} onChange={() => onSelect('')} />
        {renderLeading()}
        <span className="filter-option-content"><span className="filter-option-name">{allLabel}</span></span>
        {!selected && resolvedKind !== 'ref' && <div className="filter-option-check"><Codicon name="check" /></div>}
      </label>
      {displayed.map((value, index) => {
        const showGroup = Boolean(value.group && (index === 0 || displayed[index - 1].group !== value.group));
        return (
          <Fragment key={value.id}>
            {showGroup && <div className="filter-group-label">{t(value.group!)}</div>}
            <label data-selected={active ? active.id === value.id : selected === value.id} title={value.sublabel ? `${value.label} <${value.sublabel}>` : value.label} onClick={(event) => { if (!(event.target instanceof HTMLInputElement)) { event.preventDefault(); onSelect(value.id); } }}>
              <input name={radioGroup} aria-label={`${value.label}${value.sublabel ? ` ${value.sublabel}` : ''}`} type="radio" checked={active ? active.id === value.id : selected === value.id} onClick={() => { if (active ? active.id === value.id : selected === value.id) onSelect(value.id); }} onChange={() => onSelect(value.id)} />
              {renderLeading(value)}
              <span className="filter-option-content">
                <span className="filter-option-name">{value.label}</span>
                {value.sublabel && value.sublabel.trim() && <span className="filter-option-sublabel">{value.sublabel}</span>}
              </span>
              {value.count !== undefined && value.count > 0 && (
                <span className="filter-option-count">{value.count}</span>
              )}
              {(active ? active.id === value.id : selected === value.id) && <div className="filter-option-check"><Codicon name="check" /></div>}
            </label>
          </Fragment>
        );
      })}
      {!displayed.length && <div className="filter-empty">{t(kind === 'author' ? 'No authors match' : 'No matches')}</div>}
    </div>
  </div>;
}

function localizedWeekdays(locale: string): string[] {
  try {
    const sunday = new Date(2021, 7, 1);
    const formatter = new Intl.DateTimeFormat(locale, { weekday: locale.startsWith('zh') ? 'narrow' : 'short' });
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(sunday);
      date.setDate(sunday.getDate() + index);
      return formatter.format(date);
    });
  } catch {
    return ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  }
}

function formatYearMonth(year: number, month: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short' }).format(new Date(year, month, 1));
  } catch {
    return `${year}-${String(month + 1).padStart(2, '0')}`;
  }
}

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

function CalendarMonth({ year, month, from, to, hovered, onDay, onHover, weekdays }: {
  year: number;
  month: number;
  from: Date | null;
  to: Date | null;
  hovered: Date | null;
  onDay: (date: Date) => void;
  onHover: (date: Date | null) => void;
  weekdays: string[];
}) {
  const firstDay = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: Array<Date | null> = Array.from({ length: firstDay }, () => null);
  for (let day = 1; day <= days; day += 1) cells.push(new Date(year, month, day));
  const end = hovered ?? to;
  const low = from && end && from <= end ? from : end;
  const high = from && end && from <= end ? end : from;
  return <div className="calendar-month">
    <div className="calendar-grid">
      {weekdays.map((day, index) => <span className="calendar-weekday" key={`${day}-${index}`}>{day}</span>)}
      {cells.map((date, index) => date ? (() => {
        const ymd = toYmd(date);
        const edge = ymd === (from && toYmd(from)) || ymd === (to && toYmd(to)) || ymd === (hovered && toYmd(hovered));
        const inRange = !!(low && high && date > low && date < high);
        return <button type="button" key={ymd} className={`${edge ? 'edge' : ''} ${inRange ? 'in-range' : ''}`} onClick={() => onDay(date)} onMouseEnter={() => onHover(date)} onMouseLeave={() => onHover(null)}>{date.getDate()}</button>;
      })() : <span className="calendar-empty" key={`empty-${index}`} />)}
    </div>
  </div>;
}

export function DatePopover({ from, to, onChange, onClose }: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [horizontalOffset, setHorizontalOffset] = useState(0);
  const today = new Date();
  const fromDate = parseYmd(from);
  const toDate = parseYmd(to);
  const [left, setLeft] = useState(() => { const date = fromDate ?? new Date(today.getFullYear(), today.getMonth() - 1, 1); return { year: date.getFullYear(), month: date.getMonth() }; });
  const [right, setRight] = useState(() => { const date = toDate ?? new Date(today.getFullYear(), today.getMonth(), 1); return { year: date.getFullYear(), month: date.getMonth() }; });
  const [single, setSingle] = useState(() => { const date = toDate ?? fromDate ?? today; return { year: date.getFullYear(), month: date.getMonth() }; });
  const [dual, setDual] = useState(true);
  const [hovered, setHovered] = useState<Date | null>(null);
  const weekdays = localizedWeekdays(language);
  useLayoutEffect(() => {
    const anchor = popoverRef.current?.parentElement;
    const updateLayout = () => setDual((anchor?.clientWidth ?? 0) === 0 || (anchor?.clientWidth ?? 0) >= 310);
    updateLayout();
    const observer = typeof ResizeObserver === 'undefined' || !anchor ? undefined : new ResizeObserver(updateLayout);
    if (observer && anchor) observer.observe(anchor);
    window.addEventListener('resize', updateLayout);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateLayout);
    };
  }, []);
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
    onClose();
  };
  return <div ref={popoverRef} role="dialog" aria-label={t('Date range')} className={`date-popover filter-popover ${dual ? 'dual' : 'single'}`} style={{ '--date-popover-offset': `${horizontalOffset}px` } as CSSProperties}>
    {dual ? <div className="calendar-panes">
      <div className="calendar-pane"><div className="calendar-nav"><IconButton type="button" title={t('Previous month')} onClick={() => setLeft(shiftMonth(left, -1))}><Codicon name="chevron-left" /></IconButton><strong>{formatYearMonth(left.year, left.month, language)}</strong><IconButton type="button" title={t('Next month')} onClick={() => setLeft(shiftMonth(left, 1))}><Codicon name="chevron-right" /></IconButton></div><CalendarMonth {...left} from={fromDate} to={toDate} hovered={hovered} onDay={choose} onHover={setHovered} weekdays={weekdays} /></div>
      <i className="calendar-divider" />
      <div className="calendar-pane"><div className="calendar-nav"><IconButton type="button" title={t('Previous month')} onClick={() => setRight(shiftMonth(right, -1))}><Codicon name="chevron-left" /></IconButton><strong>{formatYearMonth(right.year, right.month, language)}</strong><IconButton type="button" title={t('Next month')} onClick={() => setRight(shiftMonth(right, 1))}><Codicon name="chevron-right" /></IconButton></div><CalendarMonth {...right} from={fromDate} to={toDate} hovered={hovered} onDay={choose} onHover={setHovered} weekdays={weekdays} /></div>
    </div> : <div className="calendar-panes single-calendar">
      <div className="calendar-pane"><div className="calendar-nav"><IconButton type="button" title={t('Previous month')} onClick={() => setSingle(shiftMonth(single, -1))}><Codicon name="chevron-left" /></IconButton><strong>{formatYearMonth(single.year, single.month, language)}</strong><IconButton type="button" title={t('Next month')} onClick={() => setSingle(shiftMonth(single, 1))}><Codicon name="chevron-right" /></IconButton></div><CalendarMonth {...single} from={fromDate} to={toDate} hovered={hovered} onDay={choose} onHover={setHovered} weekdays={weekdays} /></div>
    </div>}
  </div>;
}
