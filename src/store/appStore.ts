import { create } from 'zustand';
import type {
  AppStateSnapshot, BootstrapData, BranchInfo, CommitDetail, CommitFile, CommitNode, ConflictFile, DiffDocument, GraphCommitNode,
  BranchCompareResult, HistoryPage, MergeVersions, RemoteInfo, RemoteOperation, RepositoryStatus, TagInfo, ThemePreference, LanguagePreference, UiFontSizePreference,
  WorkspaceSnapshot, WorkspaceDescriptor, StashEntry, StashOperation, ShelfEntry, ShelfOperation, ChangelistEntry, ChangelistOperation, WorktreeDiffResult, WorktreeEntry, WorktreeOperation, SubtreeEntry, SubtreeOperation, SubmoduleEntry, SubmoduleOperation,
  UnpushedCommit, UnpushedOperation, HistoryOperation, PatchDocument, SvnOperation, MergeCommitSummary, DesktopSettings, LayoutState, SettingsUpdateResult, RepositoryOperationResult,
  WindowTabTransfer,
} from '../bindings/generated';
import { BridgeError, isAbortError, type VersionDockBridge } from '../platform/bridge';
import { buildCommitFileTargets, commitKey, type DetailFileTarget } from '../history/commitDetails';

export type WorkspaceMode = 'history' | 'commit-detail' | 'diff' | 'changes' | 'merge';
export type CommitSelectionMode = 'single' | 'toggle' | 'range';
export type DiffRange = { fromRevision: string; toRevision: string };
export type CommitChangesModel = { commits: CommitNode[]; files: DetailFileTarget[] };
export type HistoryScope = {
  repoIds: string[] | null;
  revisionsByRepo: Record<string, string>;
};

export interface OpenWorkspaceOptions {
  skipCrossWindowFocus?: boolean;
  insertionIndex?: number;
}

export function workspacePathsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((path, index) => path === sortedRight[index]);
}

export interface AppNotification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  actionLabel?: string;
  actionKey?: 'pullAll' | 'pushAll' | 'openConflicts' | 'openIdentity' | 'refresh';
  actionData?: any;
}

const HISTORY_PAGE_SIZE = 100;

interface LogCandidate<T extends GraphCommitNode> {
  commit: T;
  logIndex: number;
  insertionOrder: number;
}

function javaHashMapCapacity(size: number): number {
  let capacity = 16;
  while (size > capacity * 0.75) capacity *= 2;
  return capacity;
}

function javaStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function javaHashBucket(value: string, capacity: number): number {
  const hash = javaStringHash(value);
  return (hash ^ (hash >>> 16)) & (capacity - 1);
}

function compareLogCandidates<T extends GraphCommitNode>(
  left: LogCandidate<T>,
  right: LogCandidate<T>,
  hashCapacity: number,
): number {
  const leftTime = Date.parse(left.commit.committerDate);
  const rightTime = Date.parse(right.commit.committerDate);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
  if (Number.isFinite(rightTime) !== Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : -1;

  // Match JetBrains' Java HashMap traversal for equal timestamps without
  // depending on object insertion order in the browser.
  const byBucket = javaHashBucket(right.commit.hash, hashCapacity)
    - javaHashBucket(left.commit.hash, hashCapacity);
  if (byBucket !== 0) return byBucket;
  return right.insertionOrder - left.insertionOrder;
}

/** Merge each repository's already-topological log without reordering a repo's parent chain. */
function interleaveLogs<T extends GraphCommitNode>(historyByRepo: Record<string, T[]>): T[] {
  const logs = Object.values(historyByRepo);
  const positions = logs.map(() => 0);
  const total = logs.reduce((count, log) => count + log.length, 0);
  const result: T[] = [];
  const active: Array<LogCandidate<T>> = [];
  let nextInsertionOrder = 0;
  for (let logIndex = 0; logIndex < logs.length; logIndex += 1) {
    const commit = logs[logIndex][0];
    if (commit) active.push({ commit, logIndex, insertionOrder: nextInsertionOrder++ });
  }
  const hashCapacity = javaHashMapCapacity(active.length);
  while (active.length > 0 && result.length < total) {
    let selectedIndex = 0;
    for (let index = 1; index < active.length; index += 1) {
      if (compareLogCandidates(active[index], active[selectedIndex], hashCapacity) < 0) {
        selectedIndex = index;
      }
    }
    const selected = active[selectedIndex];
    result.push(selected.commit);
    positions[selected.logIndex] += 1;
    const nextCommit = logs[selected.logIndex][positions[selected.logIndex]];
    if (nextCommit) {
      active[selectedIndex] = { commit: nextCommit, logIndex: selected.logIndex, insertionOrder: nextInsertionOrder++ };
    } else {
      active.splice(selectedIndex, 1);
    }
  }
  return result;
}

export function interleaveHistory(historyByRepo: Record<string, CommitNode[]>): CommitNode[] {
  return interleaveLogs(historyByRepo);
}

export interface WorkspaceSessionState {
  snapshot: WorkspaceSnapshot;
  allRepositories: RepositoryStatus[];
  selectedRepoId?: string;
  selectedFile?: { repoId: string; path: string; staged: boolean; revision?: string; fromRevision?: string; toRevision?: string };
  fileHistoryTarget?: { repoId: string; path: string };
  mode: WorkspaceMode;
  diff?: DiffDocument;
  changesDiff?: DiffDocument;
  changes?: CommitChangesModel;
  history: CommitNode[];
  historyHasMore: boolean;
  historyByRepo: Record<string, CommitNode[]>;
  historyTopology: GraphCommitNode[];
  historyTopologyByRepo: Record<string, GraphCommitNode[]>;
  historyHasMoreByRepo: Record<string, boolean>;
  historyLoading: boolean;
  branchesLoading: boolean;
  historyScope: HistoryScope;
  historyFilter: string;
  selectedCommit?: CommitDetail;
  selectedCommits: CommitNode[];
  selectedPrimaryKey?: string;
  selectedCommitDetails: Record<string, CommitDetail>;
  selectedCommitLoading: Record<string, boolean>;
  mergeCommits: Record<string, MergeCommitSummary[]>;
  mergeCommitsLoading: Record<string, boolean>;
  mergeParentFiles: Record<string, CommitFile[]>;
  mergeParentFilesLoading: Record<string, boolean>;
  branches: BranchInfo[];
  tags: TagInfo[];
  branchesByRepo: Record<string, BranchInfo[]>;
  tagsByRepo: Record<string, TagInfo[]>;
  conflicts: ConflictFile[];
  merge?: MergeVersions;
  mergeResult: string;
  stashes: Record<string, StashEntry[]>;
  shelves: Record<string, ShelfEntry[]>;
  changelists: Record<string, ChangelistEntry[]>;
  worktrees: Record<string, WorktreeEntry[]>;
  worktreeDiff?: WorktreeDiffResult & { repoId: string; source?: 'worktree' | 'repository' };
  subtrees: Record<string, SubtreeEntry[]>;
  submodules: Record<string, SubmoduleEntry[]>;
  unpushedCommits: Record<string, UnpushedCommit[]>;
  comparisonTarget?: { repoId: string; target: string };
  comparison?: BranchCompareResult;
  remotes: Record<string, RemoteInfo[]>;
  lastSyncedAt?: number;
}

export interface AppStore {
  bridge?: VersionDockBridge;
  ready: boolean;
  busy: boolean;
  operations: Record<string, number>;
  error?: string;
  errorDetails?: string;
  notice?: string;
  notifications: AppNotification[];
  identityPanelRepoId: string | null;
  remoteManagerRepoId: string | null;
  bootstrap?: BootstrapData;
  tabs: WorkspaceSnapshot['workspace'][];
  activeTabId: string | null;
  sessions: Record<string, WorkspaceSessionState>;
  snapshot?: WorkspaceSnapshot;
  allRepositories: RepositoryStatus[];
  selectedRepoId?: string;
  selectedFile?: { repoId: string; path: string; staged: boolean; revision?: string; fromRevision?: string; toRevision?: string };
  fileHistoryTarget?: { repoId: string; path: string };
  mode: WorkspaceMode;
  diff?: DiffDocument;
  changesDiff?: DiffDocument;
  changes?: CommitChangesModel;
  history: CommitNode[];
  historyHasMore: boolean;
  historyByRepo: Record<string, CommitNode[]>;
  historyTopology: GraphCommitNode[];
  historyTopologyByRepo: Record<string, GraphCommitNode[]>;
  historyHasMoreByRepo: Record<string, boolean>;
  historyLoading: boolean;
  branchesLoading: boolean;
  historyScope: HistoryScope;
  historyFilter: string;
  selectedCommit?: CommitDetail;
  selectedCommits: CommitNode[];
  selectedPrimaryKey?: string;
  selectedCommitDetails: Record<string, CommitDetail>;
  selectedCommitLoading: Record<string, boolean>;
  mergeCommits: Record<string, MergeCommitSummary[]>;
  mergeCommitsLoading: Record<string, boolean>;
  mergeParentFiles: Record<string, CommitFile[]>;
  mergeParentFilesLoading: Record<string, boolean>;
  branches: BranchInfo[];
  tags: TagInfo[];
  branchesByRepo: Record<string, BranchInfo[]>;
  tagsByRepo: Record<string, TagInfo[]>;
  conflicts: ConflictFile[];
  merge?: MergeVersions;
  mergeResult: string;
  stashes: Record<string, StashEntry[]>;
  shelves: Record<string, ShelfEntry[]>;
  changelists: Record<string, ChangelistEntry[]>;
  worktrees: Record<string, WorktreeEntry[]>;
  worktreeDiff?: WorktreeDiffResult & { repoId: string; source?: 'worktree' | 'repository' };
  subtrees: Record<string, SubtreeEntry[]>;
  submodules: Record<string, SubmoduleEntry[]>;
  unpushedCommits: Record<string, UnpushedCommit[]>;
  comparisonTarget?: { repoId: string; target: string };
  comparison?: BranchCompareResult;
  remotes: Record<string, RemoteInfo[]>;
  initialize: (bridge: VersionDockBridge) => Promise<void>;
  openWorkspace: (paths: string[], focus?: boolean, options?: OpenWorkspaceOptions) => Promise<boolean>;
  switchTab: (workspaceId: string) => Promise<void>;
  closeTab: (workspaceId: string) => Promise<void>;
  closeOtherTabs: (workspaceId: string) => Promise<void>;
  closeAllTabs: () => Promise<void>;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  restoreTabsOnStartup: () => Promise<void>;
  restoreLastWorkspace: () => Promise<void>;
  removeRecent: (workspaceId: string) => Promise<void>;
  refresh: (silent?: boolean) => Promise<void>;
  selectRepo: (repoId: string, reload?: boolean) => Promise<void>;
  openDiff: (repoId: string, path: string, staged: boolean, revision?: string, range?: DiffRange) => Promise<void>;
  openStashDiff: (repoId: string, reference: string, path: string) => Promise<void>;
  openShelfDiff: (repoId: string, shelfId: string, path: string) => Promise<void>;
  openCommitDetail: () => void;
  openCommitChanges: () => void;
  loadChangesDiff: (target: DetailFileTarget) => Promise<void>;
  stage: (repoId: string, paths: string[]) => Promise<void>;
  unstage: (repoId: string, paths: string[]) => Promise<void>;
  discard: (repoId: string, paths: string[]) => Promise<void>;
  deletePaths: (repoId: string, paths: string[]) => Promise<void>;
  addIgnore: (repoId: string, path: string) => Promise<void>;
  commit: (repoId: string, message: string, amend: boolean, paths: string[], push: boolean) => Promise<void>;
  commitMany: (targets: Array<{ repoId: string; paths: string[]; unstagePaths: string[]; amend: boolean }>, message: string, push: boolean) => Promise<void>;
  sync: (repoId: string, action: 'fetch' | 'pull' | 'push' | 'update') => Promise<void>;
  loadHistory: (reset?: boolean) => Promise<void>;
  setHistoryFilter: (value: string) => void;
  setHistoryScope: (scope: HistoryScope) => void;
  selectCommit: (commit: CommitNode, mode?: CommitSelectionMode, rangeSource?: CommitNode[]) => Promise<void>;
  loadCommitDetail: (commit: CommitNode) => Promise<CommitDetail>;
  loadMergeCommits: (commit: CommitNode) => Promise<void>;
  loadMergeParentFiles: (repoId: string, revision: string, parentHash: string) => Promise<CommitFile[]>;
  clearCommitSelection: () => void;
  branchOperation: (operation: object, repoId?: string) => Promise<void>;
  tagOperation: (operation: object, repoId?: string) => Promise<void>;
  loadStashes: (repoId?: string) => Promise<void>;
  stashOperation: (repoId: string, operation: StashOperation) => Promise<void>;
  loadShelves: (repoId?: string) => Promise<void>;
  shelfOperation: (repoId: string, operation: ShelfOperation) => Promise<void>;
  loadChangelists: (repoId?: string) => Promise<void>;
  changelistOperation: (repoId: string, operation: ChangelistOperation) => Promise<void>;
  loadWorktrees: (repoId?: string) => Promise<void>;
  worktreeOperation: (repoId: string, operation: WorktreeOperation) => Promise<void>;
  openWorktree: (repoId: string, path: string, reveal: boolean) => Promise<void>;
  loadWorktreeDiff: (repoId: string, path: string, baseRef?: string) => Promise<void>;
  openWorktreeFileDiff: (repoId: string, path: string, baseRef: string, relativePath: string) => Promise<void>;
  loadBranchWorkingDiff: (repoId: string, baseRef: string) => Promise<void>;
  openBranchWorkingFileDiff: (repoId: string, baseRef: string, relativePath: string) => Promise<void>;
  closeWorktreeDiff: () => void;
  loadSubtrees: (repoId?: string) => Promise<void>;
  subtreeOperation: (repoId: string, operation: SubtreeOperation) => Promise<void>;
  loadSubmodules: (repoId?: string) => Promise<void>;
  submoduleOperation: (repoId: string, operation: SubmoduleOperation) => Promise<void>;
  loadUnpushedCommits: (repoId?: string) => Promise<void>;
  unpushedOperation: (repoId: string, operation: UnpushedOperation) => Promise<void>;
  historyOperation: (repoId: string, operation: HistoryOperation) => Promise<void>;
  createPatch: (repoId: string, revisions: string[]) => Promise<PatchDocument>;
  svnOperation: (repoId: string, operation: SvnOperation) => Promise<void>;
  openBranchComparison: (repoId: string, target: string) => void;
  closeBranchComparison: () => void;
  compareBranches: (repoId: string, base: string, target: string) => Promise<void>;
  clearComparison: () => void;
  loadRemotes: (repoId?: string) => Promise<void>;
  remoteOperation: (repoId: string, operation: RemoteOperation) => Promise<void>;
  systemOpen: (repoId: string, path: string, reveal: boolean, external?: boolean) => Promise<void>;
  loadConflicts: () => Promise<void>;
  openMerge: (conflict: ConflictFile) => Promise<void>;
  resolveConflict: (conflict: ConflictFile, choice: 'mine' | 'theirs' | 'working') => Promise<void>;
  setMergeResult: (value: string) => void;
  saveMerge: () => Promise<void>;
  acceptConflict: (choice: 'mine' | 'theirs' | 'working') => Promise<void>;
  abortRepositoryOperation: (repoId: string, operation: string) => Promise<void>;
  backToHistory: () => void;
  openFileHistory: (repoId: string, path: string) => void;
  closeFileHistory: () => void;
  setTheme: (value: ThemePreference) => Promise<void>;
  setLanguage: (value: LanguagePreference) => Promise<void>;
  setUiFontSize: (value: UiFontSizePreference) => void;
  setExternalEditor: (executable: string, args: string[]) => void;
  setFileViewMode: (value: 'tree' | 'list') => void;
  setStashViewMode: (value: 'tree' | 'list') => void;
  setActiveTab: (value: 'changes' | 'shelf' | 'stash' | 'worktree' | 'subtree' | 'push') => void;
  setPanelSize: (key: 'commit' | 'branches' | 'detail', value: number) => void;
  setBranchSidebarState: (collapsed: boolean, collapsedSections: string[]) => void;
  updateSettings: (patch: Partial<DesktopSettings>) => Promise<void>;
  clearError: () => void;
  clearNotice: () => void;
  addNotification: (notification: Omit<AppNotification, 'id' | 'timestamp' | 'read'>) => void;
  markNotificationAsRead: (id: string) => void;
  markAllNotificationsAsRead: () => void;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
  openIdentityPanel: (repoId?: string) => void;
  closeIdentityPanel: () => void;
  openRemoteManager: (repoId?: string) => void;
  closeRemoteManager: () => void;
}

const emptyState: AppStateSnapshot = {
  schemaVersion: 3,
  settings: {
    theme: 'system', language: 'system', uiFontSize: 'standard', changesDisplayMode: 'simplified', defaultCommitAction: 'commit', defaultSaveAction: 'stash',
    promptBeforeAddingUntracked: true, suppressDivergedWarning: false, autoRefreshInterval: 0, fetchOnStartup: false, resetViewLocationsOnStartup: false,
    notifyIncomingCommits: false, notifyUnpushedCommits: false, repositoryScanDepth: 4,
    ignoredFolders: ['.git', '.svn', '.hg', 'node_modules', 'vendor', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', 'target'],
    maximumGraphCommits: 1000, projectColors: {}, externalEditor: null,
  },
  layout: { panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', stashViewMode: 'tree', branchSidebarCollapsed: false, branchSidebarCollapsedSections: [] },
  lastWorkspaceId: null, openWorkspaceIds: [], activeWorkspaceId: null, recentWorkspaces: [],
};

let watcherTimer: ReturnType<typeof setTimeout> | undefined;
let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
let workspaceRequestGeneration = 0;
let watcherRefreshInFlight = false;
let watcherRefreshQueued = false;
const watcherReasons = new Set<string>();
let commitSelectionGeneration = 0;
let changesDiffGeneration = 0;
let historyRequestGeneration = 0;
let comparisonRequestGeneration = 0;
let branchWorkingDiffGeneration = 0;
const requestControllers = new Map<string, AbortController>();
const notificationBaseline = new Map<string, { incoming: number; unpushed: number }>();

function beginRequest(key: string): AbortController {
  requestControllers.get(key)?.abort();
  const controller = new AbortController();
  requestControllers.set(key, controller);
  return controller;
}

function cancelRequests() {
  requestControllers.forEach((controller) => controller.abort());
  requestControllers.clear();
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const errorDetails = (error: unknown) => error instanceof BridgeError
  ? [error.code, error.operation, error.repositoryId, error.subject, error.hint, error.command, error.exitCode, error.stderr].filter((value) => value !== null && value !== undefined && value !== '').join('\n')
  : undefined;

function projectSnapshot(snapshot: WorkspaceSnapshot, repositories: RepositoryStatus[], settings: DesktopSettings): WorkspaceSnapshot {
  const hidden = new Set(settings.hiddenRepositoryIds ?? []);
  return { ...snapshot, repositories: repositories.filter((repo) => !hidden.has(repo.meta.id)) };
}

export const useAppStore = create<AppStore>((set, get) => {
  const withBusy = async (operation: () => Promise<void>, domain = 'workspace') => {
    set((state) => ({ busy: true, error: undefined, operations: { ...state.operations, [domain]: (state.operations[domain] ?? 0) + 1 } }));
    try {
      await operation();
    } catch (error) {
      if (!isAbortError(error)) {
        const msg = errorText(error);
        set({ error: msg, errorDetails: errorDetails(error) });
        get().addNotification({ type: 'error', title: 'Operation failed', message: msg });
      }
    } finally {
      set((state) => {
        const operations = { ...state.operations };
        const remaining = Math.max(0, (operations[domain] ?? 1) - 1);
        if (remaining) operations[domain] = remaining; else delete operations[domain];
        return { operations, busy: Object.keys(operations).length > 0 };
      });
    }
  };

  const workspaceId = () => {
    const id = get().snapshot?.workspace.id;
    if (!id) throw new Error('Workspace is not open');
    return id;
  };

  const bridge = () => {
    const value = get().bridge;
    if (!value) throw new Error('Bridge is not initialized');
    return value;
  };

  const settings = () => get().bootstrap?.state.settings ?? emptyState.settings!;
  const layout = () => get().bootstrap?.state.layout ?? emptyState.layout!;

  const restartAutoRefresh = () => {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = undefined;
    const seconds = settings().autoRefreshInterval;
    if (seconds > 0) autoRefreshTimer = setInterval(() => { if (get().snapshot && !get().busy) void get().refresh(true); }, seconds * 1000);
  };

  const updateSettings = async (patch: Partial<DesktopSettings>) => {
    const bootstrap = get().bootstrap; if (!bootstrap) return;
    const previous = settings();
    const optimistic = { ...previous, ...patch };
    set((state) => ({
      bootstrap: { ...bootstrap, state: { ...bootstrap.state, settings: optimistic } },
      snapshot: state.snapshot ? projectSnapshot(state.snapshot, state.allRepositories, optimistic) : undefined,
    }));
    if (patch.hiddenRepositoryIds && !get().snapshot?.repositories.some((repo) => repo.meta.id === get().selectedRepoId)) {
      set({ selectedRepoId: get().snapshot?.repositories[0]?.meta.id });
    }
    try {
      const result = await bridge().request<SettingsUpdateResult>({ type: 'updateSettings', payload: { settings: optimistic } });
      const current = get().bootstrap;
      if (current) set((state) => ({
        bootstrap: { ...current, state: { ...current.state, settings: result.settings } },
        snapshot: state.snapshot ? projectSnapshot(state.snapshot, state.allRepositories, result.settings) : undefined,
      }));
      if (!get().snapshot?.repositories.some((repo) => repo.meta.id === get().selectedRepoId)) {
        set({ selectedRepoId: get().snapshot?.repositories[0]?.meta.id });
      }
      if (result.effects.rescanWorkspace && get().snapshot) await get().refresh();
      else if (result.effects.reloadHistory) await get().loadHistory(true);
      if (result.effects.restartAutoRefresh) restartAutoRefresh();
    } catch (error) {
      const current = get().bootstrap;
      if (current) set((state) => ({
        bootstrap: { ...current, state: { ...current.state, settings: previous } },
        snapshot: state.snapshot ? projectSnapshot(state.snapshot, state.allRepositories, previous) : undefined,
        error: errorText(error),
      }));
      if (!get().snapshot?.repositories.some((repo) => repo.meta.id === get().selectedRepoId)) {
        set({ selectedRepoId: get().snapshot?.repositories[0]?.meta.id });
      }
    }
  };

  const updateLayout = (next: LayoutState) => {
    const bootstrap = get().bootstrap; if (!bootstrap) return;
    set({ bootstrap: { ...bootstrap, state: { ...bootstrap.state, layout: next } } });
    bridge().send({ type: 'updateLayout', payload: { layout: next } });
  };

  const extractCurrentSession = (state: AppStore): WorkspaceSessionState | undefined => {
    if (!state.snapshot) return undefined;
    return {
      snapshot: state.snapshot,
      allRepositories: state.allRepositories,
      selectedRepoId: state.selectedRepoId,
      selectedFile: state.selectedFile,
      fileHistoryTarget: state.fileHistoryTarget,
      mode: state.mode,
      diff: state.diff,
      changesDiff: state.changesDiff,
      changes: state.changes,
      history: state.history,
      historyHasMore: state.historyHasMore,
      historyByRepo: state.historyByRepo,
      historyTopology: state.historyTopology,
      historyTopologyByRepo: state.historyTopologyByRepo,
      historyHasMoreByRepo: state.historyHasMoreByRepo,
      historyLoading: state.historyLoading,
      branchesLoading: state.branchesLoading,
      historyScope: state.historyScope,
      historyFilter: state.historyFilter,
      selectedCommit: state.selectedCommit,
      selectedCommits: state.selectedCommits,
      selectedPrimaryKey: state.selectedPrimaryKey,
      selectedCommitDetails: state.selectedCommitDetails,
      selectedCommitLoading: state.selectedCommitLoading,
      mergeCommits: state.mergeCommits,
      mergeCommitsLoading: state.mergeCommitsLoading,
      mergeParentFiles: state.mergeParentFiles,
      mergeParentFilesLoading: state.mergeParentFilesLoading,
      branches: state.branches,
      tags: state.tags,
      branchesByRepo: state.branchesByRepo,
      tagsByRepo: state.tagsByRepo,
      conflicts: state.conflicts,
      merge: state.merge,
      mergeResult: state.mergeResult,
      stashes: state.stashes,
      shelves: state.shelves,
      changelists: state.changelists,
      worktrees: state.worktrees,
      worktreeDiff: state.worktreeDiff,
      subtrees: state.subtrees,
      submodules: state.submodules,
      unpushedCommits: state.unpushedCommits,
      comparisonTarget: state.comparisonTarget,
      comparison: state.comparison,
      remotes: state.remotes,
      lastSyncedAt: Date.now(),
    };
  };

  const persistTabs = async (tabs: WorkspaceSnapshot['workspace'][], activeId: string | null) => {
    const current = get().bootstrap;
    if (current) {
      const openWorkspaceIds = tabs.map((item) => item.id);
      const updatedState: AppStateSnapshot = {
        ...current.state,
        openWorkspaceIds,
        activeWorkspaceId: activeId,
        lastWorkspaceId: activeId,
      };
      set({ bootstrap: { ...current, state: updatedState } });
    }
    await bridge().syncWindowTabs(tabs.map((item) => item.paths), activeId);
  };

  const applySnapshot = async (snapshot: WorkspaceSnapshot, reloadRepository = true) => {
    const current = get().snapshot;
    if (current?.workspace.id === snapshot.workspace.id && current.generation > snapshot.generation) return;
    const workspaceChanged = current?.workspace.id !== snapshot.workspace.id;
    if (workspaceChanged) notificationBaseline.clear();
    const allRepositories = snapshot.repositories;
    const visibleSnapshot = projectSnapshot(snapshot, allRepositories, settings());
    const selectedRepoId = visibleSnapshot.repositories.some((repo) => repo.meta.id === get().selectedRepoId)
      ? get().selectedRepoId : visibleSnapshot.repositories[0]?.meta.id;
    set(workspaceChanged
      ? { snapshot: visibleSnapshot, allRepositories, selectedRepoId, selectedFile: undefined, fileHistoryTarget: undefined, historyFilter: '', diff: undefined, changesDiff: undefined, changes: undefined, merge: undefined, comparisonTarget: undefined, comparison: undefined, mode: 'history', history: [], historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, subtrees: {}, submodules: {}, worktrees: {}, stashes: {}, shelves: {}, changelists: {}, remotes: {}, unpushedCommits: {}, selectedCommits: [], selectedPrimaryKey: undefined, selectedCommit: undefined, selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {} }
      : { snapshot: visibleSnapshot, allRepositories, selectedRepoId });
    for (const repo of visibleSnapshot.repositories) {
      const counts = { incoming: repo.behind, unpushed: repo.ahead };
      const previous = notificationBaseline.get(repo.meta.id);
      notificationBaseline.set(repo.meta.id, counts);
      if (!previous) continue;
      const preferences = settings();
      const incoming = preferences.notifyIncomingCommits && counts.incoming > previous.incoming;
      const unpushed = preferences.notifyUnpushedCommits && counts.unpushed > previous.unpushed;
      if (!incoming && !unpushed) continue;
      const body = incoming ? `${repo.meta.name}: ${counts.incoming} incoming commits` : `${repo.meta.name}: ${counts.unpushed} unpushed commits`;
      get().addNotification({
        type: incoming ? 'info' : 'warning',
        title: incoming ? 'Incoming Commits' : 'Unpushed Commits',
        message: body,
        actionLabel: incoming ? 'Pull' : 'Push',
        actionKey: incoming ? 'pullAll' : 'pushAll',
        actionData: { repoId: repo.meta.id },
      });
      if (!await bridge().notify('VersionDock Desktop', body)) set({ notice: body });
    }
    if (selectedRepoId && (workspaceChanged || reloadRepository)) await get().selectRepo(selectedRepoId, true);
    const requests: Promise<void>[] = [get().loadConflicts()];
    if (workspaceChanged || reloadRepository) requests.push(get().loadStashes(), get().loadShelves(), get().loadWorktrees(), get().loadSubtrees(), get().loadSubmodules(), get().loadUnpushedCommits());
    await Promise.all(requests);
    if (get().snapshot?.workspace.id === snapshot.workspace.id) {
      const activeSession = extractCurrentSession(get());
      if (activeSession) {
        set((state) => ({
          sessions: {
            ...state.sessions,
            [snapshot.workspace.id]: activeSession,
          },
        }));
      }
    }
  };

  const refreshFromWatcher = async () => {
    if (watcherRefreshInFlight) {
      watcherRefreshQueued = true;
      return;
    }
    watcherRefreshInFlight = true;
    const reasons = new Set(watcherReasons);
    watcherReasons.clear();
    try {
      await get().refresh(true);
      if (reasons.has('refs')) {
        await Promise.all([get().loadHistory(true), get().selectRepo(get().selectedRepoId ?? '', true)]);
      }
    } finally {
      watcherRefreshInFlight = false;
      if (watcherRefreshQueued) {
        watcherRefreshQueued = false;
        watcherTimer = setTimeout(() => void refreshFromWatcher(), 300);
      }
    }
  };

  return {
    ready: false, busy: false, notifications: [], identityPanelRepoId: null, remoteManagerRepoId: null, tabs: [], activeTabId: null, sessions: {}, allRepositories: [], mode: 'history', history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyFilter: '', historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, remotes: {},

    operations: {},

    initialize: async (value) => {
      set({ bridge: value });
      value.subscribe((event) => {
        if ('workspaceId' in event && ['worktree', 'status', 'refs'].includes(event.reason) && event.workspaceId === get().snapshot?.workspace.id) {
          watcherReasons.add(event.reason);
          if (watcherTimer) clearTimeout(watcherTimer);
          watcherTimer = setTimeout(() => void refreshFromWatcher(), 300);
        }
      });
      void value.onFocusTab((focusPaths) => {
        const targetTab = get().tabs.find((tab) =>
          tab.paths.length === focusPaths.length && tab.paths.every((p, i) => p === focusPaths[i])
        );
        if (targetTab) {
          void get().switchTab(targetTab.id);
        }
      });
      await withBusy(async () => {
        const loaded = await value.request<BootstrapData>({ type: 'bootstrap' });
        const bootstrap = loaded.state.settings?.resetViewLocationsOnStartup
          ? { ...loaded, state: { ...loaded.state, layout: emptyState.layout! } }
          : loaded;
        value.setState(bootstrap.state);
        set({ bootstrap, ready: true });
        await get().restoreTabsOnStartup();
        restartAutoRefresh();
        if (bootstrap.state.settings?.fetchOnStartup && get().snapshot) {
          const gitRepos = get().snapshot?.repositories.filter((repo) => repo.meta.kind === 'git' && repo.toolAvailable !== false) ?? [];
          await Promise.allSettled(gitRepos.map((repo) => get().sync(repo.meta.id, 'fetch')));
        }
      }, 'workspace');
      set({ ready: true });
    },

    openWorkspace: async (paths, focus = true, options = {}) => {
      let opened = false;
      await withBusy(async () => {
      if (!paths.length) return;
      const existingTab = get().tabs.find((tab) => workspacePathsEqual(tab.paths, paths));
      if (existingTab) {
        if (options.insertionIndex !== undefined) {
          const currentIndex = get().tabs.findIndex((tab) => tab.id === existingTab.id);
          const targetIndex = Math.max(0, Math.min(options.insertionIndex, get().tabs.length - 1));
          if (currentIndex !== targetIndex) get().reorderTabs(currentIndex, targetIndex);
        }
        if (focus) {
          await get().switchTab(existingTab.id);
        }
        opened = true;
        return;
      }

      if (!options.skipCrossWindowFocus) {
        try {
          const focusedOther = await bridge().focusWorkspaceAcrossWindows(paths);
          if (focusedOther) {
            return;
          }
        } catch {
          // ignore cross-window focus error and fallback to opening in current window
        }
      }

      const currentActiveId = get().activeTabId;
      if (currentActiveId) {
        const currentSession = extractCurrentSession(get());
        if (currentSession) {
          set((state) => ({
            sessions: { ...state.sessions, [currentActiveId]: currentSession },
          }));
        }
      }

      cancelRequests();
      const controller = beginRequest('workspace');
      const requestGeneration = ++workspaceRequestGeneration;
      const snapshot = await bridge().request<WorkspaceSnapshot>({ type: 'workspaceOpen', payload: { paths } }, { signal: controller.signal });
      if (requestGeneration !== workspaceRequestGeneration) return;
      const current = get().bootstrap ?? { state: emptyState, tools: snapshot.tools, capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false } };
      
      const workspaceDescriptor = snapshot.workspace;
      const filteredTabs = get().tabs.filter((item) => item.id !== workspaceDescriptor.id);
      const insertionIndex = options.insertionIndex === undefined
        ? filteredTabs.length
        : Math.max(0, Math.min(options.insertionIndex, filteredTabs.length));
      const nextTabs = [...filteredTabs];
      nextTabs.splice(insertionIndex, 0, workspaceDescriptor);
      const recentWorkspaces = [workspaceDescriptor, ...current.state.recentWorkspaces.filter((item) => item.id !== workspaceDescriptor.id)].slice(0, 10);
      const nextBootstrap: BootstrapData = {
        ...current,
        state: {
          ...current.state,
          recentWorkspaces,
          openWorkspaceIds: nextTabs.map((t) => t.id),
          activeWorkspaceId: workspaceDescriptor.id,
          lastWorkspaceId: workspaceDescriptor.id,
        },
      };

      set({
        bootstrap: nextBootstrap,
        tabs: nextTabs,
        activeTabId: workspaceDescriptor.id,
      });

      await persistTabs(nextTabs, workspaceDescriptor.id);
      await applySnapshot(snapshot);
      opened = get().tabs.some((tab) => tab.id === workspaceDescriptor.id);
      }, 'workspace');
      return opened;
    },

    switchTab: async (workspaceId: string) => {
      if (get().activeTabId === workspaceId && get().snapshot) return;
      const targetTab = get().tabs.find((t) => t.id === workspaceId);
      if (!targetTab) return;

      cancelRequests();
      workspaceRequestGeneration += 1;
      historyRequestGeneration += 1;
      changesDiffGeneration += 1;
      commitSelectionGeneration += 1;
      comparisonRequestGeneration += 1;
      branchWorkingDiffGeneration += 1;

      const currentActiveId = get().activeTabId;
      if (currentActiveId && currentActiveId !== workspaceId) {
        const currentSession = extractCurrentSession(get());
        if (currentSession) {
          set((state) => ({
            sessions: { ...state.sessions, [currentActiveId]: currentSession },
          }));
        }
      }

      const cachedSession = get().sessions[workspaceId];
      if (cachedSession) {
        set({
          activeTabId: workspaceId,
          snapshot: cachedSession.snapshot,
          allRepositories: cachedSession.allRepositories,
          selectedRepoId: cachedSession.selectedRepoId,
          selectedFile: cachedSession.selectedFile,
          fileHistoryTarget: cachedSession.fileHistoryTarget,
          mode: cachedSession.mode,
          diff: cachedSession.diff,
          changesDiff: cachedSession.changesDiff,
          changes: cachedSession.changes,
          history: cachedSession.history,
          historyHasMore: cachedSession.historyHasMore,
          historyByRepo: cachedSession.historyByRepo,
          historyTopology: cachedSession.historyTopology,
          historyTopologyByRepo: cachedSession.historyTopologyByRepo,
          historyHasMoreByRepo: cachedSession.historyHasMoreByRepo,
          historyLoading: false,
          branchesLoading: false,
          historyScope: cachedSession.historyScope,
          historyFilter: cachedSession.historyFilter,
          selectedCommit: cachedSession.selectedCommit,
          selectedCommits: cachedSession.selectedCommits,
          selectedPrimaryKey: cachedSession.selectedPrimaryKey,
          selectedCommitDetails: cachedSession.selectedCommitDetails,
          selectedCommitLoading: {},
          mergeCommits: cachedSession.mergeCommits,
          mergeCommitsLoading: {},
          mergeParentFiles: cachedSession.mergeParentFiles,
          mergeParentFilesLoading: {},
          branches: cachedSession.branches,
          tags: cachedSession.tags,
          branchesByRepo: cachedSession.branchesByRepo,
          tagsByRepo: cachedSession.tagsByRepo,
          conflicts: cachedSession.conflicts,
          merge: cachedSession.merge,
          mergeResult: cachedSession.mergeResult,
          stashes: cachedSession.stashes,
          shelves: cachedSession.shelves,
          changelists: cachedSession.changelists,
          worktrees: cachedSession.worktrees,
          worktreeDiff: cachedSession.worktreeDiff,
          subtrees: cachedSession.subtrees,
          submodules: cachedSession.submodules,
          unpushedCommits: cachedSession.unpushedCommits,
          comparisonTarget: cachedSession.comparisonTarget,
          comparison: cachedSession.comparison,
          remotes: cachedSession.remotes,
        });
        await persistTabs(get().tabs, workspaceId);
      } else {
        await withBusy(async () => {
          const controller = beginRequest('workspace');
          const requestGeneration = ++workspaceRequestGeneration;
          const snapshot = await bridge().request<WorkspaceSnapshot>({ type: 'workspaceOpen', payload: { paths: targetTab.paths } }, { signal: controller.signal });
          if (requestGeneration !== workspaceRequestGeneration) return;
          set({ activeTabId: workspaceId });
          await persistTabs(get().tabs, workspaceId);
          await applySnapshot(snapshot, true);
        }, 'workspace');
      }
    },

    closeTab: async (workspaceId: string) => {
      const currentTabs = get().tabs;
      const tabIndex = currentTabs.findIndex((t) => t.id === workspaceId);
      if (tabIndex === -1) return;

      const nextTabs = currentTabs.filter((t) => t.id !== workspaceId);
      const nextSessions = { ...get().sessions };
      delete nextSessions[workspaceId];

      if (get().activeTabId === workspaceId) {
        if (nextTabs.length > 0) {
          const nextActiveIndex = Math.min(tabIndex, nextTabs.length - 1);
          const nextActiveTab = nextTabs[nextActiveIndex];
          set({
            tabs: nextTabs,
            sessions: nextSessions,
          });
          await get().switchTab(nextActiveTab.id);
        } else {
          set({
            tabs: nextTabs,
            activeTabId: null,
            sessions: nextSessions,
            snapshot: undefined,
            allRepositories: [],
            selectedRepoId: undefined,
            selectedFile: undefined,
            fileHistoryTarget: undefined,
            mode: 'history',
            diff: undefined,
            changesDiff: undefined,
            changes: undefined,
            history: [],
            historyHasMore: false,
            historyByRepo: {},
            historyTopology: [],
            historyTopologyByRepo: {},
            historyHasMoreByRepo: {},
            historyLoading: false,
            branchesLoading: false,
            historyScope: { repoIds: null, revisionsByRepo: {} },
            historyFilter: '',
            selectedCommit: undefined,
            selectedCommits: [],
            selectedPrimaryKey: undefined,
            selectedCommitDetails: {},
            selectedCommitLoading: {},
            mergeCommits: {},
            mergeCommitsLoading: {},
            mergeParentFiles: {},
            mergeParentFilesLoading: {},
            branches: [],
            tags: [],
            branchesByRepo: {},
            tagsByRepo: {},
            conflicts: [],
            merge: undefined,
            mergeResult: '',
            stashes: {},
            shelves: {},
            changelists: {},
            worktrees: {},
            worktreeDiff: undefined,
            subtrees: {},
            submodules: {},
            unpushedCommits: {},
            comparisonTarget: undefined,
            comparison: undefined,
            remotes: {},
          });
          await persistTabs(nextTabs, null);
        }
      } else {
        set({
          tabs: nextTabs,
          sessions: nextSessions,
        });
        await persistTabs(nextTabs, get().activeTabId);
      }
    },

    closeOtherTabs: async (workspaceId: string) => {
      const targetTab = get().tabs.find((t) => t.id === workspaceId);
      if (!targetTab) return;
      const nextTabs = [targetTab];
      const nextSessions: Record<string, WorkspaceSessionState> = {};
      if (get().sessions[workspaceId]) {
        nextSessions[workspaceId] = get().sessions[workspaceId];
      }
      set({ tabs: nextTabs, sessions: nextSessions });
      if (get().activeTabId !== workspaceId) {
        await get().switchTab(workspaceId);
      } else {
        await persistTabs(nextTabs, workspaceId);
      }
    },

    closeAllTabs: async () => {
      set({
        tabs: [],
        activeTabId: null,
        sessions: {},
        snapshot: undefined,
        allRepositories: [],
        selectedRepoId: undefined,
        selectedFile: undefined,
        fileHistoryTarget: undefined,
        mode: 'history',
        diff: undefined,
        changesDiff: undefined,
        changes: undefined,
        history: [],
        historyHasMore: false,
        historyByRepo: {},
        historyTopology: [],
        historyTopologyByRepo: {},
        historyHasMoreByRepo: {},
        historyLoading: false,
        branchesLoading: false,
        historyScope: { repoIds: null, revisionsByRepo: {} },
        historyFilter: '',
        selectedCommit: undefined,
        selectedCommits: [],
        selectedPrimaryKey: undefined,
        selectedCommitDetails: {},
        selectedCommitLoading: {},
        mergeCommits: {},
        mergeCommitsLoading: {},
        mergeParentFiles: {},
        mergeParentFilesLoading: {},
        branches: [],
        tags: [],
        branchesByRepo: {},
        tagsByRepo: {},
        conflicts: [],
        merge: undefined,
        mergeResult: '',
        stashes: {},
        shelves: {},
        changelists: {},
        worktrees: {},
        worktreeDiff: undefined,
        subtrees: {},
        submodules: {},
        unpushedCommits: {},
        comparisonTarget: undefined,
        comparison: undefined,
        remotes: {},
      });
      await persistTabs([], null);
    },

    reorderTabs: (fromIndex: number, toIndex: number) => {
      const currentTabs = [...get().tabs];
      if (fromIndex < 0 || fromIndex >= currentTabs.length || toIndex < 0 || toIndex >= currentTabs.length) return;
      const [moved] = currentTabs.splice(fromIndex, 1);
      currentTabs.splice(toIndex, 0, moved);
      set({ tabs: currentTabs });
      void persistTabs(currentTabs, get().activeTabId).catch(() => undefined);
    },

    restoreTabsOnStartup: async () => {
      const currentWindowLabel = await bridge().getWindowLabel();
      if (typeof window !== 'undefined' && window.location.search) {
        const params = new URLSearchParams(window.location.search);
        const encodedPaths = params.get('workspacePaths');
        const encodedTransfer = params.get('tabTransfer');
        const clearStartupParameters = () => {
          params.delete('workspacePaths');
          params.delete('tabTransfer');
          params.delete('window');
          const query = params.toString();
          window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
        };
        if (encodedPaths) {
          let transfer: WindowTabTransfer | null = null;
          try {
            if (encodedTransfer) transfer = JSON.parse(encodedTransfer) as WindowTabTransfer;
            const paths = JSON.parse(encodedPaths) as string[];
            if (Array.isArray(paths) && paths.length > 0) {
              const accepted = await get().openWorkspace(paths, true, { skipCrossWindowFocus: true });
              if (transfer) {
                await bridge().completeTabTransfer(transfer, currentWindowLabel, accepted);
              }
              clearStartupParameters();
              return;
            }
          } catch {
            if (transfer) {
              await bridge().completeTabTransfer(transfer, currentWindowLabel, false).catch(() => undefined);
            }
          }
        }
        clearStartupParameters();
      }

      if (currentWindowLabel !== 'main') {
        await persistTabs([], null);
        return;
      }

      const state = get().bootstrap?.state;
      if (!state) return;
      const recent = state.recentWorkspaces ?? [];
      const openIds = state.openWorkspaceIds ?? [];
      let initialTabs: WorkspaceDescriptor[] = [];

      if (openIds.length > 0) {
        initialTabs = openIds
          .map((id) => recent.find((item) => item.id === id && item.available))
          .filter((item): item is WorkspaceDescriptor => Boolean(item));
      }

      if (initialTabs.length === 0) {
        const lastId = state.activeWorkspaceId ?? state.lastWorkspaceId;
        const lastWorkspace = recent.find((item) => item.id === lastId && item.available);
        if (lastWorkspace) {
          initialTabs = [lastWorkspace];
        }
      }

      if (initialTabs.length > 0) {
        const targetActiveId = (state.activeWorkspaceId && initialTabs.some((t) => t.id === state.activeWorkspaceId))
          ? state.activeWorkspaceId
          : (state.lastWorkspaceId && initialTabs.some((t) => t.id === state.lastWorkspaceId))
          ? state.lastWorkspaceId
          : initialTabs[0].id;

        set({ tabs: initialTabs, activeTabId: targetActiveId });
        const targetWorkspace = initialTabs.find((t) => t.id === targetActiveId) ?? initialTabs[0];
        await get().openWorkspace(targetWorkspace.paths, true);
      }
    },

    restoreLastWorkspace: async () => {
      await get().restoreTabsOnStartup();
    },

    removeRecent: async (id) => withBusy(async () => {
      await bridge().request({ type: 'workspaceRemoveRecent', payload: { workspace_id: id } });
      const current = get().bootstrap;
      if (current) {
        const nextLastWorkspaceId = current.state.lastWorkspaceId === id ? null : current.state.lastWorkspaceId;
        const nextActiveId = current.state.activeWorkspaceId === id ? null : current.state.activeWorkspaceId;
        const nextOpenIds = current.state.openWorkspaceIds?.filter((item) => item !== id) ?? [];
        set({
          bootstrap: {
            ...current,
            state: {
              ...current.state,
              recentWorkspaces: current.state.recentWorkspaces.filter((item) => item.id !== id),
              openWorkspaceIds: nextOpenIds,
              activeWorkspaceId: nextActiveId,
              lastWorkspaceId: nextLastWorkspaceId,
            },
          },
        });
      }
    }, 'workspace'),

    refresh: async (silent = false) => {
      const operation = async () => {
        const id = workspaceId();
        const controller = beginRequest(`workspace:${id}`);
        const snapshot = await bridge().request<WorkspaceSnapshot>({ type: 'workspaceRefresh', payload: { workspace_id: id } }, { signal: controller.signal });
        if (get().snapshot?.workspace.id !== id) return;
        await applySnapshot(snapshot, !silent);
      };
      if (silent) {
        try {
          await operation();
        } catch (error) {
          if (!isAbortError(error)) {
            set({ error: errorText(error) });
          }
        }
      } else {
        await withBusy(operation, 'workspace');
      }
    },

    selectRepo: async (repoId, reload = false) => {
      const repo = get().snapshot?.repositories.find((item) => item.meta.id === repoId);
      if (!repo) return;
      const repoChanged = get().selectedRepoId !== repoId;
      if (repoChanged) {
        comparisonRequestGeneration += 1;
        requestControllers.get('branch-comparison')?.abort();
      }
      set((state) => ({
        selectedRepoId: repoId,
        ...(repoChanged ? {
          selectedCommit: undefined,
          selectedCommits: [],
          selectedPrimaryKey: undefined,
          selectedCommitLoading: {},
          mergeCommitsLoading: {},
          changes: undefined,
          changesDiff: undefined,
          comparisonTarget: undefined,
          comparison: undefined,
          mode: 'history' as const,
        } : {}),
        branches: state.branchesByRepo[repoId] ?? [],
        tags: state.tagsByRepo[repoId] ?? [],
      }));
      if (!reload && Object.keys(get().historyByRepo).length > 0) return;
      await withBusy(async () => {
        set({ branchesLoading: true });
        const requests: Promise<unknown>[] = [get().loadHistory(true)];
        if (get().bootstrap?.capabilities.changelist && repo.capabilities?.changelist !== false) requests.push(get().loadChangelists(repoId));
        if (repo.meta.kind === 'git' && get().bootstrap?.capabilities.subtree && repo.capabilities?.subtree !== false) requests.push(get().loadSubtrees(repoId));
        const currentWorkspace = workspaceId();
        for (const item of get().snapshot?.repositories ?? []) {
          requests.push(bridge().request<BranchInfo[]>({ type: 'branches', payload: { workspace_id: currentWorkspace, repo_id: item.meta.id } }).then((branches) => {
            if (get().snapshot?.workspace.id !== currentWorkspace) return;
            set((state) => ({
              branchesByRepo: { ...state.branchesByRepo, [item.meta.id]: branches },
              branches: item.meta.id === get().selectedRepoId ? branches : state.branches,
            }));
          }));
          requests.push(bridge().request<TagInfo[]>({ type: 'tags', payload: { workspace_id: currentWorkspace, repo_id: item.meta.id } }).then((tags) => {
            if (get().snapshot?.workspace.id !== currentWorkspace) return;
            set((state) => ({
              tagsByRepo: { ...state.tagsByRepo, [item.meta.id]: tags },
              tags: item.meta.id === get().selectedRepoId ? tags : state.tags,
            }));
          }));
        }
        try {
          await Promise.all(requests);
        } finally {
          set({ branchesLoading: false });
        }
        const firstCommit = get().history[0];
        if (firstCommit && !get().selectedCommits.length) await get().selectCommit(firstCommit);
      }, `repository:${repoId}`);
    },

    openDiff: async (repoId, path, staged, revision, range) => withBusy(async () => {
      const controller = beginRequest('diff');
      const diff = await bridge().request<DiffDocument>({ type: 'fileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, relative_path: path, staged, revision: revision ?? null, from_revision: range?.fromRevision ?? null, to_revision: range?.toRevision ?? null } }, { signal: controller.signal });
      set({ selectedFile: { repoId, path, staged, revision, fromRevision: range?.fromRevision, toRevision: range?.toRevision }, diff, mode: 'diff' });
    }, `diff:${repoId}`),
    openStashDiff: async (repoId, reference, path) => withBusy(async () => {
      const controller = beginRequest('diff');
      const diff = await bridge().request<DiffDocument>({ type: 'stashFileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, reference, relative_path: path } }, { signal: controller.signal });
      set({ selectedFile: { repoId, path, staged: false, revision: reference }, diff, mode: 'diff' });
    }, `diff:${repoId}`),
    openShelfDiff: async (repoId, shelfId, path) => withBusy(async () => {
      const controller = beginRequest('diff');
      const diff = await bridge().request<DiffDocument>({ type: 'shelfFileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, shelf_id: shelfId, relative_path: path } }, { signal: controller.signal });
      set({ selectedFile: { repoId, path, staged: false, revision: shelfId }, diff, mode: 'diff' });
    }, `diff:${repoId}`),

    openCommitDetail: () => {
      if (!get().selectedCommits.length) return;
      set({ mode: 'commit-detail' });
    },

    openCommitChanges: () => {
      const state = get();
      if (!state.selectedCommits.length) return;
      const files = buildCommitFileTargets(state.selectedCommits, state.selectedCommitDetails, state.snapshot?.repositories ?? []);
      if (!files.length) return;
      set({ changes: { commits: state.selectedCommits, files }, changesDiff: undefined, mode: 'changes' });
    },

    loadChangesDiff: async (target) => withBusy(async () => {
      const generation = ++changesDiffGeneration;
      const diff = await bridge().request<DiffDocument>({ type: 'fileDiff', payload: { workspace_id: workspaceId(), repo_id: target.repoId, relative_path: target.path, staged: false, revision: target.toRevision ? null : target.commitHash, from_revision: target.fromRevision ?? null, to_revision: target.toRevision ?? null } });
      if (generation === changesDiffGeneration) set({ changesDiff: diff });
    }, `diff:${target.repoId}`),

    stage: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'stage', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
      await get().refresh();
    }, `repository:${repoId}`),

    unstage: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'unstage', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
      await get().refresh();
    }, `repository:${repoId}`),

    discard: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'discard', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
      await get().refresh();
    }, `repository:${repoId}`),
    deletePaths: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'deletePaths', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
      await get().refresh();
    }, `repository:${repoId}`),
    addIgnore: async (repoId, path) => withBusy(async () => {
      await bridge().request({ type: 'addIgnore', payload: { workspace_id: workspaceId(), repo_id: repoId, relative_path: path } });
      await get().refresh();
    }, `repository:${repoId}`),

    commit: async (repoId, message, amend, paths, push) => withBusy(async () => {
      await bridge().request({ type: 'commit', payload: { workspace_id: workspaceId(), repo_id: repoId, message, amend, paths } });
      if (push) await bridge().request({ type: 'sync', payload: { workspace_id: workspaceId(), repo_id: repoId, action: 'push', remote: null } }, { timeoutMs: 600_000 });
      await get().refresh();
    }, `commit:${repoId}`),

    commitMany: async (targets, message, push) => withBusy(async () => {
      const workspace_id = workspaceId();
      await Promise.all(targets.map(async (target) => {
        if (target.unstagePaths.length > 0) {
          await bridge().request({ type: 'unstage', payload: { workspace_id, repo_id: target.repoId, paths: target.unstagePaths } });
        }
      }));
      const results = await bridge().request<RepositoryOperationResult[]>({ type: 'batchCommit', payload: { workspace_id, targets: targets.map((target) => ({ repoId: target.repoId, message, amend: target.amend, paths: target.paths })), push } }, { timeoutMs: 600_000 });
      const failures = results.filter((result) => result.error);
      if (failures.length) set({ error: failures.map((result) => `${result.repoId}: ${result.error?.message}`).join('\n') });
      await get().refresh();
    }, 'commit:batch'),

    sync: async (repoId, action) => withBusy(async () => {
      await bridge().request({ type: 'sync', payload: { workspace_id: workspaceId(), repo_id: repoId, action, remote: null } }, { timeoutMs: 600_000 });
      await get().refresh();
    }, `sync:${repoId}`),

    loadHistory: async (reset = false) => {
      const allRepos = (get().snapshot?.repositories ?? []).filter((repo) => !repo.meta.isWorktree);
      const scope = get().historyScope;
      const repoIds = scope.repoIds ? new Set(scope.repoIds) : null;
      const repos = repoIds ? allRepos.filter((repo) => repoIds.has(repo.meta.id)) : allRepos;
      if (!repos.length) {
        if (reset) set({ history: [], historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMore: false, historyHasMoreByRepo: {}, historyLoading: false });
        return;
      }
      if (!reset && get().historyLoading) return;
      const historyMaxCommits = settings().maximumGraphCommits;
      if (!reset && get().history.length >= historyMaxCommits) {
        set({ historyHasMore: false });
        return;
      }
      const requestGeneration = reset ? ++historyRequestGeneration : historyRequestGeneration;
      const requestWorkspace = workspaceId();
      const visibleLimit = Math.min((reset ? 0 : get().history.length) + HISTORY_PAGE_SIZE, historyMaxCommits);
      set({ historyLoading: true });
      try {
        // VersionDock fetches the prefix needed from every repository, merges
        // those logs, and only then applies the workspace-wide page boundary.
        const pagesPromise = Promise.all(repos.map(async (repo) => {
          const page = await bridge().request<HistoryPage>({ type: 'history', payload: { workspace_id: requestWorkspace, repo_id: repo.meta.id, skip: 0, limit: visibleLimit, filter: get().historyFilter || null, revision: scope.revisionsByRepo[repo.meta.id] ?? null } });
          return { repoId: repo.meta.id, page };
        }));
        const topologyPromise = reset && !get().historyFilter
          ? Promise.all(repos.map(async (repo) => ({
            repoId: repo.meta.id,
            commits: await bridge().request<GraphCommitNode[]>({ type: 'historyTopology', payload: { workspace_id: requestWorkspace, repo_id: repo.meta.id, svn_limit: 1000 } }).catch(() => []),
          })))
          : Promise.resolve(undefined);
        const [pages, topology] = await Promise.all([pagesPromise, topologyPromise]);
        if (requestGeneration !== historyRequestGeneration || get().snapshot?.workspace.id !== requestWorkspace) return;
        const nextByRepo: Record<string, CommitNode[]> = {};
        const nextHasMore: Record<string, boolean> = {};
        for (const { repoId, page } of pages) {
          nextByRepo[repoId] = page.commits;
          nextHasMore[repoId] = page.hasMore;
        }
        const mergedHistory = interleaveHistory(nextByRepo);
        const history = mergedHistory.slice(0, visibleLimit);
        const historyHasMore = visibleLimit < historyMaxCommits
          && (mergedHistory.length > visibleLimit || Object.values(nextHasMore).some(Boolean));
        if (topology) {
          const historyTopologyByRepo = Object.fromEntries(topology.map((item) => [item.repoId, item.commits]));
          set({ historyByRepo: nextByRepo, historyHasMoreByRepo: nextHasMore, history, historyHasMore, historyTopologyByRepo, historyTopology: interleaveLogs(historyTopologyByRepo) });
        } else {
          set({ historyByRepo: nextByRepo, historyHasMoreByRepo: nextHasMore, history, historyHasMore });
        }
      } catch (error) {
        if (!isAbortError(error)) {
          set({ error: errorText(error) });
          throw error;
        }
      } finally {
        if (requestGeneration === historyRequestGeneration) set({ historyLoading: false });
      }
    },

    setHistoryFilter: (value) => set({ historyFilter: value }),
    setHistoryScope: (historyScope) => set({ historyScope }),

    loadCommitDetail: async (commit) => {
      const key = commitKey(commit.repoId, commit.hash);
      const cached = get().selectedCommitDetails[key];
      if (cached) return cached;
      set((state) => ({ selectedCommitLoading: { ...state.selectedCommitLoading, [key]: true } }));
      try {
        const detail = await bridge().request<CommitDetail>({ type: 'commitDetail', payload: { workspace_id: workspaceId(), repo_id: commit.repoId, revision: commit.hash } });
        set((state) => ({ selectedCommitDetails: { ...state.selectedCommitDetails, [key]: detail }, selectedCommitLoading: { ...state.selectedCommitLoading, [key]: false } }));
        return detail;
      } catch (error) {
        if (!isAbortError(error)) {
          set((state) => ({ error: errorText(error), selectedCommitLoading: { ...state.selectedCommitLoading, [key]: false } }));
          throw error;
        }
        set((state) => ({ selectedCommitLoading: { ...state.selectedCommitLoading, [key]: false } }));
        throw error;
      }
    },

    selectCommit: async (commit, mode = 'single', rangeSource) => withBusy(async () => {
      const state = get();
      const clickedKey = commitKey(commit.repoId, commit.hash);
      const source = rangeSource ?? state.history;
      let selected: CommitNode[];
      if (mode === 'single') {
        selected = [commit];
      } else if (mode === 'toggle') {
        const selectedKeys = new Set(state.selectedCommits.map((item) => commitKey(item.repoId, item.hash)));
        if (selectedKeys.has(clickedKey)) selectedKeys.delete(clickedKey);
        else selectedKeys.add(clickedKey);
        selected = source.filter((item) => selectedKeys.has(commitKey(item.repoId, item.hash)));
      } else {
        const anchorKey = state.selectedPrimaryKey ?? (state.selectedCommits[0] ? commitKey(state.selectedCommits[0].repoId, state.selectedCommits[0].hash) : clickedKey);
        const anchorIndex = source.findIndex((item) => commitKey(item.repoId, item.hash) === anchorKey);
        const clickedIndex = source.findIndex((item) => commitKey(item.repoId, item.hash) === clickedKey);
        if (anchorIndex < 0 || clickedIndex < 0) selected = [commit];
        else {
          const start = Math.min(anchorIndex, clickedIndex);
          const end = Math.max(anchorIndex, clickedIndex);
          selected = source.slice(start, end + 1);
        }
      }

      const primary = selected.length ? (selected.find((item) => commitKey(item.repoId, item.hash) === clickedKey) ?? selected[selected.length - 1]) : undefined;
      const primaryKey = primary ? commitKey(primary.repoId, primary.hash) : undefined;
      const generation = ++commitSelectionGeneration;
      const loading = Object.fromEntries(selected.filter((item) => !state.selectedCommitDetails[commitKey(item.repoId, item.hash)]).map((item) => [commitKey(item.repoId, item.hash), true]));
      set({ selectedCommits: selected, selectedPrimaryKey: primaryKey, selectedCommit: primaryKey ? state.selectedCommitDetails[primaryKey] : undefined, selectedCommitLoading: loading, changes: undefined, changesDiff: undefined, mode: 'history' });
      const missing = selected.filter((item) => !state.selectedCommitDetails[commitKey(item.repoId, item.hash)]);
      const values = await Promise.all(missing.map(async (item) => ({ key: commitKey(item.repoId, item.hash), detail: await get().loadCommitDetail(item) })));
      if (generation !== commitSelectionGeneration) return;
      const details = { ...get().selectedCommitDetails };
      for (const value of values) details[value.key] = value.detail;
      set({ selectedCommitDetails: details, selectedCommit: primaryKey ? details[primaryKey] : undefined, selectedCommitLoading: {} });
      if (primary?.parents.length && primary.parents.length >= 2) void get().loadMergeCommits(primary);
    }, `history:${commit.repoId}`),

    loadMergeCommits: async (commit) => {
      const key = commitKey(commit.repoId, commit.hash);
      if (get().mergeCommits[key] || get().mergeCommitsLoading[key] || commit.parents.length < 2) return;
      set((state) => ({ mergeCommitsLoading: { ...state.mergeCommitsLoading, [key]: true } }));
      try {
        const values = await bridge().request<MergeCommitSummary[]>({ type: 'commitMergeCommits', payload: { workspace_id: workspaceId(), repo_id: commit.repoId, revision: commit.hash, parents: commit.parents } });
        set((state) => ({ mergeCommits: { ...state.mergeCommits, [key]: values }, mergeCommitsLoading: { ...state.mergeCommitsLoading, [key]: false } }));
      } catch (error) {
        if (!isAbortError(error)) {
          set((state) => ({ error: errorText(error), mergeCommitsLoading: { ...state.mergeCommitsLoading, [key]: false } }));
        } else {
          set((state) => ({ mergeCommitsLoading: { ...state.mergeCommitsLoading, [key]: false } }));
        }
      }
    },

    loadMergeParentFiles: async (repoId, revision, parentHash) => {
      const key = `${repoId}\0${revision}\0${parentHash}`;
      const cached = get().mergeParentFiles[key];
      if (cached) return cached;
      set((state) => ({ mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: true } }));
      try {
        const values = await bridge().request<CommitFile[]>({
          type: 'commitMergeParentFiles',
          payload: {
            workspace_id: workspaceId(),
            repo_id: repoId,
            revision,
            parent_hash: parentHash,
          },
        });
        set((state) => ({
          mergeParentFiles: { ...state.mergeParentFiles, [key]: values },
          mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: false },
        }));
        return values;
      } catch (error) {
        if (!isAbortError(error)) {
          set((state) => ({
            error: errorText(error),
            mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: false },
          }));
          throw error;
        }
        set((state) => ({
          mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: false },
        }));
        throw error;
      }
    },

    clearCommitSelection: () => {
      commitSelectionGeneration += 1;
      set({ selectedCommit: undefined, selectedCommits: [], selectedPrimaryKey: undefined, selectedCommitLoading: {}, changes: undefined, changesDiff: undefined, mode: 'history' });
    },

    branchOperation: async (operation, requestedRepoId) => {
      const repoId = requestedRepoId ?? get().selectedRepoId; if (!repoId) return;
      await withBusy(async () => {
        await bridge().request({ type: 'branchOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation: operation as never } });
        await get().refresh();
      }, `repository:${repoId}`);
    },

    tagOperation: async (operation, requestedRepoId) => {
      const repoId = requestedRepoId ?? get().selectedRepoId; if (!repoId) return;
      await withBusy(async () => {
        await bridge().request({ type: 'tagOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation: operation as never } });
        await get().selectRepo(repoId, true);
      }, `repository:${repoId}`);
    },

    loadStashes: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        const values = await b.request<StashEntry[]>({ type: 'stashes', payload: { workspace_id: wid, repo_id: repoId } }).catch(() => []);
        if (get().snapshot?.workspace.id !== wid) return;
        set((state) => ({ stashes: { ...state.stashes, [repoId]: values } }));
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const values = await Promise.all(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        stashes: await b.request<StashEntry[]>({ type: 'stashes', payload: { workspace_id: wid, repo_id: repo.meta.id } }).catch(() => []),
      })));
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => ({ stashes: values.reduce((next, value) => ({ ...next, [value.repoId]: value.stashes }), state.stashes) }));
    },
    stashOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'stashOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await Promise.all([get().loadStashes(repoId), get().refresh()]);
    }, `stash:${repoId}`),
    loadShelves: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        const values = await b.request<ShelfEntry[]>({ type: 'shelves', payload: { workspace_id: wid, repo_id: repoId } }).catch(() => []);
        if (get().snapshot?.workspace.id !== wid) return;
        set((state) => ({ shelves: { ...state.shelves, [repoId]: values } }));
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const values = await Promise.all(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        shelves: await b.request<ShelfEntry[]>({ type: 'shelves', payload: { workspace_id: wid, repo_id: repo.meta.id } }).catch(() => []),
      })));
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => ({ shelves: values.reduce((next, value) => ({ ...next, [value.repoId]: value.shelves }), state.shelves) }));
    },
    shelfOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'shelfOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await Promise.all([get().loadShelves(repoId), get().refresh()]);
    }, `shelf:${repoId}`),
    loadChangelists: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      const id = repoId ?? get().selectedRepoId;
      if (!b || !wid || !id) return;
      const values = await b.request<ChangelistEntry[]>({ type: 'changelists', payload: { workspace_id: wid, repo_id: id } }).catch(() => []);
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => ({ changelists: { ...state.changelists, [id]: values } }));
    },
    changelistOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'changelistOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await get().loadChangelists(repoId);
    }, `changelist:${repoId}`),
    loadWorktrees: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        const values = await b.request<WorktreeEntry[]>({ type: 'worktrees', payload: { workspace_id: wid, repo_id: repoId } }).catch(() => []);
        if (get().snapshot?.workspace.id !== wid) return;
        set((state) => ({ worktrees: { ...state.worktrees, [repoId]: values } }));
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const values = await Promise.all(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        worktrees: await b.request<WorktreeEntry[]>({ type: 'worktrees', payload: { workspace_id: wid, repo_id: repo.meta.id } }).catch(() => []),
      })));
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => ({ worktrees: values.reduce((next, value) => ({ ...next, [value.repoId]: value.worktrees }), state.worktrees) }));
    },
    worktreeOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'worktreeOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await Promise.all([get().loadWorktrees(repoId), get().refresh()]);
    }, `worktree:${repoId}`),
    openWorktree: async (repoId, path, reveal) => withBusy(async () => {
      await bridge().request({ type: 'openWorktree', payload: { workspace_id: workspaceId(), repo_id: repoId, path, reveal } });
    }, `worktree:${repoId}`),
    loadWorktreeDiff: async (repoId, path, baseRef = 'HEAD') => withBusy(async () => {
      const wid = get().snapshot?.workspace.id;
      const result = await bridge().request<WorktreeDiffResult>({ type: 'worktreeDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, path, base_ref: baseRef } });
      if (get().snapshot?.workspace.id !== wid) return;
      set({ worktreeDiff: { ...result, repoId, source: 'worktree' } });
    }, `worktree:${repoId}`),
    openWorktreeFileDiff: async (repoId, path, baseRef, relativePath) => withBusy(async () => {
      const wid = get().snapshot?.workspace.id;
      const diff = await bridge().request<DiffDocument>({ type: 'worktreeFileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, path, base_ref: baseRef, relative_path: relativePath } });
      if (get().snapshot?.workspace.id !== wid) return;
      set({ selectedFile: { repoId, path: relativePath, staged: false, fromRevision: baseRef, toRevision: 'WORKTREE' }, diff, mode: 'diff' });
    }, `diff:${repoId}`),
    loadBranchWorkingDiff: async (repoId, baseRef) => withBusy(async () => {
      const generation = ++branchWorkingDiffGeneration;
      const requestWorkspace = workspaceId();
      const controller = beginRequest('branch-working-diff');
      const result = await bridge().request<WorktreeDiffResult>({ type: 'branchWorkingDiff', payload: { workspace_id: requestWorkspace, repo_id: repoId, base_ref: baseRef } }, { signal: controller.signal });
      if (generation !== branchWorkingDiffGeneration || get().snapshot?.workspace.id !== requestWorkspace) return;
      set({ worktreeDiff: { ...result, repoId, source: 'repository' } });
    }, `diff:${repoId}`),
    openBranchWorkingFileDiff: async (repoId, baseRef, relativePath) => withBusy(async () => {
      const wid = get().snapshot?.workspace.id;
      const diff = await bridge().request<DiffDocument>({ type: 'branchWorkingFileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, base_ref: baseRef, relative_path: relativePath } });
      if (get().snapshot?.workspace.id !== wid) return;
      set({ selectedFile: { repoId, path: relativePath, staged: false, fromRevision: baseRef, toRevision: 'WORKING' }, diff, mode: 'diff' });
    }, `diff:${repoId}`),
    closeWorktreeDiff: () => {
      branchWorkingDiffGeneration += 1;
      requestControllers.get('branch-working-diff')?.abort();
      set({ worktreeDiff: undefined });
    },
    loadSubtrees: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        const values = await b.request<SubtreeEntry[]>({ type: 'subtrees', payload: { workspace_id: wid, repo_id: repoId } }).catch(() => []);
        if (get().snapshot?.workspace.id !== wid) return;
        set((state) => ({ subtrees: { ...state.subtrees, [repoId]: values } }));
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const values = await Promise.all(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        subtrees: await b.request<SubtreeEntry[]>({ type: 'subtrees', payload: { workspace_id: wid, repo_id: repo.meta.id } }).catch(() => []),
      })));
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => ({ subtrees: values.reduce((next, value) => ({ ...next, [value.repoId]: value.subtrees }), state.subtrees) }));
    },
    subtreeOperation: async (repoId, operation) => withBusy(async () => {
      const networkOperation = operation.type === 'add' || operation.type === 'pull' || operation.type === 'push';
      await bridge().request({ type: 'subtreeOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, networkOperation ? { timeoutMs: 600_000 } : undefined);
      await Promise.all([get().loadSubtrees(repoId), get().refresh()]);
    }, `subtree:${repoId}`),
    loadSubmodules: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git' && !repo.meta.isSubmodule && (!repoId || repo.meta.id === repoId));
      const values = await Promise.all(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        submodules: await b.request<SubmoduleEntry[]>({ type: 'submodules', payload: { workspace_id: wid, repo_id: repo.meta.id } }).catch(() => []),
      })));
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => ({ submodules: values.reduce((next, value) => ({ ...next, [value.repoId]: value.submodules }), state.submodules) }));
    },
    submoduleOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'submoduleOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, { timeoutMs: 600_000 });
      await Promise.all([get().loadSubmodules(repoId), get().refresh()]);
    }, `submodule:${repoId}`),
    loadUnpushedCommits: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        const values = await b.request<UnpushedCommit[]>({ type: 'unpushedCommits', payload: { workspace_id: wid, repo_id: repoId } }).catch(() => []);
        if (get().snapshot?.workspace.id !== wid) return;
        set((state) => ({ unpushedCommits: { ...state.unpushedCommits, [repoId]: values } }));
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const values = await Promise.all(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        commits: await b.request<UnpushedCommit[]>({ type: 'unpushedCommits', payload: { workspace_id: wid, repo_id: repo.meta.id } }).catch(() => []),
      })));
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => ({ unpushedCommits: values.reduce((next, value) => ({ ...next, [value.repoId]: value.commits }), state.unpushedCommits) }));
    },
    unpushedOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'unpushedOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, { timeoutMs: 600_000 });
      await Promise.all([get().loadUnpushedCommits(repoId), get().refresh()]);
    }, `history:${repoId}`),
    historyOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'historyOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, { timeoutMs: 600_000 });
      await get().refresh();
    }, `history:${repoId}`),
    createPatch: async (repoId, revisions) => bridge().request<PatchDocument>({ type: 'createPatch', payload: { workspace_id: workspaceId(), repo_id: repoId, revisions } }),
    svnOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'svnOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, { timeoutMs: 600_000 });
      await get().selectRepo(repoId, true);
    }, `svn:${repoId}`),
    openBranchComparison: (repoId, target) => {
      const current = get().comparisonTarget;
      if (current?.repoId === repoId && current.target === target) {
        set({ mode: 'history' });
        return;
      }
      comparisonRequestGeneration += 1;
      requestControllers.get('branch-comparison')?.abort();
      set({
        comparisonTarget: { repoId, target }, comparison: undefined, diff: undefined, selectedFile: undefined,
        selectedCommit: undefined, selectedCommits: [], selectedPrimaryKey: undefined, selectedCommitLoading: {},
        mode: 'history',
      });
    },
    closeBranchComparison: () => {
      comparisonRequestGeneration += 1;
      requestControllers.get('branch-comparison')?.abort();
      set({ comparisonTarget: undefined, comparison: undefined, diff: undefined, mode: 'history' });
    },
    compareBranches: async (repoId, base, target) => withBusy(async () => {
      const generation = ++comparisonRequestGeneration;
      const requestWorkspace = workspaceId();
      const controller = beginRequest('branch-comparison');
      const comparison = await bridge().request<BranchCompareResult>({ type: 'branchCompare', payload: { workspace_id: requestWorkspace, repo_id: repoId, base, target } }, { signal: controller.signal });
      if (generation === comparisonRequestGeneration && get().snapshot?.workspace.id === requestWorkspace) set({ comparison });
    }, `history:${repoId}`),
    clearComparison: () => {
      comparisonRequestGeneration += 1;
      requestControllers.get('branch-comparison')?.abort();
      set({ comparison: undefined });
    },
    loadRemotes: async (repoId) => {
      const id = repoId ?? get().selectedRepoId; if (!id) return;
      const values = await bridge().request<RemoteInfo[]>({ type: 'remotes', payload: { workspace_id: workspaceId(), repo_id: id } });
      set((state) => ({ remotes: { ...state.remotes, [id]: values } }));
    },
    remoteOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'remoteOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, operation.type === 'prune' ? { timeoutMs: 600_000 } : undefined);
      await Promise.all([get().loadRemotes(repoId), get().selectRepo(repoId, true)]);
    }, `remote:${repoId}`),
    systemOpen: async (repoId, relativePath, reveal, external = false) => withBusy(async () => {
      await bridge().request({ type: 'systemOpen', payload: { workspace_id: workspaceId(), repo_id: repoId, relative_path: relativePath, reveal, external } });
    }, `system:${repoId}`),

    loadConflicts: async () => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      const conflicts = await b.request<ConflictFile[]>({ type: 'conflicts', payload: { workspace_id: wid } }).catch(() => []);
      if (get().snapshot?.workspace.id !== wid) return;
      set({ conflicts });
    },

    openMerge: async (conflict) => withBusy(async () => {
      if (conflict.conflictType && !['text', 'binary'].includes(conflict.conflictType)) {
        set({ error: `${conflict.path}: ${conflict.conflictType} conflict requires an explicit working-copy resolution` });
        return;
      }
      const merge = await bridge().request<MergeVersions>({ type: 'conflictVersions', payload: { workspace_id: workspaceId(), repo_id: conflict.repoId, relative_path: conflict.path } });
      set({ merge, mergeResult: merge.working, selectedFile: { repoId: conflict.repoId, path: conflict.path, staged: false }, mode: 'merge' });
    }, `conflict:${conflict.repoId}`),
    resolveConflict: async (conflict, choice) => withBusy(async () => {
      await bridge().request({ type: 'conflictAccept', payload: { workspace_id: workspaceId(), repo_id: conflict.repoId, relative_path: conflict.path, choice } });
      await get().refresh();
    }, `conflict:${conflict.repoId}`),

    setMergeResult: (mergeResult) => set({ mergeResult }),
    saveMerge: async () => withBusy(async () => {
      const merge = get().merge; const file = get().selectedFile;
      if (!merge || !file) return;
      await bridge().request({ type: 'conflictSave', payload: { workspace_id: workspaceId(), repo_id: file.repoId, relative_path: file.path, content: get().mergeResult, expected_fingerprint: merge.fingerprint } });
      await get().refresh();
    }),
    acceptConflict: async (choice) => withBusy(async () => {
      const file = get().selectedFile; if (!file) return;
      await bridge().request({ type: 'conflictAccept', payload: { workspace_id: workspaceId(), repo_id: file.repoId, relative_path: file.path, choice } });
      await get().refresh();
    }),
    abortRepositoryOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'abortRepositoryOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await get().refresh();
    }, `conflict:${repoId}`),

    backToHistory: () => set({ mode: 'history', diff: undefined, changes: undefined, changesDiff: undefined, merge: undefined }),
    openFileHistory: (repoId, path) => set({ fileHistoryTarget: { repoId, path } }),
    closeFileHistory: () => set({ fileHistoryTarget: undefined }),

    setTheme: async (theme) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      await updateSettings({ theme });
    },
    setLanguage: async (language) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      await updateSettings({ language });
    },
    setUiFontSize: (uiFontSize) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      void updateSettings({ uiFontSize });
    },
    setExternalEditor: (executable, args) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      void updateSettings({ externalEditor: executable.trim() ? { executable: executable.trim(), args } : null });
    },
    setFileViewMode: (fileViewMode) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      updateLayout({ ...layout(), fileViewMode });
    },
    setStashViewMode: (stashViewMode) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      updateLayout({ ...layout(), stashViewMode });
    },
    setActiveTab: (activeTab) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      updateLayout({ ...layout(), activeTab });
    },
    setPanelSize: (key, value) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      updateLayout({ ...layout(), panelSizes: { ...layout().panelSizes, [key]: Math.round(value) } });
    },
    setBranchSidebarState: (collapsed, collapsedSections) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      updateLayout({ ...layout(), branchSidebarCollapsed: collapsed, branchSidebarCollapsedSections: [...new Set(collapsedSections)] });
    },
    updateSettings,
    clearError: () => set({ error: undefined, errorDetails: undefined }),
    clearNotice: () => set({ notice: undefined }),
    addNotification: (notification) => {
      const id = crypto.randomUUID();
      const item: AppNotification = {
        id,
        timestamp: Date.now(),
        read: false,
        ...notification,
      };
      set((state) => ({
        notifications: [item, ...state.notifications].slice(0, 100),
      }));
    },
    markNotificationAsRead: (id) => {
      set((state) => ({
        notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
      }));
    },
    markAllNotificationsAsRead: () => {
      set((state) => ({
        notifications: state.notifications.map((n) => ({ ...n, read: true })),
      }));
    },
    removeNotification: (id) => {
      set((state) => ({
        notifications: state.notifications.filter((n) => n.id !== id),
      }));
    },
    clearNotifications: () => set({ notifications: [] }),
    openIdentityPanel: (repoId) => {
      const targetRepoId = repoId ?? get().selectedRepoId ?? get().snapshot?.repositories[0]?.meta.id ?? null;
      set({ identityPanelRepoId: targetRepoId });
    },
    closeIdentityPanel: () => set({ identityPanelRepoId: null }),
    openRemoteManager: (repoId) => {
      const targetRepoId = repoId ?? get().selectedRepoId ?? get().snapshot?.repositories[0]?.meta.id ?? null;
      set({ remoteManagerRepoId: targetRepoId });
    },
    closeRemoteManager: () => set({ remoteManagerRepoId: null }),
  };
});

export const selectedRepository = (state: AppStore): RepositoryStatus | undefined =>
  state.snapshot?.repositories.find((repo) => repo.meta.id === state.selectedRepoId);
