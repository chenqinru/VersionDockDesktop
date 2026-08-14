import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { useResizable } from '../hooks/useResizable';
import { BranchSidebar } from './BranchSidebar';
import { CommitGraph } from './CommitGraph';
import { CommitDetailPanel } from './CommitDetailPanel';
import { COMMIT_ROW_HEIGHT, layoutCommits } from './commitGraphLayout';
import { commitKey } from '../history/commitDetails';
import type { CommitNode } from '../bindings/generated';

type FilterMenu = 'authors' | 'repos' | 'refs' | 'dates' | null;

function ToggleFilter({ icon, label, active, open, onClick }: { icon: string; label: string; active: boolean; open: boolean; onClick: () => void }) {
  return <button className={`filter-button ${active ? 'active' : ''} ${open ? 'open' : ''}`} onClick={onClick} aria-expanded={open}><Codicon name={icon} /><span>{label}</span>{active && <i />}<Codicon name="chevron-down" /></button>;
}

function CheckMenu({ title, values, selected, toggle, clear, single = false }: { title: string; values: Array<{ id: string; label: string; color?: string; detail?: string }>; selected: Set<string>; toggle: (value: string) => void; clear: () => void; single?: boolean }) {
  const { t } = useI18n();
  return <div className="filter-popover"><header><strong>{title}</strong><button disabled={!selected.size} onClick={clear}>{t('Clear')}</button></header><div className="filter-options">
    {values.map((value) => <label key={value.id}><input type={single ? 'radio' : 'checkbox'} checked={selected.has(value.id)} onChange={() => toggle(value.id)} />{value.color && <i style={{ background: value.color }} />}<span>{value.label}{value.detail && <small>{value.detail}</small>}</span></label>)}
  </div></div>;
}

function DateMenu({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (value: string) => void; setTo: (value: string) => void }) {
  const { t } = useI18n();
  return <div className="filter-popover date-popover"><header><strong>{t('Date range')}</strong><button disabled={!from && !to} onClick={() => { setFrom(''); setTo(''); }}>{t('Clear')}</button></header><label><span>{t('From')}</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label><span>{t('To')}</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></div>;
}


function refKind(ref: string) { if (ref.includes('tag:')) return 'tag'; if (ref.includes('HEAD')) return 'head'; if (ref.includes('origin/') || ref.includes('remotes/')) return 'remote'; return 'branch'; }
function refLabel(ref: string) { return ref.replace('HEAD -> ', '').replace('tag: ', '').replace('refs/heads/', '').replace('refs/remotes/', ''); }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); }

function CommitList({ history }: { history: CommitNode[] }) {
  const parent = useRef<HTMLDivElement>(null);
  const repos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const hasMore = useAppStore((state) => state.historyHasMore);
  const selected = useAppStore((state) => new Set(state.selectedCommits.map((commit) => commitKey(commit.repoId, commit.hash))));
  const selectCommit = useAppStore((state) => state.selectCommit);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const commits = useMemo(() => layoutCommits(history), [history]);
  const repoColors = useMemo(() => Object.fromEntries(repos.map((repo) => [repo.meta.id, repo.meta.color])), [repos]);
  const repoNames = useMemo(() => Object.fromEntries(repos.map((repo) => [repo.meta.id, repo.meta.name])), [repos]);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: commits.length, getScrollElement: () => parent.current, estimateSize: () => COMMIT_ROW_HEIGHT, overscan: 12 });
  return <div className="commit-list" ref={parent} onScroll={(event) => { const element = event.currentTarget; if (hasMore && element.scrollHeight - element.scrollTop - element.clientHeight < 300) void loadHistory(false); }}><div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
    {virtualizer.getVirtualItems().map((item) => { const commit = commits[item.index]; const isSelected = selected.has(commitKey(commit.repoId, commit.hash)); return <button className={`commit-row ${isSelected ? 'selected' : ''}`} key={`${commit.repoId}:${commit.hash}`} style={{ transform: `translateY(${item.start}px)` }} onClick={(event) => void selectCommit(commit, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single', commits)}>
      <span className="repo-stripe" style={{ background: repoColors[commit.repoId] ?? '#888' }} title={repoNames[commit.repoId]} /><CommitGraph commit={commit} selected={isSelected} />
      <span className="commit-subject"><span className="commit-refs">{commit.refs.map((ref) => <em className={refKind(ref)} key={ref}>{refLabel(ref)}</em>)}</span><span>{commit.message}</span></span>
      <span className="commit-author"><span className="mini-avatar">{commit.author.slice(0, 1).toUpperCase()}</span>{commit.author}</span><time>{formatDate(commit.committerDate)}</time>
    </button>; })}
  </div></div>;
}

export function HistoryWorkspace() {
  const [menu, setMenu] = useState<FilterMenu>(null);
  const activeFilter = useRef<HTMLDivElement>(null);
  const [authors, setAuthors] = useState(new Set<string>());
  const [repos, setRepos] = useState(new Set<string>());
  const [refs, setRefs] = useState(new Set<string>());
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);
  const allHistory = useAppStore((state) => state.history);
  const snapshotRepos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const tagsByRepo = useAppStore((state) => state.tagsByRepo);
  const filter = useAppStore((state) => state.historyFilter);
  const setFilter = useAppStore((state) => state.setHistoryFilter); const loadHistory = useAppStore((state) => state.loadHistory);
  const branchWidth = useAppStore((state) => state.bootstrap?.state.panelSizes.branches ?? 220); const detailWidth = useAppStore((state) => state.bootstrap?.state.panelSizes.detail ?? 360); const setPanelSize = useAppStore((state) => state.setPanelSize);
  const branchSidebarCollapsed = useAppStore((state) => state.bootstrap?.state.branchSidebarCollapsed ?? false); const collapsedSections = useAppStore((state) => state.bootstrap?.state.branchSidebarCollapsedSections ?? []); const setBranchSidebarState = useAppStore((state) => state.setBranchSidebarState);
  const [detailSidebarCollapsed, setDetailSidebarCollapsed] = useState(false);
  const resizeBranches = useResizable(branchWidth, 190, 420, (value) => setPanelSize('branches', value)); const resizeDetail = useResizable(detailWidth, 300, 620, (value) => setPanelSize('detail', value), -1); const { t } = useI18n();
  const authorOptions = useMemo(() => [...new Set(allHistory.map((commit) => commit.author))].sort().map((author) => ({ id: author, label: author })), [allHistory]);
  const repoOptions = snapshotRepos.map((item) => ({ id: item.meta.id, label: item.meta.name, color: item.meta.color, detail: item.meta.kind.toUpperCase() }));
  const refOptions = useMemo(() => { const values = new Set<string>(); Object.values(branchesByRepo).flat().forEach((branch) => values.add(branch.remote && branch.name.includes('/') ? branch.name.slice(branch.name.indexOf('/') + 1) : branch.name)); Object.values(tagsByRepo).flat().forEach((tag) => values.add(tag.name)); return [...values].sort().map((value) => ({ id: value, label: value })); }, [branchesByRepo, tagsByRepo]);
  const selectedRepoLabel = repos.size === 1 ? repoOptions.find((value) => repos.has(value.id))?.label ?? t('Repository') : t('Repository');
  const selectedRefLabel = refs.size === 1 ? [...refs][0] : `${t('Branch')} / ${t('Tags')}`;
  const visibleHistory = useMemo(() => allHistory.filter((commit) => {
    if (authors.size && !authors.has(commit.author)) return false; if (repos.size && !repos.has(commit.repoId)) return false;
    if (refs.size && !commit.refs.some((ref) => [...refs].some((value) => refLabel(ref) === value || refLabel(ref).endsWith(`/${value}`)))) return false;
    const date = Date.parse(commit.committerDate); if (from && date < Date.parse(`${from}T00:00:00`)) return false; if (to && date > Date.parse(`${to}T23:59:59`)) return false; return true;
  }), [allHistory, authors, from, refs, repos, to]);
  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (value: string) => setter((current) => { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; });
  const selectOne = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (value: string) => setter(new Set([value]));

  useEffect(() => {
    if (!menu) return;
    const handleOutsideInteraction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !activeFilter.current?.contains(target)) setMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMenu(null);
    };
    document.addEventListener('pointerdown', handleOutsideInteraction, true);
    document.addEventListener('focusin', handleOutsideInteraction, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutsideInteraction, true);
      document.removeEventListener('focusin', handleOutsideInteraction, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menu]);

  if (!selectedRepoId) return <div className="workspace-empty"><Codicon name="repo" />{t('Select a repository')}</div>;
  return <section className="history-workspace" onClick={() => menu && setMenu(null)}>
    <div className="history-filters" onClick={(event) => event.stopPropagation()}><label className="commit-search"><Codicon name="search" /><input value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void loadHistory(true); }} placeholder={t('Search commits')} />{filter && <button onClick={() => { setFilter(''); queueMicrotask(() => void loadHistory(true)); }}><Codicon name="close" /></button>}</label>
      <div ref={menu === 'authors' ? activeFilter : undefined} className="filter-anchor"><ToggleFilter icon="person" label={authors.size ? `${t('Author')} · ${authors.size}` : t('Author')} active={!!authors.size} open={menu === 'authors'} onClick={() => setMenu((current) => current === 'authors' ? null : 'authors')} />{menu === 'authors' && <CheckMenu title={t('Author')} values={authorOptions} selected={authors} toggle={toggleSet(setAuthors)} clear={() => setAuthors(new Set())} />}</div>
      <div ref={menu === 'repos' ? activeFilter : undefined} className="filter-anchor"><ToggleFilter icon="repo" label={selectedRepoLabel} active={!!repos.size} open={menu === 'repos'} onClick={() => setMenu((current) => current === 'repos' ? null : 'repos')} />{menu === 'repos' && <CheckMenu title={t('Repository')} values={repoOptions} selected={repos} toggle={selectOne(setRepos)} single clear={() => setRepos(new Set())} />}</div>
      <div ref={menu === 'refs' ? activeFilter : undefined} className="filter-anchor"><ToggleFilter icon="git-branch" label={selectedRefLabel} active={!!refs.size} open={menu === 'refs'} onClick={() => setMenu((current) => current === 'refs' ? null : 'refs')} />{menu === 'refs' && <CheckMenu title={`${t('Branch')} / ${t('Tags')}`} values={refOptions} selected={refs} toggle={selectOne(setRefs)} single clear={() => setRefs(new Set())} />}</div>
      <div ref={menu === 'dates' ? activeFilter : undefined} className="filter-anchor"><ToggleFilter icon="calendar" label={from || to ? `${from || '…'} → ${to || '…'}` : t('From to')} active={!!from || !!to} open={menu === 'dates'} onClick={() => setMenu((current) => current === 'dates' ? null : 'dates')} />{menu === 'dates' && <DateMenu from={from} to={to} setFrom={setFrom} setTo={setTo} />}</div><span />
    </div>
    <div className="history-columns"><div className={`branch-slot ${branchSidebarCollapsed ? 'branch-slot-collapsed' : ''}`} style={{ width: branchSidebarCollapsed ? 28 : branchWidth }}>{branchSidebarCollapsed ? <button className="branch-sidebar-expand" title={t('Show branches')} aria-label={t('Show branches')} onClick={() => setBranchSidebarState(false, collapsedSections)}><Codicon name="layout-sidebar-left-off" /></button> : <BranchSidebar repoFilter={repos} refFilter={refs} onRepoFilter={selectOne(setRepos)} onRefFilter={selectOne(setRefs)} onCollapse={() => setBranchSidebarState(true, collapsedSections)} />}</div>{!branchSidebarCollapsed && <div className="inner-resize-handle" onPointerDown={resizeBranches} />}<div className="log-pane">{visibleHistory.length ? <CommitList history={visibleHistory} /> : <div className="empty-state"><Codicon name="history" />{t('No history')}</div>}</div>{!detailSidebarCollapsed && <div className="inner-resize-handle" onPointerDown={resizeDetail} />}<div className={`detail-slot ${detailSidebarCollapsed ? 'detail-slot-collapsed' : ''}`} style={{ width: detailSidebarCollapsed ? 28 : detailWidth }}>{detailSidebarCollapsed ? <button className="detail-sidebar-expand" title={t('Show commit detail')} aria-label={t('Show commit detail')} onClick={() => setDetailSidebarCollapsed(false)}><Codicon name="layout-sidebar-right-off" /></button> : <CommitDetailPanel onCollapse={() => setDetailSidebarCollapsed(true)} />}</div></div>
  </section>;
}
