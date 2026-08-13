import { useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import type { FileChange, RepositoryStatus } from '../bindings/generated';
import { StashPanel } from './StashPanel';
import { ShelfPanel } from './ShelfPanel';
import { buildFileTree, type FileTreeNode } from './fileTree';
import { ChangelistManager } from './ChangelistManager';
import { WorktreePanel } from './WorktreePanel';

function StatusMark({ file }: { file: FileChange }) {
  const value = file.conflicted ? 'C' : file.status === 'untracked' ? 'U' : file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M';
  return <span className={`status-mark status-${file.status}`}>{value}</span>;
}

function TreeNode({ node, depth, repo, selected, toggle, onFile, onContext }: { node: FileTreeNode; depth: number; repo: RepositoryStatus; selected: Set<string>; toggle: (key: string) => void; onFile: (file: FileChange) => void; onContext: (event: React.MouseEvent, file: FileChange) => void }) {
  const [expanded, setExpanded] = useState(true);
  if (!node.file) return <div className="tree-directory"><button style={{ paddingLeft: 18 + depth * 14 }} onClick={() => setExpanded(!expanded)}><Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /><Codicon name={expanded ? 'folder-opened' : 'folder'} /><span>{node.name}</span></button>{expanded && node.children.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} repo={repo} selected={selected} toggle={toggle} onFile={onFile} onContext={onContext} />)}</div>;
  const key = `${repo.meta.id}\0${node.file.path}`;
  return <div className={`file-row ${node.file.conflicted ? 'conflicted' : ''}`} style={{ paddingLeft: 18 + depth * 14 }} onDoubleClick={() => onFile(node.file!)} onContextMenu={(event) => onContext(event, node.file!)}>
    <input aria-label={node.file.path} type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
    <button onClick={() => onFile(node.file!)}><Codicon name="file" /><span className="file-name">{node.name}</span></button>
    {node.file.staged && <span className="staged-dot" />}<StatusMark file={node.file} />
  </div>;
}

function RepoFiles({ repo, active, selected, toggle, onFile, onContext, viewMode }: { repo: RepositoryStatus; active: boolean; selected: Set<string>; toggle: (key: string) => void; onFile: (file: FileChange) => void; onContext: (event: React.MouseEvent, file: FileChange) => void; viewMode: 'tree' | 'list' }) {
  const [expanded, setExpanded] = useState(true);
  const tree = useMemo(() => buildFileTree(repo.files), [repo.files]);
  return (
    <section className={`repo-change-group ${active ? 'active' : ''}`}>
      <button className="repo-heading" onClick={() => setExpanded(!expanded)}>
        <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
        <i style={{ background: repo.meta.color }} />
        <strong>{repo.meta.name}</strong>
        <span className="branch-chip"><Codicon name="git-branch" />{repo.branch || repo.revision}</span>
        {(repo.ahead > 0 || repo.behind > 0) && <span className="repo-sync-state">{repo.ahead > 0 && `↑${repo.ahead}`}{repo.behind > 0 && ` ↓${repo.behind}`}</span>}
        <b>{repo.files.length}</b>
      </button>
      {expanded && viewMode === 'tree' && tree.map((node) => <TreeNode key={node.path} node={node} depth={0} repo={repo} selected={selected} toggle={toggle} onFile={onFile} onContext={onContext} />)}
      {expanded && viewMode === 'list' && repo.files.map((file) => {
        const key = `${repo.meta.id}\0${file.path}`;
        const parts = file.path.split('/');
        const name = parts.pop();
        return (
          <div className={`file-row ${file.conflicted ? 'conflicted' : ''}`} key={key} onDoubleClick={() => onFile(file)} onContextMenu={(event) => onContext(event, file)}>
            <input aria-label={file.path} type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
            <button onClick={() => onFile(file)}><Codicon name="file" /><span className="file-name">{name}</span><small>{parts.join('/')}</small></button>
            {file.staged && <span className="staged-dot" />}
            <StatusMark file={file} />
          </div>
        );
      })}
    </section>
  );
}

export function CommitPanel() {
  const snapshot = useAppStore((state) => state.snapshot);
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);
  const selectRepo = useAppStore((state) => state.selectRepo);
  const openDiff = useAppStore((state) => state.openDiff);
  const stage = useAppStore((state) => state.stage);
  const unstage = useAppStore((state) => state.unstage);
  const commit = useAppStore((state) => state.commit);
  const conflicts = useAppStore((state) => state.conflicts);
  const openMerge = useAppStore((state) => state.openMerge);
  const busy = useAppStore((state) => state.busy);
  const viewMode = useAppStore((state) => state.bootstrap?.state.fileViewMode === 'list' ? 'list' : 'tree');
  const setFileViewMode = useAppStore((state) => state.setFileViewMode);
  const systemOpen = useAppStore((state) => state.systemOpen);
  const externalEditor = useAppStore((state) => state.bootstrap?.state.externalEditor);
  const stashEnabled = useAppStore((state) => state.bootstrap?.capabilities.stash ?? false);
  const shelfEnabled = useAppStore((state) => state.bootstrap?.capabilities.shelf ?? false);
  const worktreeEnabled = useAppStore((state) => state.bootstrap?.capabilities.worktree ?? false);
  const stashCount = useAppStore((state) => Object.values(state.stashes).reduce((sum, items) => sum + items.length, 0));
  const shelfCount = useAppStore((state) => Object.values(state.shelves).reduce((sum, items) => sum + items.length, 0));
  const storedTab = useAppStore((state) => state.bootstrap?.state.activeTab);
  const tab = stashEnabled && storedTab === 'stash' ? 'stash' : shelfEnabled && storedTab === 'shelf' ? 'shelf' : worktreeEnabled && storedTab === 'worktree' ? 'worktree' : 'changes';
  const setTab = useAppStore((state) => state.setActiveTab);
  const changelistEnabled = useAppStore((state) => state.bootstrap?.capabilities.changelist ?? false);
  const changelists = useAppStore((state) => state.changelists);
  const changelistOperation = useAppStore((state) => state.changelistOperation);
  const [showChangelists, setShowChangelists] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [context, setContext] = useState<{ x: number; y: number; repo: RepositoryStatus; file: FileChange }>();
  const { t } = useI18n();
  const repos = snapshot?.repositories ?? [];
  const selectedByRepo = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const key of selected) { const [repoId, path] = key.split('\0'); map.set(repoId, [...(map.get(repoId) ?? []), path]); }
    return map;
  }, [selected]);
  const activeRepo = repos.find((repo) => repo.meta.id === selectedRepoId) ?? repos[0];
  const activePaths = activeRepo ? selectedByRepo.get(activeRepo.meta.id) ?? [] : [];

  const toggle = (key: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const doCommit = async (push: boolean) => {
    if (!activeRepo || !message.trim()) return;
    await commit(activeRepo.meta.id, message, amend, activePaths, push);
    setMessage(''); setSelected(new Set());
  };

  return (
    <aside className="commit-panel" onClick={() => setContext(undefined)}>
      <div className="panel-toolbar"><strong>VERSIONDOCK</strong><span /><button disabled={busy} title={t('Refresh')} onClick={() => void useAppStore.getState().refresh()}><Codicon name="refresh" /></button></div>
      <div className="commit-tabs"><button title={t('Changes')} className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}><Codicon name="git-commit" /><span>{t('Changes')}</span><b>{repos.reduce((sum, repo) => sum + repo.files.length, 0)}</b></button>{shelfEnabled && <button title={t('Shelf')} className={tab === 'shelf' ? 'active' : ''} onClick={() => setTab('shelf')}><Codicon name="archive" /><span>{t('Shelf')}</span><b>{shelfCount}</b></button>}{stashEnabled && <button title={t('Stash')} className={tab === 'stash' ? 'active' : ''} onClick={() => setTab('stash')}><Codicon name="save" /><span>{t('Stash')}</span><b>{stashCount}</b></button>}{worktreeEnabled && <button title={t('Worktrees')} className={tab === 'worktree' ? 'active' : ''} onClick={() => setTab('worktree')}><Codicon name="repo-clone" /><span>{t('Worktrees')}</span></button>}</div>
      {tab === 'worktree' ? <WorktreePanel repos={repos.filter((repo) => repo.meta.kind === 'git')} /> : tab === 'shelf' ? <ShelfPanel repos={repos.filter((repo) => repo.meta.kind === 'git')} selectedPaths={selectedByRepo} /> : tab === 'stash' ? <StashPanel repos={repos.filter((repo) => repo.meta.kind === 'git')} selectedPaths={selectedByRepo} /> : <>
      {conflicts.length > 0 && (
        <button className="conflict-banner" onClick={() => void openMerge(conflicts[0])}><Codicon name="warning" /><span><strong>{t('Resolve conflicts')}</strong><small>{conflicts.length} {t('Conflicts')}</small></span><Codicon name="chevron-right" /></button>
      )}
      <div className="changes-actions">
        <button disabled={!activeRepo || !activePaths.length || activeRepo.meta.kind !== 'git'} onClick={() => activeRepo && void stage(activeRepo.meta.id, activePaths)}><Codicon name="add" />{t('Stage')}</button>
        <button disabled={!activeRepo || !activePaths.length || activeRepo.meta.kind !== 'git'} onClick={() => activeRepo && void unstage(activeRepo.meta.id, activePaths)}><Codicon name="remove" />{t('Unstage')}</button>
        <span />
        <button className={viewMode === 'tree' ? 'selected' : ''} title={t('Tree view')} onClick={() => setFileViewMode('tree')}><Codicon name="list-tree" /></button>
        <button className={viewMode === 'list' ? 'selected' : ''} title={t('List view')} onClick={() => setFileViewMode('list')}><Codicon name="list-flat" /></button>
        {changelistEnabled && activeRepo && <button className={showChangelists ? 'selected' : ''} title={t('Changelists')} onClick={(event) => { event.stopPropagation(); setShowChangelists(!showChangelists); }}><Codicon name="list-unordered" /></button>}
      </div>
      {showChangelists && activeRepo && <ChangelistManager repoId={activeRepo.meta.id} close={() => setShowChangelists(false)} />}
      <div className="changes-scroll">
        {!repos.length && <div className="empty-state"><Codicon name="source-control" />{t('No repositories found')}</div>}
        {repos.map((repo) => <div key={repo.meta.id} onMouseDown={() => void selectRepo(repo.meta.id)}><RepoFiles repo={repo} active={repo.meta.id === activeRepo?.meta.id} selected={selected} toggle={toggle} onFile={(file) => void openDiff(repo.meta.id, file.path, file.staged)} onContext={(event, file) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY, repo, file }); }} viewMode={viewMode} /></div>)}
        {!!repos.length && repos.every((repo) => !repo.files.length) && <div className="empty-state"><Codicon name="check" />{t('No changes')}</div>}
      </div>
      <div className="commit-form">
        <div className="selected-summary"><span><i style={{ background: activeRepo?.meta.color }} />{activeRepo?.meta.name ?? t('Select a repository')}</span><b>{activePaths.length || activeRepo?.files.length || 0}</b></div>
        <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder={t('Commit message')} />
        {activeRepo?.meta.kind === 'git' && <label className="amend"><input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} />Amend</label>}
        <div className="commit-buttons">
          <button disabled={!message.trim() || !activeRepo || busy} onClick={() => void doCommit(false)}><Codicon name="check" />{t('Commit')}</button>
          {activeRepo?.meta.kind === 'git' && <button disabled={!message.trim() || busy} onClick={() => void doCommit(true)}><Codicon name="cloud-upload" />{t('Commit & Push')}</button>}
        </div>
      </div>
      {context && <div className="context-menu" style={{ left: context.x, top: context.y }} onClick={(event) => event.stopPropagation()}>
        <button onClick={() => { void openDiff(context.repo.meta.id, context.file.path, context.file.staged); setContext(undefined); }}><Codicon name="diff" />{t('Diff')}</button>
        <button onClick={() => { void systemOpen(context.repo.meta.id, context.file.path, false); setContext(undefined); }}><Codicon name="go-to-file" />{t('Open')}</button>
        {externalEditor && <button onClick={() => { void systemOpen(context.repo.meta.id, context.file.path, false, true); setContext(undefined); }}><Codicon name="code" />{t('Open in external editor')}</button>}
        <button onClick={() => { void systemOpen(context.repo.meta.id, context.file.path, true); setContext(undefined); }}><Codicon name="folder-opened" />{t('Reveal')}</button>
        {context.repo.meta.kind === 'git' && <><i /><button onClick={() => { void stage(context.repo.meta.id, [context.file.path]); setContext(undefined); }}><Codicon name="add" />{t('Stage')}</button><button onClick={() => { void unstage(context.repo.meta.id, [context.file.path]); setContext(undefined); }}><Codicon name="remove" />{t('Unstage')}</button></>}
        {changelistEnabled && <><i /><span className="context-label">{t('Move to changelist')}</span>{(changelists[context.repo.meta.id] ?? []).map((entry) => <button key={entry.id} onClick={() => { void changelistOperation(context.repo.meta.id, { type: 'assign', changelist_id: entry.id, paths: [context.file.path] }); setContext(undefined); }}><Codicon name="list-unordered" />{entry.name}</button>)}<button onClick={() => { void changelistOperation(context.repo.meta.id, { type: 'assign', changelist_id: null, paths: [context.file.path] }); setContext(undefined); }}><Codicon name="remove" />{t('Remove from changelist')}</button></>}
      </div>}
      </>}
    </aside>
  );
}
