import { IconButton } from './IconButton';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { AuthorAvatar } from './AuthorAvatar';

export type HistoryFilterOption = {
  id: string;
  label: string;
  sublabel?: string;
  count?: number;
  color?: string;
  detail?: string;
  icon?: string;
  avatarName?: string;
  avatarEmail?: string;
  avatarRepoId?: string;
  group?: string;
};

export function CommitSearch({ value, onChange, onSubmit, onClear }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  onClear?: () => void;
}) {
  const { t } = useI18n();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const submitNow = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    onSubmit?.();
  };
  const change = (next: string) => {
    onChange(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onSubmit?.();
    }, 250);
  };
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    onChange('');
    onClear?.();
  };
  return <label className="commit-search">
    <Codicon name="search" />
    <input
      value={value}
      onChange={(event) => change(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') submitNow();
        if (event.key === 'Escape' && value) {
          clear();
          event.currentTarget.blur();
        }
      }}
      placeholder={t('Search commits…')}
    />
    {value && <IconButton type="button" aria-label={t('Clear')} onClick={clear}><Codicon name="close" /></IconButton>}
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

export function FilterPopover({
  values,
  selected,
  onSelect,
  onClear,
  allLabel: customAllLabel,
  kind,
  query: externalQuery,
  onQuery: externalOnQuery,
  allowCustom: externalAllowCustom,
  searchable,
}: {
  title?: string;
  values: HistoryFilterOption[];
  selected: string;
  onSelect: (value: string) => void;
  onClear: () => void;
  query?: string;
  onQuery?: (value: string) => void;
  allowCustom?: boolean;
  allLabel?: string;
  kind?: 'author' | 'repo' | 'ref';
  searchable?: boolean;
}) {
  const { t } = useI18n();
  const [internalQuery, setInternalQuery] = useState('');
  const query = externalQuery !== undefined ? externalQuery : internalQuery;
  const setQuery = externalOnQuery ?? setInternalQuery;

  const resolvedKind: 'author' | 'repo' | 'ref' = kind ?? (
    values.some((v) => Boolean(v.avatarName))
      ? 'author'
      : values.some((v) => Boolean(v.color))
        ? 'repo'
        : 'ref'
  );

  const allowCustom = externalAllowCustom ?? (resolvedKind === 'author');
  const isSearchable = searchable ?? (resolvedKind !== 'repo');

  const allLabel = customAllLabel ?? (
    resolvedKind === 'author'
      ? t('All authors')
      : resolvedKind === 'repo'
        ? t('All repositories')
        : t('All branches & tags')
  );

  const mergedValues: HistoryFilterOption[] = useMemo(() => {
    if (!selected) return values;
    if (values.some((v) => v.id === selected || v.label === selected)) return values;
    return [{ id: selected, label: selected }, ...values];
  }, [selected, values]);

  const normalizedQuery = query.trim().toLowerCase();
  const displayed = normalizedQuery
    ? mergedValues.filter((value) => {
        const text = `${value.label} ${value.sublabel ?? ''} ${value.detail ?? ''}`.toLowerCase();
        return text.includes(normalizedQuery);
      })
    : mergedValues;

  const radioGroup = `filter-${resolvedKind}`;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      if (displayed.length > 0) {
        event.preventDefault();
        onSelect(displayed[0].id);
      } else if (allowCustom && query.trim()) {
        event.preventDefault();
        onSelect(query.trim());
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

  return <div className="filter-popover" data-selection-mode="single">
    {isSearchable && (
      <div className="popover-search">
        <Codicon name="search" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={allowCustom ? t('Type an author and press Enter…') : t('Filter…')}
        />
      </div>
    )}
    <div className="filter-options">
      <label className="filter-option-all">
        <input name={radioGroup} aria-label={allLabel} type="radio" checked={!selected} onChange={onClear} />
        {renderLeading()}
        <span className="filter-option-content"><span className="filter-option-name">{allLabel}</span></span>
        {!selected && resolvedKind !== 'ref' && <div className="filter-option-check"><Codicon name="check" /></div>}
      </label>
      {displayed.map((value, index) => {
        const showGroup = Boolean(value.group && (index === 0 || displayed[index - 1].group !== value.group));
        return (
          <Fragment key={value.id}>
            {showGroup && <div className="filter-group-label">{t(value.group!)}</div>}
            <label title={value.sublabel ? `${value.label} <${value.sublabel}>` : value.detail}>
              <input name={radioGroup} aria-label={`${value.label}${value.sublabel ? ` ${value.sublabel}` : ''}`} type="radio" checked={selected === value.id} onChange={() => onSelect(value.id)} />
              {renderLeading(value)}
              <span className="filter-option-content">
                <span className="filter-option-name">{value.label}</span>
                {value.sublabel && value.sublabel.trim() && <span className="filter-option-sublabel">{value.sublabel}</span>}
              </span>
              {value.count !== undefined && value.count > 0 && (
                <span className="filter-option-count">{value.count}</span>
              )}
              {selected === value.id && <div className="filter-option-check"><Codicon name="check" /></div>}
            </label>
          </Fragment>
        );
      })}
      {!displayed.length && <div className="filter-empty">{t('No matches')}</div>}
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
    <div className="calendar-weekdays">{weekdays.map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
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
  };
  return <div ref={popoverRef} className={`date-popover filter-popover ${dual ? 'dual' : 'single'}`} style={{ '--date-popover-offset': `${horizontalOffset}px` } as CSSProperties}>
    <header><strong>{t('Date range')}</strong><button type="button" disabled={!from && !to} onClick={onClear}>{t('Clear')}</button></header>
    {dual ? <div className="calendar-panes">
      <div className="calendar-pane"><div className="calendar-nav"><IconButton type="button" title={t('Previous month')} onClick={() => setLeft(shiftMonth(left, -1))}><Codicon name="chevron-left" /></IconButton><strong>{formatYearMonth(left.year, left.month, language)}</strong><IconButton type="button" title={t('Next month')} onClick={() => setLeft(shiftMonth(left, 1))}><Codicon name="chevron-right" /></IconButton></div><CalendarMonth {...left} from={fromDate} to={toDate} hovered={hovered} onDay={choose} onHover={setHovered} weekdays={weekdays} /></div>
      <i className="calendar-divider" />
      <div className="calendar-pane"><div className="calendar-nav"><IconButton type="button" title={t('Previous month')} onClick={() => setRight(shiftMonth(right, -1))}><Codicon name="chevron-left" /></IconButton><strong>{formatYearMonth(right.year, right.month, language)}</strong><IconButton type="button" title={t('Next month')} onClick={() => setRight(shiftMonth(right, 1))}><Codicon name="chevron-right" /></IconButton></div><CalendarMonth {...right} from={fromDate} to={toDate} hovered={hovered} onDay={choose} onHover={setHovered} weekdays={weekdays} /></div>
    </div> : <div className="calendar-panes single-calendar">
      <div className="calendar-pane"><div className="calendar-nav"><IconButton type="button" title={t('Previous month')} onClick={() => setSingle(shiftMonth(single, -1))}><Codicon name="chevron-left" /></IconButton><strong>{formatYearMonth(single.year, single.month, language)}</strong><IconButton type="button" title={t('Next month')} onClick={() => setSingle(shiftMonth(single, 1))}><Codicon name="chevron-right" /></IconButton></div><CalendarMonth {...single} from={fromDate} to={toDate} hovered={hovered} onDay={choose} onHover={setHovered} weekdays={weekdays} /></div>
    </div>}
  </div>;
}
