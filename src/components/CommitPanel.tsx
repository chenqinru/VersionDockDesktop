import { useEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import type { FileChange, RepositoryStatus } from '../bindings/generated';
import { StashPanel } from './StashPanel';
import { ShelfPanel } from './ShelfPanel';
import { buildFileTree, type FileTreeNode } from './fileTree';
import { WorktreePanel } from './WorktreePanel';
import { SubtreePanel } from './SubtreePanel';
import { PushPanel } from './PushPanel';
import { FileIcon } from './FileIcon';
import { branchColor } from './branchColor';
import { SettingsPanel } from './SettingsPanel';

const emptyRepositories: RepositoryStatus[] = [];

function StatusMark({ file }: { file: FileChange }) {
  const value = file.conflicted ? 'C' : file.status === 'untracked' ? 'U' : file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M';
  return <span className={`status-mark status-${file.status}`}>{value}</span>;
}

function SelectionCheckbox({ label, checked, indeterminate = false, disabled = false, onChange }: { label: string; checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <span className={`selection-checkbox ${checked || indeterminate ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}>
    <input ref={ref} aria-label={label} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} onClick={(event) => event.stopPropagation()} />
    {(checked || indeterminate) && <Codicon name={indeterminate ? 'remove' : 'check'} />}
  </span>;
}

type ExpansionCommand = { sequence: number; expanded: boolean };

function TreeNode({ node, depth, repo, selected, setFiles, onFile, onContext, expansion }: { node: FileTreeNode; depth: number; repo: RepositoryStatus; selected: Set<string>; setFiles: (repoId: string, paths: string[], value: boolean) => void; onFile: (file: FileChange) => void; onContext: (event: React.MouseEvent, file: FileChange) => void; expansion: ExpansionCommand }) {
  const [localExpansion, setLocalExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const expanded = localExpansion.sequence === expansion.sequence ? localExpansion.expanded : expansion.expanded;
  if (!node.file) {
    const selectedCount = node.files.filter((file) => selected.has(`${repo.meta.id}\0${file.path}`)).length;
    const allSelected = node.files.length > 0 && selectedCount === node.files.length;
    return <div className="tree-directory"><div className="directory-row" style={{ paddingLeft: 20 + depth * 20 }}><SelectionCheckbox label={node.path} checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} onChange={() => setFiles(repo.meta.id, node.files.map((file) => file.path), !allSelected)} /><button title={node.path} onClick={() => setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded })}><Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /><FileIcon name={node.name} folder open={expanded} /><span>{node.name}</span></button><b>{node.files.length}</b></div>{expanded && node.children.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} repo={repo} selected={selected} setFiles={setFiles} onFile={onFile} onContext={onContext} expansion={expansion} />)}</div>;
  }
  const key = `${repo.meta.id}\0${node.file.path}`;
  return <div className={`file-row status-${node.file.status} ${node.file.conflicted ? 'conflicted' : ''}`} style={{ paddingLeft: 20 + depth * 20 }} onDoubleClick={() => onFile(node.file!)} onContextMenu={(event) => onContext(event, node.file!)}>
    <SelectionCheckbox label={node.file.path} checked={selected.has(key)} onChange={() => setFiles(repo.meta.id, [node.file!.path], !selected.has(key))} />
    <button title={node.file.path} onClick={() => onFile(node.file!)}><FileIcon name={node.name} /><span className="file-name-group"><span className="file-name">{node.name}</span></span></button>
    {node.file.staged && <span className="staged-dot" />}<StatusMark file={node.file} />
  </div>;
}

function RepoFiles({ repo, selected, setFiles, onFile, onContext, viewMode, expansion }: { repo: RepositoryStatus; selected: Set<string>; setFiles: (repoId: string, paths: string[], value: boolean) => void; onFile: (file: FileChange) => void; onContext: (event: React.MouseEvent, file: FileChange) => void; viewMode: 'tree' | 'list'; expansion: ExpansionCommand }) {
  const { t } = useI18n();
  const [localExpansion, setLocalExpansion] = useState<ExpansionCommand>(() => ({ sequence: 0, expanded: repo.files.length > 0 }));
  const previousFileCount = useRef(repo.files.length);
  const expanded = localExpansion.sequence === expansion.sequence ? localExpansion.expanded : expansion.expanded;
  useEffect(() => {
    if (previousFileCount.current === 0 && repo.files.length > 0) {
      setLocalExpansion((current) => ({ sequence: Math.max(current.sequence, expansion.sequence) + 1, expanded: true }));
    }
    previousFileCount.current = repo.files.length;
  }, [expansion.sequence, repo.files.length]);
  const tree = useMemo(() => buildFileTree(repo.files), [repo.files]);
  const selectedCount = repo.files.filter((file) => selected.has(`${repo.meta.id}\0${file.path}`)).length;
  const allSelected = repo.files.length > 0 && selectedCount === repo.files.length;
  const branch = branchColor(repo.branch || repo.revision);
  return (
    <section className="repo-change-group">
      <div className="repo-heading" style={{ background: `color-mix(in srgb, ${repo.meta.color} 18%, var(--versiondock-surface))` }}>
        <SelectionCheckbox label={repo.meta.name} checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} disabled={!repo.files.length} onChange={() => setFiles(repo.meta.id, repo.files.map((file) => file.path), !allSelected)} />
        <button title={repo.meta.name} onClick={() => setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded })}><Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /><i style={{ background: repo.meta.color }} /><strong>{repo.meta.name}</strong><span className="branch-chip" title={repo.branch || repo.revision} style={{ color: branch, background: `${branch}33`, borderColor: `${branch}88` }}><Codicon name="git-branch" /><span className="branch-name">{repo.branch || repo.revision}</span></span></button>
        {(repo.ahead > 0 || repo.behind > 0) && <span className="repo-sync-state">{repo.ahead > 0 && `↑${repo.ahead}`}{repo.behind > 0 && ` ↓${repo.behind}`}</span>}
        {repo.files.length > 0 && <b>{selectedCount}/{repo.files.length}</b>}
      </div>
      {expanded && !repo.files.length && <div className="repo-no-changes">{t('No changes')}</div>}
      {expanded && viewMode === 'tree' && tree.map((node) => <TreeNode key={node.path} node={node} depth={0} repo={repo} selected={selected} setFiles={setFiles} onFile={onFile} onContext={onContext} expansion={expansion} />)}
      {expanded && viewMode === 'list' && repo.files.map((file) => {
        const key = `${repo.meta.id}\0${file.path}`;
        const parts = file.path.split('/');
        const name = parts.pop();
        return (
          <div className={`file-row status-${file.status} ${file.conflicted ? 'conflicted' : ''}`} style={{ paddingLeft: 20 }} key={key} onDoubleClick={() => onFile(file)} onContextMenu={(event) => onContext(event, file)}>
            <SelectionCheckbox label={file.path} checked={selected.has(key)} onChange={() => setFiles(repo.meta.id, [file.path], !selected.has(key))} />
            <button title={file.path} onClick={() => onFile(file)}><FileIcon name={name ?? file.path} /><span className="file-name-group"><span className="file-name">{name}</span><small>{parts.join('/')}</small></span></button>
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
  const selectRepo = useAppStore((state) => state.selectRepo);
  const openDiff = useAppStore((state) => state.openDiff);
  const stage = useAppStore((state) => state.stage);
  const unstage = useAppStore((state) => state.unstage);
  const discard = useAppStore((state) => state.discard);
  const commitMany = useAppStore((state) => state.commitMany);
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
  const subtreeEnabled = useAppStore((state) => state.bootstrap?.capabilities.subtree ?? false);
  const stashCount = useAppStore((state) => Object.values(state.stashes).reduce((sum, items) => sum + items.length, 0));
  const shelfCount = useAppStore((state) => Object.values(state.shelves).reduce((sum, items) => sum + items.length, 0));
  const subtreeCount = useAppStore((state) => Object.values(state.subtrees).reduce((sum, items) => sum + items.length, 0));
  const storedTab = useAppStore((state) => state.bootstrap?.state.activeTab);
  const pushEnabled = snapshot?.repositories.some((repo) => repo.meta.kind === 'git') ?? false;
  const tab = pushEnabled && storedTab === 'push' ? 'push' : stashEnabled && storedTab === 'stash' ? 'stash' : shelfEnabled && storedTab === 'shelf' ? 'shelf' : worktreeEnabled && storedTab === 'worktree' ? 'worktree' : subtreeEnabled && storedTab === 'subtree' ? 'subtree' : 'changes';
  const setTab = useAppStore((state) => state.setActiveTab);
  const changelistEnabled = useAppStore((state) => state.bootstrap?.capabilities.changelist ?? false);
  const changelists = useAppStore((state) => state.changelists);
  const changelistOperation = useAppStore((state) => state.changelistOperation);
  const [selected, setSelected] = useState(new Set<string>());
  const [message, setMessage] = useState('');
  const [amendRepos, setAmendRepos] = useState(new Set<string>());
  const [commitMenu, setCommitMenu] = useState(false);
  const [saveMenu, setSaveMenu] = useState(false);
  const [viewMenu, setViewMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const [expansion, setExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const [shelfViewMode, setShelfViewMode] = useState<'tree' | 'list'>('tree');
  const [shelfExpansion, setShelfExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: false });
  const [stashExpansion, setStashExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: false });
  const [textareaHeight, setTextareaHeight] = useState(54);
  const [context, setContext] = useState<{ x: number; y: number; repo: RepositoryStatus; file: FileChange }>();
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  const commitMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const repos = snapshot?.repositories ?? emptyRepositories;
  const totalChanges = repos.reduce((sum, repo) => sum + repo.files.length, 0);
  const gitRepos = useMemo(() => repos.filter((repo) => repo.meta.kind === 'git'), [repos]);
  const selectedByRepo = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const key of selected) { const [repoId, path] = key.split('\0'); map.set(repoId, [...(map.get(repoId) ?? []), path]); }
    return map;
  }, [selected]);
  const commitTargets = repos.filter((repo) => (selectedByRepo.get(repo.meta.id)?.length ?? 0) > 0);
  const setFiles = (repoId: string, paths: string[], value: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const path of paths) {
      const key = `${repoId}\0${path}`;
      if (value) next.add(key); else next.delete(key);
    }
    return next;
  });
  const doCommit = async (push: boolean) => {
    if (!message.trim() || !commitTargets.length) return;
    await commitMany(commitTargets.map((repo) => {
      const paths = selectedByRepo.get(repo.meta.id) ?? [];
      return {
        repoId: repo.meta.id,
        paths,
        unstagePaths: repo.files.filter((file) => file.staged && !paths.includes(file.path)).map((file) => file.path),
        amend: amendRepos.has(repo.meta.id),
      };
    }), message, push);
    setMessage(''); setSelected(new Set());
  };
  const doSave = async (kind: 'stash' | 'shelf') => {
    for (const repo of commitTargets.filter((item) => item.meta.kind === 'git')) {
      const paths = selectedByRepo.get(repo.meta.id) ?? [];
      if (kind === 'stash') await useAppStore.getState().stashOperation(repo.meta.id, { type: 'create', message: message.trim() || t('WIP stash'), paths, include_untracked: true });
      else await useAppStore.getState().shelfOperation(repo.meta.id, { type: 'create', name: message.trim() || t('WIP shelf'), paths });
    }
  };
  const discardAll = async () => {
    const total = repos.reduce((sum, repo) => sum + repo.files.length, 0);
    if (!total || !confirm(t('Discard changes to {0} files? This cannot be undone.', total))) return;
    for (const repo of repos) await discard(repo.meta.id, repo.files.map((file) => file.path));
    setSelected(new Set());
  };
  const startTextareaResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = textareaHeight;
    const move = (moveEvent: PointerEvent) => setTextareaHeight(Math.max(52, Math.min(window.innerHeight * 0.55, startHeight + startY - moveEvent.clientY)));
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  useEffect(() => {
    if (!commitMenu && !saveMenu && !viewMenu && !context) return;
    const handleOutsideInteraction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (context && !contextMenuRef.current?.contains(target)) setContext(undefined);
      if (viewMenu && !viewMenuRef.current?.contains(target)) setViewMenu(false);
      if (saveMenu && !saveMenuRef.current?.contains(target)) setSaveMenu(false);
      if (commitMenu && !commitMenuRef.current?.contains(target)) setCommitMenu(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setContext(undefined);
      setViewMenu(false);
      setSaveMenu(false);
      setCommitMenu(false);
    };
    document.addEventListener('pointerdown', handleOutsideInteraction, true);
    document.addEventListener('focusin', handleOutsideInteraction, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutsideInteraction, true);
      document.removeEventListener('focusin', handleOutsideInteraction, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [commitMenu, context, saveMenu, viewMenu]);

  return (
    <aside className="commit-panel" onClick={() => setContext(undefined)}>
      <div className="panel-toolbar"><strong title={t('VersionDock Commit')}>{t('VersionDock Commit')}</strong><span /><button disabled={busy} title={t('Fetch')} onClick={() => void Promise.all(gitRepos.map((repo) => useAppStore.getState().sync(repo.meta.id, 'fetch')))}><Codicon name="cloud-download" /></button><button disabled={busy} title={t('Refresh')} onClick={() => void useAppStore.getState().refresh()}><Codicon name="refresh" /></button><button className={settings ? 'selected' : ''} title={t('Settings')} aria-label={t('Settings')} onClick={() => setSettings(!settings)}><Codicon name="settings-gear" /></button></div>
      {settings && <SettingsPanel onClose={() => setSettings(false)} />}
      <div className="commit-commandbar"><button disabled={busy} title={t('Refresh')} onClick={() => void useAppStore.getState().refresh()}><Codicon name="refresh" /></button>{tab === 'changes' && <><button disabled={!repos.some((repo) => repo.files.length) || busy} title={t('Rollback')} onClick={() => void discardAll()}><Codicon name="discard" /></button><button title={t('Expand all')} onClick={() => setExpansion((current) => ({ sequence: current.sequence + 1, expanded: true }))}><Codicon name="expand-all" /></button><button title={t('Collapse all')} onClick={() => setExpansion((current) => ({ sequence: current.sequence + 1, expanded: false }))}><Codicon name="collapse-all" /></button><div ref={viewMenuRef} className="view-options"><button title={t('View options')} className={viewMenu ? 'selected' : ''} onClick={(event) => { event.stopPropagation(); setViewMenu((value) => !value); }}><Codicon name="eye" /></button>{viewMenu && <div className="view-options-menu" onClick={(event) => event.stopPropagation()}><strong>{t('View')}</strong><button className={viewMode === 'list' ? 'selected' : ''} onClick={() => { setFileViewMode('list'); setViewMenu(false); }}><Codicon name="list-unordered" />{t('List view')}{viewMode === 'list' && <Codicon name="check" />}</button><button className={viewMode === 'tree' ? 'selected' : ''} onClick={() => { setFileViewMode('tree'); setViewMenu(false); }}><Codicon name="list-tree" />{t('Tree view')}{viewMode === 'tree' && <Codicon name="check" />}</button></div>}</div></>}{tab === 'shelf' && <><button title={t('Expand all')} onClick={() => setShelfExpansion((current) => ({ sequence: current.sequence + 1, expanded: true }))}><Codicon name="expand-all" /></button><button title={t('Collapse all')} onClick={() => setShelfExpansion((current) => ({ sequence: current.sequence + 1, expanded: false }))}><Codicon name="collapse-all" /></button><div ref={viewMenuRef} className="view-options"><button title={t('View options')} className={viewMenu ? 'selected' : ''} onClick={(event) => { event.stopPropagation(); setViewMenu((value) => !value); }}><Codicon name="eye" /></button>{viewMenu && <div className="view-options-menu" onClick={(event) => event.stopPropagation()}><strong>{t('View')}</strong><button className={shelfViewMode === 'list' ? 'selected' : ''} onClick={() => { setShelfViewMode('list'); setViewMenu(false); }}><Codicon name="list-unordered" />{t('List view')}{shelfViewMode === 'list' && <Codicon name="check" />}</button><button className={shelfViewMode === 'tree' ? 'selected' : ''} onClick={() => { setShelfViewMode('tree'); setViewMenu(false); }}><Codicon name="list-tree" />{t('Tree view')}{shelfViewMode === 'tree' && <Codicon name="check" />} </button></div>}</div></>}{tab === 'stash' && <><button title={t('Expand all')} onClick={() => setStashExpansion((current) => ({ sequence: current.sequence + 1, expanded: true }))}><Codicon name="expand-all" /></button><button title={t('Collapse all')} onClick={() => setStashExpansion((current) => ({ sequence: current.sequence + 1, expanded: false }))}><Codicon name="collapse-all" /></button></>}<span /></div>
      <div className="commit-tabs"><button title={t('Changes')} className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}><Codicon name="source-control" />{tab === 'changes' && <span>{t('Changes')}</span>}{totalChanges > 0 && <b>{totalChanges}</b>}</button>{shelfEnabled && <button title={t('Shelf')} className={tab === 'shelf' ? 'active' : ''} onClick={() => setTab('shelf')}><Codicon name="archive" />{tab === 'shelf' && <span>{t('Shelf')}</span>}{shelfCount > 0 && <b>{shelfCount}</b>}</button>}{stashEnabled && <button title={t('Stash')} className={tab === 'stash' ? 'active' : ''} onClick={() => setTab('stash')}><Codicon name="save" />{tab === 'stash' && <span>{t('Stash')}</span>}{stashCount > 0 && <b>{stashCount}</b>}</button>}{worktreeEnabled && <button title={t('Worktrees')} className={tab === 'worktree' ? 'active' : ''} onClick={() => setTab('worktree')}><Codicon name="worktree" />{tab === 'worktree' && <span>{t('Worktrees')}</span>}</button>}{subtreeEnabled && <button title={t('Subtree')} className={tab === 'subtree' ? 'active' : ''} onClick={() => setTab('subtree')}><Codicon name="repo" />{tab === 'subtree' && <span>{t('Subtree')}</span>}{subtreeCount > 0 && <b>{subtreeCount}</b>}</button>}{gitRepos.length > 0 && <button title={t('Push')} className={tab === 'push' ? 'active' : ''} onClick={() => setTab('push')}><Codicon name="cloud-upload" />{tab === 'push' && <span>{t('Push')}</span>}{gitRepos.reduce((sum, repo) => sum + repo.ahead, 0) > 0 && <b>{gitRepos.reduce((sum, repo) => sum + repo.ahead, 0)}</b>}</button>}</div>
      {tab === 'push' ? <PushPanel repos={gitRepos} /> : tab === 'subtree' ? <SubtreePanel repos={gitRepos} /> : tab === 'worktree' ? <WorktreePanel repos={gitRepos} /> : tab === 'shelf' ? <ShelfPanel repos={gitRepos} selectedPaths={selectedByRepo} viewMode={shelfViewMode} expansion={shelfExpansion} /> : tab === 'stash' ? <StashPanel repos={gitRepos} selectedPaths={selectedByRepo} viewMode={viewMode} expansion={stashExpansion} onOpenFileDiff={(repoId, reference, path) => void openDiff(repoId, path, false)} /> : <>
      {conflicts.length > 0 && (
        <button className="conflict-banner" onClick={() => void openMerge(conflicts[0])}><Codicon name="warning" /><span><strong>{t('Resolve conflicts')}</strong><small>{conflicts.length} {t('Conflicts')}</small></span><Codicon name="chevron-right" /></button>
      )}
      <div className="changes-scroll">
        {!repos.length && <div className="empty-state"><Codicon name="source-control" />{t('No repositories found')}</div>}
        {repos.map((repo) => <div key={repo.meta.id} onMouseDown={() => void selectRepo(repo.meta.id)}><RepoFiles repo={repo} selected={selected} setFiles={setFiles} onFile={(file) => void openDiff(repo.meta.id, file.path, file.staged)} onContext={(event, file) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY, repo, file }); }} viewMode={viewMode} expansion={expansion} /></div>)}
      </div>
      <div className="commit-form">
        <div className="commit-resize-grip" role="separator" aria-label={t('Resize commit message')} aria-orientation="horizontal" onPointerDown={startTextareaResize}><i /></div>
        {repos.length > 1 && <div className="commit-targets">{commitTargets.length === 0 ? <span>{t('No files selected')}</span> : commitTargets.map((repo) => <em key={repo.meta.id} style={{ color: repo.meta.color, background: `${repo.meta.color}28`, borderColor: `${repo.meta.color}60` }}><button title={t('Remove {0}', repo.meta.name)} onClick={() => setFiles(repo.meta.id, repo.files.map((file) => file.path), false)}><Codicon name="close" /></button>{repo.meta.name}<b>{selectedByRepo.get(repo.meta.id)?.length}</b></em>)}</div>}
        {commitTargets.length === 1 && commitTargets[0].meta.kind === 'git' && <div className="commit-options"><label title={t('Amend')}><input type="checkbox" checked={amendRepos.has(commitTargets[0].meta.id)} onChange={() => setAmendRepos((current) => { const next = new Set(current); if (next.has(commitTargets[0].meta.id)) next.delete(commitTargets[0].meta.id); else next.add(commitTargets[0].meta.id); return next; })} />{t('Amend')}</label></div>}
        <textarea style={{ height: textareaHeight }} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`${t('Commit message')} (Cmd+Enter ${t('Commit')})`} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void doCommit(false); }} />
        <div className="commit-actions">
          <div ref={saveMenuRef} className="split-button save-action"><button disabled={!message.trim() || !commitTargets.length || busy} onClick={() => void doSave('stash')}><Codicon name="save" />{t('Stash')}</button><button disabled={!message.trim() || !commitTargets.length || busy} onClick={() => { setSaveMenu((value) => !value); setCommitMenu(false); }}><Codicon name="chevron-down" /></button>{saveMenu && <div className="split-menu"><button onClick={() => { void doSave('stash'); setSaveMenu(false); }}><Codicon name="save" />{t('Stash changes')}</button><button onClick={() => { void doSave('shelf'); setSaveMenu(false); }}><Codicon name="archive" />{t('Shelve changes')}</button></div>}</div>
          <div ref={commitMenuRef} className="split-button commit-action"><button disabled={!message.trim() || !commitTargets.length || busy} onClick={() => void doCommit(false)}><Codicon name="check" />{t('Commit')}</button><button disabled={!message.trim() || !commitTargets.length || busy} onClick={() => { setCommitMenu((value) => !value); setSaveMenu(false); }}><Codicon name="chevron-down" /></button>{commitMenu && <div className="split-menu right"><button onClick={() => { void doCommit(false); setCommitMenu(false); }}><Codicon name="check" />{t('Commit')}</button><button onClick={() => { void doCommit(true); setCommitMenu(false); }}><Codicon name="cloud-upload" />{t('Commit & Push')}</button></div>}</div>
        </div>
      </div>
      {context && <div ref={contextMenuRef} className="context-menu" style={{ left: context.x, top: context.y }} onClick={(event) => event.stopPropagation()}>
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
