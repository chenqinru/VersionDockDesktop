import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { useResizable } from '../hooks/useResizable';
import { BranchSidebar } from './BranchSidebar';
import { CommitGraph } from './CommitGraph';
import { CommitDetailPanel } from './CommitDetailPanel';
import { COMMIT_ROW_HEIGHT, layoutCommits, type GraphCommit } from './commitGraphLayout';
import { commitKey } from '../history/commitDetails';
import { commitRefs, groupRefs, mergeLocalRemote, type CommitRef, type RefGroup } from '../history/refs';
import { branchColor, headColor, isPrimaryBranch, primaryBranchColor, tagColor } from './branchColor';
import type { CommitDetail, CommitNode } from '../bindings/generated';

type FilterMenu = 'authors' | 'repos' | 'refs' | 'dates' | null;
type ViewFilters = { author: string; repoId: string; ref: string; from: string; to: string };

const EMPTY_FILTERS: ViewFilters = { author: '', repoId: '', ref: '', from: '', to: '' };
const BLOCK_GAP = 4;

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (item: number) => String(item).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || '?').toUpperCase();
}

function avatarColor(value: string): string {
  return branchColor(value || 'author');
}

function toYmd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseYmd(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function refMatches(ref: CommitRef, value: string): boolean {
  return ref.label === value || ref.label.endsWith(`/${value}`) || ref.value === value;
}

function ToggleFilter({ icon, leading, label, active, open, onClick }: { icon?: string; leading?: ReactNode; label: string; active: boolean; open: boolean; onClick: () => void }) {
  return <button className={`filter-button ${active ? 'active' : ''} ${open ? 'open' : ''}`} onClick={onClick} aria-expanded={open}>{leading ?? (icon ? <Codicon name={icon} /> : null)}<span>{label}</span>{active && <i />}{open ? <Codicon name="chevron-up" /> : <Codicon name="chevron-down" />}</button>;
}

function FilterPopover({ title, values, selected, onSelect, onClear, query, onQuery }: {
  title: string;
  values: Array<{ id: string; label: string; color?: string; detail?: string; icon?: string }>;
  selected: string;
  onSelect: (value: string) => void;
  onClear: () => void;
  query?: string;
  onQuery?: (value: string) => void;
}) {
  const { t } = useI18n();
  const displayed = query?.trim()
    ? values.filter((value) => `${value.label} ${value.detail ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    : values;
  const radioGroup = `filter-${title}`;
  const allLabel = title === t('Author') ? t('All authors') : title === t('Repository') ? t('All repositories') : t('All branches & tags');
  return <div className="filter-popover" data-selection-mode="single">
    <header><strong>{title}</strong><button disabled={!selected} onClick={onClear}>{t('Clear')}</button></header>
    {onQuery && <label className="popover-search"><Codicon name="search" /><input autoFocus value={query ?? ''} onChange={(event) => onQuery(event.target.value)} placeholder={t('Filter…')} /></label>}
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

function shiftMonth(value: { year: number; month: number }, delta: number) {
  const next = new Date(value.year, value.month + delta, 1);
  return { year: next.getFullYear(), month: next.getMonth() };
}

function CalendarMonth({ year, month, from, to, hovered, onDay, onHover }: { year: number; month: number; from: Date | null; to: Date | null; hovered: Date | null; onDay: (date: Date) => void; onHover: (date: Date | null) => void }) {
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
        return <button key={ymd} className={`${edge ? 'edge' : ''} ${inRange ? 'in-range' : ''}`} onClick={() => onDay(date)} onMouseEnter={() => onHover(date)} onMouseLeave={() => onHover(null)}>{date.getDate()}</button>;
      })() : <span key={`empty-${index}`} />)}
    </div>
  </div>;
}

function DatePopover({ from, to, onChange, onClear }: { from: string; to: string; onChange: (from: string, to: string) => void; onClear: () => void }) {
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
  return <div ref={popoverRef} className="date-popover filter-popover" style={{ '--date-popover-offset': `${horizontalOffset}px` } as React.CSSProperties}>
    <header><strong>{t('Date range')}</strong><button disabled={!from && !to} onClick={onClear}>{t('Clear')}</button></header>
    <div className="calendar-panes">
      <div className="calendar-pane"><div className="calendar-nav"><button onClick={() => setLeft(shiftMonth(left, -1))}><Codicon name="chevron-left" /></button><strong>{MONTH_NAMES[left.month]} {left.year}</strong><button onClick={() => setLeft(shiftMonth(left, 1))}><Codicon name="chevron-right" /></button></div><CalendarMonth {...left} from={fromDate} to={toDate} hovered={hovered} onDay={choose} onHover={setHovered} /></div>
      <i className="calendar-divider" />
      <div className="calendar-pane"><div className="calendar-nav"><button onClick={() => setRight(shiftMonth(right, -1))}><Codicon name="chevron-left" /></button><strong>{MONTH_NAMES[right.month]} {right.year}</strong><button onClick={() => setRight(shiftMonth(right, 1))}><Codicon name="chevron-right" /></button></div><CalendarMonth {...right} from={fromDate} to={toDate} hovered={hovered} onDay={choose} onHover={setHovered} /></div>
    </div>
  </div>;
}

function MoreMenu({ open, onToggle, onFetch, expanded, onToggleExpanded }: { open: boolean; onToggle: () => void; onFetch: () => void; expanded: boolean; onToggleExpanded: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onToggle(); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onToggle, open]);
  return <div ref={ref} className="history-more"><button className={`more-button ${open ? 'selected' : ''}`} title={t('More actions')} aria-label={t('More actions')} onClick={onToggle}><Codicon name="three-bars" /></button>{open && <div className="more-menu">
    <button onClick={() => { onFetch(); onToggle(); }}><Codicon name="sync" />{t('Fetch and Refresh')}</button>
    <button onClick={() => { onToggleExpanded(); onToggle(); }}><Codicon name={expanded ? 'collapse-all' : 'expand-all'} />{t(expanded ? 'Collapse project names' : 'Expand project names')}</button>
  </div>}</div>;
}

function RefBadgeIcon({ group }: { group: RefGroup }) {
  if (group.isSvnRevision) return <Codicon name="versions" />;
  if (group.isTag) return <Codicon name="tag" />;
  if (group.isRemote) return <Codicon name="cloud" />;
  if (group.isHead || group.isDetached) return <Codicon name="arrow-right" />;
  return <Codicon name="git-branch" />;
}

function badgeColor(group: RefGroup): string {
  if (group.isTag || group.isSvnRevision) return tagColor();
  if (group.isHead || group.isDetached) return headColor();
  if (isPrimaryBranch(group.label)) return primaryBranchColor();
  return branchColor(group.label);
}

function RefBadges({
  refs,
  repoKind = 'git',
  remoteNames = [],
  isSelected = false,
}: {
  refs: string[];
  repoKind?: 'git' | 'svn';
  remoteNames?: readonly string[];
  isSelected?: boolean;
}) {
  const allGroups = useMemo(
    () => mergeLocalRemote(groupRefs(refs, repoKind, remoteNames)),
    [refs, repoKind, remoteNames],
  );
  if (allGroups.length === 0) return null;

  const headGroup = allGroups.find((g) => g.isHead && !g.isDetached && !g.isSvnRevision);
  const remoteHeadGroups = allGroups.filter((g) => g.isRemoteHead);
  const remoteHeadGroup = remoteHeadGroups.length === 1 ? remoteHeadGroups[0] : undefined;
  const headAndRemoteHead = headGroup && remoteHeadGroup;
  const otherGroups = allGroups.filter((g) => !(headAndRemoteHead && g.key === remoteHeadGroup.key));

  const visible = otherGroups.slice(0, 2);
  const overflow = otherGroups.slice(2);
  const hc = headColor();

  return (
    <span className="commit-refs">
      {visible.map((group) => {
        const color = badgeColor(group);
        return (
          <em
            key={group.key}
            className={`${group.isTag ? 'tag' : group.isRemote ? 'remote' : group.isHead ? 'head' : group.isSvnRevision ? 'svn' : 'branch'} ${isSelected ? 'selected' : ''}`}
            style={{ '--ref-color': color } as React.CSSProperties}
            title={group.label}
          >
            <RefBadgeIcon group={group} />
            <span className="ref-label">{group.remoteName && !group.isLocal ? `${group.remoteName}/${group.label}` : group.label}</span>
          </em>
        );
      })}
      {headGroup && (
        <em
          className={`head ${isSelected ? 'selected' : ''}`}
          style={{ '--ref-color': hc } as React.CSSProperties}
          title="HEAD"
        >
          {headAndRemoteHead ? <Codicon name="milestone" /> : <Codicon name="arrow-right" />}
          <span className="ref-label">{headAndRemoteHead ? `${remoteHeadGroup!.remoteName}/HEAD & HEAD` : 'HEAD'}</span>
        </em>
      )}
      {overflow.length > 0 && (
        <em className={`ref-overflow ${isSelected ? 'selected' : ''}`} title={overflow.map((g) => g.label).join('\n')}>
          +{overflow.length}
        </em>
      )}
    </span>
  );
}

type CommitWithIndicators = CommitNode & { incoming?: boolean; unpushed?: boolean };
type CommitPopoverAnchor = { rowTop: number; listTop: number; listBottom: number; listLeft: number; listRight: number; mouseX: number };

function CommitPopover({ detail, anchor, onEnter, onLeave }: { detail: CommitDetail; anchor: CommitPopoverAnchor; onEnter: () => void; onLeave: () => void }) {
  const { t } = useI18n();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const added = detail.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = detail.files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  useLayoutEffect(() => {
    const element = popoverRef.current;
    if (!element) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = Math.max(anchor.listLeft, Math.min(anchor.listRight - width, anchor.mouseX - width / 2));
    const preferredTop = anchor.rowTop - height - 6;
    const belowTop = anchor.rowTop + COMMIT_ROW_HEIGHT + 6;
    const top = preferredTop >= anchor.listTop
      ? preferredTop
      : Math.max(anchor.listTop, Math.min(belowTop, anchor.listBottom - height));
    setPosition({ top, left });
  }, [anchor]);
  return <div ref={popoverRef} className="commit-popover" style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden', pointerEvents: position ? 'auto' : 'none' }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
    <div className="popover-line"><Codicon name="git-commit" /><code>{detail.commit.shortHash}</code></div>
    <div className="popover-line"><span className="mini-avatar" style={{ background: avatarColor(detail.commit.email || detail.commit.author) }}>{initials(detail.commit.author)}</span><span>{detail.commit.author}</span><i>·</i><time>{formatDate(detail.commit.authorDate)}</time></div>
    <div className="popover-line"><Codicon name="diff" /><span>{detail.files.length} {detail.files.length === 1 ? t('file changed') : t('files changed')}</span>{added > 0 && <b className="added">+{added}</b>}{removed > 0 && <b className="removed">-{removed}</b>}</div>
    <RefBadges refs={detail.commit.refs} />
    <small>{t('Click to view more details')}</small>
  </div>;
}

function CommitList({
  history,
  expandedRepoIds,
  onToggleRepoName,
  repoKindById,
  remoteNamesByRepo,
  topologyCommits,
  isFiltered,
}: {
  history: CommitNode[];
  expandedRepoIds: Set<string>;
  onToggleRepoName: (repoId: string) => void;
  repoKindById: Record<string, 'git' | 'svn'>;
  remoteNamesByRepo: Record<string, string[]>;
  topologyCommits?: CommitNode[];
  isFiltered?: boolean;
}) {
  const { t } = useI18n();
  const parent = useRef<HTMLDivElement>(null);
  const repos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const hasMore = useAppStore((state) => state.historyHasMore);
  const selected = useAppStore((state) => new Set(state.selectedCommits.map((commit) => commitKey(commit.repoId, commit.hash))));
  const selectCommit = useAppStore((state) => state.selectCommit);
  const loadCommitDetail = useAppStore((state) => state.loadCommitDetail);
  const openDiff = useAppStore((state) => state.openDiff);
  const openChanges = useAppStore((state) => state.openCommitChanges);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const commits = useMemo(
    () => layoutCommits(history, isFiltered, repoKindById, remoteNamesByRepo, topologyCommits),
    [history, isFiltered, repoKindById, remoteNamesByRepo, topologyCommits],
  );
  const repoMap = useMemo(() => new Map(repos.map((repo) => [repo.meta.id, repo])), [repos]);
  const repoBlocks = useMemo(() => {
    const blocks: Array<{ repoId: string; name: string; color: string; start: number; count: number }> = [];
    for (let index = 0; index < commits.length; index += 1) {
      const commit = commits[index];
      const previous = blocks[blocks.length - 1];
      if (previous?.repoId === commit.repoId) previous.count += 1;
      else blocks.push({ repoId: commit.repoId, name: repoMap.get(commit.repoId)?.meta.name ?? commit.repoId, color: repoMap.get(commit.repoId)?.meta.color ?? 'var(--versiondock-muted)', start: index, count: 1 });
    }
    return blocks;
  }, [commits, repoMap]);
  const multiRepo = repos.length > 1;
  const anyExpanded = expandedRepoIds.size > 0;
  const labelColWidth = multiRepo ? (anyExpanded ? 110 : 8) : 0;

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => parent.current,
    estimateSize: () => COMMIT_ROW_HEIGHT,
    overscan: 14,
  });
  const [hoveredKey, setHoveredKey] = useState<string>();
  const [popover, setPopover] = useState<{ detail: CommitDetail; anchor: CommitPopoverAnchor }>();
  const hoveredKeyRef = useRef<string>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const popoverActive = useRef(false);

  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const schedulePopover = (event: React.MouseEvent<HTMLDivElement>, commit: CommitNode) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    const key = commitKey(commit.repoId, commit.hash);
    setHoveredKey(key);
    hoveredKeyRef.current = key;
    const row = event.currentTarget;
    const mouseX = event.clientX;
    hoverTimer.current = setTimeout(() => {
      void loadCommitDetail(commit).then((detail) => {
        if (hoveredKeyRef.current === key) {
          const rect = row.getBoundingClientRect();
          const listRect = parent.current?.getBoundingClientRect();
          if (!listRect) return;
          setPopover({ detail, anchor: { rowTop: rect.top, listTop: listRect.top, listBottom: listRect.bottom, listLeft: listRect.left, listRight: listRect.right, mouseX } });
        }
      }).catch(() => undefined);
    }, 650);
  };
  const closePopoverSoon = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoveredKey(undefined);
    hoveredKeyRef.current = undefined;
    closeTimer.current = setTimeout(() => { if (!popoverActive.current) setPopover(undefined); }, 140);
  };
  const allExpanded = repoBlocks.length > 0 && repoBlocks.every((block) => expandedRepoIds.has(block.repoId));

  return <div className="commit-list" ref={parent} onScroll={(event) => { const element = event.currentTarget; if (hasMore && element.scrollHeight - element.scrollTop - element.clientHeight < 300) void loadHistory(false); }}>
    <div className="commit-list-content" style={{ height: virtualizer.getTotalSize() }}>
      {multiRepo && repoBlocks.map((block) => {
        const blockTopPx = block.start * COMMIT_ROW_HEIGHT;
        const blockHeightPx = block.count * COMMIT_ROW_HEIGHT;
        const leadingGap = block.start > 0 ? BLOCK_GAP : 0;
        const top = blockTopPx + leadingGap;
        const height = Math.max(0, blockHeightPx - leadingGap);
        const expanded = expandedRepoIds.has(block.repoId);
        return <button key={`${block.repoId}:${block.start}`} className={`repo-strip ${expanded ? 'expanded' : ''}`} style={{ top, height, '--repo-color': block.color } as React.CSSProperties} onClick={() => onToggleRepoName(block.repoId)} title={block.name}><span className="repo-strip-bar" />{expanded && <strong>{block.name}</strong>}</button>;
      })}
      {virtualizer.getVirtualItems().map((item) => {
        const commit = commits[item.index] as GraphCommit & CommitWithIndicators;
        if (!commit) return null;
        const key = commitKey(commit.repoId, commit.hash);
        const isSelected = selected.has(key);
        const isMergeCommit = commit.parents.length > 1;
        return <div key={key} className={`commit-row ${isSelected ? 'selected' : ''}`} style={{ transform: `translateY(${item.start}px)` }} role="button" tabIndex={0} onMouseEnter={(event) => schedulePopover(event, commit)} onMouseLeave={closePopoverSoon} onClick={(event) => void selectCommit(commit, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single', commits)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') void selectCommit(commit, 'single', commits); }} title={`${commit.hash}\n${commit.author}\n${formatDate(commit.authorDate)}`}>
          {labelColWidth > 0 && <div style={{ width: labelColWidth, flexShrink: 0 }} />}
          <CommitGraph commit={commit} selected={isSelected} />
          <RefBadges refs={commit.refs} repoKind={repoKindById[commit.repoId] ?? 'git'} remoteNames={remoteNamesByRepo[commit.repoId] ?? []} isSelected={isSelected} />
          <span className={`commit-subject-text ${isMergeCommit ? 'merge-commit' : ''}`}>{commit.message}</span>
          <span className="commit-author">
            {hoveredKey === key && <span className="commit-row-actions"><button title={t('Open preview')} onClick={(event) => { event.stopPropagation(); const file = useAppStore.getState().selectedCommitDetails[key]?.files[0]; if (file) void openDiff(commit.repoId, file.path, false, commit.hash); }}><Codicon name="open-preview" /></button><button title={t('Open Changes')} onClick={(event) => { event.stopPropagation(); void selectCommit(commit).then(openChanges); }}><Codicon name="diff-multiple" /></button></span>}
            <span className={`commit-flow-indicators ${commit.incoming || commit.unpushed ? 'has-flow' : ''} ${commit.incoming && commit.unpushed ? 'has-both' : ''}`}>
              {commit.incoming && <span title={t('Not pulled')}><Codicon name="arrow-down" className="commit-flow-icon incoming" /></span>}
              {commit.unpushed && <span title={t('Not pushed')}><Codicon name="arrow-up" className="commit-flow-icon unpushed" /></span>}
            </span>
            <span className="mini-avatar" style={{ background: avatarColor(commit.email || commit.author) }}>{initials(commit.author)}</span><span className="commit-author-name">{commit.author}</span>
          </span>
          <time>{formatDate(commit.committerDate)}</time>
        </div>;
      })}
    </div>
    {popover && <CommitPopover detail={popover.detail} anchor={popover.anchor} onEnter={() => { popoverActive.current = true; if (closeTimer.current) clearTimeout(closeTimer.current); }} onLeave={() => { popoverActive.current = false; setPopover(undefined); }} />}
    {!commits.length && <div className="empty-state"><Codicon name="history" /><span>{t('No history')}</span></div>}
    {commits.length > 0 && allExpanded && <span className="sr-only">{t('Collapse project names')}</span>}
  </div>;
}

export function HistoryWorkspace() {
  const { t } = useI18n();
  const [menu, setMenu] = useState<FilterMenu>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [filters, setFilters] = useState<ViewFilters>(EMPTY_FILTERS);
  const [authorQuery, setAuthorQuery] = useState('');
  const [refQuery, setRefQuery] = useState('');
  const [expandedRepoIds, setExpandedRepoIds] = useState(new Set<string>());
  const activeFilter = useRef<HTMLDivElement>(null);
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);
  const allHistory = useAppStore((state) => state.history);
  const snapshotRepos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const tagsByRepo = useAppStore((state) => state.tagsByRepo);
  const historySearch = useAppStore((state) => state.historyFilter);
  const setHistorySearch = useAppStore((state) => state.setHistoryFilter);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const refresh = useAppStore((state) => state.refresh);
  const sync = useAppStore((state) => state.sync);
  const branchWidth = useAppStore((state) => state.bootstrap?.state.panelSizes.branches ?? 220);
  const detailWidth = useAppStore((state) => state.bootstrap?.state.panelSizes.detail ?? 380);
  const setPanelSize = useAppStore((state) => state.setPanelSize);
  const branchSidebarCollapsed = useAppStore((state) => state.bootstrap?.state.branchSidebarCollapsed ?? false);
  const collapsedSections = useAppStore((state) => state.bootstrap?.state.branchSidebarCollapsedSections ?? []);
  const setBranchSidebarState = useAppStore((state) => state.setBranchSidebarState);
  const [detailSidebarCollapsed, setDetailSidebarCollapsed] = useState(false);
  const resizeBranches = useResizable(branchWidth, 190, 420, (value) => setPanelSize('branches', value));
  const resizeDetail = useResizable(detailWidth, 300, 620, (value) => setPanelSize('detail', value), -1);

  const remotes = useAppStore((state) => state.remotes);
  const repoKindById = useMemo(() => {
    const map: Record<string, 'git' | 'svn'> = {};
    snapshotRepos.forEach((repo) => {
      map[repo.meta.id] = (repo.meta.kind as 'git' | 'svn') ?? 'git';
    });
    return map;
  }, [snapshotRepos]);
  const remoteNamesByRepo = useMemo(() => {
    const map: Record<string, string[]> = {};
    snapshotRepos.forEach((repo) => {
      const list = remotes[repo.meta.id] ?? [];
      map[repo.meta.id] = list.map((r) => r.name);
    });
    return map;
  }, [snapshotRepos, remotes]);

  const hasTopologyBreakingFilter = !!(historySearch.trim() || filters.author || filters.from || filters.to);
  const hasBranchFilter = !!filters.ref;
  const topologyCommits = !hasTopologyBreakingFilter && hasBranchFilter ? allHistory : undefined;

  const authorOptions = useMemo(() => {
    const counts = new Map<string, number>();
    allHistory.forEach((commit) => counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1));
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([author, count]) => ({ id: author, label: author, detail: String(count), icon: 'person' }));
  }, [allHistory]);
  const repoOptions = snapshotRepos.map((repo) => ({ id: repo.meta.id, label: repo.meta.name, color: repo.meta.color, detail: repo.meta.kind.toUpperCase() }));
  const refOptions = useMemo(() => {
    const branches = Object.values(branchesByRepo).flat().filter((branch) => !branch.remote).map((branch) => ({ id: branch.name, label: branch.name, icon: 'git-branch' }));
    const tags = Object.values(tagsByRepo).flat().map((tag) => ({ id: tag.name, label: tag.name, icon: 'tag' }));
    return [...new Map([...branches, ...tags].map((value) => [value.id, value])).values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [branchesByRepo, tagsByRepo]);
  const selectedRepo = repoOptions.find((option) => option.id === filters.repoId);
  const selectedRepoLabel = selectedRepo?.label ?? t('Repository');
  const selectedRefLabel = refOptions.find((option) => option.id === filters.ref)?.label ?? t('Branch / Tags');
  const filterActive = !!(filters.author || filters.repoId || filters.ref || filters.from || filters.to);
  const visibleHistory = useMemo(() => allHistory.filter((commit) => {
    const search = historySearch.trim().toLowerCase();
    if (search && !`${commit.message} ${commit.hash} ${commit.author}`.toLowerCase().includes(search)) return false;
    if (filters.author && commit.author !== filters.author) return false;
    if (filters.repoId && commit.repoId !== filters.repoId) return false;
    if (filters.ref && !commitRefs(commit).some((ref) => refMatches(ref, filters.ref))) return false;
    const date = Date.parse(commit.committerDate);
    if (filters.from && date < Date.parse(`${filters.from}T00:00:00`)) return false;
    if (filters.to && date > Date.parse(`${filters.to}T23:59:59`)) return false;
    return true;
  }), [allHistory, filters, historySearch]);
  const updateFilters = (next: Partial<ViewFilters>) => setFilters((current) => ({ ...current, ...next }));
  const clearFilters = () => setFilters(EMPTY_FILTERS);
  const fetchAndRefresh = async () => {
    await Promise.all(snapshotRepos.filter((repo) => repo.meta.kind === 'git').map((repo) => sync(repo.meta.id, 'fetch')));
    await refresh();
  };
  const toggleRepoNames = () => {
    const repoIds = [...new Set(allHistory.map((commit) => commit.repoId))];
    setExpandedRepoIds((current) => current.size === repoIds.length ? new Set() : new Set(repoIds));
  };

  useEffect(() => {
    if (!menu) return;
    const handleOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !activeFilter.current?.contains(target)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', handleOutside, true);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', handleOutside, true); document.removeEventListener('keydown', escape); };
  }, [menu]);

  if (!selectedRepoId) return <div className="workspace-empty"><Codicon name="repo" />{t('Select a repository')}</div>;
  return <section className="history-workspace">
    <div className="history-filters" onClick={(event) => event.stopPropagation()}>
      <label className="commit-search"><Codicon name="search" /><input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void loadHistory(true); }} placeholder={t('Search commits…')} />{historySearch && <button aria-label={t('Clear')} onClick={() => { setHistorySearch(''); queueMicrotask(() => void loadHistory(true)); }}><Codicon name="close" /></button>}</label>
      <div ref={menu === 'authors' ? activeFilter : undefined} className="filter-anchor"><ToggleFilter icon="person" label={filters.author ? filters.author : t('Author…')} active={!!filters.author} open={menu === 'authors'} onClick={() => setMenu(menu === 'authors' ? null : 'authors')} />{menu === 'authors' && <FilterPopover title={t('Author')} values={authorOptions} selected={filters.author} onSelect={(author) => { updateFilters({ author }); setMenu(null); }} onClear={() => updateFilters({ author: '' })} query={authorQuery} onQuery={setAuthorQuery} />}</div>
      <div ref={menu === 'repos' ? activeFilter : undefined} className="filter-anchor"><ToggleFilter icon={selectedRepo ? undefined : 'repo'} leading={selectedRepo ? <span className="filter-repo-dot" style={{ background: selectedRepo.color }} /> : undefined} label={selectedRepoLabel} active={!!filters.repoId} open={menu === 'repos'} onClick={() => setMenu(menu === 'repos' ? null : 'repos')} />{menu === 'repos' && <FilterPopover title={t('Repository')} values={repoOptions} selected={filters.repoId} onSelect={(repoId) => { updateFilters({ repoId }); setMenu(null); }} onClear={() => updateFilters({ repoId: '' })} />}</div>
      <div ref={menu === 'refs' ? activeFilter : undefined} className="filter-anchor branch-filter-anchor"><ToggleFilter icon="git-branch" label={selectedRefLabel} active={!!filters.ref} open={menu === 'refs'} onClick={() => setMenu(menu === 'refs' ? null : 'refs')} />{menu === 'refs' && <FilterPopover title={t('Branch / Tags')} values={refOptions} selected={filters.ref} onSelect={(ref) => { updateFilters({ ref }); setMenu(null); }} onClear={() => updateFilters({ ref: '' })} query={refQuery} onQuery={setRefQuery} />}</div>
      <div ref={menu === 'dates' ? activeFilter : undefined} className="filter-anchor date-filter-anchor"><ToggleFilter icon="calendar" label={filters.from || filters.to ? `${filters.from || '…'} → ${filters.to || '…'}` : t('From → To')} active={!!filters.from || !!filters.to} open={menu === 'dates'} onClick={() => setMenu(menu === 'dates' ? null : 'dates')} />{menu === 'dates' && <DatePopover from={filters.from} to={filters.to} onChange={(from, to) => updateFilters({ from, to })} onClear={() => updateFilters({ from: '', to: '' })} />}</div>
      <span className="history-filter-spacer" />
      {filterActive && <button className="history-clear-filters" title={t('Clear all filters')} onClick={clearFilters}><Codicon name="clear-all" /></button>}
      <MoreMenu open={moreOpen} onToggle={() => setMoreOpen((value) => !value)} onFetch={() => void fetchAndRefresh()} expanded={expandedRepoIds.size > 0 && expandedRepoIds.size === new Set(allHistory.map((commit) => commit.repoId)).size} onToggleExpanded={toggleRepoNames} />
    </div>
    <div className="history-columns">
      <div className={`branch-slot ${branchSidebarCollapsed ? 'branch-slot-collapsed' : ''}`} style={{ width: branchSidebarCollapsed ? 28 : branchWidth }}>{branchSidebarCollapsed ? <button className="branch-sidebar-expand" title={t('Show branches')} aria-label={t('Show branches')} onClick={() => setBranchSidebarState(false, collapsedSections)}><Codicon name="layout-sidebar-left-off" /></button> : <BranchSidebar repoFilter={filters.repoId ? new Set([filters.repoId]) : new Set()} refFilter={filters.ref ? new Set([filters.ref]) : new Set()} onRepoFilter={(repoId) => updateFilters({ repoId })} onRefFilter={(ref) => updateFilters({ ref })} onCollapse={() => setBranchSidebarState(true, collapsedSections)} />}</div>
      {!branchSidebarCollapsed && <div className="inner-resize-handle" onPointerDown={resizeBranches} />}
      <div className="log-pane"><CommitList history={visibleHistory} expandedRepoIds={expandedRepoIds} onToggleRepoName={(repoId) => setExpandedRepoIds((current) => { const next = new Set(current); if (next.has(repoId)) next.delete(repoId); else next.add(repoId); return next; })} repoKindById={repoKindById} remoteNamesByRepo={remoteNamesByRepo} topologyCommits={topologyCommits} isFiltered={hasTopologyBreakingFilter} /></div>
      {!detailSidebarCollapsed && <div className="inner-resize-handle" onPointerDown={resizeDetail} />}
      <div className={`detail-slot ${detailSidebarCollapsed ? 'detail-slot-collapsed' : ''}`} style={{ width: detailSidebarCollapsed ? 28 : detailWidth }}>{detailSidebarCollapsed ? <button className="detail-sidebar-expand" title={t('Show commit detail')} aria-label={t('Show commit detail')} onClick={() => setDetailSidebarCollapsed(false)}><Codicon name="layout-sidebar-right-off" /></button> : <CommitDetailPanel onCollapse={() => setDetailSidebarCollapsed(true)} />}</div>
    </div>
  </section>;
}
