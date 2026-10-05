import { scrollbarContains } from '../scrollbars/ownership';
import { changeStatus } from '../theme/changeStatus';
import { SplitButtonMore } from './SplitButtonMore';
import { AiGenerationBorder } from './AiGenerationBorder';
import { AiCommitActions, AiCommitGenerator } from './AiCommitActions';
import { useAiStore } from '../ai/aiStore';
import { IconButton } from './IconButton';
import { RepositoryBranchBadge } from './RepositoryBranchBadge';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { SyncPanel } from './SyncPanel';
import { SubmodulePanel } from './SubmodulePanel';
import { FileIcon } from './FileIcon';
import { SettingsPanel } from './SettingsPanel';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { IgnoreRulesPanel } from './IgnoreRulesPanel';
import { ChangelistView } from './ChangelistView';
import { StatusMark } from './ChangelistGroup';
import { BranchWorkingDiffPanel } from './BranchWorkingDiffPanel';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';
import { BranchMenuPopover } from './StatusBar/BranchMenuPopover';
import { ProviderPanel } from './ProviderPanel';
import { InvertSelectionIcon, SelectAllIcon, WarningConflictIcon } from './CustomIcons';
import { performCommitSafetyCheck } from '../history/safetyCheck';
import { useSpeedSearch } from '../hooks/useSpeedSearch';
import { SpeedSearchIndicator } from './SpeedSearchIndicator';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SubmoduleDiffModal } from './SubmoduleDiffModal';
import { VscodeChangesView } from './VscodeChangesView';
import { useBridge } from '../platform/context';
import { SelectionCheckbox } from './SelectionCheckbox';
import { hasMixedRepositoryKinds, repositoryLabel } from './repoLabel';
import { buildChangeContextMenu } from './commitPanelMenus';
import { ChangeRowActions } from './ChangeRowActions';
import { ChangeRowHighlightContext, useChangeRowHighlight } from './changeRowHighlight';
import { CommitTabs } from './CommitTabs';

const COMMIT_TEXTAREA_HEIGHT_KEY = 'versiondock:commit-message-textarea-height';

function loadPersistedTextareaHeight(): number | null {
  try {
    const raw = localStorage.getItem(COMMIT_TEXTAREA_HEIGHT_KEY);
    if (raw === null) return null;
    const stored = Number(raw);
    if (!Number.isFinite(stored)) return null;
    return Math.max(52, Math.min(Math.floor(window.innerHeight * 0.5), stored));
  } catch {
    return null;
  }
}

function persistTextareaHeight(height: number): void {
  try {
    localStorage.setItem(COMMIT_TEXTAREA_HEIGHT_KEY, String(Math.round(height)));
  } catch {
    // ignore
  }
}

function PillAmendButton({
  active,
  color,
  displayName,
  onClick,
}: {
  active: boolean;
  color: string;
  displayName: string;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { t } = useI18n();
  const title = active
    ? t('Amend active for {0} (click to cancel)', displayName)
    : t('Amend last commit for {0}', displayName);

  return (
    <button
      type="button"
      className="pill-amend-button"
      data-action-btn=""
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '2px',
        padding: '0 4px',
        marginLeft: '4px',
        height: '16px',
        lineHeight: '16px',
        borderRadius: '8px',
        fontSize: '10px',
        boxSizing: 'border-box',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'all 0.12s ease',
        border: active
          ? '1px solid var(--versiondock-selection-border)'
          : hovered
            ? `1px solid ${color}80`
            : `1px solid transparent`,
        background: active
          ? 'var(--versiondock-selection-background)'
          : hovered
            ? 'rgba(255, 255, 255, 0.16)'
            : 'rgba(255, 255, 255, 0.08)',
        color: active ? 'var(--versiondock-selection-foreground)' : 'inherit',
        opacity: active ? 1 : hovered ? 0.9 : 0.65,
        fontWeight: active ? 600 : 400,
      }}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Codicon name="history" style={{ fontSize: '10px', lineHeight: 1 }} />
      <span>{t('Amend')}</span>
    </button>
  );
}

const emptyRepositories: RepositoryStatus[] = [];
type ExpansionCommand = { sequence: number; expanded: boolean };
type ChangeContext = { x: number; y: number; kind: 'file' | 'folder' | 'repo'; repo: RepositoryStatus; files: FileChange[]; path?: string; changelistId?: string; stagedSection?: boolean };

type FlatChangeItem = { node: FileTreeNode; depth: number; key: string };

function flattenVisibleTree(nodes: FileTreeNode[], isExpanded: (path: string) => boolean, depth = 0): FlatChangeItem[] {
  const result: FlatChangeItem[] = [];
  for (const node of nodes) {
    result.push({ node, depth, key: node.path });
    if (!node.file && isExpanded(node.path)) result.push(...flattenVisibleTree(node.children, isExpanded, depth + 1));
  }
  return result;
}

function TreeRow({ node, depth, expanded, toggleExpanded, showDirectory, repo, selected, setFiles, onFile, onContext, onFolderContext, onRollback, onOpenFile, onResolve, onStage }: { node: FileTreeNode; depth: number; expanded: boolean; toggleExpanded: () => void; showDirectory: boolean; repo: RepositoryStatus; selected: Set<string>; setFiles: (repoId: string, paths: string[], value: boolean) => void; onFile: (file: FileChange) => void; onContext: (event: React.MouseEvent, file: FileChange) => void; onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[]) => void; onRollback: (files: FileChange[]) => void; onOpenFile: (file: FileChange) => void; onResolve: (file: FileChange) => void; onStage: (file: FileChange) => void }) {
  const { t } = useI18n();
  const highlight = useChangeRowHighlight(repo.meta.id, node.path);
  if (!node.file) {
    const selectable = node.files.filter((file) => !file.isTruncated);
    const selectedCount = selectable.filter((file) => selected.has(`${repo.meta.id}\0${file.path}`)).length;
    const allSelected = selectable.length > 0 && selectedCount === selectable.length;
    return <div className={`directory-row ${highlight}`} style={{ paddingLeft: 20 + depth * 20 }} onClick={toggleExpanded} onContextMenu={(event) => onFolderContext(event, node.path, node.files)}><SelectionCheckbox label={node.path} checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} disabled={!selectable.length} onChange={() => setFiles(repo.meta.id, selectable.map((file) => file.path), !allSelected)} /><button title={node.path} onClick={(event) => { event.stopPropagation(); toggleExpanded(); }}><Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /><FileIcon name={node.name} folder open={expanded} /><span>{node.name}</span></button><span className="change-row-actions" onClick={(event) => event.stopPropagation()}><IconButton type="button" title={t('Rollback all files in folder')} onClick={() => onRollback(node.files)}><Codicon name="discard" /></IconButton></span><b>{node.files.length}</b></div>;
  }
  const key = `${repo.meta.id}\0${node.file.path}`;
  const pathParts = node.file.path.split('/');
  const fileName = pathParts.pop() ?? node.name;
  return <div className={`file-row status-${changeStatus(node.file.status, node.file.conflicted)} ${node.file.conflicted ? 'conflicted' : ''} ${highlight}`} style={{ paddingLeft: 20 + depth * 20 }} onClick={() => onFile(node.file!)} onContextMenu={(event) => onContext(event, node.file!)}>
    <SelectionCheckbox label={node.file.path} checked={selected.has(key)} disabled={node.file.isTruncated} onChange={() => setFiles(repo.meta.id, [node.file!.path], !selected.has(key))} />
    <button title={node.file.path} onClick={(event) => { event.stopPropagation(); onFile(node.file!); }}><FileIcon name={fileName} /><span className="file-name-group"><span className="file-name">{fileName}</span>{showDirectory && <small>{pathParts.join('/')}</small>}</span></button>
    <ChangeRowActions repo={repo} file={node.file} onOpenFile={() => onOpenFile(node.file!)} onRollback={() => onRollback([node.file!])} onResolve={() => onResolve(node.file!)} onStage={() => onStage(node.file!)} />
    {node.file.isTruncated && <span title={node.file.truncationReason === 'depth-limit' ? t('Directory scan depth limit reached') : t('Directory scan item limit reached')}><Codicon name="warning" /></span>}{node.file.staged && <span className="staged-dot" />}<StatusMark file={node.file} />
  </div>;
}

function RepoFiles({ repo, selected, setFiles, onFile, onContext, onFolderContext, onRepoContext, viewMode, expansion, onManualExpansionChange, onRollback, onOpenFile, onResolve, onStage }: { repo: RepositoryStatus; selected: Set<string>; setFiles: (repoId: string, paths: string[], value: boolean) => void; onFile: (file: FileChange) => void; onContext: (event: React.MouseEvent, file: FileChange) => void; onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[]) => void; onRepoContext: (event: React.MouseEvent) => void; viewMode: 'tree' | 'list'; expansion: ExpansionCommand; onManualExpansionChange: () => void; onRollback: (files: FileChange[]) => void; onOpenFile: (file: FileChange) => void; onResolve: (file: FileChange) => void; onStage: (file: FileChange) => void }) {
  const { t } = useI18n();
  const mixedKinds = useAppStore((state) => hasMixedRepositoryKinds(state.snapshot?.repositories ?? []));
  const repoLabel = repositoryLabel(repo, mixedKinds);
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
  const [folderExpansion, setFolderExpansion] = useState<Record<string, ExpansionCommand>>({});
  const flatItems = useMemo(() => {
    if (viewMode === 'list') {
      return repo.files.map((file) => ({ node: { name: file.path.split('/').at(-1) ?? file.path, path: file.path, children: [], files: [file], file }, depth: 0, key: file.path }));
    }
    return flattenVisibleTree(tree, (path) => {
      const local = folderExpansion[path];
      return local?.sequence === expansion.sequence ? local.expanded : expansion.expanded;
    });
  }, [expansion, folderExpansion, repo.files, tree, viewMode]);
  const [filesContainer, setFilesContainer] = useState<HTMLDivElement | null>(null);
  const shouldVirtualize = flatItems.length > 40;
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? flatItems.length : 0,
    getScrollElement: () => filesContainer?.closest<HTMLElement>('.changes-scroll') ?? null,
    estimateSize: () => 22,
    scrollMargin: filesContainer?.offsetTop ?? 0,
    overscan: 10,
    enabled: shouldVirtualize,
  });
  const selectableFiles = repo.files.filter((file) => !file.isTruncated);
  const selectedCount = selectableFiles.filter((file) => selected.has(`${repo.meta.id}\0${file.path}`)).length;
  const allSelected = selectableFiles.length > 0 && selectedCount === selectableFiles.length;
  const [branchMenuAnchor, setBranchMenuAnchor] = useState<DOMRect | undefined>(undefined);
  return (
    <section className="repo-change-group">
      <div
        className="repo-heading"
        style={{ '--repo-color': repo.meta.color } as React.CSSProperties}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={onRepoContext}
        onClick={() => { onManualExpansionChange(); setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded }); }}
      >
        <SelectionCheckbox label={repoLabel} checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} disabled={!selectableFiles.length} onChange={() => setFiles(repo.meta.id, selectableFiles.map((file) => file.path), !allSelected)} />
        <div className="repo-heading-main">
          <button
            type="button"
            className="repo-heading-toggle"
            title={repo.meta.name}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              onManualExpansionChange();
              setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded });
            }}
          >
            <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
            <i style={{ background: repo.meta.color }} />
            <strong>{repo.meta.name}</strong>
          </button>
          {repo.meta.isSubmodule && (
            <span className="submodule-badge" title={t('Submodule')}>
              {t('SUB')}
            </span>
          )}
          {mixedKinds && (
            <span
              className={`vcs-badge ${repo.meta.kind === 'svn' ? 'svn' : 'git'}`}
              title={repo.meta.kind === 'svn' ? t('SVN working copy') : 'Git'}
            >
              {repo.meta.kind === 'svn' ? 'SVN' : 'GIT'}
            </span>
          )}
          <button
            type="button"
            className="repo-branch-trigger"
            data-branch-switch-badge=""
            title={t('Switch branch')}
            aria-haspopup="menu"
            aria-expanded={Boolean(branchMenuAnchor)}
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setBranchMenuAnchor((cur) => (cur ? undefined : rect));
            }}
          >
            <RepositoryBranchBadge repo={repo} className="branch-chip" />
          </button>
        </div>
        {branchMenuAnchor && (
          <BranchMenuPopover
            anchorRect={branchMenuAnchor}
            initialRepoId={repo.meta.id}
            repoOnly
            onClose={() => setBranchMenuAnchor(undefined)}
          />
        )}
        <div className="repo-actions">
          {repo.files.length > 0 && (
            <IconButton
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
            </IconButton>
          )}
          {repo.files.length > 0 && (
            <span className={`count-badge ${selectedCount > 0 ? 'selected' : ''}`}>
              {selectedCount}/{repo.files.length}
            </span>
          )}
        </div>
      </div>
      {expanded && !repo.files.length && <div className="repo-no-changes">{t('No changes')}</div>}
      {expanded && <div ref={setFilesContainer} className="virtual-change-files" style={shouldVirtualize ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}>
        {(shouldVirtualize ? virtualizer.getVirtualItems().map((virtualRow) => ({ item: flatItems[virtualRow.index], start: virtualRow.start - virtualizer.options.scrollMargin })) : flatItems.map((item) => ({ item, start: undefined }))).map(({ item, start }) => item && <div key={item.key} style={start === undefined ? undefined : { position: 'absolute', top: 0, left: 0, width: '100%', height: 22, transform: `translateY(${start}px)` }}><TreeRow node={item.node} depth={item.depth} expanded={item.node.file ? false : (folderExpansion[item.node.path]?.sequence === expansion.sequence ? folderExpansion[item.node.path].expanded : expansion.expanded)} toggleExpanded={() => { if (item.node.file) return; onManualExpansionChange(); const current = folderExpansion[item.node.path]?.sequence === expansion.sequence ? folderExpansion[item.node.path].expanded : expansion.expanded; setFolderExpansion((value) => ({ ...value, [item.node.path]: { sequence: expansion.sequence, expanded: !current } })); }} showDirectory={viewMode === 'list'} repo={repo} selected={selected} setFiles={setFiles} onFile={onFile} onRollback={onRollback} onOpenFile={onOpenFile} onResolve={onResolve} onStage={onStage} onContext={onContext} onFolderContext={onFolderContext} /></div>)}
      </div>}
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
  const openConflicts = useAppStore((state) => state.openConflicts);
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
  const stashEnabled = useAppStore((state) => capabilityAvailable(state.bootstrap?.capabilities, 'stash') && (state.snapshot?.repositories.some((repo) => capabilityAvailable(repo.capabilities, 'stash', true)) ?? true));
  const shelfEnabled = useAppStore((state) => capabilityAvailable(state.bootstrap?.capabilities, 'shelf') && (state.snapshot?.repositories.some((repo) => capabilityAvailable(repo.capabilities, 'shelf', true)) ?? true));
  const worktreeEnabled = useAppStore((state) => capabilityAvailable(state.bootstrap?.capabilities, 'worktree') && (state.snapshot?.repositories.some((repo) => capabilityAvailable(repo.capabilities, 'worktree', true)) ?? true));
  const subtreeEnabled = useAppStore((state) => capabilityAvailable(state.bootstrap?.capabilities, 'subtree') && (state.snapshot?.repositories.some((repo) => capabilityAvailable(repo.capabilities, 'subtree', true)) ?? true));
  const submoduleEnabled = useAppStore((state) => capabilityAvailable(state.bootstrap?.capabilities, 'submodule') && (state.snapshot?.repositories.some((repo) => capabilityAvailable(repo.capabilities, 'submoduleWrite', true)) ?? true));
  const storedTab = useAppStore((state) => state.bootstrap?.state.layout?.activeTab ?? state.bootstrap?.state.activeTab);
  const defaultCommitAction = useAppStore((state) => state.bootstrap?.state.settings?.defaultCommitAction ?? 'commit');
  const defaultSaveAction = useAppStore((state) => state.bootstrap?.state.settings?.defaultSaveAction ?? 'stash');
  const changesDisplayMode = useAppStore((state) => state.bootstrap?.state.settings?.changesDisplayMode ?? 'simplified');
  const pushEnabled = snapshot?.repositories.some((repo) => repo.meta.kind === 'git') ?? false;
  const tab = pushEnabled && (storedTab === 'sync' || storedTab === 'push') ? 'sync' : submoduleEnabled && storedTab === 'submodule' ? 'submodule' : stashEnabled && storedTab === 'stash' ? 'stash' : shelfEnabled && storedTab === 'shelf' ? 'shelf' : worktreeEnabled && storedTab === 'worktree' ? 'worktree' : subtreeEnabled && storedTab === 'subtree' ? 'subtree' : 'changes';
  const setTab = useAppStore((state) => state.setActiveTab);
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set<string>([tab]));
  const lastTabSyncAtRef = useRef<Partial<Record<string, number>>>({});

  if (!visitedTabs.has(tab)) {
    setVisitedTabs((prev) => new Set(prev).add(tab));
  }

  const [commitMenu, setCommitMenu] = useState(false);
  const [saveMenu, setSaveMenu] = useState(false);
  const [viewMenu, setViewMenu] = useState(false);
  const switchTab = useCallback((targetTab: string) => {
    setCommitMenu(false);
    setSaveMenu(false);
    setViewMenu(false);
    setTab(targetTab as any);
    setVisitedTabs((prev) => {
      if (prev.has(targetTab)) return prev;
      const next = new Set(prev);
      next.add(targetTab);
      return next;
    });

    const now = Date.now();
    const last = lastTabSyncAtRef.current[targetTab] ?? 0;
    if (now - last < 5000) {
      return;
    }
    lastTabSyncAtRef.current[targetTab] = now;

    if (targetTab === 'sync') {
      void Promise.all([
        useAppStore.getState().loadUnpushedCommits(),
        useAppStore.getState().loadIncomingCommits(),
      ]);
    } else if (targetTab === 'submodule') {
      void useAppStore.getState().loadSubmodules();
    } else if (targetTab === 'shelf') {
      void useAppStore.getState().loadShelves();
    } else if (targetTab === 'stash') {
      void useAppStore.getState().loadStashes();
    } else if (targetTab === 'worktree') {
      void useAppStore.getState().loadWorktrees();
    } else if (targetTab === 'subtree') {
      void useAppStore.getState().loadSubtrees();
    }
  }, [setTab]);
  const speedSearch = useSpeedSearch(tab, tab === 'changes');
  const changelistCapability = useAppStore((state) => capabilityAvailable(state.bootstrap?.capabilities, 'changelist') && (state.snapshot?.repositories.some((repo) => capabilityAvailable(repo.capabilities, 'changelist', true)) ?? true));
  const changelistEnabled = changelistCapability && changesDisplayMode === 'changelists';
  const changelists = useAppStore((state) => state.changelists);
  const changelistOperation = useAppStore((state) => state.changelistOperation);
  const stashes = useAppStore((state) => state.stashes);
  const shelves = useAppStore((state) => state.shelves);
  const subtrees = useAppStore((state) => state.subtrees);
  const submodules = useAppStore((state) => state.submodules);
  const worktrees = useAppStore((state) => state.worktrees);
  const branchWorkingDiffOpen = useAppStore((state) => state.worktreeDiff?.source === 'repository');
  const commitSelections = useAppStore((state) => state.commitSelections);
  const setCommitSelection = useAppStore((state) => state.setCommitSelection);
  const selected = useMemo(() => new Set(Object.entries(commitSelections).flatMap(([repoId, paths]) => paths.map((path) => `${repoId}\0${path}`))), [commitSelections]);
  const aiMessage = useAiStore((state) => state.runs['commit-message']);
  const message = useAppStore((state) => state.commitMessage);
  const setMessage = useAppStore((state) => state.setCommitMessage);
  const mergeMessageSuggestion = useAppStore((state) => state.mergeMessageSuggestion);
  const applyMergeMessageSuggestion = useAppStore((state) => state.applyMergeMessageSuggestion);
  const dismissMergeMessageSuggestion = useAppStore((state) => state.dismissMergeMessageSuggestion);
  const amendRepoIds = useAppStore((state) => state.amendRepoIds);
  const setAmendRepoIds = useAppStore((state) => state.setAmendRepoIds);
  const amendRepos = useMemo(() => new Set(amendRepoIds), [amendRepoIds]);
  const openWorkingChanges = useAppStore((state) => state.openWorkingChanges);
  const [viewSubmenu, setViewSubmenu] = useState<'expand' | 'view'>('expand');
  const [settings, setSettings] = useState(false);
  const openIdentityPanel = useAppStore((state) => state.openIdentityPanel);
  const [ignoreManager, setIgnoreManager] = useState<{ repoId: string; directory: string }>();
  const [expansion, setExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const [shelfViewMode, setShelfViewMode] = useState<'tree' | 'list'>('tree');
  const [shelfExpansion, setShelfExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: false });
  const [stashExpansion, setStashExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: false });
  const [syncExpansion, setSyncExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const [syncFileViewMode, setSyncFileViewMode] = useState<'tree' | 'list'>('tree');
  const [syncSelectionCommand, setSyncSelectionCommand] = useState<{ sequence: number; action: 'selectAll' | 'invert' }>({ sequence: 0, action: 'selectAll' });
  const [syncHasSelectable, setSyncHasSelectable] = useState(false);
  const [syncAllSelected, setSyncAllSelected] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [expandedByTab, setExpandedByTab] = useState<Record<'changes' | 'shelf' | 'stash' | 'sync', boolean | null>>({ changes: true, shelf: false, stash: false, sync: true });
  const [manualTextareaHeight, setManualTextareaHeight] = useState<number | null>(loadPersistedTextareaHeight);
  const manualTextareaHeightRef = useRef<number | null>(manualTextareaHeight);
  useEffect(() => {
    manualTextareaHeightRef.current = manualTextareaHeight;
  }, [manualTextareaHeight]);
  const bridge = useBridge();
  const [highlightSubmodule, setHighlightSubmodule] = useState<{ repoId: string; path: string }>();
  const [submoduleDiffTarget, setSubmoduleDiffTarget] = useState<{ repo: RepositoryStatus; file: FileChange } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyDialog = useDialogFocusTrap(historyOpen, () => setHistoryOpen(false));
  const [historyMessages, setHistoryMessages] = useState<RecentCommitMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const messageRequestRef = useRef<AbortController | null>(null);
  const amendMessageRequestRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const updateManualTextareaHeight = useCallback((height: number) => {
    const nextHeight = Math.max(52, Math.min(Math.floor(window.innerHeight * 0.5), height));
    manualTextareaHeightRef.current = nextHeight;
    persistTextareaHeight(nextHeight);
    setManualTextareaHeight(nextHeight);
  }, []);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const manualHeight = manualTextareaHeightRef.current;
    if (manualHeight !== null) {
      el.style.height = `${manualHeight}px`;
      el.style.overflow = 'auto';
      return;
    }
    el.style.height = 'auto';
    const maxHeight = Math.max(52, Math.floor(window.innerHeight * 0.5));
    if (el.scrollHeight > maxHeight) {
      el.style.height = `${maxHeight}px`;
      el.style.overflow = 'auto';
    } else {
      const nextHeight = Math.max(52, el.scrollHeight);
      el.style.height = `${nextHeight}px`;
      el.style.overflow = 'hidden';
    }
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [message, resizeTextarea, manualTextareaHeight]);

  const historyIndexRef = useRef(-1);
  const historyDraftRef = useRef(message);
  const messageRef = useRef(message);
  const appliedHistoryMessageRef = useRef<string | null>(null);
  const [context, setContext] = useState<ChangeContext>();
  const selectedFile = useAppStore((state) => state.selectedFile);
  const [clHeaderContext, setClHeaderContext] = useState<{ x: number; y: number; changelistId: string }>();
  const [conflictMenuOpen, setConflictMenuOpen] = useState(false);
  const [conflictMenuPos, setConflictMenuPos] = useState<{ top: number; left: number } | null>(null);
  const conflictMenuRef = useRef<HTMLDivElement>(null);
  const conflictButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!conflictMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        conflictMenuRef.current &&
        !scrollbarContains(conflictMenuRef.current, target) &&
        !scrollbarContains(conflictButtonRef.current, target)
      ) {
        setConflictMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setConflictMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [conflictMenuOpen]);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  const commitMenuRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    if (!historyOpen) return;
    const closeOnBlur = () => setHistoryOpen(false);
    const closeWhenHidden = () => { if (document.visibilityState !== 'visible') setHistoryOpen(false); };
    const closeOnOutsideInteraction = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !scrollbarContains(historyDialog.current, target)) setHistoryOpen(false);
    };
    window.addEventListener('blur', closeOnBlur);
    document.addEventListener('visibilitychange', closeWhenHidden);
    document.addEventListener('pointerdown', closeOnOutsideInteraction, true);
    document.addEventListener('focusin', closeOnOutsideInteraction, true);
    return () => {
      window.removeEventListener('blur', closeOnBlur);
      document.removeEventListener('visibilitychange', closeWhenHidden);
      document.removeEventListener('pointerdown', closeOnOutsideInteraction, true);
      document.removeEventListener('focusin', closeOnOutsideInteraction, true);
    };
  }, [historyDialog, historyOpen]);
  const repos = snapshot?.repositories ?? emptyRepositories;
  const speedNeedle = speedSearch.query.trim().toLocaleLowerCase();
  const visibleChangeRepos = useMemo(() => !speedNeedle ? repos : repos.flatMap((repo) => {
    if (`${repo.meta.name} ${repo.branch}`.toLocaleLowerCase().includes(speedNeedle)) return [repo];
    const files = repo.files.filter((file) => file.path.toLocaleLowerCase().includes(speedNeedle));
    return files.length ? [{ ...repo, files }] : [];
  }), [repos, speedNeedle]);
  const totalChanges = repos.reduce((sum, repo) => sum + repo.files.length, 0);
  const gitRepos = useMemo(() => repos.filter((repo) => repo.meta.kind === 'git'), [repos]);
  const parentGitRepos = useMemo(() => gitRepos.filter((repo) => !repo.meta.isSubmodule), [gitRepos]);
  const updateProject = useAppStore((state) => state.updateProject);
  const [toolbarAction, setToolbarAction] = useState<'refresh' | 'update' | undefined>();
  const toolbarActionRef = useRef<'refresh' | 'update' | undefined>();
  const unpushedCommits = useAppStore((state) => state.unpushedCommits);
  const incomingCommits = useAppStore((state) => state.incomingCommits);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const stashCount = useMemo(() => gitRepos.reduce((sum, repo) => sum + (stashes[repo.meta.id]?.length ?? 0), 0), [gitRepos, stashes]);
  const shelfCount = useMemo(() => gitRepos.reduce((sum, repo) => sum + (shelves[repo.meta.id]?.length ?? 0), 0), [gitRepos, shelves]);
  const subtreeCount = useMemo(() => gitRepos.reduce((sum, repo) => sum + (subtrees[repo.meta.id]?.length ?? 0), 0), [gitRepos, subtrees]);
  const submoduleCount = useMemo(() => gitRepos.reduce((sum, repo) => sum + (submodules[repo.meta.id]?.length ?? 0), 0), [gitRepos, submodules]);
  const submoduleIssues = gitRepos.reduce((sum, repo) => sum + (submodules[repo.meta.id] ?? []).filter((entry) => !entry.initialized || entry.syncStatus === 'outOfSync').length, 0);
  const worktreeCount = useMemo(() => gitRepos.reduce((sum, repo) => sum + (worktrees[repo.meta.id]?.length ?? 0), 0), [gitRepos, worktrees]);
  const totalToPush = useMemo(() => gitRepos.reduce((sum, r) => {
    const branch = branchesByRepo[r.meta.id]?.find((item) => item.current);
    if (branch?.upstream) return sum + (r.ahead ?? 0);
    return sum + (unpushedCommits[r.meta.id]?.length ?? (r.ahead || 0));
  }, 0), [branchesByRepo, gitRepos, unpushedCommits]);
  const totalToSync = useMemo(() => totalToPush + gitRepos.reduce((sum, repo) => sum + Math.max(repo.behind, incomingCommits[repo.meta.id]?.length ?? 0), 0), [gitRepos, incomingCommits, totalToPush]);
  const runToolbarAction = async (action: 'refresh' | 'update', operation: () => Promise<void>) => {
    if (toolbarActionRef.current) return;
    toolbarActionRef.current = action;
    setToolbarAction(action);
    try {
      await operation();
    } catch (error) {
      useAppStore.getState().addNotification({ type: 'error', title: action === 'update' ? 'Project update' : 'Workspace refresh failed', message: String(error), workspaceId: snapshot?.workspace.id });
    } finally {
      toolbarActionRef.current = undefined;
      setToolbarAction(undefined);
    }
  };
  const refreshPanel = () => runToolbarAction('refresh', async () => {
    lastTabSyncAtRef.current = { [tab]: Date.now() };
    const store = useAppStore.getState();
    await store.refresh(false, { reloadRepository: false });
    if (useAppStore.getState().snapshot?.workspace.id !== snapshot?.workspace.id) return;
    const requests = [store.loadStashes(), store.loadShelves(), store.loadUnpushedCommits(), store.loadIncomingCommits()];
    if (changelistCapability) requests.push(store.loadChangelists());
    if (tab === 'worktree') requests.push(store.loadWorktrees());
    else if (tab === 'submodule') requests.push(store.loadSubmodules());
    else if (tab === 'subtree') requests.push(store.loadSubtrees());
    await Promise.all(requests);
  });
  const conflictingRepos = useMemo(
    () => repos.filter((repo) => repo.conflicts > 0 || repo.files.some((file) => file.conflicted)),
    [repos],
  );
  const totalConflicts = useMemo(
    () => conflictingRepos.reduce((sum, repo) => sum + (repo.conflicts || repo.files.filter((file) => file.conflicted).length), 0),
    [conflictingRepos],
  );
  const conflictRepoCount = conflictingRepos.length;
  const conflictSummary = useMemo(() => {
    const repoSummary = conflictRepoCount === 1 ? t('{0} repository', conflictRepoCount) : t('{0} repositories', conflictRepoCount);
    const fileSummary = totalConflicts === 1 ? t('{0} unresolved conflict file', totalConflicts) : t('{0} unresolved conflict files', totalConflicts);
    return `${repoSummary} · ${fileSummary}`;
  }, [conflictRepoCount, totalConflicts, t]);

  const activeOperationRepos = useMemo(
    () => repos.filter((repo) => repo.meta.kind === 'git' && Boolean(repo.operation)),
    [repos],
  );

  const abortTargets = activeOperationRepos;
  const abortStates = useMemo(() => new Set(abortTargets.map((r) => r.operation)), [abortTargets]);
  const abortLabel = useMemo(() => {
    if (abortTargets.length > 1) {
      if (abortStates.size > 1) return t('Abort Merge/Rebase — Select repository');
      if (abortStates.has('merge')) return t('Abort Merge — Select repository');
      if (abortStates.has('rebase')) return t('Abort Rebase — Select repository');
      if (abortStates.has('cherry-pick')) return t('Abort Cherry-pick — Select repository');
      return t('Abort Revert — Select repository');
    }
    const op = abortTargets[0]?.operation;
    if (op === 'rebase') return t('Abort Rebase');
    if (op === 'cherry-pick') return t('Abort Cherry-pick');
    if (op === 'revert') return t('Abort Revert');
    return t('Abort Merge');
  }, [abortTargets, abortStates, t]);
  const abortDesc = useMemo(() => abortTargets.map((r) => r.meta.name).join(', '), [abortTargets]);
  const abortDetail = useMemo(() => {
    if (abortTargets.length > 1) {
      if (abortStates.size > 1) return t('Select the repository whose {0} should be aborted', t('merge/rebase'));
      if (abortStates.has('merge')) return t('Select the repository whose merge should be aborted');
      if (abortStates.has('rebase')) return t('Select the repository whose rebase should be aborted');
      if (abortStates.has('cherry-pick')) return t('Select the repository whose cherry-pick should be aborted');
      return t('Select the repository whose revert should be aborted');
    }
    const op = abortTargets[0]?.operation;
    if (op === 'rebase') return t('Rebase in progress — abort and restore previous state');
    if (op === 'cherry-pick') return t('Cherry-pick in progress — abort and restore previous state');
    if (op === 'revert') return t('Revert in progress — abort and restore previous state');
    return t('Merge in progress — abort and restore previous state');
  }, [abortTargets, abortStates, t]);

  const continueTargets = useMemo(
    () => activeOperationRepos.filter((repo) => repo.conflicts === 0 && !repo.files.some((f) => f.conflicted)),
    [activeOperationRepos],
  );
  const continueStates = useMemo(() => new Set(continueTargets.map((r) => r.operation)), [continueTargets]);
  const continueLabel = useMemo(() => {
    if (continueTargets.length > 1) {
      if (continueStates.size > 1) return t('Continue Operation — Select repository');
      if (continueStates.has('merge')) return t('Commit Merge — Select repository');
      if (continueStates.has('rebase')) return t('Continue Rebase — Select repository');
      if (continueStates.has('cherry-pick')) return t('Continue Cherry-pick — Select repository');
      return t('Continue Revert — Select repository');
    }
    const op = continueTargets[0]?.operation;
    if (op === 'rebase') return t('Continue Rebase');
    if (op === 'cherry-pick') return t('Continue Cherry-pick');
    if (op === 'revert') return t('Continue Revert');
    return t('Commit Merge');
  }, [continueTargets, continueStates, t]);
  const continueDesc = useMemo(() => continueTargets.map((r) => r.meta.name).join(', '), [continueTargets]);
  const continueDetail = useMemo(() => {
    if (continueTargets.length > 1) {
      return t('All conflicts resolved. Select repository to continue operation.');
    }
    const op = continueTargets[0]?.operation;
    if (op === 'rebase') return t('All conflicts resolved. Continue rebase to apply next commits.');
    if (op === 'cherry-pick') return t('All conflicts resolved. Continue cherry-pick.');
    if (op === 'revert') return t('All conflicts resolved. Continue revert.');
    return t('All conflicts resolved. Complete merge commit.');
  }, [continueTargets, t]);

  const restorableRepos = useMemo(
    () => conflictingRepos.filter((repo) => repo.meta.kind === 'git' && !repo.operation),
    [conflictingRepos],
  );
  const totalRestorableFiles = useMemo(
    () => restorableRepos.reduce((sum, repo) => sum + (repo.conflicts || repo.files.filter((file) => file.conflicted).length), 0),
    [restorableRepos],
  );
  const restorableDesc = useMemo(
    () => totalRestorableFiles === 1 ? t('{0} unresolved conflict file', totalRestorableFiles) : t('{0} unresolved conflict files', totalRestorableFiles),
    [totalRestorableFiles, t],
  );
  const restorableDetail = t('Discard conflicted index and working tree changes, then restore the current branch versions');

  const restoreConflicts = useAppStore((state) => state.restoreConflicts);
  const continueRepositoryOperation = useAppStore((state) => state.continueRepositoryOperation);

  const handleContinueClick = useCallback(async () => {
    setConflictMenuOpen(false);
    let target: RepositoryStatus | undefined = continueTargets[0];
    if (continueTargets.length > 1) {
      const choiceId = await choiceDialog({
        title: continueLabel,
        message: continueDetail,
        choices: continueTargets.map((r) => ({
          id: r.meta.id,
          label: r.meta.name,
          description: r.operation ?? undefined,
          icon: 'git-merge',
        })),
      });
      if (!choiceId) return;
      target = continueTargets.find((r) => r.meta.id === choiceId);
    }
    if (!target || !target.operation) return;
    await continueRepositoryOperation(target.meta.id, target.operation);
  }, [continueTargets, continueLabel, continueDetail, continueRepositoryOperation]);

  const handleAbortClick = useCallback(async () => {
    setConflictMenuOpen(false);
    let target: RepositoryStatus | undefined = abortTargets[0];
    if (abortTargets.length > 1) {
      const choiceId = await choiceDialog({
        title: abortLabel,
        message: abortDetail,
        choices: abortTargets.map((r) => ({
          id: r.meta.id,
          label: r.meta.name,
          description: r.operation ?? undefined,
          icon: 'git-branch',
        })),
      });
      if (!choiceId) return;
      target = abortTargets.find((r) => r.meta.id === choiceId);
    }
    if (!target || !target.operation) return;

    const confirmTitle = t('Abort {0}?', target.operation);
    const confirmMessage = target.operation === 'merge'
      ? t('VersionDock [{0}]: Abort merge? This will restore the repository to its pre-merge state.', target.meta.name)
      : t('VersionDock [{0}]: Abort {1}? This will restore the repository to its previous state.', target.meta.name, target.operation);

    const yes = await confirmDialog({
      title: confirmTitle,
      message: confirmMessage,
      danger: true,
      confirmLabel: target.operation === 'rebase'
        ? t('Abort Rebase')
        : target.operation === 'cherry-pick'
          ? t('Abort Cherry-pick')
          : target.operation === 'revert'
            ? t('Abort Revert')
            : t('Abort Merge'),
    });
    if (yes) {
      await abortRepositoryOperation(target.meta.id, target.operation);
    }
  }, [abortTargets, abortLabel, abortDetail, abortRepositoryOperation, t]);

  const handleRestoreCurrentBranchClick = useCallback(async () => {
    setConflictMenuOpen(false);
    if (restorableRepos.length === 0 || totalRestorableFiles === 0) return;
    const singleTarget = restorableRepos.length === 1 ? restorableRepos[0] : undefined;
    const confirmMessage = singleTarget
      ? (totalRestorableFiles === 1
          ? t('VersionDock [{0}]: Restore the conflicted file to the current branch version? This discards its index and working tree changes.', singleTarget.meta.name)
          : t('VersionDock [{0}]: Restore {1} conflicted files to their current branch versions? This discards their index and working tree changes.', singleTarget.meta.name, totalRestorableFiles))
      : (totalRestorableFiles === 1
          ? t('VersionDock: Restore the conflicted file to the current branch version? This discards its index and working tree changes.')
          : t('VersionDock: Restore {0} conflicted files to their current branch versions? This discards their index and working tree changes.', totalRestorableFiles));

    const yes = await confirmDialog({
      title: t('Restore Current Branch'),
      message: confirmMessage,
      danger: true,
      confirmLabel: t('Restore Current Branch'),
    });
    if (yes) {
      await restoreConflicts(restorableRepos.map((r) => r.meta.id));
    }
  }, [restorableRepos, totalRestorableFiles, restoreConflicts, t]);
  const canRepoAmend = useCallback((repo: RepositoryStatus) => {
    if (repo.meta.kind !== 'git') return false;
    const unpushed = unpushedCommits[repo.meta.id];
    const branch = branchesByRepo[repo.meta.id]?.find((b) => b.current);
    return (branch?.ahead ?? repo.ahead) > 0 || (!branch?.upstream && Boolean(unpushed?.length));
  }, [branchesByRepo, unpushedCommits]);

  const [vscodeDeselectedRepos, setVscodeDeselectedRepos] = useState<Set<string>>(new Set());

  const selectedByRepo = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const key of selected) {
      const [repoId, path] = key.split('\0');
      map.set(repoId, [...(map.get(repoId) ?? []), path]);
    }
    return map;
  }, [selected]);

  const effectiveSelectedByRepo = useMemo(() => {
    if (changesDisplayMode === 'vscode') {
      const map = new Map<string, string[]>();
      for (const repo of repos) {
        if (vscodeDeselectedRepos.has(repo.meta.id)) continue;
        if (repo.meta.kind === 'svn') {
          const paths = repo.files.map((f) => f.path);
          if (paths.length > 0) {
            map.set(repo.meta.id, paths);
          }
        } else {
          const staged = repo.files.filter((f) => f.staged).map((f) => f.path);
          if (staged.length > 0) {
            map.set(repo.meta.id, staged);
          }
        }
      }
      return map;
    }
    return selectedByRepo;
  }, [changesDisplayMode, repos, selectedByRepo, vscodeDeselectedRepos]);

  const commitTargets = repos.filter((repo) => (effectiveSelectedByRepo.get(repo.meta.id)?.length ?? 0) > 0);
  const vscodeTargetRepoIds = useMemo(() => new Set(commitTargets.map((r) => r.meta.id)), [commitTargets]);
  const showGitActions = commitTargets.length > 0
    ? commitTargets.some((repo) => repo.meta.kind === 'git')
    : gitRepos.length > 0;

  const primaryCommitAction = showGitActions ? defaultCommitAction : 'commit';
  const orderedSaveActions = defaultSaveAction === 'shelf' ? ['shelf', 'stash'] as const : ['stash', 'shelf'] as const;
  const orderedCommitActions = primaryCommitAction === 'commitAndPush' ? [true, false] : [false, true];
  const singleAmendTarget = repos.length === 1 && commitTargets.length === 1 && canRepoAmend(commitTargets[0])
    ? commitTargets[0]
    : undefined;
  const showAmend = Boolean(singleAmendTarget);

  useEffect(() => {
    const validTargetIds = new Set(
      commitTargets
        .filter((r) => canRepoAmend(r))
        .map((r) => r.meta.id)
    );
    const next = amendRepoIds.filter((repoId) => validTargetIds.has(repoId));
    if (next.length !== amendRepoIds.length) {
      setAmendRepoIds(next);
    }
  }, [amendRepoIds, canRepoAmend, commitTargets, setAmendRepoIds]);

  const messageHistoryRepoKey = repos.map((repo) => repo.meta.id).sort().join('\0');
  const recentCommitMessages = useAppStore((state) => state.recentCommitMessages);
  const lastCommitMessage = useAppStore((state) => state.lastCommitMessage);

  const fetchMessageHistory = useCallback(async (signal?: AbortSignal) => {
    if (!messageHistoryRepoKey) {
      setHistoryMessages([]);
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const values = await recentCommitMessages(messageHistoryRepoKey.split('\0'), signal);
      if (!signal?.aborted) {
        setHistoryMessages(values);
      }
    } catch {
      // 忽略请求错误，保留已有数据
    } finally {
      if (!signal?.aborted) {
        setHistoryLoading(false);
      }
    }
  }, [messageHistoryRepoKey, recentCommitMessages]);

  useEffect(() => {
    messageRequestRef.current?.abort();
    const controller = new AbortController();
    messageRequestRef.current = controller;
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        void fetchMessageHistory(controller.signal);
      }
    });
    return () => controller.abort();
  }, [fetchMessageHistory, snapshot?.workspace.id]);
  useEffect(() => { messageRef.current = message; }, [message]);
  useEffect(() => {
    historyIndexRef.current = -1;
    historyDraftRef.current = messageRef.current;
    appliedHistoryMessageRef.current = null;
  }, [historyMessages]);
  useEffect(() => {
    if (appliedHistoryMessageRef.current === message) {
      appliedHistoryMessageRef.current = null;
      return;
    }
    historyIndexRef.current = -1;
    historyDraftRef.current = message;
  }, [message]);
  const applyMessageFromHistory = (nextMessage: string) => {
    historyIndexRef.current = -1;
    historyDraftRef.current = nextMessage;
    appliedHistoryMessageRef.current = null;
    setMessage(nextMessage);
    setHistoryOpen(false);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextMessage.length, nextMessage.length);
    });
  };
  const toggleAmend = async (repoId: string) => {
    const enabled = !amendRepos.has(repoId);
    setAmendRepoIds(enabled ? [...amendRepos, repoId] : amendRepoIds.filter((id) => id !== repoId));
    amendMessageRequestRef.current?.abort();
    if (!enabled || message.trim()) return;
    const controller = new AbortController();
    amendMessageRequestRef.current = controller;
    try {
      const value = await lastCommitMessage(repoId, controller.signal);
      if (!controller.signal.aborted && amendMessageRequestRef.current === controller && value && !useAppStore.getState().commitMessage.trim() && useAppStore.getState().amendRepoIds.includes(repoId)) {
        setMessage(value);
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          textarea.focus();
          textarea.setSelectionRange(value.length, value.length);
        });
      }
    } catch { /* store reports non-cancellation errors */ }
  };
  useEffect(() => () => amendMessageRequestRef.current?.abort(), [snapshot?.workspace.id]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const commitBusy = workspaceBusy || isSubmitting || isOperationActiveForRepositories(operations, commitTargets.map((repo) => repo.meta.id), {
    workspaceId: snapshot?.workspace.id,
    domain: ['commit', 'sync', 'stash', 'shelf'],
  });
  const saveBusy = workspaceBusy || isSaving || isOperationActiveForRepositories(operations, commitTargets.map((repo) => repo.meta.id), {
    workspaceId: snapshot?.workspace.id,
    domain: ['commit', 'sync', 'stash', 'shelf'],
  });
  const commitUnavailable = commitTargets.find((repo) => !capabilityAvailable(repo.capabilities, 'commit', true));
  const pushUnavailable = commitTargets.find((repo) => repo.meta.kind === 'git' && !capabilityAvailable(repo.capabilities, 'syncPush', true));
  const commitDisabledReason = commitUnavailable
    ? capabilityReason(commitUnavailable.capabilities, 'commit')
    : pushUnavailable
      ? capabilityReason(pushUnavailable.capabilities, 'syncPush')
      : undefined;
  const settingsNoVerify = useAppStore((state) => state.bootstrap?.state.settings?.noVerify ?? false);
  const [hookChoice, setHookChoice] = useState({ configured: settingsNoVerify, checked: settingsNoVerify });
  if (hookChoice.configured !== settingsNoVerify) setHookChoice({ configured: settingsNoVerify, checked: settingsNoVerify });
  const noVerify = hookChoice.configured === settingsNoVerify ? hookChoice.checked : settingsNoVerify;
  const setFiles = useCallback((repoId: string, paths: string[], value: boolean) => setCommitSelection(repoId, paths, value), [setCommitSelection]);
  const isVscode = changesDisplayMode === 'vscode';
  const changesTotalFiles = repos.reduce((sum, repo) => sum + repo.files.filter((file) => !file.isTruncated).length, 0);
  const changesHasSelectable = changesTotalFiles > 0;
  const changesIsAllSelected = useMemo(() => {
    if (!changesHasSelectable) return false;
    return repos.every((repo) => repo.files.filter((file) => !file.isTruncated).every((file) => selected.has(`${repo.meta.id}\0${file.path}`)));
  }, [changesHasSelectable, repos, selected]);
  const canSelectAll = tab === 'changes' || tab === 'sync';
  const currentTabHasSelectable = tab === 'changes'
    ? changesHasSelectable
    : tab === 'sync'
      ? syncHasSelectable
      : false;
  const currentTabIsAllSelected = tab === 'changes'
    ? changesIsAllSelected
    : tab === 'sync'
      ? syncAllSelected
      : false;
  const handleSelectAll = useCallback(() => {
    if (tab === 'changes') {
      for (const repo of repos) {
        setFiles(repo.meta.id, repo.files.filter((file) => !file.isTruncated).map((file) => file.path), true);
      }
    } else if (tab === 'sync') {
      setSyncSelectionCommand((current) => ({ sequence: current.sequence + 1, action: 'selectAll' }));
    }
  }, [repos, setFiles, tab]);
  const handleInvertSelection = useCallback(() => {
    if (tab === 'changes') {
      for (const repo of repos) {
        const selectedPaths = new Set(commitSelections[repo.meta.id] ?? []);
        const allPaths = repo.files.filter((file) => !file.isTruncated).map((file) => file.path);
        setFiles(repo.meta.id, allPaths.filter((path) => selectedPaths.has(path)), false);
        setFiles(repo.meta.id, allPaths.filter((path) => !selectedPaths.has(path)), true);
      }
    } else if (tab === 'sync') {
      setSyncSelectionCommand((current) => ({ sequence: current.sequence + 1, action: 'invert' }));
    }
  }, [commitSelections, repos, setFiles, tab]);
  const doCommit = async (push: boolean) => {
    if (!message.trim() || !commitTargets.length || commitBusy || isSubmitting || commitUnavailable || (push && pushUnavailable)) return;
    const targetWid = snapshot?.workspace.id ?? useAppStore.getState().snapshot?.workspace.id ?? '';
    if (!targetWid) return;

    setIsSubmitting(true);
    try {
      const submittedMessage = message;

      // Safety check for sensitive files, large files, CRLF, invalid names, detached head, and rebase
      const safetyResults = await Promise.all(
        commitTargets.map(async (repo) => {
          const paths = effectiveSelectedByRepo.get(repo.meta.id) ?? [];
          if (paths.length === 0) return null;
          return performCommitSafetyCheck(targetWid, repo.meta.id, paths, isVscode && repo.meta.kind === 'git');
        })
      );

      const sensitiveFiles = Array.from(new Set(safetyResults.flatMap((r) => r?.sensitiveFiles ?? [])));
      const largeFiles = safetyResults.flatMap((r) => r?.largeFiles ?? []);
      const invalidFileNameFiles = safetyResults.flatMap((r) => r?.invalidFileNameFiles ?? []);
      const crlfFiles = Array.from(new Set(safetyResults.flatMap((r) => r?.crlfFiles ?? [])));

      const checkErrors = Array.from(new Set(safetyResults.map((r) => r?.checkError).filter(Boolean))) as string[];

      const settings = useAppStore.getState().bootstrap?.state.settings;
      const detachedHeadWarning = (settings?.warnOnDetachedHead ?? true)
        ? commitTargets.filter((repo) => {
            if (repo.meta.kind !== 'git') return false;
            const branches = branchesByRepo[repo.meta.id];
            if (!branches || branches.length === 0) return false;
            const current = branches.find((b) => b.current);
            return current?.name === 'HEAD' || Boolean(current?.detachedHash);
          })
        : [];

      const rebaseInProgressRepos = commitTargets.filter((repo) => repo.operation === 'rebase');

      const hasIssues =
        sensitiveFiles.length > 0 ||
        largeFiles.length > 0 ||
        invalidFileNameFiles.length > 0 ||
        crlfFiles.length > 0 ||
        detachedHeadWarning.length > 0 ||
        rebaseInProgressRepos.length > 0 ||
        checkErrors.length > 0;

      if (hasIssues) {
        const issues: string[] = [];
        if (checkErrors.length > 0) {
          issues.push(`${t('Safety check service error (large file and CRLF checks skipped): {0}', checkErrors.join('; '))}`);
        }
        if (rebaseInProgressRepos.length > 0) {
          issues.push(`${t('Rebase in progress')}: ${rebaseInProgressRepos.map((r) => r.meta.name).join(', ')}`);
        }
        if (detachedHeadWarning.length > 0) {
          issues.push(`${t('Warn on detached HEAD')}: ${detachedHeadWarning.map((r) => r.meta.name).join(', ')}`);
        }
        if (sensitiveFiles.length > 0) {
          issues.push(`${t('Sensitive files')}: ${sensitiveFiles.join(', ')}`);
        }
        if (largeFiles.length > 0) {
          const list = largeFiles.map((f) => `${f.path} (${f.sizeFormatted})`).join(', ');
          issues.push(`${t('Large files: {0}', list)}`);
        }
        if (invalidFileNameFiles.length > 0) {
          issues.push(`${t('Incompatible / invalid file names: {0}', invalidFileNameFiles.map((f) => `${f.path} (${f.reason})`).join(', '))}`);
        }
        if (crlfFiles.length > 0) {
          const list = crlfFiles.slice(0, 5).join(', ') + (crlfFiles.length > 5 ? ` (+${crlfFiles.length - 5})` : '');
          issues.push(`${t('CRLF line separators: {0}', list)}`);
        }
        const confirmed = await confirmDialog({
          title: t('Commit Safety Check'),
          message: t('VersionDock Warning: The commit contains potential issues:\n{0}\nDo you want to commit anyway?', issues.join('\n')),
          confirmLabel: t('Commit Anyway'),
          danger: true,
        });
        if (!confirmed) return;
      }

      const orderedCommitTargets = [...commitTargets].sort((a, b) => {
        const aDepth = a.meta.depth ?? 0;
        const bDepth = b.meta.depth ?? 0;
        return bDepth - aDepth; // deeper (submodules) first
      });

      const results = await commitMany(orderedCommitTargets.map((repo) => {
        const paths = effectiveSelectedByRepo.get(repo.meta.id) ?? [];
        return {
          repoId: repo.meta.id,
          paths,
          unstagePaths: repo.files.filter((file) => file.staged && !paths.includes(file.path)).map((file) => file.path),
          amend: amendRepos.has(repo.meta.id),
          noVerify,
          stagedOnly: changesDisplayMode === 'vscode' && repo.meta.kind === 'git',
        };
      }), message, push, targetWid);
      if (!results) {
        return;
      }
      const failedRepoIds = new Set(results.filter((result) => result.error || !result.committed).map((result) => result.repoId));
      const isCurrentWorkspace = (useAppStore.getState().snapshot?.workspace.id ?? '') === targetWid;
      if (isCurrentWorkspace) {
        if (failedRepoIds.size === 0) {
          if (useAppStore.getState().commitMessage.trim() === submittedMessage.trim()) setMessage('');
          setAmendRepoIds([]);
          useAppStore.getState().dismissBatchReport();
          if (submittedMessage.trim()) {
            const repoId = commitTargets[0]?.meta.id ?? '';
            setHistoryMessages((prev) => [
              {
                repoId,
                revision: 'HEAD',
                committedAt: new Date().toISOString(),
                message: submittedMessage.trim(),
              },
              ...prev.filter((item) => item.message.trim() !== submittedMessage.trim()),
            ]);
          }
        } else {
          setAmendRepoIds(amendRepoIds.filter((repoId) => failedRepoIds.has(repoId)));
        }
      } else {
        useAppStore.setState((state) => {
          const targetSession = state.sessions[targetWid];
          if (!targetSession) return state;
          const currentDraft = targetSession.commitMessage ?? '';
          const shouldClearMessage = currentDraft.trim() === submittedMessage.trim();
          const nextAmend = failedRepoIds.size === 0
            ? []
            : (targetSession.amendRepoIds ?? []).filter((repoId) => failedRepoIds.has(repoId));
          return {
            sessions: {
              ...state.sessions,
              [targetWid]: {
                ...targetSession,
                commitMessage: failedRepoIds.size === 0 && shouldClearMessage ? '' : targetSession.commitMessage,
                amendRepoIds: nextAmend,
                batchCommitReport: failedRepoIds.size === 0 ? undefined : targetSession.batchCommitReport,
              },
            },
          };
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };
  const doSave = async (kind: 'stash' | 'shelf') => {
    if (saveBusy || isSaving) return;
    const targetWid = snapshot?.workspace.id ?? useAppStore.getState().snapshot?.workspace.id ?? '';
    if (!targetWid) return;

    setIsSaving(true);
    try {
      const submittedMessage = message;
      let succeeded = true;
      for (const repo of commitTargets.filter((item) => item.meta.kind === 'git')) {
        const paths = effectiveSelectedByRepo.get(repo.meta.id) ?? [];
        const result = kind === 'stash'
          ? await useAppStore.getState().stashOperation(repo.meta.id, { type: 'create', message: message.trim() || t('WIP stash'), paths, include_untracked: true }, targetWid)
          : await useAppStore.getState().shelfOperation(repo.meta.id, { type: 'create', name: message.trim() || t('WIP shelf'), paths }, targetWid);
        succeeded = Boolean(result && succeeded);
      }
      if (succeeded) {
        const isCurrentWorkspace = (useAppStore.getState().snapshot?.workspace.id ?? '') === targetWid;
        if (isCurrentWorkspace) {
          if (useAppStore.getState().commitMessage.trim() === submittedMessage.trim()) {
            setMessage('');
          }
        } else {
          useAppStore.setState((state) => {
            const targetSession = state.sessions[targetWid];
            if (!targetSession) return state;
            const currentDraft = targetSession.commitMessage ?? '';
            if (currentDraft.trim() === submittedMessage.trim()) {
              return {
                sessions: {
                  ...state.sessions,
                  [targetWid]: {
                    ...targetSession,
                    commitMessage: '',
                  },
                },
              };
            }
            return state;
          });
        }
      }
    } finally {
      setIsSaving(false);
    }
  };
  const confirmDiscard = async (repo: RepositoryStatus, files: FileChange[]) => {
    const safeFiles = files.filter((file) => !file.isTruncated);
    if (!safeFiles.length) return;
    const tracked = safeFiles.filter((file) => file.status !== 'untracked');
    const untracked = safeFiles.filter((file) => file.status === 'untracked');
    const details = [tracked.length ? t('{0} tracked paths will be restored.', tracked.length) : '', untracked.length ? t('{0} untracked paths will be deleted.', untracked.length) : '', ...safeFiles.map((file) => file.path)].filter(Boolean).join('\n');
    if (await confirmDialog({ title: t('Rollback'), message: details, danger: true })) await discard(repo.meta.id, safeFiles.map((file) => file.path));
  };
  const confirmDelete = async (repo: RepositoryStatus, files: FileChange[]) => {
    const message = t('Move {0} paths to the system Trash?', files.length) + '\n\n' + files.map((file) => file.path).join('\n');
    if (await confirmDialog({ title: t('Delete'), message, danger: true })) await deletePaths(repo.meta.id, files.map((file) => file.path));
  };
  const savePaths = async (repo: RepositoryStatus, files: FileChange[], kind: 'stash' | 'shelf') => {
    if (repo.meta.kind !== 'git') return;
    const targetWid = snapshot?.workspace.id ?? useAppStore.getState().snapshot?.workspace.id ?? '';
    const paths = files.map((file) => file.path);
    if (kind === 'stash') await useAppStore.getState().stashOperation(repo.meta.id, { type: 'create', message: t('WIP stash'), paths, include_untracked: true }, targetWid);
    else await useAppStore.getState().shelfOperation(repo.meta.id, { type: 'create', name: t('Changes'), paths }, targetWid);
  };
  const contextItems = (value: ChangeContext): ContextMenuEntry[] => buildChangeContextMenu({
    ...value,
    mode: changesDisplayMode,
    hasCustomChangelists: Object.values(changelists).some((entries) => entries.length > 0),
  }, t);
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
          const paths = g.files.filter((file) => !file.isTruncated).map((file) => file.path);
          if (paths.length) await stage(g.repo.meta.id, paths);
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
            const paths = g.files.filter((file) => !file.isTruncated).map((file) => file.path);
            if (paths.length) await discard(g.repo.meta.id, paths);
            setFiles(g.repo.meta.id, paths, false);
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
      case 'stage': {
        const stageFiles = repo.meta.kind === 'svn' ? files.filter((entry) => entry.status === 'untracked') : files;
        const stagePaths = stageFiles.map((entry) => entry.path);
        const truncated = stageFiles.filter((entry) => entry.isTruncated);
        if (!truncated.length) { if (stagePaths.length) await stage(repo.meta.id, stagePaths); }
        else if (files.length === 1 && await confirmDialog({ title: t('Add directory recursively to SVN'), message: t('The directory scan was truncated. SVN will add all eligible descendants recursively. Continue?') })) await stage(repo.meta.id, paths, true);
        else {
          const safePaths = stageFiles.filter((entry) => !entry.isTruncated).map((entry) => entry.path);
          if (safePaths.length) await stage(repo.meta.id, safePaths);
        }
        break;
      }
      case 'stage-truncated': {
        const target = files.find((entry) => entry.isTruncated && entry.path === value.path);
        if (target && await confirmDialog({ title: t('Add directory recursively to SVN'), message: t('The directory scan was truncated. SVN will add all eligible descendants recursively. Continue?') })) {
          await stage(repo.meta.id, [target.path], true);
        }
        break;
      }
      case 'unstage': await unstage(repo.meta.id, paths); break;
      case 'submodule-update-parent': {
        if (file) {
          await useAppStore.getState().submoduleOperation(repo.meta.id, {
            type: 'update',
            path: file.path,
            init: false,
            recursive: false,
            remote: false,
          });
        }
        break;
      }
      case 'submodule-reveal-panel': {
        if (file) setHighlightSubmodule({ repoId: repo.meta.id, path: file.path });
        switchTab('submodule');
        break;
      }
      case 'submodule-diff': {
        if (file) {
          setSubmoduleDiffTarget({ repo, file });
        }
        break;
      }
      case 'submodule-open-window': {
        if (file) {
          const absPath = `${repo.meta.rootPath}/${file.path}`.replace(/\\/g, '/');
          void bridge?.openInNewWindow([absPath]);
        }
        break;
      }
      case 'diff-unstaged': if (file) await openDiff(repo.meta.id, file.path, false); break;
      case 'diff-staged': if (file) await openDiff(repo.meta.id, file.path, true); break;
      case 'resolve': if (file) { const conflict = conflicts.find((item) => item.repoId === repo.meta.id && item.path === file.path); if (conflict) await openMerge(conflict); } break;
      case 'accept-yours': if (file) { const conflict = conflicts.find((item) => item.repoId === repo.meta.id && item.path === file.path); if (conflict) await resolveConflict(conflict, 'mine'); } break;
      case 'accept-theirs': if (file) { const conflict = conflicts.find((item) => item.repoId === repo.meta.id && item.path === file.path); if (conflict) await resolveConflict(conflict, 'theirs'); } break;
      case 'accept-working': if (file) await useAppStore.getState().svnOperation(repo.meta.id, { type: 'resolveWorking', paths: [file.path] }); break;
      case 'rollback': await confirmDiscard(repo, files); break;
      case 'shelf':
      case 'stash': {
        const selectedPaths = new Set(useAppStore.getState().commitSelections[repo.meta.id] ?? []);
        const saveFiles = value.kind === 'repo' && selectedPaths.size > 0 ? repo.files.filter((entry) => selectedPaths.has(entry.path)) : files;
        await savePaths(repo, saveFiles, id);
        break;
      }
      case 'open': if (file) await systemOpen(repo.meta.id, file.path, false); break;
      case 'external': if (file) await systemOpen(repo.meta.id, file.path, false, true); break;
      case 'reveal-explorer':
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
    const el = textareaRef.current;
    const startY = event.clientY;
    const startHeight = el?.getBoundingClientRect().height ?? manualTextareaHeightRef.current ?? 54;
    let latestHeight = startHeight;
    const move = (moveEvent: PointerEvent) => {
      latestHeight = Math.max(52, Math.min(window.innerHeight * 0.5, startHeight + startY - moveEvent.clientY));
      manualTextareaHeightRef.current = latestHeight;
      setManualTextareaHeight(latestHeight);
    };
    const finish = () => {
      persistTextareaHeight(latestHeight);
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
      if (viewMenu && !scrollbarContains(viewMenuRef.current, target)) setViewMenu(false);
      if (saveMenu && !scrollbarContains(saveMenuRef.current, target)) setSaveMenu(false);
      if (commitMenu && !scrollbarContains(commitMenuRef.current, target)) setCommitMenu(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setViewMenu(false);
      setSaveMenu(false);
      setCommitMenu(false);
    };
    const closeMenus = () => { setCommitMenu(false); setSaveMenu(false); setViewMenu(false); };
    window.addEventListener('blur', closeMenus);
    document.addEventListener('pointerdown', handleOutsideInteraction, true);
    document.addEventListener('focusin', handleOutsideInteraction, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutsideInteraction, true);
      document.removeEventListener('focusin', handleOutsideInteraction, true);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', closeMenus);
    };
  }, [commitMenu, saveMenu, viewMenu]);

  const panelViewMode = tab === 'shelf' ? shelfViewMode : tab === 'stash' ? stashViewMode : tab === 'sync' ? syncFileViewMode : viewMode;
  const setPanelViewMode = (mode: 'tree' | 'list') => {
    if (tab === 'shelf') setShelfViewMode(mode);
    else if (tab === 'stash') setStashViewMode(mode);
    else if (tab === 'sync') setSyncFileViewMode(mode);
    else if (tab === 'changes') setFileViewMode(mode);
    setViewMenu(false);
    setViewSubmenu('expand');
  };
  const setPanelExpansion = (expanded: boolean) => {
    if (tab === 'shelf') setShelfExpansion((current) => ({ sequence: current.sequence + 1, expanded }));
    else if (tab === 'stash') setStashExpansion((current) => ({ sequence: current.sequence + 1, expanded }));
    else if (tab === 'sync') setSyncExpansion((current) => ({ sequence: current.sequence + 1, expanded }));
    else if (tab === 'changes') setExpansion((current) => ({ sequence: current.sequence + 1, expanded }));
    if (tab === 'changes' || tab === 'shelf' || tab === 'stash' || tab === 'sync') {
      setExpandedByTab((current) => ({ ...current, [tab]: expanded }));
    }
    setViewMenu(false);
    setViewSubmenu('expand');
  };
  const markPanelExpansionMixed = (target: 'changes' | 'shelf' | 'stash') => {
    setExpandedByTab((current) => current[target] === null ? current : { ...current, [target]: null });
  };
  const panelExpanded = tab === 'changes' || tab === 'shelf' || tab === 'stash' || tab === 'sync'
    ? expandedByTab[tab]
    : true;
  const hasConflictOrOperation = conflictingRepos.length > 0 || activeOperationRepos.length > 0;
  const panelToolbar = <div className="panel-toolbar">
    <strong title={t('VersionDock Commit')}>{t('VersionDock Commit')}</strong>
    <span />
    {hasConflictOrOperation && (
      <div className="view-options panel-view-options conflict-action-wrapper" style={{ position: 'relative' }}>
        <IconButton
          ref={conflictButtonRef}
          type="button"
          className={totalConflicts > 0 ? 'conflict-warning-button pulsing' : 'conflict-warning-button'}
          title={totalConflicts > 0 ? t('VersionDock: Resolve Conflicts') : continueLabel}
          aria-label={totalConflicts > 0 ? t('VersionDock: Resolve Conflicts') : continueLabel}
          aria-haspopup="menu"
          aria-expanded={conflictMenuOpen}
          onClick={(e) => {
            e.stopPropagation();
            if (!conflictMenuOpen) {
              const rect = conflictButtonRef.current?.getBoundingClientRect();
              if (rect) {
                const menuWidth = 360;
                let left = rect.left;
                if (left + menuWidth > window.innerWidth - 12) {
                  left = Math.max(12, window.innerWidth - menuWidth - 12);
                }
                if (left < 12) {
                  left = 12;
                }
                setConflictMenuPos({ top: rect.bottom + 5, left });
              }
              setConflictMenuOpen(true);
            } else {
              setConflictMenuOpen(false);
            }
          }}
        >
          {totalConflicts > 0 ? (
            <WarningConflictIcon />
          ) : (
            <Codicon name="play" style={{ color: 'var(--vscode-testing-iconPassed, #73c991)' }} />
          )}
        </IconButton>
        {conflictMenuOpen && (
          <div
            ref={conflictMenuRef}
            className="conflict-actions-menu"
            role="menu"
            style={{
              position: 'fixed',
              top: conflictMenuPos?.top ?? 35,
              left: conflictMenuPos?.left ?? 12,
              width: 360,
              zIndex: 1000,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="conflict-actions-header">
              <div className="conflict-actions-title">
                VersionDock: {totalConflicts > 0 ? t('There are still unresolved conflicts') : t('All conflicts resolved')}
              </div>
              <div className="conflict-actions-subtitle">
                {totalConflicts > 0 ? t('Select an action to resolve or handle conflicts') : t('Continue or abort the repository operation')}
              </div>
            </div>
            <div className="conflict-actions-list">
              {continueTargets.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  className="conflict-action-item"
                  onClick={() => void handleContinueClick()}
                >
                  <div className="conflict-action-item__header">
                    <Codicon name="play" className="conflict-action-item__icon" />
                    <span className="conflict-action-item__label">{continueLabel}</span>
                    <span className="conflict-action-item__desc">{continueDesc}</span>
                  </div>
                  <div className="conflict-action-item__detail">
                    {continueDetail}
                  </div>
                </button>
              )}
              {totalConflicts > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  className="conflict-action-item"
                  onClick={() => {
                    setConflictMenuOpen(false);
                    openConflicts();
                  }}
                >
                  <div className="conflict-action-item__header">
                    <Codicon name="git-merge" className="conflict-action-item__icon" />
                    <span className="conflict-action-item__label">{t('Resolve Conflicts')}</span>
                    <span className="conflict-action-item__desc">{conflictSummary}</span>
                  </div>
                  <div className="conflict-action-item__detail">
                    {t('Open the conflicts panel to resolve files')}
                  </div>
                </button>
              )}
              {abortTargets.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  className="conflict-action-item danger"
                  onClick={() => void handleAbortClick()}
                >
                  <div className="conflict-action-item__header">
                    <Codicon name="close" className="conflict-action-item__icon" />
                    <span className="conflict-action-item__label">{abortLabel}</span>
                    <span className="conflict-action-item__desc">{abortDesc}</span>
                  </div>
                  <div className="conflict-action-item__detail">
                    {abortDetail}
                  </div>
                </button>
              )}
              {restorableRepos.length > 0 && totalRestorableFiles > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  className="conflict-action-item danger"
                  onClick={() => void handleRestoreCurrentBranchClick()}
                >
                  <div className="conflict-action-item__header">
                    <Codicon name="discard" className="conflict-action-item__icon" />
                    <span className="conflict-action-item__label">{t('Restore Current Branch')}</span>
                    <span className="conflict-action-item__desc">{restorableDesc}</span>
                  </div>
                  <div className="conflict-action-item__detail">
                    {restorableDetail}
                  </div>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    )}
    {canSelectAll && currentTabHasSelectable && (
      <IconButton
        className="panel-selection-action"
        disabled={workspaceBusy || Boolean(toolbarAction)}
        title={currentTabIsAllSelected ? t('VersionDock: Invert Selection') : t('VersionDock: Select All')}
        aria-label={currentTabIsAllSelected ? t('VersionDock: Invert Selection') : t('VersionDock: Select All')}
        onClick={() => {
          if (currentTabIsAllSelected) {
            handleInvertSelection();
          } else {
            handleSelectAll();
          }
        }}
      >
        {currentTabIsAllSelected ? <InvertSelectionIcon /> : <SelectAllIcon />}
      </IconButton>
    )}
    <IconButton disabled={workspaceBusy || Boolean(toolbarAction)} title={t('VersionDock: Update Project')} aria-label={t('VersionDock: Update Project')} onClick={() => void runToolbarAction('update', updateProject)}><Codicon name="cloud-download" /></IconButton>
    <IconButton disabled={workspaceBusy || Boolean(toolbarAction)} title={t('VersionDock: Refresh Commit Panel')} aria-label={t('VersionDock: Refresh Commit Panel')} onClick={() => void refreshPanel()}><Codicon name="refresh" /></IconButton>
    <IconButton
      title={t('VersionDock: Manage Remote Accounts (GitHub / GitLab / Gitee)')}
      aria-label={t('VersionDock: Manage Remote Accounts (GitHub / GitLab / Gitee)')}
      onClick={() => {
        setViewMenu(false);
        setSettings(false);
        setProvidersOpen(true);
      }}
    >
      <Codicon name="account" />
    </IconButton>
    <IconButton className={settings ? 'selected' : ''} title={t('VersionDock: Settings')} aria-label={t('VersionDock: Settings')} onClick={() => { setViewMenu(false); setSettings(!settings); }}><Codicon name="settings-gear" /></IconButton>
    <div ref={viewMenuRef} className="view-options panel-view-options">
      <IconButton title={t('More Actions...')} aria-label={t('More Actions...')} aria-haspopup="menu" aria-expanded={viewMenu} className={viewMenu ? 'selected' : ''} onClick={(event) => { event.stopPropagation(); setSettings(false); setViewSubmenu('expand'); setViewMenu((value) => !value); }}><Codicon name="ellipsis" /></IconButton>
      {viewMenu && <div className="view-options-menu" role="menu" onClick={(event) => event.stopPropagation()}>
        <div className="view-submenu-entry" onMouseEnter={() => setViewSubmenu('expand')} onFocus={() => setViewSubmenu('expand')}>
          <button type="button" role="menuitem" className={viewSubmenu === 'expand' ? 'active' : ''} onClick={() => setViewSubmenu('expand')}><span>{t('Expand Mode')}</span><Codicon name="chevron-right" /></button>
          {viewSubmenu === 'expand' && <div className="view-options-submenu" role="menu">
            <button type="button" aria-pressed={panelExpanded === true} className={panelExpanded === true ? 'selected' : ''} onClick={() => setPanelExpansion(true)}><span className="view-menu-check">{panelExpanded === true && <Codicon name="check" />}</span><span>{t('Expand all')}</span></button>
            <button type="button" aria-pressed={panelExpanded === false} className={panelExpanded === false ? 'selected' : ''} onClick={() => setPanelExpansion(false)}><span className="view-menu-check">{panelExpanded === false && <Codicon name="check" />}</span><span>{t('Collapse all')}</span></button>
          </div>}
        </div>
        <div className="view-submenu-entry" onMouseEnter={() => setViewSubmenu('view')} onFocus={() => setViewSubmenu('view')}>
          <button type="button" role="menuitem" className={viewSubmenu === 'view' ? 'active' : ''} onClick={() => setViewSubmenu('view')}><span>{t('View options')}</span><Codicon name="chevron-right" /></button>
          {viewSubmenu === 'view' && <div className="view-options-submenu" role="menu">
            <button type="button" aria-pressed={panelViewMode === 'list'} className={panelViewMode === 'list' ? 'selected' : ''} onClick={() => setPanelViewMode('list')}><span className="view-menu-check">{panelViewMode === 'list' && <Codicon name="check" />}</span><span>{t('Flat list')}</span></button>
            <button type="button" aria-pressed={panelViewMode === 'tree'} className={panelViewMode === 'tree' ? 'selected' : ''} onClick={() => setPanelViewMode('tree')}><span className="view-menu-check">{panelViewMode === 'tree' && <Codicon name="check" />}</span><span>{t('Tree view')}</span></button>
          </div>}
        </div>
      </div>}
    </div>
  </div>;
  const panelOverlays = <>{providersOpen && <ProviderPanel mode="manage" close={() => setProvidersOpen(false)} />}{settings && <SettingsPanel onClose={() => setSettings(false)} />}{ignoreManager && <IgnoreRulesPanel repoId={ignoreManager.repoId} directory={ignoreManager.directory} close={() => setIgnoreManager(undefined)} />}</>;

  if (branchWorkingDiffOpen) return <aside className="commit-panel">{panelToolbar}{panelOverlays}<BranchWorkingDiffPanel /></aside>;

  return (
    <aside className="commit-panel" onClick={() => setContext(undefined)}>
      {panelToolbar}
      {panelOverlays}
      <CommitTabs activeTab={tab} onSelect={switchTab} tabs={[
        { id: 'changes', label: t(changesDisplayMode === 'simplified' ? 'Changes' : 'Commit'), icon: 'source-control', count: totalChanges },
        ...(shelfEnabled ? [{ id: 'shelf', label: t('Shelf'), icon: 'archive', count: shelfCount }] : []),
        ...(stashEnabled ? [{ id: 'stash', label: t('Stash'), icon: 'save', count: stashCount }] : []),
        ...(submoduleEnabled ? [{ id: 'submodule', label: t('Submodules'), icon: 'repo-clone', count: submoduleCount, detail: submoduleIssues > 0 ? t('{0} issues', submoduleIssues) : undefined }] : []),
        ...(worktreeEnabled ? [{ id: 'worktree', label: t('Worktrees'), icon: 'worktree', count: worktreeCount }] : []),
        ...(subtreeEnabled ? [{ id: 'subtree', label: t('Subtrees'), icon: 'repo', count: subtreeCount }] : []),
        ...(gitRepos.length ? [{ id: 'sync', label: t('Sync'), icon: 'sync', count: totalToSync, detail: t('{0} incoming, {1} outgoing', totalToSync - totalToPush, totalToPush) }] : []),
      ]} />
      {visitedTabs.has('changes') && (
        <ChangeRowHighlightContext.Provider value={{ selected: selectedFile && !selectedFile.revision && !selectedFile.fromRevision ? selectedFile : undefined, context: context ? { repoId: context.repo.meta.id, path: context.path ?? '' } : undefined }}>
        <div className="commit-tab-content changes-tab-content" style={{ display: tab === 'changes' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>

      <div className="changes-scroll">
        {tab === 'changes' && <SpeedSearchIndicator query={speedSearch.query} onClear={speedSearch.clear} />}
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
        ) : changesDisplayMode === 'vscode' ? (
          <VscodeChangesView
            repos={visibleChangeRepos}
            selected={selected}
            setFiles={setFiles}
            onFile={(repoId, file, staged) => {
              if (file.submodule) {
                const repo = repos.find((r) => r.meta.id === repoId);
                if (repo) setSubmoduleDiffTarget({ repo, file });
              } else {
                void openDiff(repoId, file.path, staged);
              }
            }}
            onContext={(event, file, repo, staged) => {
              event.preventDefault();
              event.stopPropagation();
              setContext({ x: event.clientX, y: event.clientY, kind: 'file' as const, repo, files: [file], path: file.path, stagedSection: staged });
            }}
            onFolderContext={(event, folderPath, files, repo, staged) => {
              event.preventDefault();
              event.stopPropagation();
              setContext({ x: event.clientX, y: event.clientY, kind: 'folder' as const, repo, files, path: folderPath, stagedSection: staged });
            }}
            onRepoContext={(event, repo, staged) => {
              event.preventDefault();
              event.stopPropagation();
              setContext({ x: event.clientX, y: event.clientY, kind: 'repo' as const, repo, files: repo.files, stagedSection: staged });
            }}
            viewMode={viewMode as 'tree' | 'list'}
            expansion={expansion}
            openWorkingChanges={(repoId) => openWorkingChanges(repoId)}
            onStage={async (repoId, paths) => {
              setVscodeDeselectedRepos((prev) => {
                if (!prev.has(repoId)) return prev;
                const next = new Set(prev);
                next.delete(repoId);
                return next;
              });
              const repo = repos.find((r) => r.meta.id === repoId);
              if (repo?.meta.kind === 'svn') {
                const truncated = repo.files.filter((entry) => entry.isTruncated && paths.includes(entry.path));
                if (truncated.length === 1 && paths.length === 1) {
                  const confirmed = await confirmDialog({
                    title: t('Add directory recursively to SVN'),
                    message: t('The directory scan was truncated. SVN will add all eligible descendants recursively. Continue?'),
                  });
                  if (confirmed) {
                    await stage(repoId, paths, true);
                  }
                  return;
                }
                const safePaths = paths.filter((p) => !repo.files.some((entry) => entry.path === p && entry.isTruncated));
                if (safePaths.length) await stage(repoId, safePaths);
                return;
              }
              await stage(repoId, paths);
            }}
            onUnstage={(repoId, paths) => void unstage(repoId, paths)}
            onDiscard={(repoId, paths) => {
              const repo = repos.find((r) => r.meta.id === repoId);
              const files = repo?.files.filter((f) => paths.includes(f.path)) ?? [];
              if (repo && files.length) void confirmDiscard(repo, files);
            }}
            speedSearchQuery={speedSearch.query}
            selectedRepos={vscodeTargetRepoIds}
            onToggleRepoSelection={(repoId) => {
              setVscodeDeselectedRepos((prev) => {
                const next = new Set(prev);
                if (vscodeTargetRepoIds.has(repoId)) {
                  next.add(repoId);
                } else {
                  next.delete(repoId);
                }
                return next;
              });
            }}
          />
        ) : (
          visibleChangeRepos.map((repo) => {
            const fileProps = {
              selected,
              setFiles,
              onRollback: (files: FileChange[]) => { void confirmDiscard(repo, files); },
              onOpenFile: (file: FileChange) => { void systemOpen(repo.meta.id, file.path, false); },
              onResolve: (file: FileChange) => {
                const conflict = conflicts.find((item) => item.repoId === repo.meta.id && item.path === file.path);
                if (conflict) void openMerge(conflict);
              },
              onStage: (file: FileChange) => {
                void (async () => {
                  if (file.isTruncated && !await confirmDialog({ title: t('Add directory recursively to SVN'), message: t('The directory scan was truncated. SVN will add all eligible descendants recursively. Continue?') })) return;
                  await stage(repo.meta.id, [file.path], Boolean(file.isTruncated));
                })();
              },
              onFile: (file: FileChange) => {
                if (file.submodule) {
                  setSubmoduleDiffTarget({ repo, file });
                } else {
                  void openDiff(repo.meta.id, file.path, file.staged && !file.unstaged);
                }
              },
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
        <div
          className="commit-resize-grip"
          role="separator"
          tabIndex={0}
          aria-label={t('Resize commit message')}
          aria-orientation="horizontal"
          aria-valuemin={52}
          aria-valuemax={Math.round(window.innerHeight * 0.5)}
          aria-valuenow={Math.round(manualTextareaHeight ?? 54)}
          onPointerDown={startTextareaResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              const cur = manualTextareaHeight ?? textareaRef.current?.getBoundingClientRect().height ?? 54;
              const next = Math.max(52, Math.min(window.innerHeight * 0.5, cur + (event.key === 'ArrowUp' ? 10 : -10)));
              updateManualTextareaHeight(next);
            }
          }}
        >
          <i />
        </div>
        {repos.length > 1 && (
          <div className="commit-targets">
            {commitTargets.length === 0 ? (
              <span>{t('No files selected')}</span>
            ) : (
              commitTargets.map((repo) => {
                const count = effectiveSelectedByRepo.get(repo.meta.id)?.length ?? 0;
                const isAmended = amendRepos.has(repo.meta.id);
                const repoCanAmend = canRepoAmend(repo);
                return (
                  <em
                    key={repo.meta.id}
                    style={{
                      color: repo.meta.color,
                      background: `${repo.meta.color}${isAmended ? '3d' : '28'}`,
                      borderColor: isAmended ? repo.meta.color : `${repo.meta.color}60`,
                      boxShadow: isAmended ? `0 0 0 1px ${repo.meta.color}50` : undefined,
                      display: 'inline-flex',
                      alignItems: 'center',
                    }}
                  >
                    <IconButton
                      title={t('Remove {0}', repo.meta.name)}
                      onClick={() => {
                        if (changesDisplayMode === 'vscode') {
                          setVscodeDeselectedRepos((prev) => {
                            const next = new Set(prev);
                            next.add(repo.meta.id);
                            return next;
                          });
                        } else {
                          setFiles(repo.meta.id, repo.files.map((file) => file.path), false);
                        }
                      }}
                    >
                      <Codicon name="close" />
                    </IconButton>
                    {repo.meta.name}
                    <b>{count}</b>
                    {repoCanAmend && (
                      <PillAmendButton
                        active={isAmended}
                        color={repo.meta.color}
                        displayName={repo.meta.name}
                        onClick={() => void toggleAmend(repo.meta.id)}
                      />
                    )}
                  </em>
                );
              })
            )}
          </div>
        )}
        <div className="commit-options">
          {showAmend && singleAmendTarget && <label title={t('Amend last commit')}><SelectionCheckbox label={t('Amend last commit')} checked={amendRepos.has(singleAmendTarget.meta.id)} onChange={() => void toggleAmend(singleAmendTarget.meta.id)} />{t('Amend last commit')}</label>}
          {showGitActions && (
            <label title={t('Bypass Git pre-commit hooks')}>
              <SelectionCheckbox label={t('Bypass hooks (--no-verify)')} checked={noVerify} onChange={() => setHookChoice({ configured: settingsNoVerify, checked: !noVerify })} />
              {t('Bypass hooks (--no-verify)')}
            </label>
          )}
          <div className="commit-option-actions">
            <AiCommitActions busy={commitBusy || workspaceBusy} candidates={commitTargets.map((repo) => ({ repoId: repo.meta.id, paths: effectiveSelectedByRepo.get(repo.meta.id) ?? [], stagedOnly: isVscode && repo.meta.kind === 'git' }))} />
            <IconButton
              type="button"
              disabled={!repos.length || workspaceBusy || historyLoading || Boolean(aiMessage?.running)}
              aria-label={t('Commit message history')}
              title={t('View commit message history')}
              onClick={() => {
                void fetchMessageHistory();
                setHistoryOpen(true);
              }}
            >
              <Codicon name="history" />
            </IconButton>
          </div>
        </div>
        {aiMessage?.error && <div role="alert" className="ai-error">{aiMessage.error}</div>}
        {mergeMessageSuggestion && <div className="merge-message-suggestion" role="status"><span>{t('Merge message suggestion')}: {mergeMessageSuggestion}</span><button type="button" onClick={applyMergeMessageSuggestion}>{t('Use Merge Message')}</button><button type="button" onClick={dismissMergeMessageSuggestion}>{t('Ignore')}</button></div>}
        <div className="ai-commit-input ai-input-surface" data-generating={Boolean(aiMessage?.running)}>
        <AiGenerationBorder active={Boolean(aiMessage?.running)} />
        <textarea ref={textareaRef} readOnly={Boolean(aiMessage?.running)} className={aiMessage?.running ? 'ai-input-generating' : undefined} style={manualTextareaHeight !== null ? { height: manualTextareaHeight } : undefined} value={message} onChange={(event) => { historyIndexRef.current = -1; historyDraftRef.current = event.target.value; appliedHistoryMessageRef.current = null; setMessage(event.target.value); }} onPointerDown={() => { if (historyIndexRef.current < 0) return; historyIndexRef.current = -1; historyDraftRef.current = message; }} placeholder={t(aiMessage?.running ? 'Generating commit message…' : 'Commit message (Cmd+Enter to commit)')} onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (aiMessage?.running) return; void doCommit(primaryCommitAction === 'commitAndPush'); return; }
          if (aiMessage?.running) return;
          if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
          const historyActive = historyIndexRef.current >= 0;
          const selectionCollapsed = event.currentTarget.selectionStart === event.currentTarget.selectionEnd;
          const caretOnFirstLine = selectionCollapsed && event.currentTarget.value.lastIndexOf('\n', event.currentTarget.selectionStart - 1) < 0;
          if (event.key === 'ArrowUp' && (historyActive || caretOnFirstLine)) {
            if (!historyActive) historyDraftRef.current = message;
            let nextIndex = historyIndexRef.current + 1;
            while (nextIndex < historyMessages.length && historyMessages[nextIndex].message === message) nextIndex += 1;
            if (nextIndex < historyMessages.length) {
              event.preventDefault();
              historyIndexRef.current = nextIndex;
              const nextMessage = historyMessages[nextIndex].message;
              appliedHistoryMessageRef.current = nextMessage;
              setMessage(nextMessage);
              requestAnimationFrame(() => textareaRef.current?.setSelectionRange(0, 0));
            } else if (historyActive) event.preventDefault();
            return;
          }
          if (event.key === 'ArrowDown' && historyActive) {
            event.preventDefault();
            let nextIndex = historyIndexRef.current - 1;
            while (nextIndex >= 0 && historyMessages[nextIndex].message === message) nextIndex -= 1;
            if (nextIndex >= 0) {
              historyIndexRef.current = nextIndex;
              const nextMessage = historyMessages[nextIndex].message;
              appliedHistoryMessageRef.current = nextMessage;
              setMessage(nextMessage);
              requestAnimationFrame(() => textareaRef.current?.setSelectionRange(nextMessage.length, nextMessage.length));
            } else {
              historyIndexRef.current = -1;
              const draft = historyDraftRef.current;
              appliedHistoryMessageRef.current = draft;
              setMessage(draft);
              requestAnimationFrame(() => textareaRef.current?.setSelectionRange(draft.length, draft.length));
            }
          }
        }} />
        <AiCommitGenerator busy={commitBusy || workspaceBusy} candidates={commitTargets.map((repo) => ({ repoId: repo.meta.id, paths: effectiveSelectedByRepo.get(repo.meta.id) ?? [], stagedOnly: isVscode && repo.meta.kind === 'git' }))} />
        </div>
        <div className="commit-actions">
          {showGitActions && <div ref={saveMenuRef} className="split-button action-split save-action"><button disabled={Boolean(aiMessage?.running) || !message.trim() || !commitTargets.length || saveBusy} onClick={() => void doSave(defaultSaveAction)}><Codicon name={defaultSaveAction === 'shelf' ? 'archive' : 'save'} />{t(defaultSaveAction === 'shelf' ? 'Shelve' : 'Stash')}</button><SplitButtonMore title={t('Save options')} aria-haspopup="menu" aria-expanded={saveMenu} disabled={Boolean(aiMessage?.running) || !message.trim() || !commitTargets.length || saveBusy} onClick={() => { setSaveMenu((value) => !value); setCommitMenu(false); }} />{saveMenu && <div className="split-menu">{orderedSaveActions.map((action) => <button key={action} disabled={saveBusy} onClick={() => { void doSave(action); setSaveMenu(false); }}><Codicon name={action === 'shelf' ? 'archive' : 'save'} />{t(action === 'shelf' ? 'Shelve changes' : 'Stash changes')}</button>)}</div>}</div>}
          <div ref={commitMenuRef} className="split-button action-split commit-action"><button title={commitDisabledReason} disabled={Boolean(aiMessage?.running) || !message.trim() || !commitTargets.length || commitBusy || Boolean(commitUnavailable) || (primaryCommitAction === 'commitAndPush' && Boolean(pushUnavailable))} onClick={() => void doCommit(primaryCommitAction === 'commitAndPush')}><Codicon name={primaryCommitAction === 'commitAndPush' ? 'cloud-upload' : 'check'} />{t(primaryCommitAction === 'commitAndPush' ? 'Commit & Push' : 'Commit')}</button>{showGitActions && <SplitButtonMore title={t('Commit options')} aria-haspopup="menu" aria-expanded={commitMenu} disabled={Boolean(aiMessage?.running) || !message.trim() || !commitTargets.length || commitBusy || Boolean(commitUnavailable)} onClick={() => { setCommitMenu((value) => !value); setSaveMenu(false); }} />}{commitMenu && <div className="split-menu right">{orderedCommitActions.map((push) => <button key={String(push)} disabled={commitBusy || Boolean(commitUnavailable) || (push && Boolean(pushUnavailable))} title={commitUnavailable ? capabilityReason(commitUnavailable.capabilities, 'commit') : push && pushUnavailable ? capabilityReason(pushUnavailable.capabilities, 'syncPush') : undefined} onClick={() => { void doCommit(push); setCommitMenu(false); }}><Codicon name={push ? 'cloud-upload' : 'check'} />{t(push ? 'Commit & Push' : 'Commit')}</button>)}</div>}</div>
        </div>
      </div>
      </div>
        </ChangeRowHighlightContext.Provider>
      )}
      {visitedTabs.has('shelf') && (
        <div className="commit-tab-content shelf-tab-content" style={{ display: tab === 'shelf' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <ShelfPanel active={tab === 'shelf'} repos={gitRepos} selectedPaths={selectedByRepo} viewMode={shelfViewMode} expansion={shelfExpansion} onManualExpansionChange={() => markPanelExpansionMixed('shelf')} onOpenFileDiff={(repoId, shelfId, path) => void openShelfDiff(repoId, shelfId, path)} />
        </div>
      )}
      {visitedTabs.has('stash') && (
        <div className="commit-tab-content stash-tab-content" style={{ display: tab === 'stash' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <StashPanel active={tab === 'stash'} repos={gitRepos} selectedPaths={selectedByRepo} viewMode={stashViewMode} expansion={stashExpansion} onManualExpansionChange={() => markPanelExpansionMixed('stash')} onOpenFileDiff={(repoId, reference, path) => void openStashDiff(repoId, reference, path)} />
        </div>
      )}
      {visitedTabs.has('worktree') && (
        <div className="commit-tab-content worktree-tab-content" style={{ display: tab === 'worktree' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <WorktreePanel active={tab === 'worktree'} repos={gitRepos} />
        </div>
      )}
      {visitedTabs.has('subtree') && (
        <div className="commit-tab-content subtree-tab-content" style={{ display: tab === 'subtree' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <SubtreePanel repos={gitRepos} active={tab === 'subtree'} />
        </div>
      )}
      {visitedTabs.has('submodule') && (
        <div className="commit-tab-content submodule-tab-content" style={{ display: tab === 'submodule' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <SubmodulePanel active={tab === 'submodule'} repos={parentGitRepos} highlight={highlightSubmodule} />
        </div>
      )}
      {visitedTabs.has('sync') && (
        <div className="commit-tab-content sync-tab-content" style={{ display: tab === 'sync' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <SyncPanel active={tab === 'sync'} repos={gitRepos} expansionCommand={syncExpansion} selectionCommand={syncSelectionCommand} fileViewMode={syncFileViewMode === 'list' ? 'flat' : 'tree'} onFileViewModeChange={(mode) => setSyncFileViewMode(mode === 'flat' ? 'list' : 'tree')} onExpansionChange={(expanded) => setExpandedByTab((current) => ({ ...current, sync: expanded }))} onSelectionChange={(allSelected, hasSelectable) => { setSyncAllSelected(allSelected); setSyncHasSelectable(hasSelectable); }} />
        </div>
      )}
      {context && <ContextMenu x={context.x} y={context.y} items={contextItems(context)} onSelect={(id) => void handleContextAction(id)} onClose={() => setContext(undefined)} />}
      {clHeaderContext && <ContextMenu x={clHeaderContext.x} y={clHeaderContext.y} items={clHeaderItems(clHeaderContext.changelistId)} onSelect={(id) => void handleClHeaderAction(id)} onClose={() => setClHeaderContext(undefined)} />}
      {submoduleDiffTarget && (
        <SubmoduleDiffModal
          repo={submoduleDiffTarget.repo}
          file={submoduleDiffTarget.file}
          onClose={() => setSubmoduleDiffTarget(null)}
          onRevealPanel={() => {
            setHighlightSubmodule({ repoId: submoduleDiffTarget.repo.meta.id, path: submoduleDiffTarget.file.path });
            setSubmoduleDiffTarget(null);
            switchTab('submodule');
          }}
        />
      )}
      {historyOpen && <div className="commit-history-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryOpen(false); }}><section ref={historyDialog} className="commit-history-modal" role="dialog" aria-modal="true" aria-label={t('Commit message history')}>
        <header className="commit-history-header"><Codicon name="history" /><strong>{t('Commit message history')}</strong><IconButton type="button" aria-label={t('Cancel')} title={t('Cancel')} onClick={() => setHistoryOpen(false)}><Codicon name="close" /></IconButton></header>
        <div className="commit-history-subtitle">{t('Select a previous commit message to use.')}</div>
        <div className="commit-history-list">{historyLoading && historyMessages.length === 0 ? <div className="commit-history-empty"><Codicon name="loading codicon-modifier-spin" /><span>{t('Loading…')}</span></div> : historyMessages.length ? historyMessages.map((item) => {
          const [subject, ...bodyLines] = item.message.split('\n');
          const body = bodyLines.join('\n').trim();
          return <button key={`${item.repoId}:${item.revision}`} type="button" title={item.message} onClick={() => applyMessageFromHistory(item.message)}><strong>{subject}</strong>{body && <span>{body}</span>}</button>;
        }) : <div className="commit-history-empty"><Codicon name="history" /><span>{t('No commit message history')}</span></div>}</div>
      </section></div>}
    </aside>
  );
}
