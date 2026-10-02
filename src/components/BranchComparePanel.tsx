import { buildHistoryAuthorOptions } from '../history/authors';
import { IconButton } from './IconButton';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CommitNode } from '../bindings/generated';
import { Codicon } from './Codicon';
import { AuthorAvatar } from './AuthorAvatar';
import { useI18n } from '../i18n';
import { isOperationActive, useAppStore } from '../store/appStore';
import { CommitSearch, DateFilter, DatePopover, FilterPopover, ToggleFilter } from './HistoryFilterControls';

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

function ComparePane({
  repoId,
  base,
  target,
  side,
  title,
  emptyText,
  commits,
  renderCommits,
  authors,
}: {
  repoId: string;
  base: string;
  target: string;
  side: 'baseOnly' | 'targetOnly';
  title: string;
  emptyText: string;
  commits: CommitNode[];
  renderCommits: (commits: CommitNode[]) => ReactNode;
  authors: ReturnType<typeof buildHistoryAuthorOptions>;
}) {
  const { t } = useI18n();
  const compareBranchCommits = useAppStore((state) => state.compareBranchCommits);
  const [filters, setFilters] = useState<CompareFilters>(EMPTY_FILTERS);
  const [searchReset, setSearchReset] = useState(0);
  const [filteredCommits, setFilteredCommits] = useState<CommitNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [menu, setMenu] = useState<'authors' | 'dates' | null>(null);
  const activeFilter = useRef<HTMLDivElement>(null);
  const selectedAuthor = useMemo(
    () => authors.find((item) => item.id === filters.author || item.label === filters.author || item.sublabel === filters.author),
    [authors, filters.author]
  );

  const active = Boolean(filters.search || filters.author || filters.from || filters.to);

  useEffect(() => {
    if (!active) {
      return;
    }

    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) setLoading(true); });
    void (async () => {
      try {
        const result = await compareBranchCommits(
          repoId,
          base,
          target,
          side,
          {
            text: filters.search ? filters.search : null,
            author: filters.author ? filters.author : null,
            fromDate: filters.from ? filters.from : null,
            toDate: filters.to ? filters.to : null,
            path: null,
            revision: null,
          },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setFilteredCommits(result);
          setLoading(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setFilteredCommits([]);
          setLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [active, filters.search, filters.author, filters.from, filters.to, repoId, base, target, side, compareBranchCommits]);

  const visible = active ? (filteredCommits ?? []) : commits;

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !activeFilter.current?.contains(target)) setMenu(null);
    };
    const blur = () => setMenu(null);
    window.addEventListener('blur', blur);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('blur', blur);
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);

  return <section className="compare-pane">
    <div className="history-filters compare-pane-filters">
      <CommitSearch key={searchReset} value={filters.search} onChange={(search) => setFilters((current) => ({ ...current, search }))} />
      <div ref={menu === 'authors' ? activeFilter : undefined} className="filter-anchor">
        <ToggleFilter
          icon="person"
          leading={
            filters.author ? (
              <AuthorAvatar
                name={selectedAuthor?.avatarName ?? filters.author}
                email={selectedAuthor?.avatarEmail ?? ''}
                repoId={selectedAuthor?.avatarRepoId ?? repoId}
                size={14}
              />
            ) : undefined
          }
          title={selectedAuthor ? `${selectedAuthor.label}${selectedAuthor.sublabel ? ` <${selectedAuthor.sublabel}>` : ''}` : t('Filter by author')}
          label={selectedAuthor?.label || filters.author || t('Author…')}
          active={Boolean(filters.author)}
          open={menu === 'authors'}
          onClick={() => setMenu(menu === 'authors' ? null : 'authors')}
        />
        {menu === 'authors' && <FilterPopover allLabel={t('All authors')} kind="author" values={authors} selected={filters.author} onSelect={(author) => { setFilters((current) => ({ ...current, author })); setMenu(null); }} />}
      </div>
      <div ref={menu === 'dates' ? activeFilter : undefined} className="filter-anchor date-filter-anchor">
        <DateFilter from={filters.from} to={filters.to} open={menu === 'dates'} onClick={() => setMenu(menu === 'dates' ? null : 'dates')} onClear={() => setFilters((current) => ({ ...current, from: '', to: '' }))} />
        {menu === 'dates' && <DatePopover key={`${filters.from}:${filters.to}`} from={filters.from} to={filters.to} onChange={(from, to) => setFilters((current) => ({ ...current, from, to }))} onClose={() => setMenu(null)} />}
      </div>
      {active && <IconButton type="button" className="history-clear-filters" title={t('Clear all filters')} aria-label={t('Clear all filters')} onClick={() => { setSearchReset((version) => version + 1); setFilters(EMPTY_FILTERS); setMenu(null); }}><Codicon name="clear-all" /></IconButton>}
    </div>
    <h3 title={title}>{title}</h3>
    <div className="compare-pane-list">
      {active && loading ? (
        <div className="compare-empty">{t('Loading...')}</div>
      ) : visible.length > 0 ? (
        renderCommits(visible)
      ) : (
        <div className="compare-empty">{active ? t('No matches') : emptyText}</div>
      )}
    </div>
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
  const logHistory = useAppStore((state) => state.history);
  const authors = useMemo(() => buildHistoryAuthorOptions(logHistory), [logHistory]);
  const compare = useAppStore((state) => state.compareBranches);
  const busy = useAppStore((state) => isOperationActive(state.operations, { repositoryId: repoId, domain: 'history' }));
  const repo = useAppStore((state) => state.snapshot?.repositories.find((item) => item.meta.id === repoId));
  const head = branches.find((branch) => branch.current);
  const current = head?.detachedTag ? `refs/tags/${head.detachedTag}` : head?.detachedHash ?? (head?.name && head.name !== 'HEAD' ? `refs/heads/${head.name}` : repo?.revision ?? 'HEAD');
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
      <IconButton aria-label={t('Close')} title={t('Close')} onClick={close}><Codicon name="close" /></IconButton>
    </header>
    {!activeComparison ? <div className="empty-state"><Codicon name={busy ? 'loading codicon-modifier-spin' : 'compare-changes'} />{t(busy ? 'Loading...' : 'Select two branches to compare')}</div> : <div ref={stack} className="compare-stack" style={topHeight ? { gridTemplateRows: `${topHeight}px 4px minmax(0, 1fr)` } : undefined}>
      <ComparePane
        repoId={repoId}
        authors={authors}
        base={current}
        target={target}
        side="targetOnly"
        title={t('Exists in {0} but not in {1}', targetLabel, baseLabel)}
        emptyText={t('{0} contains all commits from {1}', baseLabel, targetLabel)}
        commits={activeComparison.targetCommits}
        renderCommits={renderCommits}
      />
      <div className="compare-splitter" role="separator" tabIndex={0} aria-label={t('Resize branch comparison')} aria-orientation="horizontal" aria-valuemin={110} aria-valuenow={Math.round(topHeight ?? 110)} onPointerDown={resize} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setTopHeight((value) => Math.max(110, (value ?? 110) + (event.key === 'ArrowDown' ? 10 : -10))); } }}><i /></div>
      <ComparePane
        repoId={repoId}
        authors={authors}
        base={current}
        target={target}
        side="baseOnly"
        title={t('Exists in {0} but not in {1}', baseLabel, targetLabel)}
        emptyText={t('{0} contains all commits from {1}', targetLabel, baseLabel)}
        commits={activeComparison.baseCommits}
        renderCommits={renderCommits}
      />
    </div>}
  </section>;
}
