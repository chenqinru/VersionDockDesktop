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
import type { CommitFile } from '../bindings/generated';

function BranchSidebar() {
  const repo = useAppStore(selectedRepository);
  const branches = useAppStore((state) => state.branches);
  const tags = useAppStore((state) => state.tags);
  const branchOperation = useAppStore((state) => state.branchOperation);
  const tagOperation = useAppStore((state) => state.tagOperation);
  const [expanded, setExpanded] = useState({ local: true, remote: true, tags: true });
  const [filter, setFilter] = useState('');
  const { t } = useI18n();
  const visibleBranches = branches.filter((branch) => branch.name.toLowerCase().includes(filter.toLowerCase()));
  const visibleTags = tags.filter((tag) => tag.name.toLowerCase().includes(filter.toLowerCase()));
  const checkout = async (name: string) => { if (confirm(t('Checkout branch {0}?', name))) await branchOperation({ type: 'checkout', name }); };
  const create = async () => { const name = prompt(`${t('Branch')}:`); if (name) await branchOperation({ type: 'create', name, from: null }); };
  const rename = async (name: string) => { const next = prompt(`${t('Branch')}:`, name); if (next && next !== name) await branchOperation({ type: 'rename', old_name: name, new_name: next }); };
  const remove = async (name: string, force = false) => { if (confirm(force ? `${t('Force delete branch')}: ${name}?` : t('Delete branch {0}?', name))) await branchOperation({ type: 'delete', name, force }); };
  const createTag = async () => { const name = prompt(`${t('Tags')}:`); if (name) await tagOperation({ type: 'create', name, revision: null }); };

  return <aside className="branch-sidebar">
    <div className="branch-search"><Codicon name="filter" /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={`${t('Branch')} / ${t('Tags')}…`} /></div>
    {repo && <button className="branch-repo-row"><i style={{ background: repo.meta.color }} /><strong>{repo.meta.name}</strong><small>{repo.meta.kind.toUpperCase()}</small></button>}
    {repo?.meta.kind !== 'git' ? <div className="svn-branch"><Codicon name="repo" /><strong>{repo?.branch}</strong><small>r{repo?.revision}</small></div> : <>
      <BranchGroup icon="git-branch" title={t('Local')} count={visibleBranches.filter((branch) => !branch.remote).length} open={expanded.local} toggle={() => setExpanded({ ...expanded, local: !expanded.local })} action={() => void create()}>
        {visibleBranches.filter((branch) => !branch.remote).map((branch) => <div className={`branch-item ${branch.current ? 'active' : ''}`} key={branch.name}>
          <button onDoubleClick={() => void checkout(branch.name)}><Codicon name={branch.current ? 'star-full' : 'git-branch'} /><span>{branch.name}</span>{branch.current && <em>HEAD</em>}<span className="ahead-behind">{branch.ahead > 0 && <b className="ahead">↑{branch.ahead}</b>}{branch.behind > 0 && <b className="behind">↓{branch.behind}</b>}</span></button>
          <button title={t('Rename')} onClick={() => void rename(branch.name)}><Codicon name="edit" /></button>{!branch.current && <button title={t('Delete')} onClick={(event) => void remove(branch.name, event.shiftKey)}><Codicon name="trash" /></button>}
        </div>)}
      </BranchGroup>
      <BranchGroup icon="cloud" title={t('Remote')} count={visibleBranches.filter((branch) => branch.remote).length} open={expanded.remote} toggle={() => setExpanded({ ...expanded, remote: !expanded.remote })}>
        {visibleBranches.filter((branch) => branch.remote).map((branch) => <button className="branch-leaf" key={branch.name} onDoubleClick={() => void checkout(branch.name)}><Codicon name="cloud" /><span>{branch.name}</span></button>)}
      </BranchGroup>
      <BranchGroup icon="tag" title={t('Tags')} count={visibleTags.length} open={expanded.tags} toggle={() => setExpanded({ ...expanded, tags: !expanded.tags })} action={() => void createTag()}>
        {visibleTags.map((tag) => <div className="branch-item" key={tag.name}><button onDoubleClick={() => void tagOperation({ type: 'checkout', name: tag.name })}><Codicon name="tag" /><span>{tag.name}</span></button><button title={t('Push')} onClick={() => { const remote = prompt(`${t('Remote')}:`, 'origin'); if (remote) void tagOperation({ type: 'push', name: tag.name, remote }); }}><Codicon name="cloud-upload" /></button><button title={t('Delete')} onClick={() => { if (confirm(t('Delete tag {0}?', tag.name))) void tagOperation({ type: 'delete', name: tag.name }); }}><Codicon name="trash" /></button></div>)}
      </BranchGroup>
    </>}
  </aside>;
}

function BranchGroup({ icon, title, count, open, toggle, action, children }: { icon: string; title: string; count: number; open: boolean; toggle: () => void; action?: () => void; children: React.ReactNode }) {
  return <section className="branch-group"><div className="group-title"><button onClick={toggle}><Codicon name={open ? 'chevron-down' : 'chevron-right'} /><Codicon name={icon} /><strong>{title}</strong><b>{count}</b></button>{action && <button className="section-action" onClick={action}><Codicon name="add" /></button>}</div>{open && children}</section>;
}

function refKind(ref: string) {
  if (ref.includes('tag:')) return 'tag';
  if (ref.includes('HEAD')) return 'head';
  if (ref.includes('origin/') || ref.includes('remotes/')) return 'remote';
  return 'branch';
}

function refLabel(ref: string) {
  return ref.replace('HEAD -> ', '').replace('tag: ', '').replace('refs/heads/', '').replace('refs/remotes/', '');
}

function CommitList() {
  const parent = useRef<HTMLDivElement>(null);
  const history = useAppStore((state) => state.history);
  const repos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const hasMore = useAppStore((state) => state.historyHasMore);
  const selected = useAppStore((state) => state.selectedCommit?.commit.hash);
  const selectCommit = useAppStore((state) => state.selectCommit);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const commits = useMemo(() => layoutCommits(history), [history]);
  const repoColors = useMemo(() => Object.fromEntries(repos.map((repo) => [repo.meta.id, repo.meta.color])), [repos]);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: commits.length, getScrollElement: () => parent.current, estimateSize: () => COMMIT_ROW_HEIGHT, overscan: 12 });
  return <div className="commit-list" ref={parent} onScroll={(event) => {
    const element = event.currentTarget;
    if (hasMore && element.scrollHeight - element.scrollTop - element.clientHeight < 300) void loadHistory(false);
  }}><div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
    {virtualizer.getVirtualItems().map((item) => {
      const commit = commits[item.index];
      const isSelected = selected === commit.hash;
      return <button className={`commit-row ${isSelected ? 'selected' : ''}`} key={`${commit.repoId}:${commit.hash}`} style={{ transform: `translateY(${item.start}px)` }} onClick={() => void selectCommit(commit)}>
        <span className="repo-stripe" style={{ background: repoColors[commit.repoId] ?? '#888' }} />
        <CommitGraph commit={commit} selected={isSelected} />
        <span className="commit-subject"><span className="commit-refs">{commit.refs.map((ref) => <em className={refKind(ref)} key={ref}>{refLabel(ref)}</em>)}</span><span>{commit.message}</span></span>
        <span className="commit-author"><span className="mini-avatar">{commit.author.slice(0, 1).toUpperCase()}</span>{commit.author}</span>
        <time>{formatRelative(commit.committerDate)}</time>
      </button>;
    })}
  </div></div>;
}

function formatRelative(value: string) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

type DetailTree = { name: string; path: string; children: DetailTree[]; file?: CommitFile };
function buildDetailTree(files: CommitFile[]) {
  const root: DetailTree[] = [];
  files.forEach((file) => {
    let nodes = root;
    const parts = file.path.split('/');
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let node = nodes.find((item) => item.name === name);
      if (!node) { node = { name, path, children: [] }; nodes.push(node); }
      if (index === parts.length - 1) node.file = file;
      nodes = node.children;
    });
  });
  return root;
}

function DetailFileNode({ node, depth, openDiff, revision, repoId }: { node: DetailTree; depth: number; openDiff: (repoId: string, path: string, staged: boolean, revision?: string) => Promise<void>; revision: string; repoId: string }) {
  const [expanded, setExpanded] = useState(true);
  if (!node.file) return <div className="detail-tree-dir"><button style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setExpanded(!expanded)}><Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /><Codicon name={expanded ? 'folder-opened' : 'folder'} /><span>{node.name}</span><b>{node.children.length}</b></button>{expanded && node.children.map((child) => <DetailFileNode key={child.path} node={child} depth={depth + 1} openDiff={openDiff} revision={revision} repoId={repoId} />)}</div>;
  const status = node.file.status.slice(0, 1).toUpperCase();
  return <button className="detail-file-row" style={{ paddingLeft: 22 + depth * 14 }} onClick={() => void openDiff(repoId, node.file!.path, false, revision)}><Codicon name="file" /><span>{node.name}</span>{node.file.added !== null && <b className="added">+{node.file.added}</b>}{node.file.removed !== null && <b className="removed">−{node.file.removed}</b>}<em>{status}</em></button>;
}

function CommitDetailPanel() {
  const detail = useAppStore((state) => state.selectedCommit);
  const repo = useAppStore((state) => state.snapshot?.repositories.find((item) => item.meta.id === state.selectedCommit?.commit.repoId));
  const openDiff = useAppStore((state) => state.openDiff);
  const { t } = useI18n();
  const tree = useMemo(() => buildDetailTree(detail?.files ?? []), [detail?.files]);
  if (!detail) return <aside className="commit-detail empty-detail"><Codicon name="git-commit" /><span>{t('Select a commit')}</span></aside>;
  return <aside className="commit-detail">
    <header className="detail-toolbar"><span><i style={{ background: repo?.meta.color }} />{repo?.meta.name}</span><button title={t('Copy')} onClick={() => void navigator.clipboard.writeText(detail.commit.hash)}><Codicon name="copy" /></button></header>
    <section className="detail-summary">
      <div className="detail-hash"><Codicon name="git-commit" /><code>{detail.commit.shortHash}</code></div>
      <h2>{detail.commit.message}</h2>
      <div className="commit-meta"><span className="avatar">{detail.commit.author.slice(0, 1).toUpperCase()}</span><span><strong>{detail.commit.author}</strong><small>{detail.commit.email}</small></span><time>{formatRelative(detail.commit.committerDate)}</time></div>
      {detail.commit.refs.length > 0 && <div className="detail-refs">{detail.commit.refs.map((ref) => <em className={refKind(ref)} key={ref}>{refLabel(ref)}</em>)}</div>}
      {detail.fullMessage !== detail.commit.message && <pre className="full-message">{detail.fullMessage}</pre>}
    </section>
    <section className="detail-file-section"><div className="detail-files-title"><strong>{detail.files.length} {t('files')}</strong><span /><button className="selected"><Codicon name="list-tree" /></button><button><Codicon name="list-flat" /></button></div><div className="detail-files">{tree.map((node) => <DetailFileNode key={node.path} node={node} depth={0} openDiff={openDiff} revision={detail.commit.hash} repoId={detail.commit.repoId} />)}</div></section>
  </aside>;
}

export function HistoryWorkspace() {
  const [tool, setTool] = useState<'compare' | 'remotes'>();
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);
  const history = useAppStore((state) => state.history);
  const filter = useAppStore((state) => state.historyFilter);
  const setFilter = useAppStore((state) => state.setHistoryFilter);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const sync = useAppStore((state) => state.sync);
  const repo = useAppStore(selectedRepository);
  const compareEnabled = useAppStore((state) => state.bootstrap?.capabilities.compare ?? false);
  const remotesEnabled = useAppStore((state) => state.bootstrap?.capabilities.remoteManagement ?? false);
  const clearComparison = useAppStore((state) => state.clearComparison);
  const branchWidth = useAppStore((state) => state.bootstrap?.state.panelSizes.branches ?? 220);
  const detailWidth = useAppStore((state) => state.bootstrap?.state.panelSizes.detail ?? 360);
  const setPanelSize = useAppStore((state) => state.setPanelSize);
  const resizeBranches = useResizable(branchWidth, 170, 420, (value) => setPanelSize('branches', value));
  const resizeDetail = useResizable(detailWidth, 260, 620, (value) => setPanelSize('detail', value), -1);
  const { t } = useI18n();
  if (!selectedRepoId) return <div className="workspace-empty"><Codicon name="repo" />{t('Select a repository')}</div>;
  if (tool === 'compare' && repo?.meta.kind === 'git') return <BranchComparePanel repoId={repo.meta.id} close={() => { clearComparison(); setTool(undefined); }} />;
  return <section className="history-workspace">
    <div className="history-filters">
      <label><Codicon name="search" /><input value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void loadHistory(true); }} placeholder={t('Search commits')} /></label>
      <button className="filter-button"><Codicon name="person" />{t('Author')}<Codicon name="chevron-down" /></button><button className="filter-button"><Codicon name="repo" />{t('Repository')}<Codicon name="chevron-down" /></button><button className="filter-button"><Codicon name="git-branch" />{t('Branch')} / {t('Tags')}<Codicon name="chevron-down" /></button>
      <span />
      {repo?.meta.kind === 'git' && compareEnabled && <button onClick={() => setTool('compare')}><Codicon name="compare-changes" />{t('Compare')}</button>}
      {repo?.meta.kind === 'git' && remotesEnabled && <button className={tool === 'remotes' ? 'selected' : ''} onClick={() => setTool(tool === 'remotes' ? undefined : 'remotes')}><Codicon name="remote" />{t('Remotes')}</button>}
      {repo?.meta.kind === 'git' ? <><button title={t('Fetch')} onClick={() => void sync(repo.meta.id, 'fetch')}><Codicon name="cloud-download" /><span>{t('Fetch')}</span></button><button title={t('Pull')} onClick={() => void sync(repo.meta.id, 'pull')}><Codicon name="arrow-down" /><span>{t('Pull')}</span></button><button title={t('Push')} onClick={() => void sync(repo.meta.id, 'push')}><Codicon name="arrow-up" /><span>{t('Push')}</span></button></> : <button onClick={() => repo && void sync(repo.meta.id, 'update')}><Codicon name="sync" />{t('Update')}</button>}
    </div>
    {tool === 'remotes' && repo?.meta.kind === 'git' && <RemoteManager repoId={repo.meta.id} close={() => setTool(undefined)} />}
    <div className="history-columns"><div className="branch-slot" style={{ width: branchWidth }}><BranchSidebar /></div><div className="inner-resize-handle" onPointerDown={resizeBranches} /><div className="log-pane">{history.length ? <CommitList /> : <div className="empty-state"><Codicon name="history" />{t('No history')}</div>}</div><div className="inner-resize-handle" onPointerDown={resizeDetail} /><div className="detail-slot" style={{ width: detailWidth }}><CommitDetailPanel /></div></div>
  </section>;
}
