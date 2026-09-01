import { useEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { choiceDialog, confirmDialog, promptDialog } from './dialogService';
import { capabilityAvailable, capabilityReason, isOperationActive, isOperationActiveForRepositories, useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import type { FileChange, RecentCommitMessage, RepositoryStatus } from '../bindings/generated';
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
import { ChangelistView } from './ChangelistView';
import { BranchWorkingDiffPanel } from './BranchWorkingDiffPanel';
import { ConflictBanner } from './ConflictBanner';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';

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
type ChangeContext = { x: number; y: number; kind: 'file' | 'folder' | 'repo'; repo: RepositoryStatus; files: FileChange[]; path?: string; changelistId?: string };

function TreeNode({ node, depth, repo, selected, setFiles, onFile, onContext, onFolderContext, expansion, onManualExpansionChange }: { node: FileTreeNode; depth: number; repo: RepositoryStatus; selected: Set<string>; setFiles: (repoId: string, paths: string[], value: boolean) => void; onFile: (file: FileChange) => void; onContext: (event: React.MouseEvent, file: FileChange) => void; onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[]) => void; expansion: ExpansionCommand; onManualExpansionChange: () => void }) {
  const [localExpansion, setLocalExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const expanded = localExpansion.sequence === expansion.sequence ? localExpansion.expanded : expansion.expanded;
  if (!node.file) {
    const selectedCount = node.files.filter((file) => selected.has(`${repo.meta.id}\0${file.path}`)).length;
    const allSelected = node.files.length > 0 && selectedCount === node.files.length;
    return <div className="tree-directory"><div className="directory-row" style={{ paddingLeft: 20 + depth * 20 }} onContextMenu={(event) => onFolderContext(event, node.path, node.files)}><SelectionCheckbox label={node.path} checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} onChange={() => setFiles(repo.meta.id, node.files.map((file) => file.path), !allSelected)} /><button title={node.path} onClick={() => { onManualExpansionChange(); setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded }); }}><Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /><FileIcon name={node.name} folder open={expanded} /><span>{node.name}</span></button><b>{node.files.length}</b></div>{expanded && node.children.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} repo={repo} selected={selected} setFiles={setFiles} onFile={onFile} onContext={onContext} onFolderContext={onFolderContext} expansion={expansion} onManualExpansionChange={onManualExpansionChange} />)}</div>;
  }
  const key = `${repo.meta.id}\0${node.file.path}`;
  return <div className={`file-row status-${node.file.status} ${node.file.conflicted ? 'conflicted' : ''}`} style={{ paddingLeft: 20 + depth * 20 }} onDoubleClick={() => onFile(node.file!)} onContextMenu={(event) => onContext(event, node.file!)}>
    <SelectionCheckbox label={node.file.path} checked={selected.has(key)} onChange={() => setFiles(repo.meta.id, [node.file!.path], !selected.has(key))} />
    <button title={node.file.path} onClick={() => onFile(node.file!)}><FileIcon name={node.name} /><span className="file-name-group"><span className="file-name">{node.name}</span></span></button>
    {node.file.staged && <span className="staged-dot" />}<StatusMark file={node.file} />
  </div>;
}

function RepoFiles({ repo, selected, setFiles, onFile, onContext, onFolderContext, onRepoContext, viewMode, expansion, onManualExpansionChange }: { repo: RepositoryStatus; selected: Set<string>; setFiles: (repoId: string, paths: string[], value: boolean) => void; onFile: (file: FileChange) => void; onContext: (event: React.MouseEvent, file: FileChange) => void; onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[]) => void; onRepoContext: (event: React.MouseEvent) => void; viewMode: 'tree' | 'list'; expansion: ExpansionCommand; onManualExpansionChange: () => void }) {
  const { t } = useI18n();
  const openWorkingChanges = useAppStore((state) => state.openWorkingChanges);
  const [localExpansion, setLocalExpansion] = useState<ExpansionCommand>(() => ({ sequence: 0, expanded: repo.files.length > 0 }));
  const previousFileCount = useRef(repo.files.length);
  const expanded = localExpansion.sequence === expansion.sequence ? localExpansion.expanded : expansion.expanded;
  const [hovered, setHovered] = useState(false);
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
      <div
        className="repo-heading"
        style={{
          background: `color-mix(in srgb, ${repo.meta.color} 14%, var(--versiondock-surface))`,
          height: 26,
          paddingRight: 8,
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={onRepoContext}
      >
        <SelectionCheckbox label={repo.meta.name} checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} disabled={!repo.files.length} onChange={() => setFiles(repo.meta.id, repo.files.map((file) => file.path), !allSelected)} />
        <button title={repo.meta.name} onClick={() => { onManualExpansionChange(); setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded }); }}><Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /><i style={{ background: repo.meta.color }} /><strong>{repo.meta.name}</strong><span className="branch-chip" title={repo.branch || repo.revision} style={{ color: branch, background: `${branch}33`, borderColor: `${branch}88` }}><Codicon name="git-branch" /><span className="branch-name">{repo.branch || repo.revision}</span></span></button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 'auto', flexShrink: 0 }}>
          {repo.files.length > 0 && (
            <button
              className="repo-open-changes"
              style={{
                opacity: hovered ? 1 : 0,
                pointerEvents: hovered ? 'auto' : 'none',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 4px',
                color: 'inherit',
                display: 'inline-flex',
                alignItems: 'center',
              }}
              title={t('Open all changes')}
              onClick={(e) => {
                e.stopPropagation();
                openWorkingChanges(repo.meta.id);
              }}
            >
              <Codicon name="diff-multiple" />
            </button>
          )}
          {repo.files.length > 0 && (
            <span className={`count-badge ${selectedCount > 0 ? 'selected' : ''}`}>
              {selectedCount}/{repo.files.length}
            </span>
          )}
        </div>
      </div>
      {expanded && !repo.files.length && <div className="repo-no-changes">{t('No changes')}</div>}
      {expanded && viewMode === 'tree' && tree.map((node) => <TreeNode key={node.path} node={node} depth={0} repo={repo} selected={selected} setFiles={setFiles} onFile={onFile} onContext={onContext} onFolderContext={onFolderContext} expansion={expansion} onManualExpansionChange={onManualExpansionChange} />)}
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
  const operations = useAppStore((state) => state.operations);
  const workspaceBusy = useAppStore((state) => isOperationActive(state.operations, {
    workspaceId: state.snapshot?.workspace.id,
    domain: 'workspace',
  }));
  const viewMode = useAppStore((state) => (state.bootstrap?.state.layout?.fileViewMode ?? state.bootstrap?.state.fileViewMode) === 'list' ? 'list' : 'tree');
  const setFileViewMode = useAppStore((state) => state.setFileViewMode);
  const stashViewMode = useAppStore((state) => (state.bootstrap?.state.layout?.stashViewMode ?? state.bootstrap?.state.stashViewMode) === 'list' ? 'list' : 'tree');
  const setStashViewMode = useAppStore((state) => state.setStashViewMode);
  const systemOpen = useAppStore((state) => state.systemOpen);
  const openFileHistory = useAppStore((state) => state.openFileHistory);
  const stashEnabled = useAppStore((state) => capabilityAvailable(state.bootstrap?.capabilities, 'stash') && (state.snapshot?.repositories.some((repo) => capabilityAvailable(repo.capabilities, 'stash', true)) ?? true));
  const shelfEnabled = useAppStore((state) => capabilityAvailable(state.bootstrap?.capabilities, 'shelf') && (state.snapshot?.repositories.some((repo) => capabilityAvailable(repo.capabilities, 'shelf', true)) ?? true));
  const worktreeEnabled = useAppStore((state) => capabilityAvailable(state.bootstrap?.capabilities, 'worktree') && (state.snapshot?.repositories.some((repo) => capabilityAvailable(repo.capabilities, 'worktree', true)) ?? true));
  const subtreeEnabled = useAppStore((state) => capabilityAvailable(state.bootstrap?.capabilities, 'subtree') && (state.snapshot?.repositories.some((repo) => capabilityAvailable(repo.capabilities, 'subtree', true)) ?? true));
  const storedTab = useAppStore((state) => state.bootstrap?.state.layout?.activeTab ?? state.bootstrap?.state.activeTab);
  const defaultCommitAction = useAppStore((state) => state.bootstrap?.state.settings?.defaultCommitAction ?? 'commit');
  const defaultSaveAction = useAppStore((state) => state.bootstrap?.state.settings?.defaultSaveAction ?? 'stash');
  const changesDisplayMode = useAppStore((state) => state.bootstrap?.state.settings?.changesDisplayMode ?? 'simplified');
  const pushEnabled = snapshot?.repositories.some((repo) => repo.meta.kind === 'git') ?? false;
  const tab = pushEnabled && storedTab === 'push' ? 'push' : stashEnabled && storedTab === 'stash' ? 'stash' : shelfEnabled && storedTab === 'shelf' ? 'shelf' : worktreeEnabled && storedTab === 'worktree' ? 'worktree' : subtreeEnabled && storedTab === 'subtree' ? 'subtree' : 'changes';
  const setTab = useAppStore((state) => state.setActiveTab);
  const changelistCapability = useAppStore((state) => capabilityAvailable(state.bootstrap?.capabilities, 'changelist') && (state.snapshot?.repositories.some((repo) => capabilityAvailable(repo.capabilities, 'changelist', true)) ?? true));
  const changelistEnabled = changelistCapability && changesDisplayMode === 'changelists';
  const changelists = useAppStore((state) => state.changelists);
  const changelistOperation = useAppStore((state) => state.changelistOperation);
  const stashes = useAppStore((state) => state.stashes);
  const shelves = useAppStore((state) => state.shelves);
  const subtrees = useAppStore((state) => state.subtrees);
  const worktrees = useAppStore((state) => state.worktrees);
  const branchWorkingDiffOpen = useAppStore((state) => state.worktreeDiff?.source === 'repository');
  const commitSelections = useAppStore((state) => state.commitSelections);
  const setCommitSelection = useAppStore((state) => state.setCommitSelection);
  const selected = useMemo(() => new Set(Object.entries(commitSelections).flatMap(([repoId, paths]) => paths.map((path) => `${repoId}\0${path}`))), [commitSelections]);
  const message = useAppStore((state) => state.commitMessage);
  const setMessage = useAppStore((state) => state.setCommitMessage);
  const mergeMessageSuggestion = useAppStore((state) => state.mergeMessageSuggestion);
  const applyMergeMessageSuggestion = useAppStore((state) => state.applyMergeMessageSuggestion);
  const dismissMergeMessageSuggestion = useAppStore((state) => state.dismissMergeMessageSuggestion);
  const amendRepoIds = useAppStore((state) => state.amendRepoIds);
  const setAmendRepoIds = useAppStore((state) => state.setAmendRepoIds);
  const amendRepos = useMemo(() => new Set(amendRepoIds), [amendRepoIds]);
  const openWorkingChanges = useAppStore((state) => state.openWorkingChanges);
  const [commitMenu, setCommitMenu] = useState(false);
  const [saveMenu, setSaveMenu] = useState(false);
  const [viewMenu, setViewMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const openIdentityPanel = useAppStore((state) => state.openIdentityPanel);
  const [ignoreManager, setIgnoreManager] = useState<{ repoId: string; directory: string }>();
  const [expansion, setExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const [shelfViewMode, setShelfViewMode] = useState<'tree' | 'list'>('tree');
  const [shelfExpansion, setShelfExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: false });
  const [stashExpansion, setStashExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: false });
  const [expandedByTab, setExpandedByTab] = useState<Record<'changes' | 'shelf' | 'stash', boolean | null>>({ changes: true, shelf: false, stash: false });
  const [textareaHeight, setTextareaHeight] = useState(54);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyDialog = useDialogFocusTrap(historyOpen, () => setHistoryOpen(false));
  const [historyMessages, setHistoryMessages] = useState<RecentCommitMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const messageRequestRef = useRef<AbortController | null>(null);
  const [context, setContext] = useState<ChangeContext>();
  const [clHeaderContext, setClHeaderContext] = useState<{ x: number; y: number; changelistId: string }>();
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  const commitMenuRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const repos = snapshot?.repositories ?? emptyRepositories;
  const totalChanges = repos.reduce((sum, repo) => sum + repo.files.length, 0);
  const gitRepos = useMemo(() => repos.filter((repo) => repo.meta.kind === 'git'), [repos]);
  const fetchTargets = gitRepos.filter((repo) => !isOperationActiveForRepositories(operations, [repo.meta.id], {
    workspaceId: snapshot?.workspace.id,
    domain: 'sync',
  }));
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
  const refreshPanel = async () => {
    const store = useAppStore.getState();
    const requests: Promise<unknown>[] = [store.refresh()];
    if (tab === 'changes' && changelistEnabled) requests.push(store.loadChangelists());
    if (tab === 'shelf') requests.push(store.loadShelves());
    if (tab === 'stash') requests.push(store.loadStashes());
    if (tab === 'worktree') requests.push(store.loadWorktrees());
    if (tab === 'subtree') requests.push(store.loadSubtrees());
    if (tab === 'push') requests.push(store.loadUnpushedCommits());
    await Promise.all(requests);
  };
  const activeOperationRepo = repos.find((repo) => repo.meta.kind === 'git' && repo.operation);
  const restoreConflicts = useAppStore((state) => state.restoreConflicts);
  const restorableConflictRepoIds = repos.filter((repo) => repo.meta.kind === 'git' && !repo.operation && (repo.conflicts > 0 || repo.files.some((file) => file.conflicted))).map((repo) => repo.meta.id);
  const selectedByRepo = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const key of selected) { const [repoId, path] = key.split('\0'); map.set(repoId, [...(map.get(repoId) ?? []), path]); }
    return map;
  }, [selected]);
  const commitTargets = repos.filter((repo) => (selectedByRepo.get(repo.meta.id)?.length ?? 0) > 0);
  const amendTarget = commitTargets.length === 1 && commitTargets[0].meta.kind === 'git' ? commitTargets[0] : undefined;
  const amendBranch = amendTarget ? branchesByRepo[amendTarget.meta.id]?.find((branch) => branch.current) : undefined;
  const showAmend = Boolean(amendTarget && (
    (amendBranch?.ahead ?? amendTarget.ahead) > 0
    || (!amendBranch?.upstream && (unpushedCommits[amendTarget.meta.id]?.length ?? 0) > 0)
  ));
  useEffect(() => {
    const allowedRepoId = showAmend ? amendTarget?.meta.id : undefined;
    const next = amendRepoIds.filter((repoId) => repoId === allowedRepoId);
    if (next.length !== amendRepoIds.length) setAmendRepoIds(next);
  }, [amendRepoIds, amendTarget, setAmendRepoIds, showAmend]);
  const commitTargetKey = commitTargets.map((repo) => repo.meta.id).join('\0');
  const recentCommitMessages = useAppStore((state) => state.recentCommitMessages);
  const lastCommitMessage = useAppStore((state) => state.lastCommitMessage);
  const openMessageHistory = async () => {
    if (!commitTargets.length) return;
    messageRequestRef.current?.abort();
    const controller = new AbortController();
    messageRequestRef.current = controller;
    setHistoryOpen(true); setHistoryLoading(true); setHistoryMessages([]);
    try { const values = await recentCommitMessages(commitTargets.map((repo) => repo.meta.id), controller.signal); if (!controller.signal.aborted && messageRequestRef.current === controller) setHistoryMessages(values); }
    catch { /* store handles non-cancellation errors */ }
    finally { if (!controller.signal.aborted) setHistoryLoading(false); }
  };
  const fillLastMessage = async () => {
    if (!commitTargets.length) return;
    let repoId = commitTargets[0].meta.id;
    if (commitTargets.length > 1) {
      const selected = await choiceDialog({ title: t('Use Last Commit Message'), message: t('Select a repository.'), choices: commitTargets.map((repo) => ({ id: repo.meta.id, label: repo.meta.name, icon: 'repo' })) });
      if (!selected) return;
      repoId = selected;
    }
    messageRequestRef.current?.abort();
    const controller = new AbortController(); messageRequestRef.current = controller;
    const value = await lastCommitMessage(repoId, controller.signal);
    if (!controller.signal.aborted && messageRequestRef.current === controller) { if (value) setMessage(value); else useAppStore.getState().addNotification({ type: 'info', title: 'VersionDock Desktop', message: 'No commit message is available for this repository.', workspaceId: snapshot?.workspace.id }); }
  };
  useEffect(() => () => messageRequestRef.current?.abort(), [snapshot?.workspace.id, commitTargetKey]);
  const commitBusy = workspaceBusy || isOperationActiveForRepositories(operations, commitTargets.map((repo) => repo.meta.id), {
    workspaceId: snapshot?.workspace.id,
    domain: ['commit', 'sync'],
  });
  const saveBusy = workspaceBusy || isOperationActiveForRepositories(operations, commitTargets.map((repo) => repo.meta.id), {
    workspaceId: snapshot?.workspace.id,
    domain: ['stash', 'shelf'],
  });
  const commitUnavailable = commitTargets.find((repo) => !capabilityAvailable(repo.capabilities, 'commit', true));
  const pushUnavailable = commitTargets.find((repo) => repo.meta.kind === 'git' && !capabilityAvailable(repo.capabilities, 'syncPush', true));
  const commitDisabledReason = commitUnavailable
    ? capabilityReason(commitUnavailable.capabilities, 'commit')
    : pushUnavailable
      ? capabilityReason(pushUnavailable.capabilities, 'syncPush')
      : undefined;
  const setFiles = (repoId: string, paths: string[], value: boolean) => setCommitSelection(repoId, paths, value);
  const doCommit = async (push: boolean) => {
    if (!message.trim() || !commitTargets.length || commitBusy || commitUnavailable || (push && pushUnavailable)) return;
    await commitMany(commitTargets.map((repo) => {
      const paths = selectedByRepo.get(repo.meta.id) ?? [];
      return {
        repoId: repo.meta.id,
        paths,
        unstagePaths: repo.files.filter((file) => file.staged && !paths.includes(file.path)).map((file) => file.path),
        amend: amendRepos.has(repo.meta.id),
      };
    }), message, push);
    const failedRepoIds = new Set(useAppStore.getState().batchCommitReport?.results.filter((result) => result.error).map((result) => result.repoId) ?? []);
    if (failedRepoIds.size === 0) {
      setMessage('');
      setAmendRepoIds([]);
      useAppStore.getState().dismissBatchReport();
    } else {
      setAmendRepoIds(amendRepoIds.filter((repoId) => failedRepoIds.has(repoId)));
    }
  };
  const doSave = async (kind: 'stash' | 'shelf') => {
    if (saveBusy) return;
    for (const repo of commitTargets.filter((item) => item.meta.kind === 'git')) {
      const paths = selectedByRepo.get(repo.meta.id) ?? [];
      if (kind === 'stash') await useAppStore.getState().stashOperation(repo.meta.id, { type: 'create', message: message.trim() || t('WIP stash'), paths, include_untracked: true });
      else await useAppStore.getState().shelfOperation(repo.meta.id, { type: 'create', name: message.trim() || t('WIP shelf'), paths });
    }
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
      { id: 'history', label: t('File history'), icon: 'history' },
      { id: 'commit-history', label: t('Show in commit history'), icon: 'git-commit' },
      { id: 'open', label: t('Open file'), icon: 'go-to-file' },
      { id: 'reveal', label: t('Reveal in File Manager'), icon: 'folder-opened' },
    );
    if (kind !== 'repo' && value.path && (git || allUntracked)) items.push(
      { separator: true },
      { id: 'ignore', label: t(git ? 'Add to .gitignore' : 'Add to SVN Ignore'), icon: 'exclude' },
    );
    if (files.length && kind !== 'repo') items.push({ separator: true }, { id: 'delete', label: t('Delete'), icon: 'trash', danger: true });
    if (changelistEnabled && files.length) items.push(
      { separator: true },
      { id: 'move-to-changelist', label: t('Move to Changelist…'), icon: 'list-unordered' },
    );
    if (kind === 'repo') items.push(
      { separator: true },
      { id: 'open-all-changes', label: t('Open All Changes'), icon: 'diff-multiple' },
      { id: 'manage', label: t('Manage Repository'), icon: 'git-branch' },
      { id: 'view-log', label: t(git ? 'View Git Log' : 'View SVN Log'), icon: 'git-commit' },
      { separator: true },
      { id: 'hide-repo', label: t('Hide Repository'), icon: 'eye-closed' },
    );
    items.push({ separator: true }, { id: 'refresh', label: t('Refresh'), icon: 'refresh' });
    if (repo.meta.kind === 'svn') items.push({ separator: true }, { id: 'manage-ignore', label: t('Manage SVN Ignore...'), icon: 'list-unordered' });
    return items;
  };
  const getChangelistFiles = (clId: string) => {
    const result: Array<{ repo: RepositoryStatus; files: FileChange[] }> = [];
    for (const r of repos) {
      if (clId === 'unversioned') {
        const files = r.files.filter((f) => f.status === 'untracked');
        if (files.length) result.push({ repo: r, files });
      } else if (clId === 'default' || clId === 'unassigned') {
        const entries = changelists[r.meta.id] ?? [];
        const assigned = new Set(entries.flatMap((e) => e.files));
        const files = r.files.filter((f) => !assigned.has(f.path) && f.status !== 'untracked');
        if (files.length) result.push({ repo: r, files });
      } else {
        const entries = changelists[r.meta.id] ?? [];
        const entry = entries.find((e) => e.id === clId);
        if (entry) {
          const assigned = new Set(entry.files);
          const files = r.files.filter((f) => assigned.has(f.path) && f.status !== 'untracked');
          if (files.length) result.push({ repo: r, files });
        }
      }
    }
    return result;
  };
  const clHeaderItems = (clId: string): ContextMenuEntry[] => {
    const isEmpty = clId === 'empty';
    const isUnversioned = clId === 'unversioned';
    const isCustom = clId !== 'default' && clId !== 'unassigned' && !isUnversioned && !isEmpty;
    const clFiles = getChangelistFiles(clId);
    const hasGitTargets = clFiles.some((g) => g.repo.meta.kind === 'git');
    const items: ContextMenuEntry[] = [];

    if (isEmpty) {
      return [
        { id: 'cl-new', label: t('New Changelist…'), icon: 'add' },
        { separator: true },
        { id: 'refresh', label: t('Refresh'), icon: 'refresh' },
      ];
    }

    items.push({ id: 'cl-rollback', label: t('Rollback'), icon: 'discard' });
    if (hasGitTargets) {
      items.push(
        { id: 'cl-shelve', label: t('Shelve Changes'), icon: 'archive' },
        { id: 'cl-stash', label: t('Stash Changes'), icon: 'save' },
      );
    }
    if (isUnversioned) {
      items.push(
        { separator: true },
        { id: 'cl-add-to-git', label: t('Add to Git'), icon: 'add' },
      );
    }
    items.push(
      { separator: true },
      { id: 'cl-new', label: t('New Changelist…'), icon: 'add' },
    );
    if (isCustom) {
      items.push(
        { id: 'cl-rename', label: t('Rename Changelist…'), icon: 'edit' },
        { separator: true },
        { id: 'cl-delete', label: t('Delete Changelist'), icon: 'trash', danger: true },
      );
    }
    items.push(
      { separator: true },
      { id: 'refresh', label: t('Refresh'), icon: 'refresh' },
    );
    return items;
  };
  const handleClHeaderAction = async (actionId: string) => {
    const clCtx = clHeaderContext;
    if (!clCtx) return;
    const clId = clCtx.changelistId;
    const clFiles = getChangelistFiles(clId);
    switch (actionId) {
      case 'refresh': {
        await useAppStore.getState().refresh();
        break;
      }
      case 'cl-add-to-git': {
        for (const g of clFiles) {
          await stage(g.repo.meta.id, g.files.map((f) => f.path));
        }
        break;
      }
      case 'cl-new': {
        const name = await promptDialog({
          title: t('New Changelist'),
          message: t('Create a new changelist.'),
          inputLabel: t('Changelist name'),
          initialValue: '',
        });
        if (name?.trim()) {
          const target = repos[0];
          if (target) await changelistOperation(target.meta.id, { type: 'create', name: name.trim() });
        }
        break;
      }
      case 'cl-rename': {
        let currentName = '';
        for (const r of repos) {
          const e = (changelists[r.meta.id] ?? []).find((entry) => entry.id === clId);
          if (e) { currentName = e.name; break; }
        }
        const newName = await promptDialog({
          title: t('Rename Changelist'),
          message: t('Enter a new changelist name.'),
          inputLabel: t('Changelist name'),
          initialValue: currentName,
        });
        if (newName && newName !== currentName) {
          const target = repos.find((r) => (changelists[r.meta.id] ?? []).some((entry) => entry.id === clId));
          if (target) await changelistOperation(target.meta.id, { type: 'rename', changelist_id: clId, name: newName });
        }
        break;
      }
      case 'cl-delete': {
        let currentName = '';
        for (const r of repos) {
          const e = (changelists[r.meta.id] ?? []).find((entry) => entry.id === clId);
          if (e) { currentName = e.name; break; }
        }
        const total = clFiles.reduce((sum, g) => sum + g.files.length, 0);
        if (await confirmDialog({
          title: t('Delete Changelist'),
          message: `${t('Delete changelist {0}?', currentName || clId)}\n${total} ${t('file')}`,
          danger: true,
        })) {
          const target = repos.find((r) => (changelists[r.meta.id] ?? []).some((entry) => entry.id === clId));
          if (target) await changelistOperation(target.meta.id, { type: 'delete', changelist_id: clId });
        }
        break;
      }
      case 'cl-shelve': {
        let currentName = t('Shelve changes');
        for (const r of repos) {
          const e = (changelists[r.meta.id] ?? []).find((entry) => entry.id === clId);
          if (e) { currentName = e.name; break; }
        }
        const shelfName = await promptDialog({
          title: t('Shelve changes'),
          message: t('Enter a shelf name.'),
          inputLabel: t('Shelf name'),
          initialValue: currentName,
        });
        if (shelfName?.trim()) {
          for (const g of clFiles.filter((g) => g.repo.meta.kind === 'git')) {
            await useAppStore.getState().shelfOperation(g.repo.meta.id, {
              type: 'create',
              name: shelfName.trim(),
              paths: g.files.map((f) => f.path),
            });
          }
        }
        break;
      }
      case 'cl-stash': {
        let currentName = t('Stash changes');
        for (const r of repos) {
          const e = (changelists[r.meta.id] ?? []).find((entry) => entry.id === clId);
          if (e) { currentName = e.name; break; }
        }
        const stashMessage = await promptDialog({
          title: t('Stash changes'),
          message: t('Enter a stash message.'),
          inputLabel: t('Stash message'),
          initialValue: currentName,
        });
        if (stashMessage?.trim()) {
          for (const g of clFiles.filter((g) => g.repo.meta.kind === 'git')) {
            await useAppStore.getState().stashOperation(g.repo.meta.id, {
              type: 'create',
              message: stashMessage.trim(),
              include_untracked: clId === 'unversioned',
              paths: g.files.map((f) => f.path),
            });
          }
        }
        break;
      }
      case 'cl-rollback': {
        const total = clFiles.reduce((sum, g) => sum + g.files.length, 0);
        if (!total) break;
        const details = clFiles.flatMap((g) => g.files.map((f) => `${g.repo.meta.name}: ${f.path}`)).join('\n');
        if (await confirmDialog({
          title: t('Rollback'),
          message: `${t('Discard changes to {0} files? This cannot be undone.', total)}\n\n${details}`,
          danger: true,
        })) {
          for (const g of clFiles) {
            await discard(g.repo.meta.id, g.files.map((f) => f.path));
            setFiles(g.repo.meta.id, g.files.map((f) => f.path), false);
          }
        }
        break;
      }
    }
    setClHeaderContext(undefined);
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
      case 'commit-history': if (file) await useAppStore.getState().openHistoryForPath(repo.meta.id, file.path); break;
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
        const untrackedPaths = files.filter((file) => file.status === 'untracked').map((file) => file.path);
        const customEntries = (changelists[repo.meta.id] ?? []);
        const choices = [
          { id: '__new__', label: `+ ${t('New Changelist…')}`, icon: 'add' },
          { id: 'none', label: t('Default Changelist'), icon: 'source-control' },
          ...customEntries.map((entry) => ({ id: entry.id, label: entry.name, description: `${entry.files.length} ${t('file')}`, icon: 'list-unordered' })),
        ];
        const target = await choiceDialog({
          title: t('Move to Changelist…'),
          message: paths.join('\n'),
          choices,
        });
        if (target === '__new__') {
          const newName = await promptDialog({
            title: t('New Changelist'),
            message: t('Create a new changelist.'),
            inputLabel: t('Changelist name'),
            initialValue: '',
          });
          if (newName?.trim()) {
            if (untrackedPaths.length > 0) await stage(repo.meta.id, untrackedPaths);
            await changelistOperation(repo.meta.id, { type: 'create', name: newName.trim() });
            const updatedList = useAppStore.getState().changelists[repo.meta.id] ?? [];
            const created = updatedList.find((e) => e.name === newName.trim());
            if (created) {
              await changelistOperation(repo.meta.id, { type: 'assign', changelist_id: created.id, paths });
            }
          }
        } else if (target) {
          if (untrackedPaths.length > 0) await stage(repo.meta.id, untrackedPaths);
          await changelistOperation(repo.meta.id, { type: 'assign', changelist_id: target === 'none' ? null : target, paths });
        }
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
      case 'delete': await confirmDelete(repo, files); break;
      case 'open-all-changes': openWorkingChanges(repo.meta.id); break;
      case 'manage': openIdentityPanel(repo.meta.id); break;
      case 'view-log': await selectRepo(repo.meta.id, true); break;
      case 'hide-repo': {
        const currentSettings = useAppStore.getState().bootstrap?.state.settings;
        if (currentSettings) await useAppStore.getState().updateSettings({ hiddenRepositoryIds: [...new Set([...(currentSettings.hiddenRepositoryIds ?? []), repo.meta.id])] });
        break;
      }
      case 'refresh': await refreshPanel(); break;
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

  const panelViewMode = tab === 'shelf' ? shelfViewMode : tab === 'stash' ? stashViewMode : viewMode;
  const setPanelViewMode = (mode: 'tree' | 'list') => {
    if (tab === 'shelf') setShelfViewMode(mode);
    else if (tab === 'stash') setStashViewMode(mode);
    else setFileViewMode(mode);
    setViewMenu(false);
  };
  const setPanelExpansion = (expanded: boolean) => {
    if (tab === 'shelf') setShelfExpansion((current) => ({ sequence: current.sequence + 1, expanded }));
    else if (tab === 'stash') setStashExpansion((current) => ({ sequence: current.sequence + 1, expanded }));
    else setExpansion((current) => ({ sequence: current.sequence + 1, expanded }));
    if (tab === 'changes' || tab === 'shelf' || tab === 'stash') {
      setExpandedByTab((current) => ({ ...current, [tab]: expanded }));
    }
    setViewMenu(false);
  };
  const markPanelExpansionMixed = (target: 'changes' | 'shelf' | 'stash') => {
    setExpandedByTab((current) => current[target] === null ? current : { ...current, [target]: null });
  };
  const showPanelViewOptions = tab === 'changes' || tab === 'shelf' || tab === 'stash';
  const panelExpanded = showPanelViewOptions ? expandedByTab[tab as 'changes' | 'shelf' | 'stash'] : null;
  const panelToolbar = <div className="panel-toolbar">
    <strong title={t('VersionDock Commit')}>{t('VersionDock Commit')}</strong>
    <span />
    <button disabled={workspaceBusy || fetchTargets.length === 0} title={t('Fetch')} onClick={() => void Promise.all(fetchTargets.map((repo) => useAppStore.getState().sync(repo.meta.id, 'fetch')))}><Codicon name="cloud-download" /></button>
    <button disabled={workspaceBusy} title={t('Refresh')} onClick={() => void refreshPanel()}><Codicon name="refresh" /></button>
    {showPanelViewOptions && <div ref={viewMenuRef} className="view-options panel-view-options">
      <button title={t('View options')} className={viewMenu ? 'selected' : ''} onClick={(event) => { event.stopPropagation(); setViewMenu((value) => !value); }}><Codicon name="eye" /></button>
      {viewMenu && <div className="view-options-menu" onClick={(event) => event.stopPropagation()}>
        <strong>{t('Expand Mode')}</strong>
        <button className={panelExpanded === true ? 'selected' : ''} onClick={() => setPanelExpansion(true)}><Codicon name="expand-all" />{t('Expand all')}{panelExpanded === true && <Codicon name="check" />}</button>
        <button className={panelExpanded === false ? 'selected' : ''} onClick={() => setPanelExpansion(false)}><Codicon name="collapse-all" />{t('Collapse all')}{panelExpanded === false && <Codicon name="check" />}</button>
        <strong>{t('View options')}</strong>
        <button className={panelViewMode === 'list' ? 'selected' : ''} onClick={() => setPanelViewMode('list')}><Codicon name="list-unordered" />{t('Flat list')}{panelViewMode === 'list' && <Codicon name="check" />}</button>
        <button className={panelViewMode === 'tree' ? 'selected' : ''} onClick={() => setPanelViewMode('tree')}><Codicon name="list-tree" />{t('Tree view')}{panelViewMode === 'tree' && <Codicon name="check" />}</button>
      </div>}
    </div>}
    <button className={settings ? 'selected' : ''} title={t('Settings')} aria-label={t('Settings')} onClick={() => setSettings(!settings)}><Codicon name="settings-gear" /></button>
  </div>;
  const panelOverlays = <>{settings && <SettingsPanel onClose={() => setSettings(false)} />}{ignoreManager && <IgnoreRulesPanel repoId={ignoreManager.repoId} directory={ignoreManager.directory} close={() => setIgnoreManager(undefined)} />}</>;

  if (branchWorkingDiffOpen) return <aside className="commit-panel">{panelToolbar}{panelOverlays}<BranchWorkingDiffPanel /></aside>;

  return (
    <aside className="commit-panel" onClick={() => setContext(undefined)}>
      {panelToolbar}
      {panelOverlays}
      <div className="commit-tabs"><button title={t('Changes')} className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}><Codicon name="source-control" />{tab === 'changes' && <span>{t('Changes')}</span>}{totalChanges > 0 && <b>{totalChanges}</b>}</button>{shelfEnabled && <button title={t('Shelf')} className={tab === 'shelf' ? 'active' : ''} onClick={() => setTab('shelf')}><Codicon name="archive" />{tab === 'shelf' && <span>{t('Shelf')}</span>}{shelfCount > 0 && <b>{shelfCount}</b>}</button>}{stashEnabled && <button title={t('Stash')} className={tab === 'stash' ? 'active' : ''} onClick={() => setTab('stash')}><Codicon name="save" />{tab === 'stash' && <span>{t('Stash')}</span>}{stashCount > 0 && <b>{stashCount}</b>}</button>}{worktreeEnabled && <button title={t('Worktrees')} className={tab === 'worktree' ? 'active' : ''} onClick={() => setTab('worktree')}><Codicon name="worktree" />{tab === 'worktree' && <span>{t('Worktrees')}</span>}{worktreeCount > 0 && <b>{worktreeCount}</b>}</button>}{subtreeEnabled && <button title={t('Subtree')} className={tab === 'subtree' ? 'active' : ''} onClick={() => setTab('subtree')}><Codicon name="repo" />{tab === 'subtree' && <span>{t('Subtree')}</span>}{subtreeCount > 0 && <b>{subtreeCount}</b>}</button>}{gitRepos.length > 0 && <button title={t('Push')} className={tab === 'push' ? 'active' : ''} onClick={() => { setTab('push'); void useAppStore.getState().loadUnpushedCommits(); }}><Codicon name="cloud-upload" />{tab === 'push' && <span>{t('Push')}</span>}{totalToPush > 0 && <b>{totalToPush}</b>}</button>}</div>
      {tab === 'push' ? <PushPanel repos={gitRepos} /> : tab === 'subtree' ? <SubtreePanel repos={gitRepos} /> : tab === 'worktree' ? <WorktreePanel repos={gitRepos} /> : tab === 'shelf' ? <ShelfPanel repos={gitRepos} selectedPaths={selectedByRepo} viewMode={shelfViewMode} expansion={shelfExpansion} onManualExpansionChange={() => markPanelExpansionMixed('shelf')} onOpenFileDiff={(repoId, shelfId, path) => void openShelfDiff(repoId, shelfId, path)} /> : tab === 'stash' ? <StashPanel repos={gitRepos} selectedPaths={selectedByRepo} viewMode={stashViewMode} expansion={stashExpansion} onManualExpansionChange={() => markPanelExpansionMixed('stash')} onOpenFileDiff={(repoId, reference, path) => void openStashDiff(repoId, reference, path)} /> : <>
      {conflicts.length > 0 ? (
        <ConflictBanner
          summary={(() => {
            const conflictRepos = repos.filter((r) => r.files.some((f) => f.conflicted) || r.conflicts > 0);
            const repoCount = conflictRepos.length || 1;
            const fileCount = conflicts.length;
            const repoSummary = repoCount === 1 ? t('{0} repository', repoCount) : t('{0} repositories', repoCount);
            const fileSummary = fileCount === 1 ? t('{0} unresolved conflict file', fileCount) : t('{0} unresolved conflict files', fileCount);
            return `${repoSummary} · ${fileSummary}`;
          })()}
          actions={(() => {
            const conflict = conflicts[0];
            const requiresSideSelection = Boolean(conflict.conflictType && !['text', 'binary'].includes(conflict.conflictType));
            const resolutionActions = requiresSideSelection ? [
              {
                id: 'accept-current',
                label: t('Accept Current'),
                title: t('Accept Current'),
                tone: 'primary' as const,
                onClick: () => { void resolveConflict(conflict, 'mine'); },
              },
              {
                id: 'accept-incoming',
                label: t('Accept Incoming'),
                title: t('Accept Incoming'),
                tone: 'primary' as const,
                onClick: () => { void resolveConflict(conflict, 'theirs'); },
              },
            ] : [
              {
                id: 'resolve',
                label: t('Resolve Conflicts'),
                title: t('Open the conflicts panel to resolve files'),
                tone: 'primary' as const,
                onClick: () => { void openMerge(conflict); },
              },
            ];
            return [
              ...resolutionActions,
              ...(activeOperationRepo?.operation
                ? [
                  {
                    id: 'abort',
                    label: activeOperationRepo.operation === 'rebase' ? t('Abort Rebase') : t('Abort Merge'),
                    title: t('Abort {0}?', activeOperationRepo.operation),
                    tone: 'danger' as const,
                    onClick: () => {
                      void confirmDialog({
                        title: t('Abort {0}?', activeOperationRepo.operation!),
                        message: `${activeOperationRepo.meta.name}\n${t('This can discard the in-progress operation state.')}`,
                        danger: true,
                      }).then((yes) => {
                        if (yes) return abortRepositoryOperation(activeOperationRepo.meta.id, activeOperationRepo.operation!);
                      });
                    },
                  },
                ]
                : []),
              ...(restorableConflictRepoIds.length
                ? [{
                  id: 'restore-current',
                  label: t('Restore Current Branch'),
                  title: t('Discard conflicted index and working tree changes'),
                  tone: 'danger' as const,
                  onClick: () => {
                    void confirmDialog({ title: t('Restore Current Branch?'), message: t('All conflicted files without an active Git operation will be restored. This cannot be undone.'), danger: true }).then((yes) => {
                      if (yes) return restoreConflicts(restorableConflictRepoIds);
                    });
                  },
                }]
                : []),
            ];
          })()}
        />
      ) : activeOperationRepo?.operation ? (
        <ConflictBanner
          title={activeOperationRepo.operation === 'rebase' ? t('Rebase in progress') : t('Merge in progress')}
          summary={activeOperationRepo.meta.name}
          actions={[
            {
              id: 'abort',
              label: activeOperationRepo.operation === 'rebase' ? t('Abort Rebase') : t('Abort Merge'),
              title: t('Abort {0}?', activeOperationRepo.operation),
              tone: 'danger',
              onClick: () => {
                void confirmDialog({
                  title: t('Abort {0}?', activeOperationRepo.operation!),
                  message: `${activeOperationRepo.meta.name}\n${t('This can discard the in-progress operation state.')}`,
                  danger: true,
                }).then((yes) => {
                  if (yes) return abortRepositoryOperation(activeOperationRepo.meta.id, activeOperationRepo.operation!);
                });
              },
            },
          ]}
        />
      ) : null}
      <div className="changes-scroll">
        {!repos.length && <div className="empty-state"><Codicon name="source-control" />{t('No repositories found')}</div>}
        {changelistEnabled ? (
          <ChangelistView
            repos={repos}
            changelists={changelists}
            selected={selected}
            setFiles={setFiles}
            onFile={(repoId, file) => void openDiff(repoId, file.path, file.staged && !file.unstaged)}
            onContext={(event, file, repo) => {
              event.preventDefault();
              event.stopPropagation();
              setContext({ x: event.clientX, y: event.clientY, kind: 'file', repo, files: [file], path: file.path });
            }}
            onFolderContext={(event, folderPath, files, repo) => {
              event.preventDefault();
              event.stopPropagation();
              setContext({ x: event.clientX, y: event.clientY, kind: 'folder', repo, files, path: folderPath });
            }}
            onRepoContext={(event, repo, clId) => {
              event.preventDefault();
              event.stopPropagation();
              setContext({ x: event.clientX, y: event.clientY, kind: 'repo', repo, files: repo.files, changelistId: clId });
            }}
            onHeaderContextMenu={(event, clId) => {
              setClHeaderContext({ x: event.clientX, y: event.clientY, changelistId: clId });
            }}
            onEmptyContextMenu={(event) => {
              setClHeaderContext({ x: event.clientX, y: event.clientY, changelistId: 'empty' });
            }}
            viewMode={viewMode as 'tree' | 'list'}
            expansion={expansion}
            openWorkingChanges={(repoId) => openWorkingChanges(repoId)}
            onManageRepo={(repoId) => openIdentityPanel(repoId)}
          />
        ) : (
          repos.map((repo) => {
            const fileProps = {
              selected,
              setFiles,
              onFile: (file: FileChange) => void openDiff(repo.meta.id, file.path, file.staged && !file.unstaged),
              onContext: (event: React.MouseEvent, file: FileChange) => {
                event.preventDefault();
                event.stopPropagation();
                setContext({ x: event.clientX, y: event.clientY, kind: 'file' as const, repo, files: [file], path: file.path });
              },
              onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[]) => {
                event.preventDefault();
                event.stopPropagation();
                setContext({ x: event.clientX, y: event.clientY, kind: 'folder' as const, repo, files, path: folderPath });
              },
              onRepoContext: (event: React.MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                setContext({ x: event.clientX, y: event.clientY, kind: 'repo' as const, repo, files: repo.files });
              },
              viewMode: viewMode as 'tree' | 'list',
              expansion,
              onManualExpansionChange: () => markPanelExpansionMixed('changes'),
            };
            return (
              <div key={repo.meta.id} onMouseDown={() => void selectRepo(repo.meta.id)}>
                <RepoFiles repo={repo} {...fileProps} />
              </div>
            );
          })
        )}
      </div>
      <div className="commit-form">
        <div className="commit-resize-grip" role="separator" tabIndex={0} aria-label={t('Resize commit message')} aria-orientation="horizontal" aria-valuemin={52} aria-valuemax={Math.round(window.innerHeight * 0.55)} aria-valuenow={Math.round(textareaHeight)} onPointerDown={startTextareaResize} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setTextareaHeight((value) => Math.max(52, Math.min(window.innerHeight * 0.55, value + (event.key === 'ArrowUp' ? 10 : -10)))); } }}><i /></div>
        {repos.length > 1 && <div className="commit-targets">{commitTargets.length === 0 ? <span>{t('No files selected')}</span> : commitTargets.map((repo) => <em key={repo.meta.id} style={{ color: repo.meta.color, background: `${repo.meta.color}28`, borderColor: `${repo.meta.color}60` }}><button title={t('Remove {0}', repo.meta.name)} onClick={() => setFiles(repo.meta.id, repo.files.map((file) => file.path), false)}><Codicon name="close" /></button>{repo.meta.name}<b>{selectedByRepo.get(repo.meta.id)?.length}</b></em>)}</div>}
        {showAmend && amendTarget && <div className="commit-options"><label title={t('Amend')}><input type="checkbox" checked={amendRepos.has(amendTarget.meta.id)} onChange={() => { const next = new Set(amendRepos); if (next.has(amendTarget.meta.id)) next.delete(amendTarget.meta.id); else next.add(amendTarget.meta.id); setAmendRepoIds([...next]); }} />{t('Amend')}</label></div>}
        <div className="commit-message-tools"><button type="button" disabled={!commitTargets.length} title={t('View commit message history')} onClick={() => void openMessageHistory()}><Codicon name="history" /></button><button type="button" disabled={!commitTargets.length} title={t('Use Last Commit Message')} onClick={() => void fillLastMessage()}><Codicon name="arrow-circle-down" /></button></div>
        {mergeMessageSuggestion && <div className="merge-message-suggestion" role="status"><span>{t('Merge message suggestion')}: {mergeMessageSuggestion}</span><button type="button" onClick={applyMergeMessageSuggestion}>{t('Use Merge Message')}</button><button type="button" onClick={dismissMergeMessageSuggestion}>{t('Ignore')}</button></div>}
        <textarea style={{ height: textareaHeight }} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`${t('Commit message')} (Cmd+Enter ${t('Commit')})`} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void doCommit(defaultCommitAction === 'commitAndPush'); }} />
        <div className="commit-actions">
          <div ref={saveMenuRef} className="split-button save-action"><button disabled={!message.trim() || !commitTargets.length || saveBusy} onClick={() => void doSave(defaultSaveAction)}><Codicon name={defaultSaveAction === 'shelf' ? 'archive' : 'save'} />{t(defaultSaveAction === 'shelf' ? 'Shelve' : 'Stash')}</button><button disabled={!message.trim() || !commitTargets.length || saveBusy} onClick={() => { setSaveMenu((value) => !value); setCommitMenu(false); }}><Codicon name="chevron-down" /></button>{saveMenu && <div className="split-menu"><button disabled={saveBusy} onClick={() => { void doSave('stash'); setSaveMenu(false); }}><Codicon name="save" />{t('Stash changes')}</button><button disabled={saveBusy} onClick={() => { void doSave('shelf'); setSaveMenu(false); }}><Codicon name="archive" />{t('Shelve changes')}</button></div>}</div>
          <div ref={commitMenuRef} className="split-button commit-action"><button title={commitDisabledReason} disabled={!message.trim() || !commitTargets.length || commitBusy || Boolean(commitUnavailable) || (defaultCommitAction === 'commitAndPush' && Boolean(pushUnavailable))} onClick={() => void doCommit(defaultCommitAction === 'commitAndPush')}><Codicon name={defaultCommitAction === 'commitAndPush' ? 'cloud-upload' : 'check'} />{t(defaultCommitAction === 'commitAndPush' ? 'Commit & Push' : 'Commit')}</button><button disabled={!message.trim() || !commitTargets.length || commitBusy || Boolean(commitUnavailable)} onClick={() => { setCommitMenu((value) => !value); setSaveMenu(false); }}><Codicon name="chevron-down" /></button>{commitMenu && <div className="split-menu right"><button disabled={commitBusy || Boolean(commitUnavailable)} title={commitUnavailable ? capabilityReason(commitUnavailable.capabilities, 'commit') : undefined} onClick={() => { void doCommit(false); setCommitMenu(false); }}><Codicon name="check" />{t('Commit')}</button><button disabled={commitBusy || Boolean(commitUnavailable || pushUnavailable)} title={commitDisabledReason} onClick={() => { void doCommit(true); setCommitMenu(false); }}><Codicon name="cloud-upload" />{t('Commit & Push')}</button></div>}</div>
        </div>
      </div>
      {context && <ContextMenu x={context.x} y={context.y} items={contextItems(context)} onSelect={(id) => void handleContextAction(id)} onClose={() => setContext(undefined)} />}
      {clHeaderContext && <ContextMenu x={clHeaderContext.x} y={clHeaderContext.y} items={clHeaderItems(clHeaderContext.changelistId)} onSelect={(id) => void handleClHeaderAction(id)} onClose={() => setClHeaderContext(undefined)} />}
      {historyOpen && <div className="dialog-backdrop" role="presentation"><section ref={historyDialog} className="app-dialog commit-message-history-dialog" role="dialog" aria-modal="true" aria-label={t('Commit Message History')}>
        <header><Codicon name="history" /><strong>{t('Commit Message History')}</strong></header>
        <div className="dialog-choice-list">{historyLoading ? <span>{t('Loading…')}</span> : historyMessages.length ? historyMessages.map((item) => <button key={`${item.repoId}:${item.revision}`} type="button" onClick={() => { setMessage(item.message); setHistoryOpen(false); messageRequestRef.current?.abort(); }}><strong>{item.message.split('\n')[0]}</strong><small>{item.committedAt}</small></button>) : <span>{t('No commit message history')}</span>}</div>
        <footer><button type="button" onClick={() => { setHistoryOpen(false); messageRequestRef.current?.abort(); }}>{t('Close')}</button></footer>
      </section></div>}
      </>}
    </aside>
  );
}
