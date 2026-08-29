import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CommitNode } from '../bindings/generated';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { isOperationActive, useAppStore } from '../store/appStore';
import { CommitSearch, DatePopover, FilterPopover, ToggleFilter } from './HistoryFilterControls';

type CompareFilters = {
  search: string;
  author: string;
  from: string;
  to: string;
};

const EMPTY_FILTERS: CompareFilters = { search: '', author: '', from: '', to: '' };

function formatRef(value: string): string {
  return value.replace(/^refs\/(?:heads|remotes|tags)\//, '');
}

function filterCommits(commits: CommitNode[], filters: CompareFilters): CommitNode[] {
  const needle = filters.search.trim().toLocaleLowerCase();
  return commits.filter((commit) => {
    if (filters.author && commit.author !== filters.author) return false;
    const day = commit.authorDate.slice(0, 10);
    if (filters.from && day < filters.from) return false;
    if (filters.to && day > filters.to) return false;
    if (!needle) return true;
    return [commit.message, commit.hash, commit.shortHash, commit.author, commit.email, ...commit.refs]
      .some((value) => value.toLocaleLowerCase().includes(needle));
  });
}

function ComparePane({
  title,
  emptyText,
  commits,
  renderCommits,
}: {
  title: string;
  emptyText: string;
  commits: CommitNode[];
  renderCommits: (commits: CommitNode[]) => ReactNode;
}) {
  const { t } = useI18n();
  const [filters, setFilters] = useState<CompareFilters>(EMPTY_FILTERS);
  const [menu, setMenu] = useState<'authors' | 'dates' | null>(null);
  const [authorQuery, setAuthorQuery] = useState('');
  const activeFilter = useRef<HTMLDivElement>(null);
  const authors = useMemo(() => {
    const counts = new Map<string, number>();
    commits.forEach((commit) => counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1));
    return [...counts.entries()]
      .filter(([author]) => Boolean(author))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([author, count]) => ({ id: author, label: author, detail: String(count), icon: 'person' }));
  }, [commits]);
  const visible = useMemo(() => filterCommits(commits, filters), [commits, filters]);
  const active = Boolean(filters.search || filters.author || filters.from || filters.to);
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !activeFilter.current?.contains(target)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);
  return <section className="compare-pane">
    <div className="history-filters compare-pane-filters">
      <CommitSearch value={filters.search} onChange={(search) => setFilters((current) => ({ ...current, search }))} />
      <div ref={menu === 'authors' ? activeFilter : undefined} className="filter-anchor">
        <ToggleFilter icon="person" label={filters.author || t('Author…')} active={Boolean(filters.author)} open={menu === 'authors'} onClick={() => setMenu(menu === 'authors' ? null : 'authors')} />
        {menu === 'authors' && <FilterPopover title={t('Author')} values={authors} selected={filters.author} onSelect={(author) => { setFilters((current) => ({ ...current, author })); setMenu(null); }} onClear={() => setFilters((current) => ({ ...current, author: '' }))} query={authorQuery} onQuery={setAuthorQuery} />}
      </div>
      <div ref={menu === 'dates' ? activeFilter : undefined} className="filter-anchor date-filter-anchor">
        <ToggleFilter icon="calendar" label={filters.from || filters.to ? `${filters.from || '…'} → ${filters.to || '…'}` : t('From → To')} active={Boolean(filters.from || filters.to)} open={menu === 'dates'} onClick={() => setMenu(menu === 'dates' ? null : 'dates')} />
        {menu === 'dates' && <DatePopover from={filters.from} to={filters.to} onChange={(from, to) => setFilters((current) => ({ ...current, from, to }))} onClear={() => setFilters((current) => ({ ...current, from: '', to: '' }))} />}
      </div>
      {active && <button type="button" className="history-clear-filters" title={t('Clear all filters')} aria-label={t('Clear all filters')} onClick={() => setFilters(EMPTY_FILTERS)}><Codicon name="clear-all" /></button>}
    </div>
    <h3 title={title}>{title}</h3>
    <div className="compare-pane-list">{visible.length > 0 ? renderCommits(visible) : <div className="compare-empty">{active ? t('No matches') : emptyText}</div>}</div>
  </section>;
}

export function BranchComparePanel({
  repoId,
  initialTarget,
  close,
  renderCommits,
}: {
  repoId: string;
  initialTarget?: string;
  close: () => void;
  renderCommits: (commits: CommitNode[]) => ReactNode;
}) {
  const branches = useAppStore((state) => state.branchesByRepo[repoId] ?? []);
  const comparison = useAppStore((state) => state.comparison);
  const compare = useAppStore((state) => state.compareBranches);
  const busy = useAppStore((state) => isOperationActive(state.operations, { repositoryId: repoId, domain: 'history' }));
  const repo = useAppStore((state) => state.snapshot?.repositories.find((item) => item.meta.id === repoId));
  const current = branches.find((branch) => branch.current)?.name ?? branches[0]?.name ?? '';
  const fallback = branches.find((branch) => branch.name !== current)?.name ?? current;
  const target = initialTarget ?? fallback;
  const { t } = useI18n();
  const stack = useRef<HTMLDivElement>(null);
  const [topHeight, setTopHeight] = useState<number>();
  const activeComparison = comparison?.base === current && comparison.target === target ? comparison : undefined;

  useEffect(() => {
    if (current && target && current !== target && !activeComparison) void compare(repoId, current, target);
  }, [activeComparison, compare, current, repoId, target]);

  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = stack.current?.getBoundingClientRect();
    if (!bounds) return;
    const move = (next: PointerEvent) => setTopHeight(Math.max(110, Math.min(bounds.height - 114, next.clientY - bounds.top)));
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const baseLabel = formatRef(current);
  const targetLabel = formatRef(target);
  return <section className="compare-workspace">
    <header className="compare-header">
      <strong>{t('Compare')}</strong>
      {repo && <span className="compare-repo-badge"><i style={{ background: repo.meta.color }} /><span>{repo.meta.name}</span></span>}
      <span className="compare-title" title={`${baseLabel} → ${targetLabel}`}>{t('{0} vs {1}', baseLabel, targetLabel)}</span>
      <button aria-label={t('Close')} title={t('Close')} onClick={close}><Codicon name="close" /></button>
    </header>
    {!activeComparison ? <div className="empty-state"><Codicon name={busy ? 'loading codicon-modifier-spin' : 'compare-changes'} />{t(busy ? 'Loading...' : 'Select two branches to compare')}</div> : <div ref={stack} className="compare-stack" style={topHeight ? { gridTemplateRows: `${topHeight}px 4px minmax(0, 1fr)` } : undefined}>
      <ComparePane
        title={t('Exists in {0} but not in {1}', targetLabel, baseLabel)}
        emptyText={t('{0} contains all commits from {1}', baseLabel, targetLabel)}
        commits={activeComparison.targetCommits}
        renderCommits={renderCommits}
      />
      <div className="compare-splitter" role="separator" tabIndex={0} aria-label={t('Resize branch comparison')} aria-orientation="horizontal" aria-valuemin={110} aria-valuenow={Math.round(topHeight ?? 110)} onPointerDown={resize} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setTopHeight((value) => Math.max(110, (value ?? 110) + (event.key === 'ArrowDown' ? 10 : -10))); } }}><i /></div>
      <ComparePane
        title={t('Exists in {0} but not in {1}', baseLabel, targetLabel)}
        emptyText={t('{0} contains all commits from {1}', targetLabel, baseLabel)}
        commits={activeComparison.baseCommits}
        renderCommits={renderCommits}
      />
    </div>}
  </section>;
}
