import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Codicon } from './Codicon';
import { useAppStore, selectedRepository } from '../store/appStore';
import { useI18n } from '../i18n';
import { useResizable } from '../hooks/useResizable';
import { BranchComparePanel } from './BranchComparePanel';
import { RemoteManager } from './RemoteManager';
import { CommitGraph } from './CommitGraph';
import { COMMIT_ROW_HEIGHT, layoutCommits } from './commitGraphLayout';
import { buildDetailTree, collapseDetailTree, mergeBranches, splitVisibleBranches, type DetailTree, type MergedBranch } from './HistoryWorkspace.helpers';
import type { CommitNode, RepositoryStatus, TagInfo } from '../bindings/generated';

type FilterMenu = 'authors' | 'repos' | 'refs' | 'dates' | null;

function ToggleFilter({ icon, label, active, open, onClick }: { icon: string; label: string; active: boolean; open: boolean; onClick: () => void }) {
  return <button className={`filter-button ${active ? 'active' : ''} ${open ? 'open' : ''}`} onClick={onClick} aria-expanded={open}><Codicon name={icon} /><span>{label}</span>{active && <i />}<Codicon name="chevron-down" /></button>;
}

function CheckMenu({ title, values, selected, toggle, clear }: { title: string; values: Array<{ id: string; label: string; color?: string; detail?: string }>; selected: Set<string>; toggle: (value: string) => void; clear: () => void }) {
  const { t } = useI18n();
  return <div className="filter-popover"><header><strong>{title}</strong><button disabled={!selected.size} onClick={clear}>{t('Clear')}</button></header><div className="filter-options">
    {values.map((value) => <label key={value.id}><input type="checkbox" checked={selected.has(value.id)} onChange={() => toggle(value.id)} />{value.color && <i style={{ background: value.color }} />}<span>{value.label}{value.detail && <small>{value.detail}</small>}</span></label>)}
  </div></div>;
}

function DateMenu({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (value: string) => void; setTo: (value: string) => void }) {
  const { t } = useI18n();
  return <div className="filter-popover date-popover"><header><strong>{t('Date range')}</strong><button disabled={!from && !to} onClick={() => { setFrom(''); setTo(''); }}>{t('Clear')}</button></header><label><span>{t('From')}</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label><span>{t('To')}</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></div>;
}


function BranchSidebar({ repoFilter, refFilter, onRepoFilter, onRefFilter }: { repoFilter: Set<string>; refFilter: Set<string>; onRepoFilter: (repoId: string) => void; onRefFilter: (ref: string) => void }) {
  const repos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const tagsByRepo = useAppStore((state) => state.tagsByRepo);
  const selectRepo = useAppStore((state) => state.selectRepo);
  const branchOperation = useAppStore((state) => state.branchOperation);
  const tagOperation = useAppStore((state) => state.tagOperation);
  const [expanded, setExpanded] = useState({ local: true, remote: true, tags: true, localOther: false, remoteOther: false });
  const [filter, setFilter] = useState('');
  const { t } = useI18n();
  const visibleRepos = repoFilter.size ? repos.filter((repo) => repoFilter.has(repo.meta.id)) : repos;
  const localAll = mergeBranches(visibleRepos, branchesByRepo, false);
  const remoteAll = mergeBranches(visibleRepos, branchesByRepo, true);
  const local = localAll.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()));
  const remote = remoteAll.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()));
  const localGroups = splitVisibleBranches(local, Boolean(filter));
  const remoteGroups = splitVisibleBranches(remote, Boolean(filter));
  const tagsAll = useMemo(() => {
    const values = new Map<string, Array<{ repo: RepositoryStatus; tag: TagInfo }>>();
    for (const repo of visibleRepos) for (const tag of tagsByRepo[repo.meta.id] ?? []) values.set(tag.name, [...(values.get(tag.name) ?? []), { repo, tag }]);
    return [...values.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tagsByRepo, visibleRepos]);
  const tags = tagsAll.filter(([name]) => name.toLowerCase().includes(filter.toLowerCase()));
  const runBranch = async (entry: MergedBranch, operation: object) => {
    const instance = entry.instances.find((item) => item.branch.current) ?? entry.instances[0];
    await selectRepo(instance.repoId);
    await branchOperation(operation, instance.repoId);
  };
  const create = async () => { const repo = visibleRepos[0]; const name = prompt(`${t('Branch')}:`); if (repo && name) await branchOperation({ type: 'create', name, from: null }, repo.meta.id); };
  const createTag = async () => { const repo = visibleRepos[0]; const name = prompt(`${t('Tags')}:`); if (repo && name) await tagOperation({ type: 'create', name, revision: null }, repo.meta.id); };

  return <aside className="branch-sidebar">
    <div className="branch-search"><Codicon name="filter" /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t('Filter branches and tags')} />{filter && <button onClick={() => setFilter('')}><Codicon name="close" /></button>}</div>
    <div className="branch-repo-list">{repos.map((repo) => <button key={repo.meta.id} className={repoFilter.has(repo.meta.id) ? 'selected' : ''} onClick={() => onRepoFilter(repo.meta.id)}><i style={{ background: repo.meta.color }} /><span>{repo.meta.name}</span><small>{repo.branch || `r${repo.revision}`}</small></button>)}</div>
    <BranchGroup icon="git-branch" title={t('Local')} count={localAll.length} open={expanded.local} toggle={() => setExpanded({ ...expanded, local: !expanded.local })} action={create}>
      {localGroups.primary.map((entry) => <MergedBranchRow key={entry.name} entry={entry} selected={refFilter.has(entry.name)} select={() => onRefFilter(entry.name)} checkout={() => void runBranch(entry, { type: 'checkout', name: entry.instances[0].branch.name })} />)}
      {!!localGroups.other.length && <OtherBranches open={expanded.localOther} toggle={() => setExpanded({ ...expanded, localOther: !expanded.localOther })} count={localGroups.other.length}>{localGroups.other.map((entry) => <MergedBranchRow key={entry.name} entry={entry} selected={refFilter.has(entry.name)} select={() => onRefFilter(entry.name)} checkout={() => void runBranch(entry, { type: 'checkout', name: entry.instances[0].branch.name })} />)}</OtherBranches>}
    </BranchGroup>
    <BranchGroup icon="cloud" title={t('Remote')} count={remoteAll.length} open={expanded.remote} toggle={() => setExpanded({ ...expanded, remote: !expanded.remote })}>
      {remoteGroups.primary.map((entry) => <MergedBranchRow key={entry.name} entry={entry} selected={refFilter.has(entry.name)} select={() => onRefFilter(entry.name)} checkout={() => void runBranch(entry, { type: 'checkout', name: entry.instances[0].branch.name })} />)}
      {!!remoteGroups.other.length && <OtherBranches open={expanded.remoteOther} toggle={() => setExpanded({ ...expanded, remoteOther: !expanded.remoteOther })} count={remoteGroups.other.length}>{remoteGroups.other.map((entry) => <MergedBranchRow key={entry.name} entry={entry} selected={refFilter.has(entry.name)} select={() => onRefFilter(entry.name)} checkout={() => void runBranch(entry, { type: 'checkout', name: entry.instances[0].branch.name })} />)}</OtherBranches>}
    </BranchGroup>
    <BranchGroup icon="tag" title={t('Tags')} count={tagsAll.length} open={expanded.tags} toggle={() => setExpanded({ ...expanded, tags: !expanded.tags })} action={createTag}>
      {tags.map(([name, instances]) => <button className={`branch-leaf ${refFilter.has(name) ? 'filtered' : ''}`} key={name} onClick={() => onRefFilter(name)} onDoubleClick={() => void tagOperation({ type: 'checkout', name }, instances[0].repo.meta.id)}><Codicon name="tag" /><span>{name}</span><span className="repo-dots">{instances.map(({ repo }) => <i key={repo.meta.id} style={{ background: repo.meta.color }} />)}</span></button>)}
    </BranchGroup>
  </aside>;
}

function OtherBranches({ open, toggle, count, children }: { open: boolean; toggle: () => void; count: number; children: React.ReactNode }) {
  const { t } = useI18n();
  return <div className="other-branches"><button className="other-branches-toggle" onClick={toggle}><Codicon name={open ? 'chevron-down' : 'chevron-right'} /><span>{t('Other branches')}</span><b>{count}</b></button>{open && children}</div>;
}

function MergedBranchRow({ entry, selected, select, checkout }: { entry: MergedBranch; selected: boolean; select: () => void; checkout: () => void }) {
  const ahead = entry.instances.reduce((sum, item) => sum + item.branch.ahead, 0);
  const behind = entry.instances.reduce((sum, item) => sum + item.branch.behind, 0);
  return <button className={`merged-branch-row ${entry.current ? 'active' : ''} ${selected ? 'filtered' : ''}`} onClick={select} onDoubleClick={checkout}><Codicon name={entry.current ? 'star-full' : entry.remote ? 'cloud' : 'git-branch'} /><span>{entry.name}</span>{entry.current && <em>HEAD</em>}<span className="ahead-behind">{ahead > 0 && <b className="ahead">↑{ahead}</b>}{behind > 0 && <b className="behind">↓{behind}</b>}</span><span className="repo-dots">{entry.instances.map((item) => <i key={`${item.repoId}\0${item.branch.name}`} style={{ background: item.repo.meta.color }} />)}</span></button>;
}

function BranchGroup({ icon, title, count, open, toggle, action, children }: { icon: string; title: string; count: number; open: boolean; toggle: () => void; action?: () => void; children: React.ReactNode }) {
  return <section className="branch-group"><div className="group-title"><button onClick={toggle}><Codicon name={open ? 'chevron-down' : 'chevron-right'} /><Codicon name={icon} /><strong>{title}</strong><b>{count}</b></button>{action && <button className="section-action" onClick={() => void action()}><Codicon name="add" /></button>}</div>{open && children}</section>;
}

function refKind(ref: string) { if (ref.includes('tag:')) return 'tag'; if (ref.includes('HEAD')) return 'head'; if (ref.includes('origin/') || ref.includes('remotes/')) return 'remote'; return 'branch'; }
function refLabel(ref: string) { return ref.replace('HEAD -> ', '').replace('tag: ', '').replace('refs/heads/', '').replace('refs/remotes/', ''); }

function CommitList({ history }: { history: CommitNode[] }) {
  const parent = useRef<HTMLDivElement>(null);
  const repos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const hasMore = useAppStore((state) => state.historyHasMore);
  const selected = useAppStore((state) => state.selectedCommit?.commit.hash);
  const selectCommit = useAppStore((state) => state.selectCommit);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const commits = useMemo(() => layoutCommits(history), [history]);
  const repoColors = useMemo(() => Object.fromEntries(repos.map((repo) => [repo.meta.id, repo.meta.color])), [repos]);
  const repoNames = useMemo(() => Object.fromEntries(repos.map((repo) => [repo.meta.id, repo.meta.name])), [repos]);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: commits.length, getScrollElement: () => parent.current, estimateSize: () => COMMIT_ROW_HEIGHT, overscan: 12 });
  return <div className="commit-list" ref={parent} onScroll={(event) => { const element = event.currentTarget; if (hasMore && element.scrollHeight - element.scrollTop - element.clientHeight < 300) void loadHistory(false); }}><div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
    {virtualizer.getVirtualItems().map((item) => { const commit = commits[item.index]; const isSelected = selected === commit.hash; return <button className={`commit-row ${isSelected ? 'selected' : ''}`} key={`${commit.repoId}:${commit.hash}`} style={{ transform: `translateY(${item.start}px)` }} onClick={() => void selectCommit(commit)}>
      <span className="repo-stripe" style={{ background: repoColors[commit.repoId] ?? '#888' }} title={repoNames[commit.repoId]} /><CommitGraph commit={commit} selected={isSelected} />
      <span className="commit-subject"><span className="commit-refs">{commit.refs.map((ref) => <em className={refKind(ref)} key={ref}>{refLabel(ref)}</em>)}</span><span>{commit.message}</span></span>
      <span className="commit-author"><span className="mini-avatar">{commit.author.slice(0, 1).toUpperCase()}</span>{commit.author}</span><time>{formatDate(commit.committerDate)}</time>
    </button>; })}
  </div></div>;
}

function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); }

function DetailFileNode({ node, depth, openDiff, revision, repoId }: { node: DetailTree; depth: number; openDiff: (repoId: string, path: string, staged: boolean, revision?: string) => Promise<void>; revision: string; repoId: string }) { const [expanded, setExpanded] = useState(true); if (!node.file) return <div className="detail-tree-dir"><button style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setExpanded(!expanded)}><Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /><Codicon name={expanded ? 'folder-opened' : 'folder'} /><span>{node.name}</span><b>{node.fileCount}</b></button>{expanded && node.children.map((child) => <DetailFileNode key={child.path} node={child} depth={depth + 1} openDiff={openDiff} revision={revision} repoId={repoId} />)}</div>; const status = node.file.status.slice(0, 1).toUpperCase(); return <button className="detail-file-row" style={{ paddingLeft: 22 + depth * 14 }} onClick={() => void openDiff(repoId, node.file!.path, false, revision)}><Codicon name="file" /><span>{node.name}</span>{node.file.added !== null && <b className="added">+{node.file.added}</b>}{node.file.removed !== null && <b className="removed">−{node.file.removed}</b>}<em>{status}</em></button>; }

function CommitDetailPanel() {
  const detail = useAppStore((state) => state.selectedCommit);
  const repo = useAppStore((state) => state.snapshot?.repositories.find((item) => item.meta.id === state.selectedCommit?.commit.repoId));
  const openDiff = useAppStore((state) => state.openDiff);
  const { t } = useI18n();
  const [fileMode, setFileMode] = useState<'tree' | 'list'>('tree');
  const tree = useMemo(() => buildDetailTree(detail?.files ?? []).map(collapseDetailTree), [detail?.files]);
  if (!detail) return <aside className="commit-detail empty-detail"><Codicon name="git-commit" /><span>{t('Select a commit')}</span></aside>;
  return <aside className="commit-detail">
    <section className="detail-file-section"><div className="detail-files-title"><strong>{detail.files.length} {t('files')}</strong><span /><button className={fileMode === 'tree' ? 'selected' : ''} title={t('Tree view')} onClick={() => setFileMode('tree')}><Codicon name="list-tree" /></button><button className={fileMode === 'list' ? 'selected' : ''} title={t('List view')} onClick={() => setFileMode('list')}><Codicon name="list-flat" /></button></div><div className="detail-files">{fileMode === 'tree' ? <div className="detail-tree-root"><div className="detail-root-label"><i style={{ background: repo?.meta.color }} /><strong>{repo?.meta.name}</strong><b>{detail.files.length}</b></div>{tree.map((node) => <DetailFileNode key={node.path} node={node} depth={0} openDiff={openDiff} revision={detail.commit.hash} repoId={detail.commit.repoId} />)}</div> : detail.files.map((file) => <button key={file.path} className="detail-file-row detail-list-row" onClick={() => void openDiff(detail.commit.repoId, file.path, false, detail.commit.hash)}><Codicon name="file" /><span>{file.path}</span>{file.added !== null && <b className="added">+{file.added}</b>}{file.removed !== null && <b className="removed">−{file.removed}</b>}<em>{file.status.slice(0, 1).toUpperCase()}</em></button>)}</div></section>
    <section className="detail-summary"><header className="detail-toolbar"><span><i style={{ background: repo?.meta.color }} />{repo?.meta.name}</span><button title={t('Copy')} onClick={() => void navigator.clipboard.writeText(detail.commit.hash)}><Codicon name="copy" /></button></header><h2>{detail.commit.message}</h2><div className="commit-meta"><span className="avatar">{detail.commit.author.slice(0, 1).toUpperCase()}</span><span><strong>{detail.commit.author}</strong><small>{detail.commit.email}</small></span><time>{formatDate(detail.commit.committerDate)}</time></div><div className="detail-footer"><div className="detail-refs">{detail.commit.refs.map((ref) => <em className={refKind(ref)} key={ref}>{refLabel(ref)}</em>)}</div><code>{detail.commit.shortHash}</code></div>{detail.fullMessage !== detail.commit.message && <pre className="full-message">{detail.fullMessage}</pre>}</section>
  </aside>;
}

export function HistoryWorkspace() {
  const [tool, setTool] = useState<'compare' | 'remotes'>();
  const [menu, setMenu] = useState<FilterMenu>(null);
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
  const setFilter = useAppStore((state) => state.setHistoryFilter); const loadHistory = useAppStore((state) => state.loadHistory); const sync = useAppStore((state) => state.sync); const repo = useAppStore(selectedRepository);
  const compareEnabled = useAppStore((state) => state.bootstrap?.capabilities.compare ?? false); const remotesEnabled = useAppStore((state) => state.bootstrap?.capabilities.remoteManagement ?? false); const clearComparison = useAppStore((state) => state.clearComparison);
  const branchWidth = useAppStore((state) => state.bootstrap?.state.panelSizes.branches ?? 220); const detailWidth = useAppStore((state) => state.bootstrap?.state.panelSizes.detail ?? 360); const setPanelSize = useAppStore((state) => state.setPanelSize);
  const resizeBranches = useResizable(branchWidth, 190, 420, (value) => setPanelSize('branches', value)); const resizeDetail = useResizable(detailWidth, 300, 620, (value) => setPanelSize('detail', value), -1); const { t } = useI18n();
  const authorOptions = useMemo(() => [...new Set(allHistory.map((commit) => commit.author))].sort().map((author) => ({ id: author, label: author })), [allHistory]);
  const repoOptions = snapshotRepos.map((item) => ({ id: item.meta.id, label: item.meta.name, color: item.meta.color, detail: item.meta.kind.toUpperCase() }));
  const refOptions = useMemo(() => { const values = new Set<string>(); Object.values(branchesByRepo).flat().forEach((branch) => values.add(branch.remote && branch.name.includes('/') ? branch.name.slice(branch.name.indexOf('/') + 1) : branch.name)); Object.values(tagsByRepo).flat().forEach((tag) => values.add(tag.name)); return [...values].sort().map((value) => ({ id: value, label: value })); }, [branchesByRepo, tagsByRepo]);
  const visibleHistory = useMemo(() => allHistory.filter((commit) => {
    if (authors.size && !authors.has(commit.author)) return false; if (repos.size && !repos.has(commit.repoId)) return false;
    if (refs.size && !commit.refs.some((ref) => [...refs].some((value) => refLabel(ref) === value || refLabel(ref).endsWith(`/${value}`)))) return false;
    const date = Date.parse(commit.committerDate); if (from && date < Date.parse(`${from}T00:00:00`)) return false; if (to && date > Date.parse(`${to}T23:59:59`)) return false; return true;
  }), [allHistory, authors, from, refs, repos, to]);
  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (value: string) => setter((current) => { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; });
  if (!selectedRepoId) return <div className="workspace-empty"><Codicon name="repo" />{t('Select a repository')}</div>;
  if (tool === 'compare' && repo?.meta.kind === 'git') return <BranchComparePanel repoId={repo.meta.id} close={() => { clearComparison(); setTool(undefined); }} />;
  return <section className="history-workspace" onClick={() => menu && setMenu(null)}>
    <div className="history-filters" onClick={(event) => event.stopPropagation()}><label className="commit-search"><Codicon name="search" /><input value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void loadHistory(true); }} placeholder={t('Search commits')} />{filter && <button onClick={() => { setFilter(''); queueMicrotask(() => void loadHistory(true)); }}><Codicon name="close" /></button>}</label>
      <div className="filter-anchor"><ToggleFilter icon="person" label={authors.size ? `${t('Author')} · ${authors.size}` : t('Author')} active={!!authors.size} open={menu === 'authors'} onClick={() => setMenu(menu === 'authors' ? null : 'authors')} />{menu === 'authors' && <CheckMenu title={t('Author')} values={authorOptions} selected={authors} toggle={toggleSet(setAuthors)} clear={() => setAuthors(new Set())} />}</div>
      <div className="filter-anchor"><ToggleFilter icon="repo" label={repos.size ? `${t('Repository')} · ${repos.size}` : t('Repository')} active={!!repos.size} open={menu === 'repos'} onClick={() => setMenu(menu === 'repos' ? null : 'repos')} />{menu === 'repos' && <CheckMenu title={t('Repository')} values={repoOptions} selected={repos} toggle={toggleSet(setRepos)} clear={() => setRepos(new Set())} />}</div>
      <div className="filter-anchor"><ToggleFilter icon="git-branch" label={refs.size ? `${t('Branch')} / ${t('Tags')} · ${refs.size}` : `${t('Branch')} / ${t('Tags')}`} active={!!refs.size} open={menu === 'refs'} onClick={() => setMenu(menu === 'refs' ? null : 'refs')} />{menu === 'refs' && <CheckMenu title={`${t('Branch')} / ${t('Tags')}`} values={refOptions} selected={refs} toggle={toggleSet(setRefs)} clear={() => setRefs(new Set())} />}</div>
      <div className="filter-anchor"><ToggleFilter icon="calendar" label={from || to ? `${from || '…'} → ${to || '…'}` : t('From to')} active={!!from || !!to} open={menu === 'dates'} onClick={() => setMenu(menu === 'dates' ? null : 'dates')} />{menu === 'dates' && <DateMenu from={from} to={to} setFrom={setFrom} setTo={setTo} />}</div><span />
      {repo?.meta.kind === 'git' && compareEnabled && <button onClick={() => setTool('compare')}><Codicon name="compare-changes" />{t('Compare')}</button>}{repo?.meta.kind === 'git' && remotesEnabled && <button className={tool === 'remotes' ? 'selected' : ''} onClick={() => setTool(tool === 'remotes' ? undefined : 'remotes')}><Codicon name="remote" />{t('Remotes')}</button>}{repo?.meta.kind === 'git' ? <><button title={t('Fetch')} onClick={() => void sync(repo.meta.id, 'fetch')}><Codicon name="cloud-download" /></button><button title={t('Pull')} onClick={() => void sync(repo.meta.id, 'pull')}><Codicon name="arrow-down" /></button><button title={t('Push')} onClick={() => void sync(repo.meta.id, 'push')}><Codicon name="arrow-up" /></button></> : <button onClick={() => repo && void sync(repo.meta.id, 'update')}><Codicon name="sync" />{t('Update')}</button>}
    </div>
    {tool === 'remotes' && repo?.meta.kind === 'git' && <RemoteManager repoId={repo.meta.id} close={() => setTool(undefined)} />}
    <div className="history-columns"><div className="branch-slot" style={{ width: branchWidth }}><BranchSidebar repoFilter={repos} refFilter={refs} onRepoFilter={toggleSet(setRepos)} onRefFilter={toggleSet(setRefs)} /></div><div className="inner-resize-handle" onPointerDown={resizeBranches} /><div className="log-pane">{visibleHistory.length ? <CommitList history={visibleHistory} /> : <div className="empty-state"><Codicon name="history" />{t('No history')}</div>}</div><div className="inner-resize-handle" onPointerDown={resizeDetail} /><div className="detail-slot" style={{ width: detailWidth }}><CommitDetailPanel /></div></div>
  </section>;
}
