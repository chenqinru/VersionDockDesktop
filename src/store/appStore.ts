import { create } from 'zustand';
import type {
  AppStateSnapshot, BootstrapData, BranchInfo, CommitDetail, CommitFile, CommitNode, ConflictFile, DiffDocument, GraphCommitNode,
  BranchCompareResult, HistoryPage, MergeVersions, RemoteInfo, RemoteOperation, RepositoryStatus, TagInfo, ThemePreference, LanguagePreference, UiFontSizePreference,
  WorkspaceSnapshot, StashEntry, StashOperation, ShelfEntry, ShelfOperation, ChangelistEntry, ChangelistOperation, WorktreeDiffResult, WorktreeEntry, WorktreeOperation, SubtreeEntry, SubtreeOperation, SubmoduleEntry, SubmoduleOperation,
  UnpushedCommit, UnpushedOperation, HistoryOperation, PatchDocument, SvnOperation, MergeCommitSummary, DesktopSettings, LayoutState, SettingsUpdateResult, RepositoryOperationResult,
  DesktopCapabilities, HistoryQuery, InitializeRepositoryResult, CloneRepositoryResult, OperationDomain, OperationEvent,
  RecentCommitMessage, RefreshScope, RepositoryCapabilities, RepositoryUpdateResult, RuntimeCapabilities,
  SyncResult, WindowTabTransfer, BranchOperationResult, BranchRecoveryOperation,
  BranchRecoveryResult, RepositoryCommitSelection, RestoreConflictsResult,
} from '../bindings/generated';
import { BridgeError, isAbortError, type VersionDockBridge } from '../platform/bridge';
import { buildCommitFileTargets, commitKey, type DetailFileTarget } from '../history/commitDetails';
import { checkAppUpdate, type AppUpdateCheckResult } from '../services/updater';
import { choiceDialog, confirmDialog } from '../components/dialogService';
import { createTranslator, resolveLanguage } from '../i18n';

export type WorkspaceMode = 'history' | 'commit-detail' | 'diff' | 'changes' | 'merge';
export type CommitSelectionMode = 'single' | 'toggle' | 'range';
export type DiffRange = { fromRevision: string; toRevision: string };
export type WorkingChangeTarget = { repoId: string; path: string; status: string; staged: boolean; section: 'staged' | 'unstaged' | 'untracked' };
export type CommitChangesModel =
  | { kind: 'commits'; commits: CommitNode[]; files: DetailFileTarget[] }
  | { kind: 'workingTree'; repoId: string; files: WorkingChangeTarget[] };
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
  actionKey?: 'pullAll' | 'pushAll' | 'openConflicts' | 'openIdentity' | 'refresh' | 'viewUpdateDetails';
  actionData?: any;
}

export interface BatchCommitReport {
  message: string;
  push: boolean;
  targets: Array<{ repoId: string; paths: string[]; unstagePaths: string[]; amend: boolean }>;
  results: RepositoryOperationResult[];
}
export interface UpdateProjectReport { results: Array<{ repoId: string; repoName: string; result?: RepositoryUpdateResult; error?: string }> }

const HISTORY_PAGE_SIZE = 100;
const EMPTY_HISTORY_QUERY: HistoryQuery = { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null };

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
  historyQuery: HistoryQuery;
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
  commitMessage: string;
  mergeMessageSuggestion?: string;
  amendRepoIds: string[];
  commitSelections: Record<string, string[]>;
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
  operations: Record<string, OperationEvent>;
  error?: string;
  errorDetails?: string;
  notice?: string;
  notifications: AppNotification[];
  aboutOpen: boolean;
  aboutInitialTab: 'about' | 'changelog';
  openAbout: (tab?: 'about' | 'changelog') => void;
  closeAbout: () => void;
  updateAvailableInfo: AppUpdateCheckResult | null;
  setUpdateAvailableInfo: (info: AppUpdateCheckResult | null) => void;
  checkUpdateSilently: () => Promise<void>;
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
  historyQuery: HistoryQuery;
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
  commitMessage: string;
  mergeMessageSuggestion?: string;
  amendRepoIds: string[];
  commitSelections: Record<string, string[]>;
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
  batchCommitReport?: BatchCommitReport;
  updateProjectReport?: UpdateProjectReport;
  initialize: (bridge: VersionDockBridge) => Promise<void>;
  dispose: () => void;
  openWorkspace: (paths: string[], focus?: boolean, options?: OpenWorkspaceOptions) => Promise<boolean>;
  initializeRepository: (targetPath: string) => Promise<void>;
  cloneRepository: (url: string, parentPath: string, targetName: string, openInNewWindow?: boolean, providerAccountId?: string) => Promise<boolean>;
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
  openWorkingChanges: (repoId: string) => void;
  loadChangesDiff: (target: DetailFileTarget | WorkingChangeTarget) => Promise<void>;
  setCommitMessage: (value: string) => void;
  applyMergeMessageSuggestion: () => void;
  dismissMergeMessageSuggestion: () => void;
  setAmendRepoIds: (values: string[]) => void;
  setCommitSelection: (repoId: string, paths: string[], selected: boolean) => void;
  stage: (repoId: string, paths: string[]) => Promise<void>;
  unstage: (repoId: string, paths: string[]) => Promise<void>;
  discard: (repoId: string, paths: string[]) => Promise<void>;
  deletePaths: (repoId: string, paths: string[]) => Promise<void>;
  addIgnore: (repoId: string, path: string) => Promise<void>;
  commit: (repoId: string, message: string, amend: boolean, paths: string[], push: boolean) => Promise<void>;
  commitMany: (targets: Array<{ repoId: string; paths: string[]; unstagePaths: string[]; amend: boolean }>, message: string, push: boolean) => Promise<void>;
  retryBatchResult: (repoId: string) => Promise<void>;
  dismissBatchReport: () => void;
  sync: (repoId: string, action: 'fetch' | 'pull' | 'push' | 'update', notify?: boolean) => Promise<RepositoryUpdateResult | undefined>;
  updateProject: () => Promise<void>;
  dismissUpdateProjectReport: () => void;
  openUpdateDetails: (result: RepositoryUpdateResult) => Promise<void>;
  openUpdateResults: (results: RepositoryUpdateResult[]) => Promise<void>;
  recentCommitMessages: (repoIds: string[], signal?: AbortSignal) => Promise<RecentCommitMessage[]>;
  lastCommitMessage: (repoId: string, signal?: AbortSignal) => Promise<string | null>;
  loadHistory: (reset?: boolean, silent?: boolean) => Promise<void>;
  setHistoryFilter: (value: string) => void;
  setHistoryQuery: (query: HistoryQuery) => void;
  openHistoryForPath: (repoId: string, path: string) => Promise<void>;
  clearHistoryPath: () => Promise<void>;
  setHistoryScope: (scope: HistoryScope) => void;
  selectCommit: (commit: CommitNode, mode?: CommitSelectionMode, rangeSource?: CommitNode[]) => Promise<void>;
  loadCommitDetail: (commit: CommitNode) => Promise<CommitDetail>;
  loadMergeCommits: (commit: CommitNode) => Promise<void>;
  loadMergeParentFiles: (repoId: string, revision: string, parentHash: string) => Promise<CommitFile[]>;
  clearCommitSelection: () => void;
  branchOperation: (operation: object, repoId?: string) => Promise<BranchOperationResult | undefined>;
  branchRecovery: (repoId: string, operation: BranchRecoveryOperation) => Promise<BranchRecoveryResult | undefined>;
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
  unpushedOperation: (repoId: string, operation: UnpushedOperation) => Promise<boolean>;
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
  loadConflicts: (silent?: boolean, repoId?: string) => Promise<void>;
  refreshRuntimeCapabilities: () => Promise<void>;
  openMerge: (conflict: ConflictFile) => Promise<void>;
  resolveConflict: (conflict: ConflictFile, choice: 'mine' | 'theirs' | 'working') => Promise<void>;
  setMergeResult: (value: string) => void;
  saveMerge: () => Promise<void>;
  acceptConflict: (choice: 'mine' | 'theirs' | 'working') => Promise<void>;
  abortRepositoryOperation: (repoId: string, operation: string) => Promise<void>;
  restoreConflicts: (repoIds: string[]) => Promise<RestoreConflictsResult[]>;
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
  schemaVersion: 6,
  settings: {
    theme: 'system', language: 'system', uiFontSize: 'standard', changesDisplayMode: 'simplified', defaultCommitAction: 'commit', defaultSaveAction: 'stash',
    promptBeforeAddingUntracked: true, suppressDivergedWarning: false, autoRefreshInterval: 0, fetchOnStartup: false, resetViewLocationsOnStartup: false,
    notifyIncomingCommits: false, notifyUnpushedCommits: false, repositoryScanDepth: 4,
    ignoredFolders: ['.git', '.svn', '.hg', 'node_modules', 'vendor', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', 'target'],
    maximumGraphCommits: 1000, projectColors: {}, externalEditor: null, onlineAvatarsEnabled: false, gravatarEnabled: false,
  },
  layout: { panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', stashViewMode: 'tree', branchSidebarCollapsed: false, branchSidebarCollapsedSections: [] },
  lastWorkspaceId: null, openWorkspaceIds: [], activeWorkspaceId: null, recentWorkspaces: [], commitSelections: {},
};

let watcherTimer: ReturnType<typeof setTimeout> | undefined;
let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
let workspaceRequestGeneration = 0;
let watcherRefreshInFlight = false;
let watcherRefreshQueued = false;
const watcherScopes = new Map<string, Set<RefreshScope>>();
const repositoryEventGenerations = new Map<string, number>();
let commitSelectionGeneration = 0;
let changesDiffGeneration = 0;
let diffRequestGeneration = 0;
let historyRequestGeneration = 0;
let historyPathPreviousScope: HistoryScope | undefined;
let historyPathPreviousQuery: HistoryQuery | undefined;
let comparisonRequestGeneration = 0;
let branchWorkingDiffGeneration = 0;
let commitSelectionSaveTimer: ReturnType<typeof setTimeout> | undefined;
let branchRecoveryDialogQueue: Promise<void> = Promise.resolve();
const requestControllers = new Map<string, AbortController>();
const notificationBaseline = new Map<string, { incoming: number; unpushed: number }>();
const bridgeSubscriptions: Array<() => void> = [];
let localOperationSequence = 0;
let currentWindowLabel = `window-${Math.random().toString(36).slice(2)}`;
const ownedSchedulerLeases = new Set<string>();

function claimSchedulerLease(name: string, ttlMs: number): boolean {
  if (typeof localStorage === 'undefined') return true;
  const key = `versiondock:scheduler:${name}`;
  const now = Date.now();
  try {
    const current = JSON.parse(localStorage.getItem(key) ?? 'null') as { owner?: string; expiresAt?: number } | null;
    if (current?.owner && current.owner !== currentWindowLabel && (current.expiresAt ?? 0) > now) return false;
    localStorage.setItem(key, JSON.stringify({ owner: currentWindowLabel, expiresAt: now + ttlMs }));
    ownedSchedulerLeases.add(key);
    return true;
  } catch {
    return true;
  }
}

function releaseSchedulerLeases() {
  if (typeof localStorage === 'undefined') return;
  for (const key of ownedSchedulerLeases) {
    try {
      const current = JSON.parse(localStorage.getItem(key) ?? 'null') as { owner?: string } | null;
      if (current?.owner === currentWindowLabel) localStorage.removeItem(key);
    } catch { /* ignore damaged cross-window lease state */ }
  }
  ownedSchedulerLeases.clear();
}

const ACTIVE_OPERATION_STATUSES = new Set(['queued', 'running']);

export function isOperationActive(
  operations: Record<string, OperationEvent>,
  criteria: {
    workspaceId?: string | null;
    repositoryId?: string | null;
    domain?: OperationDomain | OperationDomain[];
  },
): boolean {
  const domains = criteria.domain
    ? new Set(Array.isArray(criteria.domain) ? criteria.domain : [criteria.domain])
    : undefined;
  return Object.values(operations).some((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status)
    && (criteria.workspaceId === undefined || operation.context.workspaceId === criteria.workspaceId)
    && (criteria.repositoryId === undefined || operation.context.repositoryId === criteria.repositoryId)
    && (!domains || domains.has(operation.context.domain)));
}

const REPOSITORY_TARGET_PREFIX = 'repositories:';

function operationRepositoryIds(operation: OperationEvent): string[] {
  if (operation.context.repositoryId) return [operation.context.repositoryId];
  const target = operation.context.target;
  if (!target?.startsWith(REPOSITORY_TARGET_PREFIX)) return [];
  try {
    const values = JSON.parse(target.slice(REPOSITORY_TARGET_PREFIX.length));
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function isOperationActiveForRepositories(
  operations: Record<string, OperationEvent>,
  repositoryIds: Iterable<string>,
  criteria: { workspaceId?: string | null; domain?: OperationDomain | OperationDomain[] },
): boolean {
  const targets = new Set(repositoryIds);
  if (!targets.size) return false;
  const domains = criteria.domain
    ? new Set(Array.isArray(criteria.domain) ? criteria.domain : [criteria.domain])
    : undefined;
  return Object.values(operations).some((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status)
    && (criteria.workspaceId === undefined || operation.context.workspaceId === criteria.workspaceId)
    && (!domains || domains.has(operation.context.domain))
    && operationRepositoryIds(operation).some((repositoryId) => targets.has(repositoryId)));
}

export function capabilityAvailable(
  capabilities: DesktopCapabilities | RepositoryCapabilities | undefined,
  key: string,
  fallback = false,
): boolean {
  return capabilities?.availability?.[key]?.available
    ?? (capabilities && key in capabilities ? Boolean((capabilities as unknown as Record<string, unknown>)[key]) : fallback);
}

export function capabilityReason(
  capabilities: DesktopCapabilities | RepositoryCapabilities | undefined,
  key: string,
): string | undefined {
  const status = capabilities?.availability?.[key];
  return status && !status.available ? status.detail ?? status.reasonCode ?? undefined : undefined;
}

function operationContext(domainKey: string, state: AppStore): OperationEvent['context'] {
  const [rawDomain, repositoryId] = domainKey.split(':', 2);
  const domainMap: Record<string, OperationDomain> = {
    repository: 'status', workspace: 'workspace', diff: 'diff', history: 'history', branch: 'branch',
    tag: 'tag', commit: 'commit', sync: 'sync', conflict: 'conflict', stash: 'stash', shelf: 'shelf',
    changelist: 'changelist', worktree: 'worktree', subtree: 'subtree', submodule: 'submodule', remote: 'remote',
    identity: 'identity', svn: 'svnAccount', system: 'system', fileHistory: 'fileHistory',
  };
  return {
    generation: ++localOperationSequence,
    domain: domainMap[rawDomain] ?? 'application',
    visibility: 'foreground',
    workspaceId: state.snapshot?.workspace.id ?? null,
    repositoryId: repositoryId ?? null,
    target: null,
  };
}

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

function selectionRecord(values: RepositoryCommitSelection[] | undefined): Record<string, string[]> {
  return Object.fromEntries((values ?? []).map((item) => [item.repoId, item.paths]));
}

function pruneCommitSelections(repositories: RepositoryStatus[], selections: Record<string, string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const repo of repositories) {
    const available = new Set(repo.files.map((file) => file.path));
    const paths = [...new Set(selections[repo.meta.id] ?? [])].filter((path) => available.has(path));
    if (paths.length) result[repo.meta.id] = paths;
  }
  return result;
}

function queueBranchRecoveryDialog(task: () => Promise<void>): Promise<void> {
  const next = branchRecoveryDialogQueue.then(task, task);
  branchRecoveryDialogQueue = next.catch(() => undefined);
  return next;
}

export const useAppStore = create<AppStore>((set, get) => {
  const ensureRepositoryCapability = (repoId: string, key: string) => {
    const repository = get().snapshot?.repositories.find((item) => item.meta.id === repoId);
    if (!repository || capabilityAvailable(repository.capabilities, key, true)) return true;
    set({ notice: capabilityReason(repository.capabilities, key) ?? 'Operation is unavailable for this repository' });
    return false;
  };
  const withBusy = async <T>(
    operation: () => Promise<T>,
    domain = 'workspace',
    target?: { repositoryId?: string | null; target?: string | null },
  ): Promise<T | undefined> => {
    const operationId = `client-${Date.now()}-${++localOperationSequence}`;
    const context = { ...operationContext(domain, get()), ...target, visibility: 'background' as const };
    set((state) => ({
      error: undefined,
      operations: {
        ...state.operations,
        [operationId]: {
          operationId,
          context,
          status: 'running',
          phase: context.domain,
          message: '',
          startedAt: new Date().toISOString(),
          cancellable: false,
          completed: null,
          total: null,
          error: null,
        },
      },
    }));
    try {
      return await operation();
    } catch (error) {
      if (!isAbortError(error)) {
        const msg = errorText(error);
        set({ error: msg, errorDetails: errorDetails(error) });
        get().addNotification({ type: 'error', title: 'Operation failed', message: msg });
      }
      return undefined;
    } finally {
      set((state) => {
        const operations = { ...state.operations };
        delete operations[operationId];
        return { operations };
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

  const persistCommitSelections = (workspaceId: string, selections: Record<string, string[]>) => {
    if (commitSelectionSaveTimer) clearTimeout(commitSelectionSaveTimer);
    commitSelectionSaveTimer = setTimeout(() => {
      const values = Object.entries(selections).map(([repoId, paths]) => ({ repoId, paths }));
      get().bridge?.send({ type: 'saveCommitSelections', payload: { workspace_id: workspaceId, selections: values } });
    }, 120);
    const current = get().bootstrap;
    if (current) set({ bootstrap: { ...current, state: { ...current.state, commitSelections: { ...(current.state.commitSelections ?? {}), [workspaceId]: Object.entries(selections).map(([repoId, paths]) => ({ repoId, paths })) } } } });
  };
  const clearCommittedSelections = (repoIds: string[]) => {
    const commitSelections = { ...get().commitSelections };
    repoIds.forEach((repoId) => delete commitSelections[repoId]);
    set({ commitSelections });
    const wid = get().snapshot?.workspace.id;
    if (wid) persistCommitSelections(wid, commitSelections);
  };

  const restartAutoRefresh = () => {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = undefined;
    const seconds = settings().autoRefreshInterval;
    if (seconds > 0) autoRefreshTimer = setInterval(() => {
      const state = get();
      if (state.snapshot && claimSchedulerLease('auto-refresh', Math.max(2_000, seconds * 1_500)) && !isOperationActive(state.operations, { workspaceId: state.snapshot.workspace.id, domain: 'workspace' })) void state.refresh(true);
    }, seconds * 1000);
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
      historyQuery: state.historyQuery,
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
      commitMessage: state.commitMessage,
      mergeMessageSuggestion: state.mergeMessageSuggestion,
      amendRepoIds: state.amendRepoIds,
      commitSelections: state.commitSelections,
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

  const applySnapshot = async (snapshot: WorkspaceSnapshot, reloadRepository = true, silent = false) => {
    const current = get().snapshot;
    if (current?.workspace.id === snapshot.workspace.id && current.generation > snapshot.generation) return;
    const workspaceChanged = current?.workspace.id !== snapshot.workspace.id;
    if (workspaceChanged) notificationBaseline.clear();
    const allRepositories = snapshot.repositories;
    const visibleSnapshot = projectSnapshot(snapshot, allRepositories, settings());
    const storedSelections = workspaceChanged
      ? selectionRecord(get().bootstrap?.state.commitSelections?.[snapshot.workspace.id])
      : get().commitSelections;
    const commitSelections = pruneCommitSelections(allRepositories, storedSelections);
    const selectedRepoId = visibleSnapshot.repositories.some((repo) => repo.meta.id === get().selectedRepoId)
      ? get().selectedRepoId : visibleSnapshot.repositories[0]?.meta.id;
    set(workspaceChanged
      ? { snapshot: visibleSnapshot, allRepositories, selectedRepoId, selectedFile: undefined, fileHistoryTarget: undefined, historyFilter: '', historyQuery: { ...EMPTY_HISTORY_QUERY }, diff: undefined, changesDiff: undefined, changes: undefined, merge: undefined, mergeResult: '', commitMessage: '', mergeMessageSuggestion: undefined, amendRepoIds: [], commitSelections, comparisonTarget: undefined, comparison: undefined, mode: 'history', history: [], historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, subtrees: {}, submodules: {}, worktrees: {}, stashes: {}, shelves: {}, changelists: {}, remotes: {}, unpushedCommits: {}, selectedCommits: [], selectedPrimaryKey: undefined, selectedCommit: undefined, selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {} }
      : { snapshot: visibleSnapshot, allRepositories, selectedRepoId, commitSelections });
    if (JSON.stringify(commitSelections) !== JSON.stringify(storedSelections)) persistCommitSelections(snapshot.workspace.id, commitSelections);
    const notificationLeader = claimSchedulerLease('notifications', 5_000);
    for (const repo of visibleSnapshot.repositories) {
      const counts = { incoming: repo.behind, unpushed: repo.ahead };
      const previous = notificationBaseline.get(repo.meta.id);
      notificationBaseline.set(repo.meta.id, counts);
      if (!previous || !notificationLeader) continue;
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
      void get().refreshRuntimeCapabilities();
    }
    if (selectedRepoId && (workspaceChanged || reloadRepository)) await get().selectRepo(selectedRepoId, true);
    const requests: Promise<void>[] = [get().loadConflicts(silent)];
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

  const refreshHistoryRepository = async (workspaceId: string, repoId: string) => {
    const current = get();
    const requestGeneration = historyRequestGeneration;
    if (current.historyScope.repoIds && !current.historyScope.repoIds.includes(repoId)) return;
    const repo = current.snapshot?.repositories.find((item) => item.meta.id === repoId);
    if (!repo) return;
    const visibleLimit = Math.min(
      Math.max(current.history.length, HISTORY_PAGE_SIZE),
      settings().maximumGraphCommits,
    );
    const [page, topology] = await Promise.all([
      bridge().request<HistoryPage>({
        type: 'history',
        payload: {
          workspace_id: workspaceId,
          repo_id: repoId,
          skip: 0,
          limit: visibleLimit,
          query: { ...current.historyQuery, text: current.historyFilter || current.historyQuery.text, revision: current.historyScope.revisionsByRepo[repoId] ?? null },
        },
      }, { showProgress: false }),
      bridge().request<GraphCommitNode[]>({
        type: 'historyTopology',
        payload: { workspace_id: workspaceId, repo_id: repoId, svn_limit: 1000, revision: current.historyScope.revisionsByRepo[repoId] ?? null },
      }, { showProgress: false }).catch(() => []),
    ]);
    if (get().snapshot?.workspace.id !== workspaceId || historyRequestGeneration !== requestGeneration) return;
    set((state) => {
      const historyByRepo = { ...state.historyByRepo, [repoId]: page.commits };
      const historyHasMoreByRepo = { ...state.historyHasMoreByRepo, [repoId]: page.hasMore };
      const historyTopologyByRepo = { ...state.historyTopologyByRepo, [repoId]: topology };
      const merged = interleaveHistory(historyByRepo);
      return {
        historyByRepo,
        historyHasMoreByRepo,
        history: merged.slice(0, visibleLimit),
        historyHasMore: merged.length > visibleLimit || Object.values(historyHasMoreByRepo).some(Boolean),
        historyTopologyByRepo,
        historyTopology: interleaveLogs(historyTopologyByRepo),
      };
    });
  };

  const refreshFromWatcher = async () => {
    if (!get().snapshot?.workspace.id) return;
    if (watcherRefreshInFlight) {
      watcherRefreshQueued = true;
      return;
    }
    watcherRefreshInFlight = true;
    const pending = new Map(watcherScopes);
    watcherScopes.clear();
    try {
      const workspaceId = get().snapshot?.workspace.id;
      if (!workspaceId) return;
      if ([...pending.values()].some((scopes) => scopes.has('workspaceSnapshot'))) {
        await get().refresh(true);
        for (const [repoId, scopes] of pending) {
          if (!repoId) continue;
          if (scopes.has('worktrees')) await get().loadWorktrees(repoId);
          if (scopes.has('subtrees')) await get().loadSubtrees(repoId);
          if (scopes.has('submodules')) await get().loadSubmodules(repoId);
        }
        return;
      }
      for (const [repoId, scopes] of pending) {
        if (!repoId) continue;
        if (scopes.has('status') || scopes.has('index') || scopes.has('operation') || scopes.has('svnRevision')) {
          const status = await bridge().request<RepositoryStatus>(
            { type: 'repositoryStatus', payload: { workspace_id: workspaceId, repo_id: repoId } },
            { showProgress: false },
          );
          if (get().snapshot?.workspace.id !== workspaceId) return;
          set((state) => {
            const allRepositories = state.allRepositories.map((repo) => repo.meta.id === repoId ? status : repo);
            return {
              allRepositories,
              snapshot: state.snapshot ? projectSnapshot({ ...state.snapshot, repositories: allRepositories }, allRepositories, settings()) : undefined,
            };
          });
        }
        if (scopes.has('refs') || scopes.has('history')) {
          const [branches, tags] = await Promise.all([
            bridge().request<BranchInfo[]>({ type: 'branches', payload: { workspace_id: workspaceId, repo_id: repoId } }, { showProgress: false }),
            bridge().request<TagInfo[]>({ type: 'tags', payload: { workspace_id: workspaceId, repo_id: repoId } }, { showProgress: false }),
          ]);
          if (get().snapshot?.workspace.id !== workspaceId) return;
          set((state) => ({
            branchesByRepo: { ...state.branchesByRepo, [repoId]: branches },
            tagsByRepo: { ...state.tagsByRepo, [repoId]: tags },
            branches: state.selectedRepoId === repoId ? branches : state.branches,
            tags: state.selectedRepoId === repoId ? tags : state.tags,
          }));
          if (!get().historyLoading) await refreshHistoryRepository(workspaceId, repoId);
        }
        if (scopes.has('unpushed') || scopes.has('refs')) {
          const repo = get().snapshot?.repositories.find((item) => item.meta.id === repoId);
          if (repo?.meta.kind === 'git') await get().loadUnpushedCommits(repoId);
        }
        if (scopes.has('conflicts')) await get().loadConflicts(true, repoId);
        if (scopes.has('worktrees')) await get().loadWorktrees(repoId);
        if (scopes.has('subtrees')) await get().loadSubtrees(repoId);
        if (scopes.has('submodules')) await get().loadSubmodules(repoId);
        const selected = get().selectedFile;
        if (scopes.has('diff') && selected?.repoId === repoId && get().mode === 'diff') {
          const generation = ++diffRequestGeneration;
          const controller = beginRequest(`watcher-diff:${repoId}`);
          const diff = await bridge().request<DiffDocument>({
            type: 'fileDiff',
            payload: {
              workspace_id: workspaceId,
              repo_id: selected.repoId,
              relative_path: selected.path,
              staged: selected.staged,
              revision: selected.revision ?? null,
              from_revision: selected.fromRevision ?? null,
              to_revision: selected.toRevision ?? null,
            },
          }, { signal: controller.signal, showProgress: false });
          const current = get();
          const currentFile = current.selectedFile;
          if (generation === diffRequestGeneration
            && current.snapshot?.workspace.id === workspaceId
            && current.mode === 'diff'
            && currentFile?.repoId === selected.repoId
            && currentFile.path === selected.path
            && currentFile.staged === selected.staged
            && currentFile.revision === selected.revision
            && currentFile.fromRevision === selected.fromRevision
            && currentFile.toRevision === selected.toRevision) {
            set({ diff });
          }
        }
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
    ready: false, notifications: [], identityPanelRepoId: null, remoteManagerRepoId: null, aboutOpen: false, aboutInitialTab: 'about', updateAvailableInfo: null, tabs: [], activeTabId: null, sessions: {}, allRepositories: [], mode: 'history', history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyFilter: '', historyQuery: { ...EMPTY_HISTORY_QUERY }, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', commitMessage: '', mergeMessageSuggestion: undefined, amendRepoIds: [], commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, remotes: {}, batchCommitReport: undefined, updateProjectReport: undefined,

    operations: {},

    openAbout: (tab = 'about') => set({ aboutOpen: true, aboutInitialTab: tab }),
    closeAbout: () => set({ aboutOpen: false }),
    setUpdateAvailableInfo: (info) => set({ updateAvailableInfo: info }),
    checkUpdateSilently: async () => {
      try {
        const settings = get().bootstrap?.state.settings;
        if (settings?.autoCheckUpdates === false) return;
        const result = await checkAppUpdate();
        if (result.available && result.latestVersion) {
          if (settings?.skippedUpdateVersion === result.latestVersion) {
            return;
          }
          set({ updateAvailableInfo: result });
        }
      } catch {
        // 静默检查异常捕获
      }
    },

    initialize: async (value) => {
      bridgeSubscriptions.splice(0).forEach((dispose) => dispose());
      set({ bridge: value });
      const refreshRuntimeOnFocus = () => void get().refreshRuntimeCapabilities();
      const refreshRuntimeOnVisibility = () => {
        if (document.visibilityState === 'visible') refreshRuntimeOnFocus();
      };
      window.addEventListener('focus', refreshRuntimeOnFocus);
      document.addEventListener('visibilitychange', refreshRuntimeOnVisibility);
      bridgeSubscriptions.push(() => {
        window.removeEventListener('focus', refreshRuntimeOnFocus);
        document.removeEventListener('visibilitychange', refreshRuntimeOnVisibility);
      });
      currentWindowLabel = await value.getWindowLabel().catch(() => currentWindowLabel);
      bridgeSubscriptions.push(value.subscribe((event) => {
        if ('operationId' in event) {
          if (event.context.visibility === 'background') return;
          set((state) => ({ operations: { ...state.operations, [event.operationId]: event } }));
          if (!ACTIVE_OPERATION_STATUSES.has(event.status)) {
            window.setTimeout(() => set((state) => {
              const operations = { ...state.operations };
              delete operations[event.operationId];
              return { operations };
            }), 750);
          }
          return;
        }
        const currentWorkspaceId = get().snapshot?.workspace.id;
        if (!currentWorkspaceId) return;
        if ('scopes' in event && event.workspaceId === currentWorkspaceId) {
          const generationKey = `${event.workspaceId}:${event.repoId ?? ''}`;
          const previousGeneration = repositoryEventGenerations.get(generationKey) ?? 0;
          if (event.generation < previousGeneration) return;
          repositoryEventGenerations.set(generationKey, event.generation);
          const key = event.repoId ?? '';
          const scopes = watcherScopes.get(key) ?? new Set<RefreshScope>();
          event.scopes.forEach((scope) => scopes.add(scope));
          watcherScopes.set(key, scopes);
          if (watcherTimer) clearTimeout(watcherTimer);
          watcherTimer = setTimeout(() => void refreshFromWatcher(), 300);
        }
      }));
      void value.onFocusTab((focusPaths) => {
        const targetTab = get().tabs.find((tab) =>
          tab.paths.length === focusPaths.length && tab.paths.every((p, i) => p === focusPaths[i])
        );
        if (targetTab) {
          void get().switchTab(targetTab.id);
        }
      }).then((dispose) => bridgeSubscriptions.push(dispose));
      await withBusy(async () => {
        const loaded = await value.request<BootstrapData>({ type: 'bootstrap' });
        const bootstrap = loaded.state.settings?.resetViewLocationsOnStartup
          ? { ...loaded, state: { ...loaded.state, layout: emptyState.layout! } }
          : loaded;
        value.setState(bootstrap.state);
        set({ bootstrap, ready: true });
        const launchWorkspace = bootstrap.launchWorkspaceId
          ? bootstrap.state.recentWorkspaces.find((workspace) => workspace.id === bootstrap.launchWorkspaceId)
          : undefined;
        if (launchWorkspace) await get().openWorkspace(launchWorkspace.paths, true, { skipCrossWindowFocus: true });
        else await get().restoreTabsOnStartup();
        restartAutoRefresh();
        if (bootstrap.state.settings?.fetchOnStartup && get().snapshot && claimSchedulerLease('fetch-on-startup', 60_000)) {
          const gitRepos = get().snapshot?.repositories.filter((repo) => repo.meta.kind === 'git' && repo.toolAvailable !== false) ?? [];
          await Promise.allSettled(gitRepos.map((repo) => get().sync(repo.meta.id, 'fetch')));
        }
      }, 'workspace');
      if (!get().snapshot) {
        set({ error: undefined, errorDetails: undefined });
      }
      set({ ready: true });
      void get().checkUpdateSilently();
    },

    dispose: () => {
      cancelRequests();
      bridgeSubscriptions.splice(0).forEach((dispose) => dispose());
      if (watcherTimer) clearTimeout(watcherTimer);
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      if (commitSelectionSaveTimer) clearTimeout(commitSelectionSaveTimer);
      watcherTimer = undefined;
      autoRefreshTimer = undefined;
      commitSelectionSaveTimer = undefined;
      watcherScopes.clear();
      repositoryEventGenerations.clear();
      releaseSchedulerLeases();
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

    initializeRepository: async (targetPath) => {
      await withBusy(async () => {
        const result = await bridge().request<InitializeRepositoryResult>({ type: 'initializeRepository', payload: { workspace_id: workspaceId(), target_path: targetPath } }, { timeoutMs: 120_000 });
        await applySnapshot(result.snapshot, false);
        await get().selectRepo(result.repositoryId, true);
      }, 'workspace', { target: targetPath });
    },

    cloneRepository: async (url, parentPath, targetName, openInNewWindow = false, providerAccountId) => (await withBusy(async () => {
        const result = await bridge().request<CloneRepositoryResult>({ type: 'cloneRepository', payload: { url, parent_path: parentPath, target_name: targetName, provider_account_id: providerAccountId ?? null } }, { timeoutMs: 600_000 });
        if (openInNewWindow) {
          if (!await bridge().focusWorkspaceAcrossWindows([result.path])) await bridge().openInNewWindow([result.path]);
        } else {
          await get().openWorkspace([result.path]);
        }
        return true;
      }, 'workspace', { target: `${parentPath}/${targetName}` })) ?? false,

    switchTab: async (workspaceId: string) => {
      if (get().activeTabId === workspaceId && get().snapshot) return;
      const targetTab = get().tabs.find((t) => t.id === workspaceId);
      if (!targetTab) return;

      cancelRequests();
      workspaceRequestGeneration += 1;
      historyRequestGeneration += 1;
      changesDiffGeneration += 1;
      diffRequestGeneration += 1;
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
          historyQuery: cachedSession.historyQuery ?? { ...EMPTY_HISTORY_QUERY, text: cachedSession.historyFilter || null },
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
          commitMessage: cachedSession.commitMessage ?? '',
          mergeMessageSuggestion: cachedSession.mergeMessageSuggestion,
          amendRepoIds: cachedSession.amendRepoIds ?? [],
          commitSelections: cachedSession.commitSelections ?? {},
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
            historyQuery: { ...EMPTY_HISTORY_QUERY },
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
        historyQuery: { ...EMPTY_HISTORY_QUERY },
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

      await persistTabs([], null);
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
      const currentWorkspaceId = get().snapshot?.workspace.id;
      if (!currentWorkspaceId) return;
      const operation = async () => {
        const id = workspaceId();
        const controller = beginRequest(`workspace:${id}`);
        const snapshot = await bridge().request<WorkspaceSnapshot>(
          { type: 'workspaceRefresh', payload: { workspace_id: id } },
          { signal: controller.signal, showProgress: !silent },
        );
        if (get().snapshot?.workspace.id !== id) return;
        await applySnapshot(snapshot, !silent, silent);
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
        commitSelectionGeneration += 1;
        changesDiffGeneration += 1;
        diffRequestGeneration += 1;
        historyRequestGeneration += 1;
        for (const key of ['branch-comparison', 'diff', 'history', 'changes-diff', 'branch-working-diff']) {
          requestControllers.get(key)?.abort();
        }
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
          selectedFile: undefined,
          fileHistoryTarget: undefined,
          diff: undefined,
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
      const generation = ++diffRequestGeneration;
      const controller = beginRequest('diff');
      const diff = await bridge().request<DiffDocument>({ type: 'fileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, relative_path: path, staged, revision: revision ?? null, from_revision: range?.fromRevision ?? null, to_revision: range?.toRevision ?? null } }, { signal: controller.signal });
      if (generation === diffRequestGeneration) set({ selectedFile: { repoId, path, staged, revision, fromRevision: range?.fromRevision, toRevision: range?.toRevision }, diff, mode: 'diff' });
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
      set({ changes: { kind: 'commits', commits: state.selectedCommits, files }, changesDiff: undefined, mode: 'changes' });
    },

    openWorkingChanges: (repoId) => {
      const repo = get().snapshot?.repositories.find((item) => item.meta.id === repoId);
      if (!repo) return;
      const files: WorkingChangeTarget[] = repo.files.flatMap((file) => {
        const targets: WorkingChangeTarget[] = [];
        if (file.staged) targets.push({ repoId, path: file.path, status: file.status, staged: true, section: 'staged' });
        if (file.status === 'untracked') targets.push({ repoId, path: file.path, status: file.status, staged: false, section: 'untracked' });
        else if (file.unstaged) targets.push({ repoId, path: file.path, status: file.status, staged: false, section: 'unstaged' });
        return targets;
      });
      set({ changes: { kind: 'workingTree', repoId, files }, changesDiff: undefined, mode: 'changes' });
    },

    loadChangesDiff: async (target) => withBusy(async () => {
      const generation = ++changesDiffGeneration;
      const working = 'section' in target;
      const diff = await bridge().request<DiffDocument>({ type: 'fileDiff', payload: { workspace_id: workspaceId(), repo_id: target.repoId, relative_path: target.path, staged: working ? target.staged : false, revision: working ? null : target.toRevision ? null : target.commitHash, from_revision: working ? null : target.fromRevision ?? null, to_revision: working ? null : target.toRevision ?? null } });
      if (generation === changesDiffGeneration) set({ changesDiff: diff });
    }, `diff:${target.repoId}`),

    setCommitMessage: (commitMessage) => set({ commitMessage }),
    applyMergeMessageSuggestion: () => set((state) => ({ commitMessage: state.mergeMessageSuggestion ?? state.commitMessage, mergeMessageSuggestion: undefined })),
    dismissMergeMessageSuggestion: () => set({ mergeMessageSuggestion: undefined }),
    setAmendRepoIds: (amendRepoIds) => set({ amendRepoIds: [...new Set(amendRepoIds)] }),
    setCommitSelection: (repoId, paths, selected) => {
      const current = get().commitSelections;
      const nextPaths = new Set(current[repoId] ?? []);
      paths.forEach((path) => selected ? nextPaths.add(path) : nextPaths.delete(path));
      const commitSelections = { ...current };
      if (nextPaths.size) commitSelections[repoId] = [...nextPaths]; else delete commitSelections[repoId];
      set({ commitSelections });
      const wid = get().snapshot?.workspace.id;
      if (wid) persistCommitSelections(wid, commitSelections);
    },

    stage: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'stage', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
    }, `repository:${repoId}`),

    unstage: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'unstage', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
    }, `repository:${repoId}`),

    discard: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'discard', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
    }, `repository:${repoId}`),
    deletePaths: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'deletePaths', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
    }, `repository:${repoId}`),
    addIgnore: async (repoId, path) => withBusy(async () => {
      await bridge().request({ type: 'addIgnore', payload: { workspace_id: workspaceId(), repo_id: repoId, relative_path: path } });
    }, `repository:${repoId}`),

    commit: async (repoId, message, amend, paths, push) => withBusy(async () => {
      await bridge().request({ type: 'commit', payload: { workspace_id: workspaceId(), repo_id: repoId, message, amend, paths } });
      clearCommittedSelections([repoId]);
      if (push) await bridge().request({ type: 'sync', payload: { workspace_id: workspaceId(), repo_id: repoId, action: 'push', remote: null } }, { timeoutMs: 600_000 });
    }, `commit:${repoId}`),

    commitMany: async (targets, message, push) => withBusy(async () => {
      const workspace_id = workspaceId();
      const repositoryIds = targets.map((target) => target.repoId);
      const operationTarget = `${REPOSITORY_TARGET_PREFIX}${JSON.stringify(repositoryIds)}`;
      const results = await bridge().request<RepositoryOperationResult[]>({
        type: 'batchCommit',
        payload: {
          workspace_id,
          targets: targets.map((target) => ({
            repoId: target.repoId,
            message,
            amend: target.amend,
            paths: target.paths,
            unstagePaths: target.unstagePaths,
          })),
          push,
        },
      }, {
        timeoutMs: 600_000,
        context: {
          repositoryId: repositoryIds.length === 1 ? repositoryIds[0] : null,
          target: operationTarget,
        },
      });
      set({ batchCommitReport: { message, push, targets, results } });
      clearCommittedSelections(results.filter((result) => result.committed).map((result) => result.repoId));
      const failures = results.filter((result) => result.error);
      if (failures.length) set({ error: failures.map((result) => `${result.repoId}: ${result.error?.message}`).join('\n') });
    }, 'commit', {
      repositoryId: targets.length === 1 ? targets[0].repoId : null,
      target: `${REPOSITORY_TARGET_PREFIX}${JSON.stringify(targets.map((target) => target.repoId))}`,
    }),

    retryBatchResult: async (repoId) => withBusy(async () => {
      const report = get().batchCommitReport;
      const previous = report?.results.find((result) => result.repoId === repoId);
      const target = report?.targets.find((item) => item.repoId === repoId);
      if (!report || !previous || !target) return;
      let next: RepositoryOperationResult;
      if (previous.committed && previous.pushAttempted && !previous.pushed) {
        try {
          await bridge().request({ type: 'sync', payload: { workspace_id: workspaceId(), repo_id: repoId, action: 'push', remote: null } }, { timeoutMs: 600_000 });
          next = { ...previous, pushed: true, failedStage: null, recoveryHint: null, error: null };
        } catch (error) {
          next = { ...previous, error: error instanceof BridgeError ? error : previous.error };
        }
      } else {
        [next] = await bridge().request<RepositoryOperationResult[]>({
          type: 'batchCommit',
          payload: {
            workspace_id: workspaceId(),
            targets: [{ repoId, message: report.message, amend: target.amend, paths: target.paths, unstagePaths: target.unstagePaths }],
            push: report.push,
          },
        }, { timeoutMs: 600_000 });
      }
      set({ batchCommitReport: { ...report, results: report.results.map((item) => item.repoId === repoId ? next : item) } });
    }, `commit:${repoId}`),
    dismissBatchReport: () => set({ batchCommitReport: undefined }),

    sync: async (repoId, action, notify = true) => withBusy(async () => {
      const capability = action === 'fetch' ? 'syncFetch' : action === 'push' ? 'syncPush' : action === 'update' ? 'sync' : 'syncPull';
      if (!ensureRepositoryCapability(repoId, capability)) return;
      const result = await bridge().request<SyncResult>({ type: 'sync', payload: { workspace_id: workspaceId(), repo_id: repoId, action, remote: null } }, { timeoutMs: 600_000 });
      if (notify && result.update) {
        const repo = get().snapshot?.repositories.find((item) => item.meta.id === repoId);
        const summary = result.update.summary;
        get().addNotification({
          type: result.update.summaryError ? 'warning' : 'success',
          title: summary?.kind === 'noChanges' ? 'Repository is up to date' : 'Repository updated',
          message: result.update.summaryError ? `${repo?.meta.name ?? repoId}: update succeeded, summary unavailable` : `${repo?.meta.name ?? repoId}: ${summary?.commitCount ?? 0} commits, ${summary?.fileCount ?? 0} files`,
          actionLabel: summary?.commitCount ? 'View Update Details' : undefined,
          actionKey: summary?.commitCount ? 'viewUpdateDetails' : undefined,
          actionData: result.update,
        });
      }
      return result.update ?? undefined;
    }, `sync:${repoId}`),

    updateProject: async () => {
      const repositories = get().snapshot?.repositories ?? [];
      const wid = workspaceId();
      const settled = await Promise.all(repositories.map(async (repo) => {
        try { const value = await bridge().request<SyncResult>({ type: 'sync', payload: { workspace_id: wid, repo_id: repo.meta.id, action: repo.meta.kind === 'git' ? 'pull' : 'update', remote: null } }, { timeoutMs: 600_000 }); return { repoId: repo.meta.id, repoName: repo.meta.name, result: value.update ?? undefined }; }
        catch (error) { return { repoId: repo.meta.id, repoName: repo.meta.name, error: errorText(error) }; }
      }));
      set({ updateProjectReport: { results: settled } });
      const updated = settled.flatMap((item) => item.result ? [item.result] : []);
      const commits = updated.reduce((sum, item) => sum + (item.summary?.commitCount ?? 0), 0);
      const files = updated.reduce((sum, item) => sum + (item.summary?.fileCount ?? 0), 0);
      const failed = settled.filter((item) => item.error).length;
      get().addNotification({ type: failed ? 'warning' : 'success', title: 'Project update completed', message: `${updated.length} succeeded, ${failed} failed · ${commits} commits, ${files} files` });
    },
    dismissUpdateProjectReport: () => set({ updateProjectReport: undefined }),

    openUpdateDetails: async (result) => {
      const commits = result.summary?.detail.commits ?? [];
      if (!commits.length) return;
      const details = await Promise.all(commits.map((commit) => get().loadCommitDetail(commit)));
      const byKey = Object.fromEntries(details.map((detail) => [commitKey(detail.commit.repoId, detail.commit.hash), detail]));
      set({ selectedCommits: commits, selectedPrimaryKey: commitKey(commits[0].repoId, commits[0].hash), selectedCommit: details[0], selectedCommitDetails: { ...get().selectedCommitDetails, ...byKey } });
      if (commits.length === 1) get().openCommitDetail(); else get().openCommitChanges();
    },
    openUpdateResults: async (results) => {
      const commits = results.flatMap((result) => result.summary?.detail.commits ?? []);
      if (!commits.length) return;
      const details = await Promise.all(commits.map((commit) => get().loadCommitDetail(commit)));
      const byKey = Object.fromEntries(details.map((detail) => [commitKey(detail.commit.repoId, detail.commit.hash), detail]));
      set({ selectedCommits: commits, selectedPrimaryKey: commitKey(commits[0].repoId, commits[0].hash), selectedCommit: details[0], selectedCommitDetails: { ...get().selectedCommitDetails, ...byKey } });
      get().openCommitChanges();
    },

    recentCommitMessages: async (repoIds, signal) => bridge().request<RecentCommitMessage[]>({ type: 'recentCommitMessages', payload: { workspace_id: workspaceId(), repo_ids: repoIds, limit: 50 } }, { signal, showProgress: false }),
    lastCommitMessage: async (repoId, signal) => bridge().request<string | null>({ type: 'lastCommitMessage', payload: { workspace_id: workspaceId(), repo_id: repoId } }, { signal, showProgress: false }),

    loadHistory: async (reset = false, silent = false) => {
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
      const controller = beginRequest('history');
      const visibleLimit = Math.min((reset ? 0 : get().history.length) + HISTORY_PAGE_SIZE, historyMaxCommits);
      if (!silent) set({ historyLoading: true });
      try {
        // VersionDock fetches the prefix needed from every repository, merges
        // those logs, and only then applies the workspace-wide page boundary.
        const pagesPromise = Promise.all(repos.map(async (repo) => {
          const page = await bridge().request<HistoryPage>({ type: 'history', payload: { workspace_id: requestWorkspace, repo_id: repo.meta.id, skip: 0, limit: visibleLimit, query: { ...get().historyQuery, text: get().historyFilter || get().historyQuery.text, revision: scope.revisionsByRepo[repo.meta.id] ?? null } } }, { signal: controller.signal, showProgress: !silent });
          return { repoId: repo.meta.id, page };
        }));
        const breaking = get().historyQuery.text || get().historyQuery.author || get().historyQuery.fromDate || get().historyQuery.toDate || get().historyQuery.path;
        const topologyPromise = reset && !breaking
          ? Promise.all(repos.map(async (repo) => ({
            repoId: repo.meta.id,
            commits: await bridge().request<GraphCommitNode[]>({ type: 'historyTopology', payload: { workspace_id: requestWorkspace, repo_id: repo.meta.id, svn_limit: 1000, revision: scope.revisionsByRepo[repo.meta.id] ?? null } }, { signal: controller.signal, showProgress: !silent }).catch((error) => isAbortError(error) ? Promise.reject(error) : []),
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
        if (!silent && requestGeneration === historyRequestGeneration) set({ historyLoading: false });
      }
    },

    setHistoryFilter: (value) => set((state) => ({ historyFilter: value, historyQuery: { ...state.historyQuery, text: value || null } })),
    setHistoryQuery: (historyQuery) => {
      ++historyRequestGeneration;
      requestControllers.get('history')?.abort();
      set({ historyQuery, historyFilter: historyQuery.text ?? '', history: [], historyByRepo: {}, historyHasMore: false, historyTopology: [], historyTopologyByRepo: {} });
    },
    openHistoryForPath: async (repoId, path) => {
      ++historyRequestGeneration;
      requestControllers.get('history')?.abort();
      if (!get().historyQuery.path) {
        historyPathPreviousScope = get().historyScope;
        historyPathPreviousQuery = get().historyQuery;
      }
      set((state) => ({ historyScope: { repoIds: [repoId], revisionsByRepo: state.historyScope.revisionsByRepo[repoId] ? { [repoId]: state.historyScope.revisionsByRepo[repoId] } : {} }, historyQuery: { ...state.historyQuery, path }, selectedRepoId: repoId, mode: 'history' }));
      await get().loadHistory(true);
    },
    clearHistoryPath: async () => {
      ++historyRequestGeneration;
      requestControllers.get('history')?.abort();
      const restored = historyPathPreviousScope ?? get().historyScope;
      const restoredQuery = historyPathPreviousQuery ?? get().historyQuery;
      historyPathPreviousScope = undefined;
      historyPathPreviousQuery = undefined;
      set({ historyScope: restored, historyQuery: { ...restoredQuery, path: null }, historyFilter: restoredQuery.text ?? '' });
      await get().loadHistory(true);
    },
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
      const repoId = requestedRepoId ?? get().selectedRepoId; if (!repoId) return undefined;
      const value = operation as { type?: string; name?: string };
      const t = createTranslator(resolveLanguage(settings().language));
      const suggestMergeMessage = () => {
        const repo = get().snapshot?.repositories.find((item) => item.meta.id === repoId);
        const suggestion = `Merge branch '${value.name ?? 'branch'}' into '${repo?.branch ?? 'HEAD'}'`;
        if (get().commitMessage.trim()) set({ mergeMessageSuggestion: suggestion });
        else set({ commitMessage: suggestion, mergeMessageSuggestion: undefined });
        get().addNotification({ type: 'warning', title: t('Merge conflicts detected'), message: t('{0}: resolve conflicts before committing', repo?.meta.name ?? repoId), actionLabel: t('Open Conflicts'), actionKey: 'openConflicts' });
      };
      try {
        const result = await bridge().request<BranchOperationResult>({ type: 'branchOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation: operation as never } });
        if (result.conflicted) suggestMergeMessage();
        return result;
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== 'DIRTY_WORKTREE' || !value.name || (value.type !== 'checkout' && value.type !== 'merge')) {
          set({ error: errorText(error), errorDetails: errorDetails(error) });
          return undefined;
        }
        const target = value.name;
        await queueBranchRecoveryDialog(async () => {
        if (value.type === 'merge') {
          const selected = await choiceDialog({ title: t('Uncommitted changes'), message: t('Local changes would be overwritten by merging "{0}".', target), choices: [{ id: 'stash', label: t('Stash and merge'), description: t('Save all local changes to a retained stash, then merge.'), icon: 'archive' }, { id: 'cancel', label: t('Cancel'), icon: 'close' }] });
          if (selected === 'stash') {
            const recovery = await get().branchRecovery(repoId, { type: 'stashAndMerge', target });
            if (recovery?.status === 'conflicted') suggestMergeMessage();
          }
          return;
        }
        const selected = await choiceDialog({ title: t('Uncommitted changes'), message: t('Choose how to handle local changes before switching to "{0}".', target), choices: [{ id: 'stash', label: t('Stash and checkout'), description: t('Keep changes in a stash and switch branches.'), icon: 'archive' }, { id: 'carry', label: t('Carry changes'), description: t('Switch branches and apply the changes there.'), icon: 'arrow-right' }, { id: 'force', label: t('Force checkout'), description: t('Discard tracked local changes and switch branches.'), icon: 'warning', danger: true }, { id: 'cancel', label: t('Cancel'), icon: 'close' }] });
        if (selected === 'force' && !await confirmDialog({ title: t('Force checkout?'), message: t('Tracked working tree and index changes will be discarded. Untracked files are not deleted.'), danger: true, confirmLabel: t('Force Checkout') })) return;
        const recovery = selected === 'stash' ? { type: 'stashAndCheckout', target } as const : selected === 'carry' ? { type: 'carryChanges', target } as const : selected === 'force' ? { type: 'forceCheckout', target } as const : undefined;
        if (recovery) await get().branchRecovery(repoId, recovery);
        });
        return undefined;
      }
    },
    branchRecovery: async (repoId, operation) => {
      const t = createTranslator(resolveLanguage(settings().language));
      try {
        const result = await bridge().request<BranchRecoveryResult>({ type: 'branchRecovery', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, { timeoutMs: 600_000 });
        if (result.status === 'partialFailure') get().addNotification({ type: 'warning', title: t('Branch recovery needs attention'), message: result.recoveryHint ? t(result.recoveryHint) : result.error?.message ?? t('Review the repository and retained stash.') });
        else if (result.stashReference) get().addNotification({ type: result.status === 'conflicted' ? 'warning' : 'success', title: result.status === 'conflicted' ? t('Merge conflicts detected') : t('Branch operation completed'), message: t('{0} was retained for recovery.', result.stashReference) });
        await get().refresh(true);
        return result;
      } catch (error) {
        set({ error: errorText(error), errorDetails: errorDetails(error) });
        return undefined;
      }
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
      await get().loadStashes(repoId);
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
      await get().loadShelves(repoId);
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
      if (!ensureRepositoryCapability(repoId, 'worktreeWrite')) return;
      await bridge().request({ type: 'worktreeOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await get().loadWorktrees(repoId);
    }, `worktree:${repoId}`),
    openWorktree: async (repoId, path, reveal) => withBusy(async () => {
      const managedPath = await bridge().request<string>({ type: 'openWorktree', payload: { workspace_id: workspaceId(), repo_id: repoId, path, reveal } });
      if (!reveal && !await bridge().focusWorkspaceAcrossWindows([managedPath])) await bridge().openInNewWindow([managedPath]);
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
      if (!ensureRepositoryCapability(repoId, 'subtreeWrite')) return;
      const networkOperation = operation.type === 'add' || operation.type === 'pull' || operation.type === 'push';
      await bridge().request({ type: 'subtreeOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, networkOperation ? { timeoutMs: 600_000 } : undefined);
      await get().loadSubtrees(repoId);
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
      if (!ensureRepositoryCapability(repoId, 'submoduleWrite')) return;
      await bridge().request({ type: 'submoduleOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, { timeoutMs: 600_000 });
      await get().loadSubmodules(repoId);
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
    unpushedOperation: async (repoId, operation) => (await withBusy(async () => {
      if (!ensureRepositoryCapability(repoId, 'historyRewrite')) return false;
      await bridge().request({ type: 'unpushedOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, { timeoutMs: 600_000 });
      await get().loadUnpushedCommits(repoId);
      return true;
    }, `history:${repoId}`)) ?? false,
    historyOperation: async (repoId, operation) => withBusy(async () => {
      if (operation.type === 'reset' && !ensureRepositoryCapability(repoId, 'historyRewrite')) return;
      await bridge().request({ type: 'historyOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, { timeoutMs: 600_000 });
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
      const wid = get().snapshot?.workspace.id;
      const id = repoId ?? get().selectedRepoId;
      if (!wid || !id) return;
      const values = await bridge().request<RemoteInfo[]>({ type: 'remotes', payload: { workspace_id: wid, repo_id: id } }).catch(() => []);
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => ({ remotes: { ...state.remotes, [id]: values } }));
    },
    remoteOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'remoteOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, operation.type === 'prune' ? { timeoutMs: 600_000 } : undefined);
      await get().loadRemotes(repoId);
    }, `remote:${repoId}`),
    systemOpen: async (repoId, relativePath, reveal, external = false) => withBusy(async () => {
      await bridge().request({ type: 'systemOpen', payload: { workspace_id: workspaceId(), repo_id: repoId, relative_path: relativePath, reveal, external } });
    }, `system:${repoId}`),

    loadConflicts: async (silent = false, repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      const conflicts = await b.request<ConflictFile[]>({ type: 'conflicts', payload: { workspace_id: wid, repo_id: repoId ?? null } }, { showProgress: !silent }).catch(() => []);
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => ({
        conflicts: repoId
          ? [...state.conflicts.filter((conflict) => conflict.repoId !== repoId), ...conflicts]
          : conflicts,
      }));
    },

    refreshRuntimeCapabilities: async () => {
      const current = get().bootstrap;
      if (!current) return;
      try {
        const runtime = await bridge().request<RuntimeCapabilities>({ type: 'runtimeCapabilities' }, { showProgress: false });
        set((state) => state.bootstrap ? ({
          bootstrap: {
            ...state.bootstrap,
            runtime,
            capabilities: {
              ...state.bootstrap.capabilities,
              secureCredentials: runtime.secureCredentials.status.available,
              systemNotifications: runtime.systemNotifications.available,
              availability: {
                ...(state.bootstrap.capabilities.availability ?? {}),
                secureCredentials: runtime.secureCredentials.status,
                systemNotifications: runtime.systemNotifications,
              },
            },
          },
        }) : state);
      } catch {
        // Keep the last known runtime truth when a transient platform probe fails.
      }
    },

    openMerge: async (conflict) => withBusy(async () => {
      if (conflict.conflictType && !['text', 'binary'].includes(conflict.conflictType)) {
        set({ error: `${conflict.path}: ${conflict.conflictType} conflict requires an explicit working-copy resolution` });
        return;
      }
      const merge = await bridge().request<MergeVersions>({ type: 'conflictVersions', payload: { workspace_id: workspaceId(), repo_id: conflict.repoId, relative_path: conflict.path } });
      set({ merge, mergeResult: merge.markerContent || merge.working, selectedFile: { repoId: conflict.repoId, path: conflict.path, staged: false }, mode: 'merge' });
    }, `conflict:${conflict.repoId}`),
    resolveConflict: async (conflict, choice) => withBusy(async () => {
      await bridge().request({ type: 'conflictAccept', payload: { workspace_id: workspaceId(), repo_id: conflict.repoId, relative_path: conflict.path, choice } });
    }, `conflict:${conflict.repoId}`),

    setMergeResult: (mergeResult) => set({ mergeResult }),
    saveMerge: async () => withBusy(async () => {
      const merge = get().merge; const file = get().selectedFile;
      if (!merge || !file) return;
      await bridge().request({ type: 'conflictSave', payload: { workspace_id: workspaceId(), repo_id: file.repoId, relative_path: file.path, content: get().mergeResult, expected_fingerprint: merge.fingerprint } });
    }),
    acceptConflict: async (choice) => withBusy(async () => {
      const file = get().selectedFile; if (!file) return;
      await bridge().request({ type: 'conflictAccept', payload: { workspace_id: workspaceId(), repo_id: file.repoId, relative_path: file.path, choice } });
    }),
    abortRepositoryOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'abortRepositoryOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
    }, `conflict:${repoId}`),
    restoreConflicts: async (repoIds) => {
      const results: RestoreConflictsResult[] = [];
      for (const repoId of [...new Set(repoIds)]) {
        const result = await withBusy(async () => bridge().request<RestoreConflictsResult>({ type: 'restoreConflicts', payload: { workspace_id: workspaceId(), repo_id: repoId } }), `conflict:${repoId}`);
        if (result) results.push(result);
      }
      await get().refresh(true);
      return results;
    },

    backToHistory: () => {
      for (const key of ['diff', 'changes-diff', 'branch-working-diff']) requestControllers.get(key)?.abort();
      set({ mode: 'history', diff: undefined, changes: undefined, changesDiff: undefined, merge: undefined });
    },
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
