import { useEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { choiceDialog, confirmDialog, promptDialog } from './dialogService';
import { IdentityPanel } from './IdentityPanel';
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
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { IgnoreRulesPanel } from './IgnoreRulesPanel';
import { ChangelistManager } from './ChangelistManager';
import { BranchWorkingDiffPanel } from './BranchWorkingDiffPanel';

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
type ChangeContext = { x: number; y: number; kind: 'file' | 'folder' | 'repo'; repo: RepositoryStatus; files: FileChange[]; path?: string };

function TreeNode({ node, depth, repo, selected, setFiles, onFile, onContext, onFolderContext, expansion }: { node: FileTreeNode; depth: number; repo: RepositoryStatus; selected: Set<string>; setFiles: (repoId: string, paths: string[], value: boolean) => void; onFile: (file: FileChange) => void; onContext: (event: React.MouseEvent, file: FileChange) => void; onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[]) => void; expansion: ExpansionCommand }) {
  const [localExpansion, setLocalExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const expanded = localExpansion.sequence === expansion.sequence ? localExpansion.expanded : expansion.expanded;
  if (!node.file) {
    const selectedCount = node.files.filter((file) => selected.has(`${repo.meta.id}\0${file.path}`)).length;
    const allSelected = node.files.length > 0 && selectedCount === node.files.length;
    return <div className="tree-directory"><div className="directory-row" style={{ paddingLeft: 20 + depth * 20 }} onContextMenu={(event) => onFolderContext(event, node.path, node.files)}><SelectionCheckbox label={node.path} checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} onChange={() => setFiles(repo.meta.id, node.files.map((file) => file.path), !allSelected)} /><button title={node.path} onClick={() => setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded })}><Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /><FileIcon name={node.name} folder open={expanded} /><span>{node.name}</span></button><b>{node.files.length}</b></div>{expanded && node.children.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} repo={repo} selected={selected} setFiles={setFiles} onFile={onFile} onContext={onContext} onFolderContext={onFolderContext} expansion={expansion} />)}</div>;
  }
  const key = `${repo.meta.id}\0${node.file.path}`;
  return <div className={`file-row status-${node.file.status} ${node.file.conflicted ? 'conflicted' : ''}`} style={{ paddingLeft: 20 + depth * 20 }} onDoubleClick={() => onFile(node.file!)} onContextMenu={(event) => onContext(event, node.file!)}>
    <SelectionCheckbox label={node.file.path} checked={selected.has(key)} onChange={() => setFiles(repo.meta.id, [node.file!.path], !selected.has(key))} />
    <button title={node.file.path} onClick={() => onFile(node.file!)}><FileIcon name={node.name} /><span className="file-name-group"><span className="file-name">{node.name}</span></span></button>
    {node.file.staged && <span className="staged-dot" />}<StatusMark file={node.file} />
  </div>;
}

function RepoFiles({ repo, selected, setFiles, onFile, onContext, onFolderContext, onRepoContext, viewMode, expansion }: { repo: RepositoryStatus; selected: Set<string>; setFiles: (repoId: string, paths: string[], value: boolean) => void; onFile: (file: FileChange) => void; onContext: (event: React.MouseEvent, file: FileChange) => void; onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[]) => void; onRepoContext: (event: React.MouseEvent) => void; viewMode: 'tree' | 'list'; expansion: ExpansionCommand }) {
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
      <div className="repo-heading" style={{ background: `color-mix(in srgb, ${repo.meta.color} 18%, var(--versiondock-surface))` }} onContextMenu={onRepoContext}>
        <SelectionCheckbox label={repo.meta.name} checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} disabled={!repo.files.length} onChange={() => setFiles(repo.meta.id, repo.files.map((file) => file.path), !allSelected)} />
        <button title={repo.meta.name} onClick={() => setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded })}><Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /><i style={{ background: repo.meta.color }} /><strong>{repo.meta.name}</strong><span className="branch-chip" title={repo.branch || repo.revision} style={{ color: branch, background: `${branch}33`, borderColor: `${branch}88` }}><Codicon name="git-branch" /><span className="branch-name">{repo.branch || repo.revision}</span></span></button>
        {(repo.ahead > 0 || repo.behind > 0) && <span className="repo-sync-state">{repo.ahead > 0 && `↑${repo.ahead}`}{repo.behind > 0 && ` ↓${repo.behind}`}</span>}
        {repo.files.length > 0 && <b>{selectedCount}/{repo.files.length}</b>}
      </div>
      {expanded && !repo.files.length && <div className="repo-no-changes">{t('No changes')}</div>}
      {expanded && viewMode === 'tree' && tree.map((node) => <TreeNode key={node.path} node={node} depth={0} repo={repo} selected={selected} setFiles={setFiles} onFile={onFile} onContext={onContext} onFolderContext={onFolderContext} expansion={expansion} />)}
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

function ChangelistRepoFiles({ repo, entries, ...props }: { repo: RepositoryStatus; entries: import('../bindings/generated').ChangelistEntry[] } & Omit<Parameters<typeof RepoFiles>[0], 'repo'>) {
  const assigned = new Set(entries.flatMap((entry) => entry.files));
  const groups = [
    ...entries.map((entry) => ({ id: entry.id, name: entry.name, files: repo.files.filter((file) => entry.files.includes(file.path)) })),
    { id: 'unassigned', name: 'Default Changelist', files: repo.files.filter((file) => !assigned.has(file.path)) },
  ].filter((group) => group.files.length > 0);
  if (!groups.length) return <RepoFiles repo={repo} {...props} />;
  return <>{groups.map((group) => <RepoFiles key={`${repo.meta.id}:${group.id}`} repo={{ ...repo, meta: { ...repo.meta, name: `${repo.meta.name} · ${group.name}` }, files: group.files }} {...props} />)}</>;
}

export function CommitPanel() {
  const snapshot = useAppStore((state) => state.snapshot);
  const selectRepo = useAppStore((state) => state.selectRepo);
  const openDiff = useAppStore((state) => state.openDiff);
  const openStashDiff = useAppStore((state) => state.openStashDiff);
  const openShelfDiff = useAppStore((state) => state.openShelfDiff);
  const stage = useAppStore((state) => state.stage);
  const unstage = useAppStore((state) => state.unstage);
  const discard = useAppStore((state) => state.discard);
  const deletePaths = useAppStore((state) => state.deletePaths);
  const addIgnore = useAppStore((state) => state.addIgnore);
  const commitMany = useAppStore((state) => state.commitMany);
  const conflicts = useAppStore((state) => state.conflicts);
  const openMerge = useAppStore((state) => state.openMerge);
  const resolveConflict = useAppStore((state) => state.resolveConflict);
  const abortRepositoryOperation = useAppStore((state) => state.abortRepositoryOperation);
  const busy = useAppStore((state) => state.busy);
  const viewMode = useAppStore((state) => (state.bootstrap?.state.layout?.fileViewMode ?? state.bootstrap?.state.fileViewMode) === 'list' ? 'list' : 'tree');
  const setFileViewMode = useAppStore((state) => state.setFileViewMode);
  const stashViewMode = useAppStore((state) => (state.bootstrap?.state.layout?.stashViewMode ?? state.bootstrap?.state.stashViewMode) === 'list' ? 'list' : 'tree');
  const setStashViewMode = useAppStore((state) => state.setStashViewMode);
  const systemOpen = useAppStore((state) => state.systemOpen);
  const openFileHistory = useAppStore((state) => state.openFileHistory);
  const stashEnabled = useAppStore((state) => (state.bootstrap?.capabilities.stash ?? false) && (state.snapshot?.repositories.some((repo) => repo.capabilities?.stash !== false) ?? true));
  const shelfEnabled = useAppStore((state) => (state.bootstrap?.capabilities.shelf ?? false) && (state.snapshot?.repositories.some((repo) => repo.capabilities?.shelf !== false) ?? true));
  const worktreeEnabled = useAppStore((state) => (state.bootstrap?.capabilities.worktree ?? false) && (state.snapshot?.repositories.some((repo) => repo.capabilities?.worktree !== false) ?? true));
  const subtreeEnabled = useAppStore((state) => (state.bootstrap?.capabilities.subtree ?? false) && (state.snapshot?.repositories.some((repo) => repo.capabilities?.subtree !== false) ?? true));
  const storedTab = useAppStore((state) => state.bootstrap?.state.layout?.activeTab ?? state.bootstrap?.state.activeTab);
  const defaultCommitAction = useAppStore((state) => state.bootstrap?.state.settings?.defaultCommitAction ?? 'commit');
  const defaultSaveAction = useAppStore((state) => state.bootstrap?.state.settings?.defaultSaveAction ?? 'stash');
  const changesDisplayMode = useAppStore((state) => state.bootstrap?.state.settings?.changesDisplayMode ?? 'simplified');
  const promptBeforeAddingUntracked = useAppStore((state) => state.bootstrap?.state.settings?.promptBeforeAddingUntracked ?? true);
  const pushEnabled = snapshot?.repositories.some((repo) => repo.meta.kind === 'git') ?? false;
  const tab = pushEnabled && storedTab === 'push' ? 'push' : stashEnabled && storedTab === 'stash' ? 'stash' : shelfEnabled && storedTab === 'shelf' ? 'shelf' : worktreeEnabled && storedTab === 'worktree' ? 'worktree' : subtreeEnabled && storedTab === 'subtree' ? 'subtree' : 'changes';
  const setTab = useAppStore((state) => state.setActiveTab);
  const changelistEnabled = useAppStore((state) => (state.bootstrap?.capabilities.changelist ?? false) && (state.snapshot?.repositories.some((repo) => repo.capabilities?.changelist !== false) ?? true) && changesDisplayMode === 'changelists');
  const changelists = useAppStore((state) => state.changelists);
  const changelistOperation = useAppStore((state) => state.changelistOperation);
  const stashes = useAppStore((state) => state.stashes);
  const shelves = useAppStore((state) => state.shelves);
  const subtrees = useAppStore((state) => state.subtrees);
  const submodules = useAppStore((state) => state.submodules);
  const worktrees = useAppStore((state) => state.worktrees);
  const branchWorkingDiffOpen = useAppStore((state) => state.worktreeDiff?.source === 'repository');
  const [selected, setSelected] = useState(new Set<string>());
  const [message, setMessage] = useState('');
  const [amendRepos, setAmendRepos] = useState(new Set<string>());
  const [commitMenu, setCommitMenu] = useState(false);
  const [saveMenu, setSaveMenu] = useState(false);
  const [viewMenu, setViewMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const [identity, setIdentity] = useState(false);
  const [ignoreManager, setIgnoreManager] = useState<{ repoId: string; directory: string }>();
  const [changelistManagerRepoId, setChangelistManagerRepoId] = useState<string>();
  const selectedRepo = snapshot?.repositories.find((repo) => repo.meta.id === useAppStore.getState().selectedRepoId) ?? snapshot?.repositories[0];
  const [expansion, setExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const [shelfViewMode, setShelfViewMode] = useState<'tree' | 'list'>('tree');
  const [shelfExpansion, setShelfExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: false });
  const [stashExpansion, setStashExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: false });
  const [textareaHeight, setTextareaHeight] = useState(54);
  const [context, setContext] = useState<ChangeContext>();
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  const commitMenuRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const repos = snapshot?.repositories ?? emptyRepositories;
  const totalChanges = repos.reduce((sum, repo) => sum + repo.files.length, 0);
  const gitRepos = useMemo(() => repos.filter((repo) => repo.meta.kind === 'git'), [repos]);
  const unpushedCommits = useAppStore((state) => state.unpushedCommits);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const stashCount = useMemo(() => gitRepos.reduce((sum, repo) => sum + (stashes[repo.meta.id]?.length ?? 0), 0), [gitRepos, stashes]);
  const shelfCount = useMemo(() => gitRepos.reduce((sum, repo) => sum + (shelves[repo.meta.id]?.length ?? 0), 0), [gitRepos, shelves]);
  const subtreeCount = useMemo(() => gitRepos.reduce((sum, repo) => sum + (subtrees[repo.meta.id]?.length ?? 0), 0), [gitRepos, subtrees]);
  const worktreeCount = useMemo(() => gitRepos.reduce((sum, repo) => sum + (worktrees[repo.meta.id]?.length ?? 0), 0), [gitRepos, worktrees]);
  const totalToPush = useMemo(() => gitRepos.reduce((sum, r) => {
    const branch = branchesByRepo[r.meta.id]?.find((item) => item.current);
    if (branch?.upstream) return sum + (r.ahead ?? 0);
    return sum + (unpushedCommits[r.meta.id]?.length ?? (r.ahead || 0));
  }, 0), [branchesByRepo, gitRepos, unpushedCommits]);
  const activeOperationRepo = repos.find((repo) => repo.meta.kind === 'git' && repo.operation);
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
    const untracked = commitTargets.flatMap((repo) => repo.files.filter((file) => file.status === 'untracked' && (selectedByRepo.get(repo.meta.id) ?? []).includes(file.path)).map((file) => `${repo.meta.name}: ${file.path}`));
    if (promptBeforeAddingUntracked && untracked.length > 0 && !await confirmDialog({ title: t('Prompt before adding untracked files'), message: untracked.join('\n'), confirmLabel: t('Commit') })) return;
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
    if (!total) return;
    const tracked = repos.flatMap((repo) => repo.files.filter((file) => file.status !== 'untracked').map((file) => `${repo.meta.name}: ${file.path}`));
    const untracked = repos.flatMap((repo) => repo.files.filter((file) => file.status === 'untracked').map((file) => `${repo.meta.name}: ${file.path}`));
    const message = [
      t('Discard changes to {0} files? This cannot be undone.', total),
      tracked.length ? `Tracked (${tracked.length}):\n${tracked.join('\n')}` : '',
      untracked.length ? `Untracked files will be deleted (${untracked.length}):\n${untracked.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    if (!await confirmDialog({ title: t('Rollback'), message, danger: true })) return;
    for (const repo of repos) await discard(repo.meta.id, repo.files.map((file) => file.path));
    setSelected(new Set());
  };
  const confirmDiscard = async (repo: RepositoryStatus, files: FileChange[]) => {
    const tracked = files.filter((file) => file.status !== 'untracked');
    const untracked = files.filter((file) => file.status === 'untracked');
    const details = [tracked.length ? `${tracked.length} tracked path(s) will be restored.` : '', untracked.length ? `${untracked.length} untracked path(s) will be deleted.` : '', ...files.map((file) => file.path)].filter(Boolean).join('\n');
    if (await confirmDialog({ title: t('Rollback'), message: details, danger: true })) await discard(repo.meta.id, files.map((file) => file.path));
  };
  const confirmDelete = async (repo: RepositoryStatus, files: FileChange[]) => {
    const message = `Move ${files.length} path(s) to the system Trash?\n\n${files.map((file) => file.path).join('\n')}`;
    if (await confirmDialog({ title: t('Delete'), message, danger: true })) await deletePaths(repo.meta.id, files.map((file) => file.path));
  };
  const savePaths = async (repo: RepositoryStatus, files: FileChange[], kind: 'stash' | 'shelf') => {
    if (repo.meta.kind !== 'git') return;
    const paths = files.map((file) => file.path);
    if (kind === 'stash') await useAppStore.getState().stashOperation(repo.meta.id, { type: 'create', message: t('WIP stash'), paths, include_untracked: true });
    else await useAppStore.getState().shelfOperation(repo.meta.id, { type: 'create', name: t('Changes'), paths });
  };
  const contextItems = (value: ChangeContext): ContextMenuEntry[] => {
    const { repo, files, kind } = value;
    const file = kind === 'file' ? files[0] : undefined;
    const allUntracked = files.length > 0 && files.every((item) => item.status === 'untracked');
    const git = repo.meta.kind === 'git';
    const hasCustomChangelists = (changelists[repo.meta.id] ?? []).length > 0;
    const items: ContextMenuEntry[] = [];
    if (kind === 'file' && file?.submodule) {
      if (file.staged && !file.unstaged) items.push({ id: 'unstage', label: t('Unstage'), icon: 'remove' });
      else items.push({ id: 'stage', label: t('Stage'), icon: 'add' });
      items.push({ separator: true }, { id: 'refresh', label: t('Refresh'), icon: 'refresh' });
      return items;
    }
    if (file?.conflicted) items.push(
      { id: 'resolve', label: t('Resolve conflicts'), icon: 'git-merge' },
      { id: 'accept-yours', label: t('Accept Yours'), icon: 'check' },
      { id: 'accept-theirs', label: t('Accept Theirs'), icon: 'check-all' },
      { separator: true },
    );
    if (changelistEnabled && allUntracked) items.push({ id: 'stage', label: t(git ? 'Add to Git' : 'Add to SVN'), icon: 'add' });
    if (files.length) {
      items.push({ id: 'rollback', label: t('Rollback'), icon: 'discard' });
      if (git) items.push(
        { id: 'shelf', label: t(kind === 'file' ? 'Shelve' : 'Shelve Changes'), icon: 'archive' },
        { id: 'stash', label: t(kind === 'file' ? 'Stash' : 'Stash Changes'), icon: 'save' },
      );
    }
    if (kind === 'file' && file) items.push(
      { id: file.staged && !file.unstaged ? 'diff-staged' : 'diff-unstaged', label: t('Show Diff'), icon: 'diff' },
      { id: 'open', label: t('Open file'), icon: 'go-to-file' },
      { id: 'reveal', label: t('Reveal in File Manager'), icon: 'folder-opened' },
    );
    if (kind !== 'repo' && value.path && (git || allUntracked)) items.push(
      { separator: true },
      { id: 'ignore', label: t(git ? 'Add to .gitignore' : 'Add to SVN Ignore'), icon: 'exclude' },
    );
    if (files.length && kind !== 'repo') items.push({ separator: true }, { id: 'delete', label: t('Delete'), icon: 'trash', danger: true });
    if (changelistEnabled && hasCustomChangelists && files.length && !allUntracked) items.push(
      { separator: true },
      { id: 'move-to-changelist', label: t('Move to Changelist…'), icon: 'list-unordered' },
    );
    if (kind === 'repo') items.push(
      { separator: true },
      { id: 'manage', label: t('Manage Repository'), icon: 'git-branch' },
      { id: 'view-log', label: t(git ? 'View Git Log' : 'View SVN Log'), icon: 'git-commit' },
      { separator: true },
      { id: 'hide-repo', label: t('Hide Repository'), icon: 'eye-closed' },
    );
    items.push({ separator: true }, { id: 'refresh', label: t('Refresh'), icon: 'refresh' });
    if (repo.meta.kind === 'svn') items.push({ separator: true }, { id: 'manage-ignore', label: t('Manage SVN Ignore...'), icon: 'list-unordered' });
    return items;
  };
  const handleContextAction = async (id: string) => {
    const value = context;
    if (!value) return;
    const { repo, files } = value;
    const paths = files.map((file) => file.path);
    const file = files[0];
    switch (id) {
      case 'stage': await stage(repo.meta.id, paths); break;
      case 'unstage': await unstage(repo.meta.id, paths); break;
      case 'diff-unstaged': if (file) await openDiff(repo.meta.id, file.path, false); break;
      case 'diff-staged': if (file) await openDiff(repo.meta.id, file.path, true); break;
      case 'history': if (file) openFileHistory(repo.meta.id, file.path); break;
      case 'resolve': if (file) { const conflict = conflicts.find((item) => item.repoId === repo.meta.id && item.path === file.path); if (conflict) await openMerge(conflict); } break;
      case 'accept-yours': if (file) { const conflict = conflicts.find((item) => item.repoId === repo.meta.id && item.path === file.path); if (conflict) await resolveConflict(conflict, 'mine'); } break;
      case 'accept-theirs': if (file) { const conflict = conflicts.find((item) => item.repoId === repo.meta.id && item.path === file.path); if (conflict) await resolveConflict(conflict, 'theirs'); } break;
      case 'accept-working': if (file) await useAppStore.getState().svnOperation(repo.meta.id, { type: 'resolveWorking', paths: [file.path] }); break;
      case 'rollback': await confirmDiscard(repo, files); break;
      case 'shelf': await savePaths(repo, files, 'shelf'); break;
      case 'stash': await savePaths(repo, files, 'stash'); break;
      case 'open': if (file) await systemOpen(repo.meta.id, file.path, false); break;
      case 'external': if (file) await systemOpen(repo.meta.id, file.path, false, true); break;
      case 'reveal': if (file) await systemOpen(repo.meta.id, file.path, true); break;
      case 'ignore': if (value.path) await addIgnore(repo.meta.id, value.path); break;
      case 'manage-ignore': setIgnoreManager({ repoId: repo.meta.id, directory: value.kind === 'folder' ? (value.path ?? '') : '' }); break;
      case 'move-to-changelist': {
        const target = await choiceDialog({
          title: t('Move to Changelist…'),
          message: paths.join('\n'),
          choices: [
            { id: 'none', label: t('Unassigned'), icon: 'remove' },
            ...(changelists[repo.meta.id] ?? []).map((entry) => ({ id: entry.id, label: entry.name, description: `${entry.files.length} ${t('file')}`, icon: 'list-unordered' })),
          ],
        });
        if (target) await changelistOperation(repo.meta.id, { type: 'assign', changelist_id: target === 'none' ? null : target, paths });
        break;
      }
      case 'svn-lock': {
        const lockMessage = await promptDialog({ title: t('SVN Lock'), message: paths.join('\n'), inputLabel: t('Lock message'), initialValue: t('Locked from VersionDock') });
        if (lockMessage) await useAppStore.getState().svnOperation(repo.meta.id, { type: 'lock', paths, message: lockMessage, force: false });
        break;
      }
      case 'svn-unlock': await useAppStore.getState().svnOperation(repo.meta.id, { type: 'unlock', paths, force: false }); break;
      case 'svn-cleanup': await useAppStore.getState().svnOperation(repo.meta.id, { type: 'cleanup', break_locks: false, remove_unversioned: false, remove_ignored: false, include_externals: true }); break;
      case 'svn-relocate': {
        const fromUrl = await promptDialog({ title: t('SVN Relocate'), message: t('Old repository root URL'), inputLabel: t('From URL'), initialValue: '' });
        if (!fromUrl) break;
        const toUrl = await promptDialog({ title: t('SVN Relocate'), message: t('New repository root URL'), inputLabel: t('To URL'), initialValue: fromUrl });
        if (toUrl) await useAppStore.getState().svnOperation(repo.meta.id, { type: 'relocate', from_url: fromUrl, to_url: toUrl });
        break;
      }
      case 'svn-switch': {
        const url = await promptDialog({ title: t('SVN Switch'), message: t('Working copy target URL, for example ^/branches/release'), inputLabel: t('URL'), initialValue: '^/trunk' });
        if (url) await useAppStore.getState().svnOperation(repo.meta.id, { type: 'switch', url, revision: null, ignore_ancestry: false });
        break;
      }
      case 'svn-branch':
      case 'svn-tag': {
        const sourceUrl = await promptDialog({ title: t(id === 'svn-branch' ? 'Create SVN Branch' : 'Create SVN Tag'), message: t('Source repository URL'), inputLabel: t('Source URL'), initialValue: '^/trunk' });
        if (!sourceUrl) break;
        const destinationUrl = await promptDialog({ title: t(id === 'svn-branch' ? 'Create SVN Branch' : 'Create SVN Tag'), message: t('Destination repository URL'), inputLabel: t('Destination URL'), initialValue: id === 'svn-branch' ? '^/branches/' : '^/tags/' });
        if (!destinationUrl) break;
        const copyMessage = await promptDialog({ title: t('SVN Copy Commit'), message: `${sourceUrl}\n→ ${destinationUrl}`, inputLabel: t('Commit message'), initialValue: t(id === 'svn-branch' ? 'Create branch' : 'Create tag') });
        if (copyMessage) await useAppStore.getState().svnOperation(repo.meta.id, { type: 'copy', source_url: sourceUrl, destination_url: destinationUrl, revision: null, message: copyMessage });
        break;
      }
      case 'submodule-open': if (file) await systemOpen(repo.meta.id, file.path, false); break;
      case 'submodule-reveal': if (file) await systemOpen(repo.meta.id, file.path, true); break;
      case 'submodule-update': if (file) await useAppStore.getState().submoduleOperation(repo.meta.id, { type: 'update', path: file.path, init: true, recursive: false, remote: false }); break;
      case 'submodule-update-recursive': if (file) await useAppStore.getState().submoduleOperation(repo.meta.id, { type: 'update', path: file.path, init: true, recursive: true, remote: false }); break;
      case 'submodule-sync': if (file) await useAppStore.getState().submoduleOperation(repo.meta.id, { type: 'sync', path: file.path, recursive: true }); break;
      case 'submodule-deinit':
      case 'submodule-deinit-force': if (file && await confirmDialog({ title: t(id === 'submodule-deinit-force' ? 'Force deinitialize submodule?' : 'Deinitialize submodule?'), message: `${file.path}\n\n${t('The submodule working directory will be cleared.')}`, danger: true })) await useAppStore.getState().submoduleOperation(repo.meta.id, { type: 'deinit', path: file.path, force: id === 'submodule-deinit-force' }); break;
      case 'submodule-init-all':
      case 'submodule-update-all':
      case 'submodule-sync-all': for (const entry of submodules[repo.meta.id] ?? []) {
        if (id === 'submodule-init-all') await useAppStore.getState().submoduleOperation(repo.meta.id, { type: 'init', path: entry.path, recursive: true });
        else if (id === 'submodule-update-all') await useAppStore.getState().submoduleOperation(repo.meta.id, { type: 'update', path: entry.path, init: true, recursive: true, remote: false });
        else await useAppStore.getState().submoduleOperation(repo.meta.id, { type: 'sync', path: entry.path, recursive: true });
      } break;
      case 'delete': await confirmDelete(repo, files); break;
      case 'manage': setIdentity(true); break;
      case 'view-log': await selectRepo(repo.meta.id, true); break;
      case 'hide-repo': {
        const currentSettings = useAppStore.getState().bootstrap?.state.settings;
        if (currentSettings) await useAppStore.getState().updateSettings({ hiddenRepositoryIds: [...new Set([...(currentSettings.hiddenRepositoryIds ?? []), repo.meta.id])] });
        break;
      }
      case 'refresh': await useAppStore.getState().refresh(); break;
      default:
        if (id.startsWith('changelist:')) {
          const target = id.slice('changelist:'.length);
          await changelistOperation(repo.meta.id, { type: 'assign', changelist_id: target === 'none' ? null : target, paths });
        }
    }
    setContext(undefined);
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
    if (!commitMenu && !saveMenu && !viewMenu) return;
    const handleOutsideInteraction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (viewMenu && !viewMenuRef.current?.contains(target)) setViewMenu(false);
      if (saveMenu && !saveMenuRef.current?.contains(target)) setSaveMenu(false);
      if (commitMenu && !commitMenuRef.current?.contains(target)) setCommitMenu(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
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
  }, [commitMenu, saveMenu, viewMenu]);

  const panelToolbar = <div className="panel-toolbar"><strong title={t('VersionDock Commit')}>{t('VersionDock Commit')}</strong><span />{selectedRepo?.toolAvailable !== false && <button className={identity ? 'selected' : ''} title={selectedRepo?.meta.kind === 'git' ? 'Git Identity' : 'SVN Account'} onClick={() => setIdentity(true)}><Codicon name="account" /></button>}<button disabled={busy} title={t('Fetch')} onClick={() => void Promise.all(gitRepos.map((repo) => useAppStore.getState().sync(repo.meta.id, 'fetch')))}><Codicon name="cloud-download" /></button><button disabled={busy} title={t('Refresh')} onClick={() => void useAppStore.getState().refresh()}><Codicon name="refresh" /></button><button className={settings ? 'selected' : ''} title={t('Settings')} aria-label={t('Settings')} onClick={() => setSettings(!settings)}><Codicon name="settings-gear" /></button></div>;
  const panelOverlays = <>{settings && <SettingsPanel onClose={() => setSettings(false)} />}{identity && selectedRepo && <IdentityPanel repoId={selectedRepo.meta.id} close={() => setIdentity(false)} />}{ignoreManager && <IgnoreRulesPanel repoId={ignoreManager.repoId} directory={ignoreManager.directory} close={() => setIgnoreManager(undefined)} />}</>;

  if (branchWorkingDiffOpen) return <aside className="commit-panel">{panelToolbar}{panelOverlays}<BranchWorkingDiffPanel /></aside>;

  return (
    <aside className="commit-panel" onClick={() => setContext(undefined)}>
      {panelToolbar}
      {panelOverlays}
      <div className="commit-commandbar">
        <button disabled={busy} title={t('Refresh')} onClick={() => void useAppStore.getState().refresh()}><Codicon name="refresh" /></button>
        {tab === 'changes' && <>
          <button disabled={!repos.some((repo) => repo.files.length) || busy} title={t('Rollback')} onClick={() => void discardAll()}><Codicon name="discard" /></button>
          <button title={t('Expand all')} onClick={() => setExpansion((current) => ({ sequence: current.sequence + 1, expanded: true }))}><Codicon name="expand-all" /></button>
          <button title={t('Collapse all')} onClick={() => setExpansion((current) => ({ sequence: current.sequence + 1, expanded: false }))}><Codicon name="collapse-all" /></button>
          <div ref={viewMenuRef} className="view-options"><button title={t('View options')} className={viewMenu ? 'selected' : ''} onClick={(event) => { event.stopPropagation(); setViewMenu((value) => !value); }}><Codicon name="eye" /></button>{viewMenu && <div className="view-options-menu" onClick={(event) => event.stopPropagation()}><strong>{t('View')}</strong><button className={viewMode === 'list' ? 'selected' : ''} onClick={() => { setFileViewMode('list'); setViewMenu(false); }}><Codicon name="list-unordered" />{t('List view')}{viewMode === 'list' && <Codicon name="check" />}</button><button className={viewMode === 'tree' ? 'selected' : ''} onClick={() => { setFileViewMode('tree'); setViewMenu(false); }}><Codicon name="list-tree" />{t('Tree view')}{viewMode === 'tree' && <Codicon name="check" />}</button></div>}</div>
        </>}
        {tab === 'shelf' && <>
          <button title={t('Expand all')} onClick={() => setShelfExpansion((current) => ({ sequence: current.sequence + 1, expanded: true }))}><Codicon name="expand-all" /></button>
          <button title={t('Collapse all')} onClick={() => setShelfExpansion((current) => ({ sequence: current.sequence + 1, expanded: false }))}><Codicon name="collapse-all" /></button>
          <div ref={viewMenuRef} className="view-options"><button title={t('View options')} className={viewMenu ? 'selected' : ''} onClick={(event) => { event.stopPropagation(); setViewMenu((value) => !value); }}><Codicon name="eye" /></button>{viewMenu && <div className="view-options-menu" onClick={(event) => event.stopPropagation()}><strong>{t('View')}</strong><button className={shelfViewMode === 'list' ? 'selected' : ''} onClick={() => { setShelfViewMode('list'); setViewMenu(false); }}><Codicon name="list-unordered" />{t('List view')}{shelfViewMode === 'list' && <Codicon name="check" />}</button><button className={shelfViewMode === 'tree' ? 'selected' : ''} onClick={() => { setShelfViewMode('tree'); setViewMenu(false); }}><Codicon name="list-tree" />{t('Tree view')}{shelfViewMode === 'tree' && <Codicon name="check" />}</button></div>}</div>
        </>}
        {tab === 'stash' && <>
          <button title={t('Expand all')} onClick={() => setStashExpansion((current) => ({ sequence: current.sequence + 1, expanded: true }))}><Codicon name="expand-all" /></button>
          <button title={t('Collapse all')} onClick={() => setStashExpansion((current) => ({ sequence: current.sequence + 1, expanded: false }))}><Codicon name="collapse-all" /></button>
          <div ref={viewMenuRef} className="view-options"><button title={t('View options')} className={viewMenu ? 'selected' : ''} onClick={(event) => { event.stopPropagation(); setViewMenu((value) => !value); }}><Codicon name="eye" /></button>{viewMenu && <div className="view-options-menu" onClick={(event) => event.stopPropagation()}><strong>{t('View')}</strong><button className={stashViewMode === 'list' ? 'selected' : ''} onClick={() => { setStashViewMode('list'); setViewMenu(false); }}><Codicon name="list-unordered" />{t('List view')}{stashViewMode === 'list' && <Codicon name="check" />}</button><button className={stashViewMode === 'tree' ? 'selected' : ''} onClick={() => { setStashViewMode('tree'); setViewMenu(false); }}><Codicon name="list-tree" />{t('Tree view')}{stashViewMode === 'tree' && <Codicon name="check" />}</button></div>}</div>
        </>}
        {tab === 'changes' && changelistEnabled && <button title={t('Changelists')} onClick={() => setChangelistManagerRepoId(selectedRepo?.meta.id)}><Codicon name="list-unordered" /></button>}
        <span />
      </div>
      <div className="commit-tabs"><button title={t('Changes')} className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}><Codicon name="source-control" />{tab === 'changes' && <span>{t('Changes')}</span>}{totalChanges > 0 && <b>{totalChanges}</b>}</button>{shelfEnabled && <button title={t('Shelf')} className={tab === 'shelf' ? 'active' : ''} onClick={() => setTab('shelf')}><Codicon name="archive" />{tab === 'shelf' && <span>{t('Shelf')}</span>}{shelfCount > 0 && <b>{shelfCount}</b>}</button>}{stashEnabled && <button title={t('Stash')} className={tab === 'stash' ? 'active' : ''} onClick={() => setTab('stash')}><Codicon name="save" />{tab === 'stash' && <span>{t('Stash')}</span>}{stashCount > 0 && <b>{stashCount}</b>}</button>}{worktreeEnabled && <button title={t('Worktrees')} className={tab === 'worktree' ? 'active' : ''} onClick={() => setTab('worktree')}><Codicon name="worktree" />{tab === 'worktree' && <span>{t('Worktrees')}</span>}{worktreeCount > 0 && <b>{worktreeCount}</b>}</button>}{subtreeEnabled && <button title={t('Subtree')} className={tab === 'subtree' ? 'active' : ''} onClick={() => setTab('subtree')}><Codicon name="repo" />{tab === 'subtree' && <span>{t('Subtree')}</span>}{subtreeCount > 0 && <b>{subtreeCount}</b>}</button>}{gitRepos.length > 0 && <button title={t('Push')} className={tab === 'push' ? 'active' : ''} onClick={() => { setTab('push'); void useAppStore.getState().loadUnpushedCommits(); }}><Codicon name="cloud-upload" />{tab === 'push' && <span>{t('Push')}</span>}{totalToPush > 0 && <b>{totalToPush}</b>}</button>}</div>
      {tab === 'push' ? <PushPanel repos={gitRepos} /> : tab === 'subtree' ? <SubtreePanel repos={gitRepos} /> : tab === 'worktree' ? <WorktreePanel repos={gitRepos} /> : tab === 'shelf' ? <ShelfPanel repos={gitRepos} selectedPaths={selectedByRepo} viewMode={shelfViewMode} expansion={shelfExpansion} onOpenFileDiff={(repoId, shelfId, path) => void openShelfDiff(repoId, shelfId, path)} /> : tab === 'stash' ? <StashPanel repos={gitRepos} selectedPaths={selectedByRepo} viewMode={stashViewMode} expansion={stashExpansion} onOpenFileDiff={(repoId, reference, path) => void openStashDiff(repoId, reference, path)} /> : <>
      {conflicts.length > 0 && (
        <button className="conflict-banner" onClick={() => { const conflict = conflicts[0]; if (!conflict.conflictType || ['text', 'binary'].includes(conflict.conflictType)) void openMerge(conflict); else void confirmDialog({ title: t('{0} conflict', conflict.conflictType), message: `${conflict.path}\n${t('Mark the current working-copy state as resolved?')}`, danger: true }).then((yes) => { if (yes) return resolveConflict(conflict, 'working'); }); }}><Codicon name="warning" /><span><strong>{t('Resolve conflicts')}</strong><small>{conflicts.length} {t('Conflicts')}{conflicts[0].conflictType ? ` · ${t(conflicts[0].conflictType)}` : ''}</small></span><Codicon name="chevron-right" /></button>
      )}
      {activeOperationRepo?.operation && <button className="conflict-banner" onClick={() => void confirmDialog({ title: t('Abort {0}?', activeOperationRepo.operation!), message: `${activeOperationRepo.meta.name}\n${t('This can discard the in-progress operation state.')}`, danger: true }).then((yes) => { if (yes) return abortRepositoryOperation(activeOperationRepo.meta.id, activeOperationRepo.operation!); })}><Codicon name="debug-stop" /><span><strong>{activeOperationRepo.operation}</strong><small>{activeOperationRepo.meta.name}</small></span><span>{t('Abort')}</span></button>}
      <div className="changes-scroll">
        {!repos.length && <div className="empty-state"><Codicon name="source-control" />{t('No repositories found')}</div>}
        {repos.map((repo) => { const fileProps = { selected, setFiles, onFile: (file: FileChange) => void openDiff(repo.meta.id, file.path, file.staged && !file.unstaged), onContext: (event: React.MouseEvent, file: FileChange) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY, kind: 'file' as const, repo, files: [file], path: file.path }); }, onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[]) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY, kind: 'folder' as const, repo, files, path: folderPath }); }, onRepoContext: (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY, kind: 'repo' as const, repo, files: repo.files }); }, viewMode: viewMode as 'tree' | 'list', expansion }; return <div key={repo.meta.id} onMouseDown={() => void selectRepo(repo.meta.id)}>{changelistEnabled && repo.meta.kind === 'git' ? <ChangelistRepoFiles repo={repo} entries={changelists[repo.meta.id] ?? []} {...fileProps} /> : <RepoFiles repo={repo} {...fileProps} />}</div>; })}
      </div>
      <div className="commit-form">
        <div className="commit-resize-grip" role="separator" aria-label={t('Resize commit message')} aria-orientation="horizontal" onPointerDown={startTextareaResize}><i /></div>
        {repos.length > 1 && <div className="commit-targets">{commitTargets.length === 0 ? <span>{t('No files selected')}</span> : commitTargets.map((repo) => <em key={repo.meta.id} style={{ color: repo.meta.color, background: `${repo.meta.color}28`, borderColor: `${repo.meta.color}60` }}><button title={t('Remove {0}', repo.meta.name)} onClick={() => setFiles(repo.meta.id, repo.files.map((file) => file.path), false)}><Codicon name="close" /></button>{repo.meta.name}<b>{selectedByRepo.get(repo.meta.id)?.length}</b></em>)}</div>}
        {commitTargets.length === 1 && commitTargets[0].meta.kind === 'git' && <div className="commit-options"><label title={t('Amend')}><input type="checkbox" checked={amendRepos.has(commitTargets[0].meta.id)} onChange={() => setAmendRepos((current) => { const next = new Set(current); if (next.has(commitTargets[0].meta.id)) next.delete(commitTargets[0].meta.id); else next.add(commitTargets[0].meta.id); return next; })} />{t('Amend')}</label></div>}
        <textarea style={{ height: textareaHeight }} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`${t('Commit message')} (Cmd+Enter ${t('Commit')})`} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void doCommit(defaultCommitAction === 'commitAndPush'); }} />
        <div className="commit-actions">
          <div ref={saveMenuRef} className="split-button save-action"><button disabled={!message.trim() || !commitTargets.length || busy} onClick={() => void doSave(defaultSaveAction)}><Codicon name={defaultSaveAction === 'shelf' ? 'archive' : 'save'} />{t(defaultSaveAction === 'shelf' ? 'Shelve' : 'Stash')}</button><button disabled={!message.trim() || !commitTargets.length || busy} onClick={() => { setSaveMenu((value) => !value); setCommitMenu(false); }}><Codicon name="chevron-down" /></button>{saveMenu && <div className="split-menu"><button onClick={() => { void doSave('stash'); setSaveMenu(false); }}><Codicon name="save" />{t('Stash changes')}</button><button onClick={() => { void doSave('shelf'); setSaveMenu(false); }}><Codicon name="archive" />{t('Shelve changes')}</button></div>}</div>
          <div ref={commitMenuRef} className="split-button commit-action"><button disabled={!message.trim() || !commitTargets.length || busy} onClick={() => void doCommit(defaultCommitAction === 'commitAndPush')}><Codicon name={defaultCommitAction === 'commitAndPush' ? 'cloud-upload' : 'check'} />{t(defaultCommitAction === 'commitAndPush' ? 'Commit & Push' : 'Commit')}</button><button disabled={!message.trim() || !commitTargets.length || busy} onClick={() => { setCommitMenu((value) => !value); setSaveMenu(false); }}><Codicon name="chevron-down" /></button>{commitMenu && <div className="split-menu right"><button onClick={() => { void doCommit(false); setCommitMenu(false); }}><Codicon name="check" />{t('Commit')}</button><button onClick={() => { void doCommit(true); setCommitMenu(false); }}><Codicon name="cloud-upload" />{t('Commit & Push')}</button></div>}</div>
        </div>
      </div>
      {context && <ContextMenu x={context.x} y={context.y} items={contextItems(context)} onSelect={(id) => void handleContextAction(id)} onClose={() => setContext(undefined)} />}
      {changelistManagerRepoId && <ChangelistManager repoId={changelistManagerRepoId} close={() => setChangelistManagerRepoId(undefined)} />}
      </>}
    </aside>
  );
}
