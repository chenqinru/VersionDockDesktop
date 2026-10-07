import { runGitTagWorkflow, type TagWorkflowRequest, type TagWorkflowResult } from '../services/gitTagWorkflow';
import { DEFAULT_SETTINGS, DEFAULT_LAYOUT } from '../settings/defaults';
import { mergeLogEntries } from '../logs/entries';
import { configureTaskProgress, resetTaskProgress, useTaskProgressStore } from '../progress/taskProgressStore';
import { SettingsWriter } from '../services/settingsWriter';
import { create } from 'zustand';
import type {
  AppStateSnapshot, BootstrapData, BranchInfo, CommitBranches, CommitDetail, CommitFile, CommitNode, ConflictFile, DiffDocument, GraphCommitNode,
  BranchCompareResult, HistoryPage, MergeVersions, RemoteInfo, RemoteOperation, RepositoryStatus, TagInfo, ThemePreference, LanguagePreference, UiFontSizePreference, FileIconThemePreference,
  WorkspaceSnapshot, StashEntry, StashOperation, ShelfEntry, ShelfOperation, ChangelistEntry, ChangelistOperation, WorktreeDiffResult, WorktreeEntry, WorktreeOperation, SubtreeEntry, SubtreeOperation, SubmoduleEntry, SubmoduleOperation,
  IncomingCommit, UnpushedCommit, UnpushedOperation, HistoryOperation, PatchDocument, SvnOperation, MergeCommitSummary, DesktopSettings, LayoutState, SettingsUpdateResult, RepositoryOperationResult,
  CheckoutRepositoryResult, DesktopCapabilities, HistoryQuery, InitializeRepositoryResult, LineRange,
  CloneRepositoryResult, OperationDomain, OperationEvent,
  RecentCommitMessage, RefreshScope, RepositoryCapabilities, RepositoryUpdateResult, RuntimeCapabilities,
  SyncResult, UpdateRestoreWarning, WindowTabTransfer, BranchOperationResult, BranchRecoveryOperation,
  BranchRecoveryResult, RepositoryCommitSelection, RestoreConflictsResult,
  ConflictResolutionResult,
  LogEntry, LogLevel, LogChannel,
} from '../bindings/generated';
import { BridgeError, isAbortError, type VersionDockBridge } from '../platform/bridge';
import { buildCommitFileTargets, commitKey, type DetailFileTarget } from '../history/commitDetails';
import { checkAppUpdate, openExternalLink, type AppUpdateCheckResult } from '../services/updater';
import { APP_CURRENT_VERSION } from '../version';
import { choiceDialog, promptDialog, multiChoiceDialog, confirmDialog } from '../components/dialogService';
import { buildPullRequestUrl } from '../history/prUrlHelper';
import { createTranslator, resolveLanguage } from '../i18n';
import { mergeEditorIdentity, type MergeResolution, type NonConflictScope } from '../components/mergeEditorModel';
import type { Resolution, NormalEdits, NonConflictingSelections, NonConflictingChangeScope } from '../components/mergeEngine';

export type WorkspaceMode = 'ai-review' | 'ai-composer' | 'history' | 'commit-detail' | 'diff' | 'changes' | 'conflicts' | 'merge';
export type CommitSelectionMode = 'single' | 'toggle' | 'range';
export type DiffRange = { fromRevision: string; toRevision: string };
export type RepositoryCheckoutOutcome = { succeeded: boolean; authenticationRequired: boolean };
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

export interface SyncOptions {
  remote?: string;
  branch?: string;
  rethrow?: boolean;
  showProgress?: boolean;
  onOperationId?: (id: string) => void;
}

export function workspacePathsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((path, index) => path === sortedRight[index]);
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function normalizeHistoryRevision(rev?: string | null): string | undefined {
  if (!rev) return undefined;
  const trimmed = rev.trim();
  if (!trimmed || trimmed === 'WORKTREE' || trimmed === 'WORKING' || trimmed === 'INDEX') {
    return undefined;
  }
  return trimmed;
}

export type NotificationText = string | { key: string; args?: Array<string | number> } | { raw: string };

export type AppNotificationAction =
  | { type: 'updateProject'; label: NotificationText }
  | { type: 'openPush'; label: NotificationText }
  | { type: 'openStash'; label: NotificationText }
  | { type: 'openShelf'; label: NotificationText }
  | { type: 'openConflicts'; label: NotificationText }
  | { type: 'dropAutoStash'; label: NotificationText; workspaceId: string; repoId: string; hash: string }
  | { type: 'keepAutoStash'; label: NotificationText; workspaceId: string; repoId: string; hash: string }
  | { type: 'openIdentity'; label: NotificationText; repoId?: string }
  | { type: 'refresh'; label: NotificationText }
  | { type: 'viewUpdateDetails'; label: NotificationText; result: RepositoryUpdateResult }
  | { type: 'viewUpdateResults'; label: NotificationText; results: RepositoryUpdateResult[] }
  | { type: 'addUntracked'; label: NotificationText; files: Array<{ repoId: string; path: string }> }
  | { type: 'retryBatchResult'; label: NotificationText; repoId: string; reportId?: string; workspaceId?: string }
  | { type: 'disableIncoming'; label: NotificationText }
  | { type: 'openLogPanel'; label: NotificationText }
  | { type: 'openBranchComparison'; label: NotificationText; repoId: string; target: string }
  | { type: 'pushTag'; label: NotificationText; repoId: string; tagName: string }
  | { type: 'pushToRemote'; label: NotificationText; repoId: string }
  | { type: 'cancelOperation'; label: NotificationText; operationId: string }
  | { type: 'recoverPush'; label: NotificationText; repoId: string; strategy: 'merge' | 'rebase' | 'force'; remote?: string | null; branch?: string | null }
  | { type: 'unlockIndex'; label: NotificationText; repoId: string }
  | { type: 'pruneBranches'; label: NotificationText; repoId: string; branches: string[] }
  | { type: 'openExternal'; label: NotificationText; url: string }
  | { type: 'createBranch'; label: NotificationText; repoId: string; revision: string }
  | { type: 'continueOperation' | 'abortOperation' | 'skipOperation'; label: NotificationText; repoId: string; operation: string; revision?: string }
  | { type: 'dismiss'; label: NotificationText };

export interface AppNotification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: NotificationText;
  message: NotificationText;
  timestamp: number;
  read: boolean;
  workspaceId?: string;
  repositoryCount?: number;
  details?: string;
  urgent?: boolean;
  progress?: boolean;
  progressValue?: number;
  progressMessage?: NotificationText;
  operationId?: string;
  actionState?: Record<number, 'running' | 'done'>;
  actions: AppNotificationAction[];
}

export function resolveNotificationText(value: NotificationText, t: (key: string, ...args: Array<string | number>) => string, repositoryCount?: number): string {
  const text = typeof value === 'string' ? t(value) : 'raw' in value ? value.raw : t(value.key, ...(value.args ?? []));
  if (repositoryCount === undefined || repositoryCount > 1) return text;
  // Match the plugin's shared formatter after translation, including warnings.
  return text.replace(/^VersionDock\s*\[[^\]]+\]\s*(警告：|Warning:\s*|：|:\s*)/, (_match, suffix: string) => {
    if (suffix.startsWith('警告')) return 'VersionDock 警告：';
    if (suffix.startsWith('Warning')) return 'VersionDock Warning: ';
    return suffix.includes('：') ? 'VersionDock：' : 'VersionDock: ';
  });
}

export interface BatchCommitReport {
  id?: string;
  workspaceId?: string;
  message: string;
  push: boolean;
  targets: Array<{ repoId: string; paths: string[]; unstagePaths: string[]; amend: boolean; noVerify?: boolean; stagedOnly?: boolean }>;
  results: RepositoryOperationResult[];
}

const batchFailedStageLabels: Record<string, string> = {
  prepare: 'Preparation',
  identity: 'Identity check',
  commit: 'Commit',
  push: 'Push',
};

const HISTORY_PAGE_SIZE = 100;
const EMPTY_HISTORY_QUERY: HistoryQuery = { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null, lineRange: null };

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

function normalizeDirPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function isPathInDir(childPath: string, parentDir: string): boolean {
  const c = normalizeDirPath(childPath);
  const p = normalizeDirPath(parentDir);
  return c === p || c.startsWith(`${p}/`);
}

export function isLogEntryInWorkspace(entry: LogEntry, workspacePaths: string[], workspaceId?: string | null): boolean {
  if (entry.context?.workspaceId && workspaceId) return entry.context.workspaceId === workspaceId;
  if (!entry.cwd) {
    return true;
  }
  return workspacePaths.some((wp) => isPathInDir(entry.cwd!, wp));
}

export function calculateWorkspaceUnreadErrors(
  entries: LogEntry[],
  workspaceId: string | null,
  tabs: WorkspaceSnapshot['workspace'][],
  lastReadTimestamps: Record<string, number>,
  fallbackPaths?: string[],
): number {
  const lastRead = lastReadTimestamps[workspaceId ?? '__global__'] ?? 0;
  const currentTab = tabs.find((t) => t.id === workspaceId);
  const paths = currentTab ? currentTab.paths : (fallbackPaths ?? []);
  return entries.filter((entry) => {
    if (entry.level !== 'error') return false;
    const ts = new Date(entry.timestamp).getTime();
    if (ts <= lastRead) return false;
    if (paths.length === 0 && !entry.context?.workspaceId) return true;
    return isLogEntryInWorkspace(entry, paths, workspaceId);
  }).length;
}

export interface WorkspaceSessionState {
  mergeEditorDraft?: MergeEditorDraft;
  snapshot: WorkspaceSnapshot;
  allRepositories: RepositoryStatus[];
  selectedRepoId?: string;
  selectedFile?: { repoId: string; path: string; staged: boolean; revision?: string; fromRevision?: string; toRevision?: string };
  fileHistoryTarget?: { repoId: string; path: string };
  mode: WorkspaceMode;
  diffReturnMode?: WorkspaceMode;
  diff?: DiffDocument;
  diffReveal?: { line: number; side: 'old' | 'new' };
  changesDiff?: DiffDocument;
  changesDiffLoading?: boolean;
  changesDiffError?: string;
  changesDiffTarget?: string;
  changes?: CommitChangesModel;
  history: CommitNode[];
  historyHasMore: boolean;
  historyByRepo: Record<string, CommitNode[]>;
  historyTopology: GraphCommitNode[];
  historyTopologyByRepo: Record<string, GraphCommitNode[]>;
  historyHasMoreByRepo: Record<string, boolean>;
  historyRepoErrors?: Record<string, string>;
  historyLoading: boolean;
  historyTopologyLoading?: boolean;
  branchesLoading: boolean;
  historyScope: HistoryScope;
  historyFilter: string;
  historyQuery: HistoryQuery;
  selectedCommit?: CommitDetail;
  selectedCommits: CommitNode[];
  selectedPrimaryKey?: string;
  commitSelectionAnchorKey?: string;
  selectedCommitDetails: Record<string, CommitDetail>;
  selectedCommitLoading: Record<string, boolean>;
  selectedCommitError?: Record<string, string>;
  mergeCommits: Record<string, MergeCommitSummary[]>;
  mergeCommitsLoading: Record<string, boolean>;
  mergeParentFiles: Record<string, CommitFile[]>;
  mergeParentFilesLoading: Record<string, boolean>;
  mergeParentFilesError: Record<string, string>;
  branches: BranchInfo[];
  tags: TagInfo[];
  branchesByRepo: Record<string, BranchInfo[]>;
  tagsByRepo: Record<string, TagInfo[]>;
  conflicts: ConflictFile[];
  merge?: MergeVersions;
  mergeTarget?: { repoId: string; path: string; workspaceId?: string };
  mergeResolutions: Record<number, MergeResolution>;
  mergeScope: NonConflictScope;
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
  incomingCommits: Record<string, IncomingCommit[]>;
  comparisonTarget?: { repoId: string; target: string };
  comparison?: BranchCompareResult;
  remotes: Record<string, RemoteInfo[]>;
  lastSyncedAt?: number;
  batchCommitReport?: BatchCommitReport;
  loadErrors: Record<string, string | null>;
}

export interface MergeEditorDraft {
  identity: string;
  fingerprint: string;
  resolutions: Record<number, Resolution>;
  normalEdits: NormalEdits;
  nonConflictingSelections: NonConflictingSelections;
  appliedNonConflictingScope: NonConflictingChangeScope | null;
  currentConflictIndex: number;
  syncScrollEnabled: boolean;
}

export interface AppStore {
  tagBusy: boolean;
  runTagWorkflow: (request: TagWorkflowRequest) => Promise<TagWorkflowResult>;
  transferringTabIds: Record<string, true>;
  beginTabTransfer: (workspaceId: string) => boolean;
  endTabTransfer: (workspaceId: string) => void;
  mergeEditorDraft?: MergeEditorDraft;
  exportTabSession: (workspaceId: string) => WorkspaceSessionState | undefined;
  setMergeEditorDraft: (draft: MergeEditorDraft) => void;
  importTab: (transfer: WindowTabTransfer, insertionIndex?: number) => Promise<boolean>;
  bridge?: VersionDockBridge;
  ready: boolean;
  operations: Record<string, OperationEvent>;
  notifications: AppNotification[];
  toastNotificationIds: string[];
  notificationCenterOpen: boolean;
  aboutOpen: boolean;
  aboutInitialTab: 'about' | 'changelog';
  openAbout: (tab?: 'about' | 'changelog') => void;
  closeAbout: () => void;
  updateAvailableInfo: AppUpdateCheckResult | null;
  updateChecking: boolean;
  setUpdateAvailableInfo: (info: AppUpdateCheckResult | null) => void;
  checkUpdateSilently: (force?: boolean) => Promise<void>;
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
  diffReturnMode?: WorkspaceMode;
  diff?: DiffDocument;
  diffReveal?: { line: number; side: 'old' | 'new' };
  changesDiff?: DiffDocument;
  changesDiffLoading?: boolean;
  changesDiffError?: string;
  changesDiffTarget?: string;
  changes?: CommitChangesModel;
  history: CommitNode[];
  historyHasMore: boolean;
  historyByRepo: Record<string, CommitNode[]>;
  historyTopology: GraphCommitNode[];
  historyTopologyByRepo: Record<string, GraphCommitNode[]>;
  historyHasMoreByRepo: Record<string, boolean>;
  historyRepoErrors?: Record<string, string>;
  historyLoading: boolean;
  historyTopologyLoading?: boolean;
  branchesLoading: boolean;
  historyScope: HistoryScope;
  historyFilter: string;
  historyQuery: HistoryQuery;
  selectedCommit?: CommitDetail;
  selectedCommits: CommitNode[];
  selectedPrimaryKey?: string;
  commitSelectionAnchorKey?: string;
  selectedCommitDetails: Record<string, CommitDetail>;
  selectedCommitLoading: Record<string, boolean>;
  selectedCommitError: Record<string, string>;
  mergeCommits: Record<string, MergeCommitSummary[]>;
  mergeCommitsLoading: Record<string, boolean>;
  mergeParentFiles: Record<string, CommitFile[]>;
  mergeParentFilesLoading: Record<string, boolean>;
  mergeParentFilesError: Record<string, string>;
  branches: BranchInfo[];
  tags: TagInfo[];
  branchesByRepo: Record<string, BranchInfo[]>;
  tagsByRepo: Record<string, TagInfo[]>;
  conflicts: ConflictFile[];
  merge?: MergeVersions;
  mergeTarget?: { repoId: string; path: string; workspaceId?: string };
  mergeResolutions: Record<number, MergeResolution>;
  mergeScope: NonConflictScope;
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
  incomingCommits: Record<string, IncomingCommit[]>;
  comparisonTarget?: { repoId: string; target: string };
  comparison?: BranchCompareResult;
  remotes: Record<string, RemoteInfo[]>;
  batchCommitReport?: BatchCommitReport;
  batchCommitReports: Record<string, BatchCommitReport>;
  loadErrors: Record<string, string | null>;
  initialize: (bridge: VersionDockBridge) => Promise<void>;
  dispose: () => void;
  openWorkspace: (paths: string[], focus?: boolean, options?: OpenWorkspaceOptions) => Promise<boolean>;
  initializeRepository: (targetPath: string) => Promise<void>;
  cloneRepository: (url: string, parentPath: string, targetName: string, openInNewWindow?: boolean, providerAccountId?: string) => Promise<boolean>;
  checkoutSvnRepository: (url: string, parentPath: string, targetName: string, openInNewWindow?: boolean, username?: string, password?: string) => Promise<RepositoryCheckoutOutcome>;
  switchTab: (workspaceId: string) => Promise<void>;
  closeTab: (workspaceId: string, options?: { closeWindowIfLast?: boolean }) => Promise<void>;
  closeOtherTabs: (workspaceId: string) => Promise<void>;
  closeAllTabs: () => Promise<void>;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  restoreTabsOnStartup: () => Promise<void>;
  restoreLastWorkspace: () => Promise<void>;
  removeRecent: (workspaceId: string) => Promise<void>;
  refresh: (silent?: boolean, options?: { reloadRepository?: boolean; trackBusy?: boolean }) => Promise<void>;
  selectRepo: (repoId: string, reload?: boolean) => Promise<void>;
  openDiff: (repoId: string, path: string, staged: boolean, revision?: string, range?: DiffRange) => Promise<void>;
  openStashDiff: (repoId: string, reference: string, path: string) => Promise<void>;
  openShelfDiff: (repoId: string, shelfId: string, path: string) => Promise<void>;
  openCommitDetail: () => void;
  openCommitChanges: () => void;
  openWorkingChanges: (repoId: string, section?: 'staged' | 'unstaged') => void;
  loadChangesDiff: (target: DetailFileTarget | WorkingChangeTarget) => Promise<void>;
  setCommitMessage: (value: string) => void;
  applyMergeMessageSuggestion: () => void;
  dismissMergeMessageSuggestion: () => void;
  setAmendRepoIds: (values: string[]) => void;
  setCommitSelection: (repoId: string, paths: string[], selected: boolean) => void;
  stage: (repoId: string, paths: string[], allowTruncated?: boolean) => Promise<void>;
  unstage: (repoId: string, paths: string[]) => Promise<void>;
  discard: (repoId: string, paths: string[]) => Promise<void>;
  deletePaths: (repoId: string, paths: string[]) => Promise<void>;
  addIgnore: (repoId: string, path: string) => Promise<void>;
  commit: (repoId: string, message: string, amend: boolean, paths: string[], push: boolean, noVerify?: boolean, stagedOnly?: boolean, targetWorkspaceId?: string) => Promise<void>;
  commitMany: (targets: Array<{ repoId: string; paths: string[]; unstagePaths: string[]; amend: boolean; noVerify?: boolean; stagedOnly?: boolean }>, message: string, push: boolean, targetWorkspaceId?: string) => Promise<RepositoryOperationResult[] | undefined>;
  retryBatchResult: (repoId: string, options?: { reportId?: string; workspaceId?: string }) => Promise<void>;
  dismissBatchReport: () => void;
  sync: (repoId: string, action: 'fetch' | 'pull' | 'pullRebase' | 'pullFfOnly' | 'push' | 'pushTags' | 'update', notify?: boolean, options?: SyncOptions & { force?: boolean }, targetWorkspaceId?: string) => Promise<RepositoryUpdateResult | undefined>;
  fetchRepositories: (repoIds: string[], notifyCompletion?: boolean, targetWorkspaceId?: string) => Promise<void>;
  notifyPushSuccess: (repoId: string, workspaceId: string, remote?: string, branch?: string) => Promise<void>;
  updateProject: (strategy?: 'merge' | 'rebase') => Promise<void>;
  openUpdateDetails: (result: RepositoryUpdateResult) => Promise<void>;
  openUpdateResults: (results: RepositoryUpdateResult[]) => Promise<void>;
  recentCommitMessages: (repoIds: string[], signal?: AbortSignal) => Promise<RecentCommitMessage[]>;
  lastCommitMessage: (repoId: string, signal?: AbortSignal) => Promise<string | null>;
  loadHistory: (reset?: boolean, silent?: boolean) => Promise<void>;
  setHistoryFilter: (value: string) => void;
  historyRevealTarget?: { workspaceId: string; repoId: string; hash: string };
  revealHistoryCommit: (repoId: string, hash: string) => void;
  setHistoryQuery: (query: HistoryQuery) => void;
  openHistoryForPath: (repoId: string, path: string) => Promise<void>;
  openHistoryForLineRange: (repoId: string, path: string, lineRange: LineRange, revision?: string | null) => Promise<void>;
  clearHistoryPath: () => Promise<void>;
  setHistoryScope: (scope: HistoryScope) => void;
  selectCommit: (commit: CommitNode, mode?: CommitSelectionMode, rangeSource?: CommitNode[]) => Promise<void>;
  loadCommitDetail: (commit: CommitNode, force?: boolean) => Promise<CommitDetail>;
  reloadSelectedCommits: (targetWorkspaceId?: string) => Promise<void>;
  loadMergeCommits: (commit: CommitNode) => Promise<void>;
  loadMergeParentFiles: (repoId: string, revision: string, parentHash: string) => Promise<CommitFile[]>;
  clearCommitSelection: () => void;
  branchOperation: (operation: object, repoId?: string) => Promise<BranchOperationResult | undefined>;
  branchRecovery: (repoId: string, operation: BranchRecoveryOperation) => Promise<BranchRecoveryResult | undefined>;
  tagOperation: (operation: object, repoId?: string) => Promise<boolean>;
  loadStashes: (repoId?: string, targetWorkspaceId?: string) => Promise<void>;
  stashOperation: (repoId: string, operation: StashOperation, targetWorkspaceId?: string) => Promise<boolean>;
  loadShelves: (repoId?: string, targetWorkspaceId?: string) => Promise<void>;
  shelfOperation: (repoId: string, operation: ShelfOperation, targetWorkspaceId?: string) => Promise<boolean>;
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
  submoduleOperation: (repoId: string, operation: SubmoduleOperation, options?: { rethrow?: boolean }) => Promise<void>;
  loadUnpushedCommits: (repoId?: string, targetWorkspaceId?: string) => Promise<void>;
  loadIncomingCommits: (repoId?: string, targetWorkspaceId?: string) => Promise<void>;
  unpushedOperation: (repoId: string, operation: UnpushedOperation) => Promise<boolean>;
  historyOperation: (repoId: string, operation: HistoryOperation) => Promise<boolean>;
  createPatch: (repoId: string, revisions: string[]) => Promise<PatchDocument>;
  savePatch: (repoId: string, revisions: string[], path: string) => Promise<string>;
  svnOperation: (repoId: string, operation: SvnOperation) => Promise<void>;
  openBranchComparison: (repoId: string, target: string) => void;
  closeBranchComparison: () => void;
  compareBranches: (repoId: string, base: string, target: string) => Promise<void>;
  compareBranchCommits: (repoId: string, base: string, target: string, side: string, query: HistoryQuery, signal?: AbortSignal) => Promise<CommitNode[]>;
  clearComparison: () => void;
  loadRemotes: (repoId?: string) => Promise<void>;
  remoteOperation: (repoId: string, operation: RemoteOperation) => Promise<void>;
  systemOpen: (repoId: string, path: string, reveal: boolean, external?: boolean) => Promise<void>;
  loadConflicts: (silent?: boolean, repoId?: string) => Promise<void>;
  refreshRuntimeCapabilities: () => Promise<void>;
  openConflicts: () => void;
  setMode: (mode: WorkspaceMode) => void;
  openMerge: (conflict: ConflictFile) => Promise<void>;
  resolveConflict: (conflict: ConflictFile, choice: 'mine' | 'theirs' | 'working') => Promise<boolean>;
  setMergeResult: (value: string) => void;
  setMergeResolutions: (resolutions: Record<number, MergeResolution> | ((prev: Record<number, MergeResolution>) => Record<number, MergeResolution>)) => void;
  setMergeScope: (scope: NonConflictScope) => void;
  saveMerge: (options?: { deleteFile?: boolean }) => Promise<boolean>;
  acceptConflict: (choice: 'mine' | 'theirs' | 'working') => Promise<boolean>;
  abortRepositoryOperation: (repoId: string, operation: string) => Promise<boolean>;
  continueRepositoryOperation: (repoId: string, operation: string) => Promise<boolean>;
  restoreConflicts: (repoIds: string[]) => Promise<RestoreConflictsResult[]>;
  backToHistory: () => void;
  openFileHistory: (repoId: string, path: string) => void;
  closeFileHistory: () => void;
  setTheme: (value: ThemePreference) => Promise<void>;
  setLanguage: (value: LanguagePreference) => Promise<void>;
  setUiFontSize: (value: UiFontSizePreference) => void;
  setFileIconTheme: (value: FileIconThemePreference) => Promise<void>;
  setExternalEditor: (executable: string, args: string[]) => void;
  setFileViewMode: (value: 'tree' | 'list') => void;
  setStashViewMode: (value: 'tree' | 'list') => void;
  setActiveTab: (value: 'changes' | 'shelf' | 'stash' | 'worktree' | 'subtree' | 'submodule' | 'sync' | 'push') => void;
  setPanelSize: (key: 'commit' | 'branches' | 'detail', value: number) => void;
  setBranchSidebarState: (collapsed: boolean, collapsedSections: string[]) => void;
  updateSettings: (patch: Partial<DesktopSettings>) => Promise<void>;
  addNotification: (notification: Omit<AppNotification, 'id' | 'timestamp' | 'read' | 'actions'> & { actions?: AppNotificationAction[] }) => string;
  dismissToast: (id?: string) => void;
  setNotificationCenterOpen: (open: boolean) => void;
  performNotificationAction: (notificationId: string, actionIndex: number) => Promise<void>;
  markNotificationAsRead: (id: string) => void;
  markAllNotificationsAsRead: (workspaceId?: string) => void;
  removeNotification: (id: string) => void;
  clearNotifications: (workspaceId?: string) => void;
  openIdentityPanel: (repoId?: string) => void;
  closeIdentityPanel: () => void;
  openRemoteManager: (repoId?: string) => void;
  closeRemoteManager: () => void;
  logPanelOpen: boolean;
  logPanelHeight: number;
  logEntries: LogEntry[];
  logError: string | null;
  logStorageError: string | null;
  activeLogChannel: LogChannel | 'all';
  activeLogLevel: LogLevel | 'all';
  activeLogProject: string;
  setLogProject: (project: string) => void;
  logSearchQuery: string;
  logAutoScroll: boolean;
  unreadErrorCount: number;
  lastReadLogTimestamps: Record<string, number>;
  toggleLogPanel: () => void;
  setLogPanelOpen: (open: boolean) => void;
  setLogPanelHeight: (height: number) => void;
  setLogChannel: (channel: LogChannel | 'all') => void;
  setLogLevel: (level: LogLevel | 'all') => void;
  setLogSearchQuery: (query: string) => void;
  setLogAutoScroll: (autoScroll: boolean) => void;
  clearLogs: () => Promise<void>;
  addLogEntry: (entry: LogEntry) => void;
  loadLogs: () => Promise<void>;
  openLogFolder: () => Promise<void>;
  exportLogs: (targetPath: string) => Promise<boolean>;
  resetUnreadErrors: () => void;
}

const emptyState: AppStateSnapshot = {
  schemaVersion: 7,
  settings: DEFAULT_SETTINGS,
  layout: DEFAULT_LAYOUT,
  lastWorkspaceId: null, openWorkspaceIds: [], activeWorkspaceId: null, recentWorkspaces: [], commitSelections: {},
};

let watcherTimer: ReturnType<typeof setTimeout> | undefined;
let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
let autoFetchTimer: ReturnType<typeof setInterval> | undefined;
let workspaceRequestGeneration = 0;
let watcherRefreshInFlight = false;
let watcherRefreshQueued = false;
const repositoryEventGenerations = new Map<string, number>();
let commitSelectionGeneration = 0;
let changesDiffGeneration = 0;
let diffRequestGeneration = 0;
let historyPageGeneration = 0;
let historyTopologyGeneration = 0;

function abortHistoryRequests() {
  historyPageGeneration += 1;
  historyTopologyGeneration += 1;
  requestControllers.get('history:page')?.abort();
  requestControllers.get('history:topology')?.abort();
}
let historyPathPreviousScope: HistoryScope | undefined;
let historyPathPreviousQuery: HistoryQuery | undefined;

function resetHistoryPathFilterState(state: AppStore) {
  const hadPathFilter = Boolean(state.historyQuery.path || state.historyQuery.lineRange);
  const restoredScope = hadPathFilter ? (historyPathPreviousScope ?? state.historyScope) : state.historyScope;
  const restoredQuery = hadPathFilter ? (historyPathPreviousQuery ?? state.historyQuery) : state.historyQuery;
  if (hadPathFilter) {
    historyPathPreviousScope = undefined;
    historyPathPreviousQuery = undefined;
  }
  return {
    hadPathFilter,
    historyScope: restoredScope,
    historyQuery: { ...restoredQuery, path: null, lineRange: null },
    historyFilter: hadPathFilter ? (restoredQuery.text ?? '') : state.historyFilter,
  };
}
let comparisonRequestGeneration = 0;
let branchWorkingDiffGeneration = 0;
const commitSelectionSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let branchRecoveryDialogQueue: Promise<void> = Promise.resolve();
const requestControllers = new Map<string, AbortController>();
const activeStashOperations = new Set<string>();
const pendingPullAutoStashes = new Map<string, { hash: string; shortHash: string; prompted: boolean }>();
const bridgeSubscriptions: Array<() => void> = [];
let localOperationSequence = 0;
let currentWindowLabel = `window-${Math.random().toString(36).slice(2)}`;
const ownedSchedulerLeases = new Set<string>();
let startupFetchPending = false;
const pendingWorkspaceEvents = new Map<string, Map<string, Set<RefreshScope>>>();

function recordPendingWorkspaceEvent(workspaceId: string, repoId: string | null | undefined, scopes: RefreshScope[]): void {
  const targetWorkspaceEvents = pendingWorkspaceEvents.get(workspaceId) ?? new Map<string, Set<RefreshScope>>();
  const key = repoId ?? '';
  const existingScopes = targetWorkspaceEvents.get(key) ?? new Set<RefreshScope>();
  scopes.forEach((scope) => existingScopes.add(scope));
  targetWorkspaceEvents.set(key, existingScopes);
  pendingWorkspaceEvents.set(workspaceId, targetWorkspaceEvents);
}

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

function isSchedulerLeaseActive(name: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  const key = `versiondock:scheduler:${name}`;
  try {
    const current = JSON.parse(localStorage.getItem(key) ?? 'null') as { owner?: string; expiresAt?: number } | null;
    return Boolean(current?.owner && (current.expiresAt ?? 0) > Date.now());
  } catch {
    return false;
  }
}

interface RepoNotificationSnapshot {
  branch: string;
  revision: string;
  count: number;
}

interface NotificationBaselineMeta {
  version: number;
  count: number;
  sessionId?: string;
  owner?: string;
  revisionSignature?: string;
  repoSnapshots?: Record<string, RepoNotificationSnapshot>;
  updatedAt: number;
  notifiedSessionId?: string;
}

interface LocalBaselineState {
  version: number;
  count: number;
  revisionSignature?: string;
  repoSnapshots?: Record<string, RepoNotificationSnapshot>;
}

const sessionNotifiedCounts = new Map<string, number>();
const sessionObservedCounts = new Map<string, number>();
const sessionNotifiedStates = new Map<string, LocalBaselineState>();
const sessionNotifiedSessionFlags = new Set<string>();

function syncNotificationSession(sessionId?: string) {
  if (typeof localStorage === 'undefined' || !sessionId) return;
  const sessionKey = 'versiondock:active-application-session-id';
  try {
    const previousSessionId = localStorage.getItem(sessionKey);
    if (previousSessionId && previousSessionId !== sessionId) {
      sessionNotifiedSessionFlags.clear();
      sessionNotifiedCounts.clear();
      sessionObservedCounts.clear();
      sessionNotifiedStates.clear();
      // 应用重启（冷启动），上一代会话留下的通知基线属于历史记录，不能阻止新会话根据客观事实建立新基线
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('versiondock:notification-count:') || k.startsWith('versiondock:notification-meta:'))) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    }
    localStorage.setItem(sessionKey, sessionId);
  } catch { /* ignore damaged storage */ }
}

function getRepositoriesRevisionSignature(repositories: RepositoryStatus[]): string {
  return repositories
    .filter((repo) => !repo.meta.isWorktree)
    .map((repo) => `${repo.meta.id}:${repo.branch}:${repo.revision}`)
    .sort()
    .join('|');
}

function getSharedNotificationMeta(workspaceId: string, kind: 'conflicts' | 'incoming' | 'unpushed'): NotificationBaselineMeta | null {
  if (kind === 'conflicts' || typeof localStorage === 'undefined') return null;
  const currentSessionId = useAppStore.getState().bootstrap?.applicationSessionId;
  const metaKey = `versiondock:notification-meta:${workspaceId}:${kind}`;
  try {
    const metaStored = localStorage.getItem(metaKey);
    if (metaStored) {
      const parsed = JSON.parse(metaStored) as NotificationBaselineMeta | null;
      if (parsed && (!parsed.sessionId || !currentSessionId || parsed.sessionId === currentSessionId)) {
        return parsed;
      }
    }
  } catch { /* ignore damaged storage */ }
  return null;
}

function getLocalNotificationState(workspaceId: string, kind: 'conflicts' | 'incoming' | 'unpushed'): LocalBaselineState | null {
  const key = `versiondock:notification-count:${workspaceId}:${kind}`;
  const windowKey = `${currentWindowLabel}:${key}`;
  return sessionNotifiedStates.get(windowKey) ?? null;
}

function reconcileRepositoryStatuses(
  allRepositories: RepositoryStatus[],
  kind: 'incoming' | 'unpushed',
  sharedMeta: NotificationBaselineMeta | null,
  localState: LocalBaselineState | null,
): {
  effectiveRepositories: RepositoryStatus[];
  totalCount: number;
  repoSnapshots: Record<string, RepoNotificationSnapshot>;
  rawSnapshots: Record<string, RepoNotificationSnapshot>;
} {
  const localSnapshots = localState?.repoSnapshots;
  const sharedSnapshots = sharedMeta?.repoSnapshots;

  const effectiveRepositories: RepositoryStatus[] = [];
  const repoSnapshots: Record<string, RepoNotificationSnapshot> = {};
  const rawSnapshots: Record<string, RepoNotificationSnapshot> = {};
  let totalCount = 0;

  for (const repo of allRepositories) {
    if (repo.meta.isWorktree) {
      continue;
    }
    if (kind === 'unpushed' && repo.meta.kind !== 'git') {
      continue;
    }

    const currentCount = kind === 'incoming' ? repo.behind : repo.ahead;
    rawSnapshots[repo.meta.id] = {
      branch: repo.branch,
      revision: repo.revision,
      count: currentCount,
    };

    let effectiveCount = currentCount;

    if (sharedSnapshots) {
      const shared = sharedSnapshots[repo.meta.id];
      const local = localSnapshots?.[repo.meta.id];

      if (shared) {
        // 判定 1：Revision 明确滞后（shared 中已演进至新 HEAD，而本地仍停留在旧 HEAD，且本地计数偏高）
        const revisionStale = Boolean(
          shared.revision &&
          repo.revision &&
          shared.revision !== repo.revision &&
          (!local || repo.revision === local.revision) &&
          currentCount > shared.count
        );

        // 判定 2：计数滞后（在本地记忆中曾经是 higher count，未刷新；而 shared 中已经被拉取降级）
        const countStale = Boolean(
          local &&
          local.count > 0 &&
          repo.branch === local.branch &&
          repo.revision === local.revision &&
          currentCount === local.count &&
          shared.count < currentCount
        );

        // 判定 3：同一窗口连续检查保持（已校正为 shared.count，物理快照仍未刷新且 revision 未演进）
        const unrefreshedAfterReconcile = Boolean(
          local &&
          local.count === shared.count &&
          currentCount > shared.count &&
          repo.branch === local.branch &&
          repo.revision === local.revision &&
          (!shared.revision || !repo.revision || shared.revision !== repo.revision)
        );

        const isStaleRepo = revisionStale || countStale || unrefreshedAfterReconcile;
        if (isStaleRepo) {
          effectiveCount = shared.count;
        }
      }
    }

    repoSnapshots[repo.meta.id] = {
      branch: repo.branch,
      revision: repo.revision,
      count: effectiveCount,
    };

    totalCount += effectiveCount;

    if (effectiveCount > 0) {
      effectiveRepositories.push({
        ...repo,
        behind: kind === 'incoming' ? effectiveCount : repo.behind,
        ahead: kind === 'unpushed' ? effectiveCount : repo.ahead,
      });
    }
  }

  return { effectiveRepositories, totalCount, repoSnapshots, rawSnapshots };
}

function shouldNotifyStatusCount(
  workspaceId: string,
  kind: 'conflicts' | 'incoming' | 'unpushed',
  currentCount: number,
  sessionId?: string,
  revisionSignature?: string,
  repoSnapshots?: Record<string, RepoNotificationSnapshot>,
  rawSnapshots?: Record<string, RepoNotificationSnapshot>,
): boolean {
  const currentSessionId = sessionId ?? useAppStore.getState().bootstrap?.applicationSessionId;
  if (currentSessionId) {
    syncNotificationSession(currentSessionId);
  }

  const key = `versiondock:notification-count:${workspaceId}:${kind}`;
  const metaKey = `versiondock:notification-meta:${workspaceId}:${kind}`;

  const sharedMeta = getSharedNotificationMeta(workspaceId, kind);
  let sharedCount = sharedMeta?.count;

  // 普通提交通知跨窗口持久化去重：同一会话内共享基线，避免多窗口内存缓存滞后导致重复误报；跨会话则自动隔离失效
  if (kind !== 'conflicts' && typeof localStorage !== 'undefined' && sharedCount === undefined) {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        const parsed = parseInt(stored, 10);
        if (!Number.isNaN(parsed)) sharedCount = parsed;
      }
    } catch { /* ignore damaged storage */ }
  }

  const windowKey = `${currentWindowLabel}:${key}`;
  let localState = sessionNotifiedStates.get(windowKey);
  if (!localState) {
    if (sharedMeta && currentCount <= sharedMeta.count) {
      localState = {
        version: sharedMeta.version,
        count: sharedMeta.count,
        revisionSignature: sharedMeta.revisionSignature ?? revisionSignature,
        repoSnapshots: sharedMeta.repoSnapshots ?? repoSnapshots,
      };
      sessionNotifiedStates.set(windowKey, localState);
      sessionNotifiedCounts.set(windowKey, localState.count);
    } else if (sessionNotifiedCounts.has(windowKey)) {
      localState = {
        version: sharedMeta?.version ?? 1,
        count: sessionNotifiedCounts.get(windowKey)!,
        revisionSignature,
        repoSnapshots,
      };
      sessionNotifiedStates.set(windowKey, localState);
    }
  } else {
    if (!localState.revisionSignature && revisionSignature) {
      localState.revisionSignature = revisionSignature;
    }
    if (!localState.repoSnapshots && repoSnapshots) {
      localState.repoSnapshots = repoSnapshots;
    }
  }

  const observedMax = sessionObservedCounts.get(windowKey) ?? 0;
  if (currentCount > observedMax) {
    sessionObservedCounts.set(windowKey, currentCount);
  }

  // 核心检测：多窗口下的状态重置与降级检测 (彻底消除 ABA、多仓库交叉污染与过期快照误判)
  // 若共享基准线已经被其他窗口合法降级 (sharedMeta.count < localState.count，且共享版本已演进 sharedMeta.version > localState.version)：
  if (
    sharedMeta &&
    localState &&
    sharedMeta.version > localState.version &&
    sharedMeta.count < localState.count
  ) {
    let isStaleSnapshot = false;
    const localSnapshots = localState.repoSnapshots;
    const checkSnapshots = rawSnapshots ?? repoSnapshots;

    if (checkSnapshots && localSnapshots) {
      // 多仓库精细化分析：
      // 找出所有在旧记忆中有计数、且在共享元数据中已被降级消除的目标仓库
      const targetRepoIds = Object.keys(localSnapshots).filter((id) => {
        const local = localSnapshots[id];
        const shared = sharedMeta.repoSnapshots?.[id];
        if (!local || local.count <= 0) return false;
        return shared && (shared.count < local.count || (Boolean(shared.revision && local.revision) && shared.revision !== local.revision));
      });

      if (targetRepoIds.length > 0) {
        // 检查这些目标仓库在当前窗口手里的状态：
        // 是否存在某个目标仓库仍然停留在本地旧记忆（revision 和 count 均未刷新到 sharedMeta）
        const hasUnrefreshedTargetRepo = targetRepoIds.some((id) => {
          const current = checkSnapshots[id];
          const local = localSnapshots[id];
          const shared = sharedMeta.repoSnapshots?.[id];
          if (!current || !local || !shared) return false;
          return current.count === local.count &&
                 current.revision === local.revision &&
                 current.branch === local.branch &&
                 (current.revision !== shared.revision || current.count > shared.count);
        });

        // 如果存在未刷新的目标仓库，且当前有效计数没有超过共享基准线：
        if (hasUnrefreshedTargetRepo && currentCount <= sharedMeta.count) {
          isStaleSnapshot = true;
        }
      }
    }

    if (!isStaleSnapshot && (!checkSnapshots || !localSnapshots)) {
      // 兼容单仓库或无 repoSnapshots 模式：
      const hasCountChanged = currentCount !== localState.count;
      const hasRevisionChanged = Boolean(
        revisionSignature &&
        localState.revisionSignature &&
        revisionSignature !== localState.revisionSignature
      );
      const hasEvolved = hasCountChanged || hasRevisionChanged;
      if (!hasEvolved) {
        isStaleSnapshot = true;
      }
    }

    if (isStaleSnapshot) {
      // 保持静默，绝不误报，绝不改写共享存储中的低基准！
      return false;
    }

    // 否则说明当前窗口已脱离旧纪元 (相关仓库已演进刷新)！
    // 当前窗口的本地基线自动对齐为降级后的新共享基线 (例如 0)，作废旧纪元的历史记忆！
    localState = {
      version: sharedMeta.version,
      count: sharedMeta.count,
      revisionSignature: sharedMeta.revisionSignature ?? revisionSignature,
      repoSnapshots: sharedMeta.repoSnapshots ?? repoSnapshots,
    };
    sessionNotifiedStates.set(windowKey, localState);
    sessionNotifiedCounts.set(windowKey, sharedMeta.count);
  }

  const sessionFlagKey = `${currentSessionId ?? ''}:${workspaceId}:${kind}`;
  const hasNotifiedThisSession = kind !== 'conflicts' && (
    sessionNotifiedSessionFlags.has(sessionFlagKey) ||
    Boolean(sharedMeta?.notifiedSessionId && sharedMeta.notifiedSessionId === currentSessionId)
  );

  const effectiveBaseline = sharedCount ?? localState?.count;

  // 首次启动建立基准线：
  if (effectiveBaseline === undefined) {
    const initialVersion = 1;
    sessionNotifiedCounts.set(windowKey, currentCount);
    sessionNotifiedStates.set(windowKey, {
      version: initialVersion,
      count: currentCount,
      revisionSignature,
      repoSnapshots,
    });
    sessionObservedCounts.set(windowKey, currentCount);
    const willNotify = currentCount > 0;
    const notifiedSessionId = willNotify && kind !== 'conflicts' ? currentSessionId : undefined;
    if (willNotify && kind !== 'conflicts') {
      sessionNotifiedSessionFlags.add(sessionFlagKey);
    }
    if (kind !== 'conflicts' && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(key, String(currentCount));
        localStorage.setItem(metaKey, JSON.stringify({
          version: initialVersion,
          count: currentCount,
          sessionId: currentSessionId,
          owner: currentWindowLabel,
          revisionSignature,
          repoSnapshots,
          updatedAt: Date.now(),
          notifiedSessionId,
        }));
      } catch { /* ignore damaged storage */ }
    }
    // 首次启动时若存在未同步提交，对齐插件立即发出通知（本次会话仅提醒一次）：
    return willNotify;
  }

  // 数量未发生增长：
  if (currentCount <= effectiveBaseline) {
    // 若当前计数合法下降 (例如拉取或推送消除)，且当前窗口曾观察到过更高基线，或版本签名已改变证明外部操作：
    const revisionChanged = Boolean(
      sharedMeta?.revisionSignature &&
      revisionSignature &&
      sharedMeta.revisionSignature !== revisionSignature
    );
    if (currentCount < effectiveBaseline && (observedMax >= effectiveBaseline || !sharedMeta || revisionChanged)) {
      const nextVersion = (sharedMeta?.version ?? 0) + 1;
      sessionNotifiedCounts.set(windowKey, currentCount);
      sessionNotifiedStates.set(windowKey, {
        version: nextVersion,
        count: currentCount,
        revisionSignature,
        repoSnapshots,
      });
      sessionObservedCounts.set(windowKey, currentCount);
      if (kind !== 'conflicts' && typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(key, String(currentCount));
          localStorage.setItem(metaKey, JSON.stringify({
            version: nextVersion,
            count: currentCount,
            sessionId: currentSessionId,
            owner: currentWindowLabel,
            revisionSignature,
            repoSnapshots,
            updatedAt: Date.now(),
            notifiedSessionId: sharedMeta?.notifiedSessionId ?? (hasNotifiedThisSession ? currentSessionId : undefined),
          }));
        } catch { /* ignore damaged storage */ }
      }
    }
    return false;
  }

  // 数量严格增加 (currentCount > effectiveBaseline)：
  const nextVersion = (sharedMeta?.version ?? 0) + 1;
  sessionNotifiedCounts.set(windowKey, currentCount);
  sessionNotifiedStates.set(windowKey, {
    version: nextVersion,
    count: currentCount,
    revisionSignature,
    repoSnapshots,
  });
  sessionObservedCounts.set(windowKey, currentCount);

  // 提交通知对齐插件行为：每次启动/当前会话最多提醒一次！
  // 若此前启动时已提醒过，同一会话内后续即使数量再次增长，也不再弹窗打扰用户；
  // 若此前启动时为 0，现在是会话内首次观察到非零提交，则提醒一次并记录当前会话已提醒。
  const willNotify = kind === 'conflicts' || !hasNotifiedThisSession;
  if (willNotify && kind !== 'conflicts') {
    sessionNotifiedSessionFlags.add(sessionFlagKey);
  }
  const currentNotifiedSessionId = (kind !== 'conflicts' && (hasNotifiedThisSession || willNotify))
    ? currentSessionId
    : sharedMeta?.notifiedSessionId;

  if (kind !== 'conflicts' && typeof localStorage !== 'undefined') {
    const sharedSnapshotsToWrite: Record<string, RepoNotificationSnapshot> = { ...repoSnapshots };
    if (sharedMeta?.repoSnapshots) {
      for (const [id, snap] of Object.entries(sharedMeta.repoSnapshots)) {
        if (sharedSnapshotsToWrite[id] && sharedSnapshotsToWrite[id].count <= snap.count && snap.revision) {
          sharedSnapshotsToWrite[id] = {
            ...sharedSnapshotsToWrite[id],
            revision: snap.revision,
          };
        }
      }
    }
    try {
      localStorage.setItem(key, String(currentCount));
      localStorage.setItem(metaKey, JSON.stringify({
        version: nextVersion,
        count: currentCount,
        sessionId: currentSessionId,
        owner: currentWindowLabel,
        revisionSignature,
        repoSnapshots: sharedSnapshotsToWrite,
        updatedAt: Date.now(),
        notifiedSessionId: currentNotifiedSessionId,
      }));
    } catch { /* ignore damaged storage */ }
  }
  return willNotify;
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

const INTERNAL_PROGRESS_PHASES = new Set(['queued', 'waitingForWriteSlot', 'waitingForReadSlot', 'waitingForRepository', 'readingRepository', 'runningRepositoryOperation', 'loadCommits', 'projectPage']);
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

function isCurrentRequest(key: string, controller: AbortController): boolean {
  const current = requestControllers.get(key);
  return !current || current === controller;
}

function endRequest(key: string, controller: AbortController): boolean {
  if (requestControllers.get(key) === controller) {
    requestControllers.delete(key);
    return true;
  }
  return false;
}

function cancelRequests() {
  requestControllers.forEach((controller) => controller.abort());
  requestControllers.clear();
}

const errorText = (error: unknown) => {
  const messages: Record<string, string> = {
    GIT_UPDATE_CONFLICT: 'Update stopped with conflicts or an unfinished version-control operation.',
    SVN_AUTHORIZATION_FAILED: 'This SVN account does not have permission to access the requested repository path.',
    UPSTREAM_MISSING: 'No upstream branch is configured',
  };
  const message = error instanceof BridgeError ? messages[error.code] : undefined;
  return message
    ? createTranslator(resolveLanguage(useAppStore.getState().bootstrap?.state.settings?.language ?? 'system'))(message)
    : error instanceof Error ? error.message : String(error);
};
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
    const available = new Set(repo.files.filter((file) => !file.isTruncated).map((file) => file.path));
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
  let logSession = 0;
  let logGeneration = 0;
  let logTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingLogs: LogEntry[] = [];
  let clearLogPromise: Promise<void> | undefined;
  const commitLogs = (entries: LogEntry[]) => set((state) => {
    const merged = mergeLogEntries(state.logEntries, entries);
    let logStorageError = state.logStorageError;
    for (const entry of entries) {
      if (entry.channel !== 'core') continue;
      if (entry.message === 'Log file writing failed; logs remain available in memory.') logStorageError = entry.details || entry.message;
      if (entry.message === 'Log file writing resumed.') logStorageError = null;
    }
    return {
      logEntries: merged, logStorageError,
      lastReadLogTimestamps: state.logPanelOpen
        ? { ...state.lastReadLogTimestamps, [state.activeTabId ?? '__global__']: Date.now() }
        : state.lastReadLogTimestamps,
      unreadErrorCount: state.logPanelOpen ? 0 : calculateWorkspaceUnreadErrors(
        merged, state.activeTabId, state.tabs, state.lastReadLogTimestamps, state.snapshot?.workspace.paths,
      ),
    };
  });
  const flushLogs = () => {
    if (logTimer) clearTimeout(logTimer);
    logTimer = undefined;
    const entries = pendingLogs;
    pendingLogs = [];
    if (entries.length) commitLogs(entries);
  };
  const resetLogSession = () => {
    logSession++;
    logGeneration++;
    if (logTimer) clearTimeout(logTimer);
    logTimer = undefined;
    pendingLogs = [];
    clearLogPromise = undefined;
  };
  const enqueueLog = (entry: LogEntry) => {
    pendingLogs.push(entry);
    if (pendingLogs.length >= 128) flushLogs();
    else if (!logTimer) logTimer = setTimeout(flushLogs, 40);
  };
  // Shelve/Stash temporarily empties the working tree. Never publish that
  // intermediate status or prune the user's commit selections against it.
  const workingTreeUpdates = new Map<string, { depth: number; epoch: number }>();
  let workingTreeLifecycle = 0;
  const workingTreeRequests = new Map<string, () => void>();
  const remoteWorkingTreeRequests = new Set<string>();
  const updateEpoch = (wid: string) => `${workingTreeLifecycle}:${workingTreeUpdates.get(wid)?.epoch ?? 0}`;
  const updatingWorkingTree = (wid: string) => (workingTreeUpdates.get(wid)?.depth ?? 0) > 0;
  const queueStableRefresh = (wid: string) => {
    if (get().snapshot?.workspace.id !== wid) {
      recordPendingWorkspaceEvent(wid, null, ['workspaceSnapshot']);
      return;
    }
    recordPendingWorkspaceEvent(wid, null, ['workspaceSnapshot']);
    if (watcherTimer) clearTimeout(watcherTimer);
    if (!updatingWorkingTree(wid)) watcherTimer = setTimeout(() => void refreshFromWatcher(), 300);
  };
  const holdWorkingTreeRefresh = (wid: string) => {
    const lifecycle = workingTreeLifecycle;
    const previous = workingTreeUpdates.get(wid) ?? { depth: 0, epoch: 0 };
    workingTreeUpdates.set(wid, { depth: previous.depth + 1, epoch: previous.epoch + 1 });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (lifecycle !== workingTreeLifecycle) return;
      const current = workingTreeUpdates.get(wid);
      if (!current) return;
      workingTreeUpdates.set(wid, { depth: current.depth - 1, epoch: current.epoch + 1 });
      if (current.depth === 1) queueStableRefresh(wid);
    };
  };
  const publishError = (title: string, error: unknown, targetWorkspace?: string, targetRepoId?: string) => {
    const message = errorText(error);
    const repoId = targetRepoId ?? (error instanceof BridgeError ? error.repositoryId : undefined);
    const actions: AppNotificationAction[] = repoId && /index\.lock|git index is busy/i.test(message)
      ? [{ type: 'unlockIndex', label: 'Unlock', repoId }]
      : (error instanceof BridgeError && error.restoreWarning?.conflicted) || /CONFLICT|conflicts|冲突/i.test(message) ? [{ type: 'openConflicts', label: 'Resolve Conflicts' }] : [];
    return get().addNotification({
      type: 'error', title, message: { raw: message }, details: errorDetails(error), workspaceId: targetWorkspace ?? get().snapshot?.workspace.id, actions,
    });
  };
  const notifyUpdateRestoreWarning = async (warning: UpdateRestoreWarning | null | undefined, wid: string, repoId: string) => {
    if (!warning) return;
    const snapshot = get().snapshot?.workspace.id === wid ? get().snapshot : get().sessions[wid]?.snapshot;
    const repository = (get().snapshot?.workspace.id === wid && get().allRepositories.length ? get().allRepositories : snapshot?.repositories)?.find((repo) => repo.meta.id === repoId);
    get().addNotification({
      type: 'warning', title: 'VersionDock', workspaceId: wid, actions: [],
      message: warning.shelf
        ? { key: 'VersionDock [{0}]: Conflicts detected while restoring local changes. Shelve backup has been retained: "{1}".', args: [repository?.meta.name ?? repoId, warning.backupName] }
        : { key: 'VersionDock [{0}]: Conflicts detected while restoring stashed changes.', args: [repository?.meta.name ?? repoId] },
      details: warning.details,
    });
    await Promise.all([
      warning.shelf ? get().loadShelves(repoId, wid) : get().loadStashes(repoId, wid),
      ...(get().snapshot?.workspace.id === wid ? [get().refresh(true)] : []),
    ]);
  };
  const handlePullAutoStashError = async (error: unknown, targetWorkspace?: string): Promise<boolean> => {
    if (!(error instanceof BridgeError) || error.restoreWarning || ![
      'GIT_PULL_CONFLICT_WITH_AUTO_STASH',
      'GIT_AUTO_STASH_CONFLICT',
      'GIT_PULL_FAILED_RESTORE_FAILED',
      'GIT_AUTO_STASH_RESTORE_FAILED',
      'GIT_AUTO_SHELF_RESTORE_FAILED',
    ].includes(error.code)) return false;
    const shelfBackup = error.code === 'GIT_AUTO_SHELF_RESTORE_FAILED';
    const conflicted = shelfBackup || error.code === 'GIT_PULL_CONFLICT_WITH_AUTO_STASH' || error.code === 'GIT_AUTO_STASH_CONFLICT';
    const workspace = targetWorkspace ?? get().snapshot?.workspace.id;
    const repository = error.repositoryId;
    const hash = error.subject?.startsWith('stash:') ? error.subject.slice('stash:'.length) : undefined;
    const repositoryName = (workspace === get().snapshot?.workspace.id ? get().snapshot : workspace ? get().sessions[workspace]?.snapshot : undefined)?.repositories.find((repo) => repo.meta.id === repository)?.meta.name ?? repository ?? '';
    const shelfName = error.message.match(/retained: "([^"]+)"/)?.[1] ?? error.subject?.replace(/^shelf:/, '') ?? '';
    if (conflicted && workspace && repository && hash) {
      pendingPullAutoStashes.set(`${workspace}\0${repository}`, { hash, shortHash: hash.slice(0, 12), prompted: false });
    }
    get().addNotification({
      type: 'warning',
      urgent: true,
      title: conflicted ? 'Restoring local changes needs attention' : 'Automatic stash recovery needs attention',
      message: shelfBackup
        ? { key: 'VersionDock [{0}]: Conflicts detected while restoring local changes. Shelve backup has been retained: "{1}".', args: [repositoryName, shelfName] }
        : conflicted && repositoryName
          ? { key: 'VersionDock [{0}]: Conflicts detected while restoring stashed changes.', args: [repositoryName] }
          : { raw: error.message },
      details: errorDetails(error),
      workspaceId: workspace,
      actions: [{ type: conflicted ? 'openConflicts' : 'openStash', label: conflicted ? 'Open Conflicts' : 'Open Stash' }, ...(shelfBackup ? [{ type: 'openShelf' as const, label: 'Open Shelf' }] : [])],
    });
    if (repository && workspace) {
      if (shelfBackup) await get().loadShelves(repository, workspace);
      else await get().loadStashes(repository, workspace);
    }
    const isCurrentWorkspace = !workspace || workspace === get().snapshot?.workspace.id;
    if (isCurrentWorkspace) {
      await get().refresh(true);
      get().setActiveTab(conflicted ? 'changes' : 'stash');
    }
    return true;
  };
  const promptPendingAutoStashCleanup = () => {
    const workspace = get().snapshot?.workspace.id;
    if (!workspace) return;
    for (const [key, pending] of pendingPullAutoStashes) {
      const [pendingWorkspace, repoId] = key.split('\0');
      if (pendingWorkspace !== workspace || pending.prompted) continue;
      const repository = get().snapshot?.repositories.find((repo) => repo.meta.id === repoId);
      if (!repository || repository.conflicts > 0 || repository.operation) continue;
      const stash = get().stashes[repoId]?.find((entry) => entry.hash === pending.hash);
      if (!stash) {
        pendingPullAutoStashes.delete(key);
        continue;
      }
      pending.prompted = true;
      get().addNotification({
        type: 'info',
        title: 'Automatic stash recovery completed',
        message: { key: 'VersionDock [{0}]: All restore conflicts are resolved. Delete auto-stash backup {1}?', args: [repository.meta.name, pending.shortHash] },
        workspaceId: workspace,
        actions: [
          { type: 'dropAutoStash', label: 'Delete Backup', workspaceId: workspace, repoId, hash: pending.hash },
          { type: 'keepAutoStash', label: 'Keep in Stash', workspaceId: workspace, repoId, hash: pending.hash },
        ],
      });
    }
  };
  const notifyBatchFailures = (results: RepositoryOperationResult[], report?: BatchCommitReport, targetWorkspaceId?: string) => {
    const failures = results.filter((result) => result.error);
    if (!failures.length) return;
    const wid = targetWorkspaceId ?? report?.workspaceId ?? get().snapshot?.workspace.id;
    const t = createTranslator(resolveLanguage(settings().language));
    const repositories = (wid ? get().sessions[wid]?.snapshot.repositories : undefined) ?? get().snapshot?.repositories ?? [];
    const repositoryName = (repoId: string) => repositories.find((repo) => repo.meta.id === repoId)?.meta.name ?? repoId;
    get().addNotification({
      type: 'warning',
      urgent: true,
      title: 'Commit completed with failures',
      message: { key: 'VersionDock: {0} error(s): {1}', args: [failures.length, failures.map((result) => result.error?.message ?? result.repoId).join('; ')] },
      details: failures.map((result) => {
        const stage = result.failedStage ? t('Failed stage: {0}', t(batchFailedStageLabels[result.failedStage] ?? result.failedStage)) : '';
        return [`${repositoryName(result.repoId)}${stage ? ` · ${stage}` : ''}`, result.error?.message, result.recoveryHint ? t(result.recoveryHint) : undefined].filter(Boolean).join('\n');
      }).join('\n\n'),
      workspaceId: wid,
      actions: failures.map((result) => ({
        type: 'retryBatchResult' as const,
        label: { raw: `${repositoryName(result.repoId)}: ${t(result.committed ? 'Retry push' : 'Retry repository')}` },
        repoId: result.repoId,
        reportId: report?.id,
        workspaceId: wid,
      })),
    });
  };
  const ensureRepositoryCapability = (repoId: string, key: string, targetWorkspaceId?: string) => {
    const repository = get().snapshot?.repositories.find((item) => item.meta.id === repoId);
    if (!repository || capabilityAvailable(repository.capabilities, key, true)) return true;
    get().addNotification({
      type: 'warning',
      title: 'Operation unavailable',
      message: { raw: capabilityReason(repository.capabilities, key) ?? 'Operation is unavailable for this repository' },
      workspaceId: targetWorkspaceId ?? get().snapshot?.workspace.id,
    });
    return false;
  };
  const withBusy = async <T>(
    operation: () => Promise<T>,
    domain = 'workspace',
    target?: { repositoryId?: string | null; target?: string | null; workspaceId?: string | null; remote?: string | null; branch?: string | null },
    options?: { rethrow?: boolean; notifyError?: boolean; trackBusy?: boolean },
  ): Promise<T | undefined> => {
    const operationId = `client-${Date.now()}-${++localOperationSequence}`;
    const context = { ...operationContext(domain, get()), ...target, visibility: 'background' as const };
    if (options?.trackBusy !== false) set((state) => ({
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
      if (!isAbortError(error) && options?.notifyError !== false) {
        const msg = errorText(error);
        const domainTitle: Record<string, string> = {
          branch: 'Branch operation failed', tag: 'Tag operation failed', commit: 'Commit failed', sync: 'Sync failed',
          conflict: 'Conflict operation failed', stash: 'Stash operation failed', shelf: 'Shelf operation failed',
          changelist: 'Changelist operation failed', worktree: 'Worktree operation failed', subtree: 'Subtree operation failed',
          submodule: 'Submodule operation failed', remote: 'Remote operation failed', identity: 'Identity operation failed',
          svnAccount: 'SVN account operation failed', history: 'History operation failed', system: 'System operation failed',
          workspace: 'Workspace operation failed', repository: 'Repository operation failed', application: 'Application operation failed',
        };
        const repoId = error instanceof BridgeError ? error.repositoryId ?? context.repositoryId : context.repositoryId;
        const actions: AppNotificationAction[] = [];
        if (repoId && /\[rejected\]|non-fast-forward|fetch first|PUSH_REJECTED/i.test(`${msg} ${error instanceof BridgeError ? error.code : ''}`) && settings().onPushRejected !== 'error') {
          const merge = settings().updateProjectMethod === 'merge';
          actions.push({ type: 'recoverPush', label: merge ? 'Merge & Push' : 'Rebase & Push', repoId, strategy: merge ? 'merge' : 'rebase', remote: target?.remote, branch: target?.branch }, { type: 'recoverPush', label: 'Force Push', repoId, strategy: 'force', remote: target?.remote, branch: target?.branch });
        } else if (repoId && /index\.lock|git index is busy/i.test(msg)) {
          actions.push({ type: 'unlockIndex', label: 'Unlock', repoId });
        } else if (/CONFLICT|could not apply|conflicts|冲突/i.test(msg)) {
          actions.push({ type: 'openConflicts', label: 'Resolve Conflicts' });
          if (repoId && context.workspaceId) {
            const status = await bridge().request<RepositoryStatus>({ type: 'repositoryStatus', payload: { workspace_id: context.workspaceId, repo_id: repoId } }, { showProgress: false }).catch(() => undefined);
            if (status?.operation && ['cherry-pick', 'revert', 'rebase', 'merge'].includes(status.operation)) {
              actions.push({ type: 'continueOperation', label: 'Continue', repoId, operation: status.operation, revision: status.revision });
              if (status.operation === 'cherry-pick') actions.push({ type: 'skipOperation', label: 'Skip', repoId, operation: status.operation, revision: status.revision });
              actions.push({ type: 'abortOperation', label: 'Abort', repoId, operation: status.operation, revision: status.revision });
            }
          }
        }
        get().addNotification({
          type: 'error',
          actions,
          title: domainTitle[domain.split(':', 1)[0]] ?? 'Operation failed',
          message: { raw: msg },
          details: errorDetails(error),
          workspaceId: context.workspaceId ?? get().snapshot?.workspace.id,
        });
      }
      if (options?.rethrow) throw error;
      return undefined;
    } finally {
      if (options?.trackBusy !== false) set((state) => {
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

  const enrichCommitBranches = async (wid: string, key: string, detail: CommitDetail) => {
    const requestKey = `commit-branches:${wid}:${key}`;
    if (requestControllers.has(requestKey)) return;
    const controller = beginRequest(requestKey);
    try {
      const branches = await bridge().request<CommitBranches>({
        type: 'commitBranches',
        payload: { workspace_id: wid, repo_id: detail.commit.repoId, revision: detail.commit.hash },
      }, { signal: controller.signal, showProgress: false });
      if (controller.signal.aborted || !isCurrentRequest(requestKey, controller)) return;
      set(state => {
        const active = state.snapshot?.workspace.id === wid;
        const session = state.sessions[wid];
        const target = active ? state : session;
        // A newer file request may have replaced this detail while refs loaded.
        if (!target || target.selectedCommitDetails[key] !== detail) return {};
        const enriched: CommitDetail = {
          ...detail, branchesPending: false,
          branches: {
            local: [...new Set([...detail.branches.local, ...branches.local])],
            remote: [...new Set([...detail.branches.remote, ...branches.remote])],
            tags: [...new Set([...detail.branches.tags, ...branches.tags])],
            isHead: branches.isHead ?? detail.branches.isHead,
          },
        };
        const patch = {
          selectedCommitDetails: { ...target.selectedCommitDetails, [key]: enriched },
          selectedCommit: target.selectedPrimaryKey === key ? enriched : target.selectedCommit,
        };
        return active ? patch : { sessions: { ...state.sessions, [wid]: { ...session, ...patch } } };
      });
    } catch {
      // Supplementary refs must never erase loaded files or publish an error
      // toast. A cached partial detail can retry this query on the next visit.
    } finally { endRequest(requestKey, controller); }
  };

  const settings = () => get().bootstrap?.state.settings ?? emptyState.settings!;
  const layout = () => get().bootstrap?.state.layout ?? emptyState.layout!;

  const persistCommitSelections = (workspaceId: string, selections: Record<string, string[]>) => {
    const existing = commitSelectionSaveTimers.get(workspaceId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      commitSelectionSaveTimers.delete(workspaceId);
      const values = Object.entries(selections).map(([repoId, paths]) => ({ repoId, paths }));
      get().bridge?.send({ type: 'saveCommitSelections', payload: { workspace_id: workspaceId, selections: values } });
    }, 120);
    commitSelectionSaveTimers.set(workspaceId, timer);
    const current = get().bootstrap;
    if (current) set({ bootstrap: { ...current, state: { ...current.state, commitSelections: { ...(current.state.commitSelections ?? {}), [workspaceId]: Object.entries(selections).map(([repoId, paths]) => ({ repoId, paths })) } } } });
  };
  const clearCommittedSelections = (repoIds: string[], targetWorkspaceId?: string) => {
    const activeWid = get().snapshot?.workspace.id;
    const wid = targetWorkspaceId ?? activeWid;
    if (!wid) return;

    if (activeWid === wid) {
      const commitSelections = { ...get().commitSelections };
      repoIds.forEach((repoId) => delete commitSelections[repoId]);
      set((state) => ({
        commitSelections,
        sessions: state.sessions[wid]
          ? { ...state.sessions, [wid]: { ...state.sessions[wid], commitSelections } }
          : state.sessions,
      }));
      persistCommitSelections(wid, commitSelections);
    } else {
      const cached = get().sessions[wid];
      const selections = { ...(cached?.commitSelections ?? {}) };
      repoIds.forEach((repoId) => delete selections[repoId]);
      set((state) => ({
        sessions: {
          ...state.sessions,
          [wid]: state.sessions[wid]
            ? { ...state.sessions[wid], commitSelections: selections }
            : { ...cached, commitSelections: selections } as WorkspaceSessionState,
        },
      }));
      persistCommitSelections(wid, selections);
    }
  };

  let autoFetchController: AbortController | undefined;
  const backgroundFetch = async () => {
    const owner = bridge();
    const wid = get().snapshot?.workspace.id;
    if (!wid || autoFetchController || isOperationActive(get().operations, { workspaceId: wid })) return;
    const repositories = get().allRepositories.length ? get().allRepositories : get().snapshot?.repositories ?? [];
    const repos = repositories.filter((repo) => repo.meta.kind === 'git' && !repo.meta.isWorktree);
    if (!repos.length) return;
    const leaseName = `auto-fetch:${wid}`;
    if (!claimSchedulerLease(leaseName, 60_000)) return;
    const controller = new AbortController();
    autoFetchController = controller;
    const renewLease = setInterval(() => { claimSchedulerLease(leaseName, 60_000); }, 20_000);
    const stopRenewal = () => clearInterval(renewLease);
    controller.signal.addEventListener('abort', stopRenewal, { once: true });
    try {
      await Promise.allSettled(repos.map((repo) => owner.request({ type: 'sync', payload: { workspace_id: wid, repo_id: repo.meta.id, action: 'fetch', remote: null, branch: null, force: false } }, { showProgress: false, timeoutMs: 600_000, signal: controller.signal })));
      if (!controller.signal.aborted && get().bridge === owner && get().snapshot?.workspace.id === wid) await get().refresh(true);
    } catch (error) {
      console.debug('Background fetch refresh skipped', error);
    } finally { stopRenewal(); controller.signal.removeEventListener('abort', stopRenewal); if (autoFetchController === controller) autoFetchController = undefined; }
  };
  const restartAutoRefresh = () => {
    if (autoFetchTimer) clearInterval(autoFetchTimer);
    autoFetchTimer = undefined;
    const minutes = settings().autoFetchIntervalMinutes ?? 15;
    if (minutes > 0) autoFetchTimer = setInterval(() => void backgroundFetch(), minutes * 60_000);
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = undefined;
    const seconds = settings().autoRefreshInterval;
    if (seconds > 0) autoRefreshTimer = setInterval(() => {
      const state = get();
      if (state.snapshot && claimSchedulerLease(`auto-refresh:${state.snapshot.workspace.id}`, Math.max(2_000, seconds * 1_500)) && !isOperationActive(state.operations, { workspaceId: state.snapshot.workspace.id, domain: 'workspace' })) void state.refresh(true);
    }, seconds * 1000);
  };

  let settingsWriter: { bridge: VersionDockBridge; writer: SettingsWriter } | undefined;
  const updateSettings = async (patch: Partial<DesktopSettings>) => {
    const bootstrap = get().bootstrap; if (!bootstrap) return;
    const owner = bridge();
    if (settingsWriter?.bridge !== owner) {
      const active = () => get().bridge === owner && Boolean(get().bootstrap) && settingsWriter?.writer === writer;
      const writer: SettingsWriter = new SettingsWriter(settings(),
        (next, changed_fields) => active() ? owner.request<SettingsUpdateResult>({ type: 'updateSettings', payload: { settings: next, changed_fields } }) : Promise.reject(new Error('Settings session closed')),
        (next) => {
          if (!active()) return;
          set((state) => ({
            bootstrap: { ...state.bootstrap!, state: { ...state.bootstrap!.state, settings: next } },
            snapshot: state.snapshot ? projectSnapshot(state.snapshot, state.allRepositories, next) : undefined,
          }));
          if (!get().snapshot?.repositories.some((repo) => repo.meta.id === get().selectedRepoId)) {
            set({ selectedRepoId: get().snapshot?.repositories[0]?.meta.id });
          }
        },
        async (result) => {
          if (!active()) return;
          if (result.effects.rescanWorkspace && get().snapshot) await get().refresh();
          else if (result.effects.reloadHistory) await get().loadHistory(true);
          if (result.effects.restartAutoRefresh) restartAutoRefresh();
        },
        (error) => { if (active()) publishError('Settings update failed', error); },
      );
      settingsWriter = { bridge: owner, writer };
    }
    await settingsWriter.writer.update(patch);
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
      diffReturnMode: state.diffReturnMode,
      diff: state.diff,
      changesDiff: state.changesDiff,
      changesDiffLoading: false,
      changesDiffError: state.changesDiffError,
      changesDiffTarget: state.changesDiffTarget,
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
      commitSelectionAnchorKey: state.commitSelectionAnchorKey,
      selectedCommitDetails: state.selectedCommitDetails,
      selectedCommitLoading: state.selectedCommitLoading,
      selectedCommitError: state.selectedCommitError,
      mergeCommits: state.mergeCommits,
      mergeCommitsLoading: state.mergeCommitsLoading,
      mergeParentFiles: state.mergeParentFiles,
      mergeParentFilesLoading: state.mergeParentFilesLoading,
      mergeParentFilesError: state.mergeParentFilesError,
      branches: state.branches,
      tags: state.tags,
      branchesByRepo: state.branchesByRepo,
      tagsByRepo: state.tagsByRepo,
      conflicts: state.conflicts,
      merge: state.merge,
      mergeTarget: state.mergeTarget,
      mergeResolutions: state.mergeResolutions,
      mergeScope: state.mergeScope,
      mergeResult: state.mergeResult,
      mergeEditorDraft: state.mergeEditorDraft,
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
      incomingCommits: state.incomingCommits,
      comparisonTarget: state.comparisonTarget,
      comparison: state.comparison,
      remotes: state.remotes,
      loadErrors: state.loadErrors,
      batchCommitReport: (!state.batchCommitReport?.workspaceId || state.batchCommitReport.workspaceId === state.snapshot.workspace.id)
        ? state.batchCommitReport
        : undefined,
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

  const notifyNewUntrackedFiles = (
    previousRepositories: RepositoryStatus[],
    nextRepositories: RepositoryStatus[],
    targetWorkspaceId: string,
  ) => {
    const preferences = settings();
    if (!preferences.promptBeforeAddingUntracked || preferences.changesDisplayMode === 'simplified') return;
    const previousByRepo = new Map(previousRepositories.map((repo) => [
      repo.meta.id,
      new Set(repo.files.filter((file) => file.status === 'untracked').map((file) => file.path)),
    ]));
    const newFiles = nextRepositories.flatMap((repo) => {
      const previous = previousByRepo.get(repo.meta.id);
      if (!previous) return [];
      return repo.files
        .filter((file) => file.status === 'untracked' && !previous.has(file.path))
        .map((file) => ({ repoId: repo.meta.id, path: file.path, kind: repo.meta.kind }));
    });
    if (!newFiles.length) return;
    const kind = newFiles.some((file) => file.kind === 'svn') ? 'SVN' : 'Git';
    const message: NotificationText = newFiles.length === 1
      ? { key: 'Do you want to add "{0}" to {1}?', args: [newFiles[0].path, kind] }
      : { key: 'Do you want to add {0} new files to {1}?', args: [newFiles.length, kind] };
    get().addNotification({
      type: 'info',
      title: 'Prompt before adding untracked files',
      message,
      workspaceId: targetWorkspaceId,
      actions: [{ type: 'addUntracked', label: 'Add', files: newFiles.map(({ repoId, path }) => ({ repoId, path })) }],
    });
  };

  const notifyGoneBranches = (repoId: string, branches: BranchInfo[], wid: string) => {
    const refs = new Set(branches.filter((branch) => branch.remote).map((branch) => branch.name));
    const gone = branches.filter((branch) => !branch.remote && !branch.current && branch.upstream && !refs.has(branch.upstream)).map((branch) => branch.name);
    if (!gone.length || get().notifications.some((item) => item.workspaceId === wid && item.actions.some((action) => action.type === 'pruneBranches' && action.repoId === repoId && action.branches.join('\0') === gone.join('\0')))) return;
    const current = get().snapshot?.workspace.id === wid ? get().snapshot : get().sessions[wid]?.snapshot;
    const repoName = current?.repositories.find((repo) => repo.meta.id === repoId)?.meta.name ?? repoId;
    get().addNotification({
      type: 'info', title: 'Prune Branches', workspaceId: wid,
      message: { key: 'VersionDock [{0}]: {1} local branches have deleted remote tracking branches.', args: [repoName, gone.length] },
      actions: [{ type: 'pruneBranches', label: 'Prune Branches', repoId, branches: gone }, { type: 'dismiss', label: 'Dismiss' }],
    });
  };

  const notifyDetachedCommit = async (repoId: string, wid: string) => {
    const status = await bridge().request<RepositoryStatus>({ type: 'repositoryStatus', payload: { workspace_id: wid, repo_id: repoId } }, { showProgress: false });
    if (status.meta?.kind !== 'git' || !(status.branch === 'HEAD' || status.branch.startsWith('HEAD (')) || !status.revision) return;
    get().addNotification({
      type: 'warning', title: 'Detached HEAD', workspaceId: wid,
      message: { key: 'VersionDock [{0}]: You have committed to a detached HEAD. Create a new branch to keep these changes?', args: [status.meta.name] },
      actions: [{ type: 'createBranch', label: 'Create Branch', repoId, revision: status.revision }, { type: 'dismiss', label: 'Dismiss' }],
    });
  };
  const notifyResolvedOperations = (repositories: RepositoryStatus[], wid: string) => {
    for (const repo of repositories) {
      if (repo.meta.kind !== 'git' || repo.conflicts || !repo.operation || !['merge', 'rebase', 'cherry-pick', 'revert'].includes(repo.operation)) continue;
      if (repo.operation === 'merge' && (settings().autoCommitResolvedMerge ?? true)) continue;
      if (get().notifications.some((item) => item.workspaceId === wid && item.actions.some((action) => (action.type === 'continueOperation' || action.type === 'abortOperation') && action.repoId === repo.meta.id && action.operation === repo.operation && action.revision === repo.revision))) continue;
      const operation = repo.operation;
      const label = operation === 'merge' ? 'Merge' : operation === 'rebase' ? 'Rebase' : operation === 'cherry-pick' ? 'Cherry-pick' : 'Revert';
      get().addNotification({
        type: 'info', title: 'All conflicts resolved', workspaceId: wid,
        message: { key: operation === 'merge' ? 'VersionDock [{0}]: All conflicts resolved. Complete merge commit?' : operation === 'rebase' ? 'VersionDock [{0}]: All conflicts resolved. Continue rebase?' : operation === 'cherry-pick' ? 'VersionDock [{0}]: All conflicts resolved. Continue cherry-pick?' : 'VersionDock [{0}]: All conflicts resolved. Continue revert?', args: [repo.meta.name] },
        actions: [
          { type: 'continueOperation', label: operation === 'merge' ? 'Commit Merge' : `Continue ${label}`, repoId: repo.meta.id, operation, revision: repo.revision },
          { type: 'abortOperation', label: `Abort ${label}`, repoId: repo.meta.id, operation, revision: repo.revision },
        ],
      });
    }
  };

  const checkStatusNotifications = (allRepositories: RepositoryStatus[], workspaceId: string) => {
    const preferences = settings();
    const workspaceNotification = { workspaceId };
    const conflictCount = allRepositories.reduce((sum, repo) => sum + repo.conflicts, 0);
    const shouldNotifyConflicts = shouldNotifyStatusCount(workspaceId, 'conflicts', conflictCount);
    if (conflictCount > 0 && shouldNotifyConflicts) {
      get().addNotification({
        ...workspaceNotification,
        type: 'warning',
        urgent: true,
        title: 'Merge conflicts detected',
        message: 'VersionDock: Merge conflicts detected. Use the Merge Editor to resolve them.',
        actions: [{ type: 'openConflicts', label: 'Open Conflict List' }],
      });
    }

    const gitRevisionSignature = getRepositoriesRevisionSignature(allRepositories);

    if (!startupFetchPending) {
      const sharedIncomingMeta = getSharedNotificationMeta(workspaceId, 'incoming');
      const localIncomingState = getLocalNotificationState(workspaceId, 'incoming');
      const {
        effectiveRepositories: incomingRepos,
        totalCount: totalBehind,
        repoSnapshots: incomingSnapshots,
        rawSnapshots: incomingRawSnapshots,
      } = reconcileRepositoryStatuses(allRepositories, 'incoming', sharedIncomingMeta, localIncomingState);

      const shouldNotifyIncoming = shouldNotifyStatusCount(
        workspaceId,
        'incoming',
        totalBehind,
        undefined,
        gitRevisionSignature,
        incomingSnapshots,
        incomingRawSnapshots,
      );
      if (preferences.notifyIncomingCommits && totalBehind > 0 && shouldNotifyIncoming) {
        const singleRepo = incomingRepos.length === 1 ? incomingRepos[0] : undefined;
        const singleRepoName = singleRepo?.meta.name;
        const message: NotificationText = singleRepoName
          ? {
              key: totalBehind === 1
                ? 'VersionDock [{0}]: {1} incoming commit available to update.'
                : 'VersionDock [{0}]: {1} incoming commits available to update.',
              args: [singleRepoName, totalBehind],
            }
          : {
              key: totalBehind === 1
                ? 'VersionDock: {0} incoming commit across {1} repository to update.'
                : 'VersionDock: {0} incoming commits across {1} repositories to update.',
              args: [totalBehind, incomingRepos.length],
            };
        get().addNotification({
          ...workspaceNotification,
          type: 'info',
          title: 'Incoming Commits',
          message,
          actions: [
            { type: 'updateProject', label: 'Update' },
            { type: 'dismiss', label: 'Dismiss' },
            { type: 'disableIncoming', label: "Don't show again" },
          ],
        });
      }
    }

    const sharedUnpushedMeta = getSharedNotificationMeta(workspaceId, 'unpushed');
    const localUnpushedState = getLocalNotificationState(workspaceId, 'unpushed');
    const {
      effectiveRepositories: unpushedRepos,
      totalCount: totalAhead,
      repoSnapshots: unpushedSnapshots,
      rawSnapshots: unpushedRawSnapshots,
    } = reconcileRepositoryStatuses(allRepositories, 'unpushed', sharedUnpushedMeta, localUnpushedState);

    const shouldNotifyUnpushed = shouldNotifyStatusCount(
      workspaceId,
      'unpushed',
      totalAhead,
      undefined,
      gitRevisionSignature,
      unpushedSnapshots,
      unpushedRawSnapshots,
    );
    if (preferences.notifyUnpushedCommits && totalAhead > 0 && shouldNotifyUnpushed) {
      const singleRepo = unpushedRepos.length === 1 ? unpushedRepos[0] : undefined;
      const singleRepoName = singleRepo?.meta.name;
      const message: NotificationText = singleRepoName
        ? {
            key: totalAhead === 1
              ? 'VersionDock [{0}]: {1} unpushed commit ready to push.'
              : 'VersionDock [{0}]: {1} unpushed commits ready to push.',
            args: [singleRepoName, totalAhead],
          }
        : {
            key: totalAhead === 1
              ? 'VersionDock: {0} unpushed commit across {1} repository.'
              : 'VersionDock: {0} unpushed commits across {1} repositories.',
            args: [totalAhead, unpushedRepos.length],
          };
      get().addNotification({
        ...workspaceNotification,
        type: 'info',
        title: 'Unpushed Commits',
        message,
        actions: [
          { type: 'openPush', label: 'Go to Push' },
          { type: 'dismiss', label: 'Dismiss' },
        ],
      });
    }
  };

  const applySnapshot = async (snapshot: WorkspaceSnapshot, reloadRepository = true, silent = false) => {
    if (updatingWorkingTree(snapshot.workspace.id)) {
      queueStableRefresh(snapshot.workspace.id);
      return;
    }
    const current = get().snapshot;
    if (current?.workspace.id === snapshot.workspace.id && current.generation > snapshot.generation) return;
    const workspaceChanged = current?.workspace.id !== snapshot.workspace.id;
    const allRepositories = snapshot.repositories;
    if (!workspaceChanged) notifyNewUntrackedFiles(get().allRepositories, allRepositories, snapshot.workspace.id);
    const visibleSnapshot = projectSnapshot(snapshot, allRepositories, settings());
    const storedSelections = workspaceChanged
      ? selectionRecord(get().bootstrap?.state.commitSelections?.[snapshot.workspace.id])
      : get().commitSelections;
    const commitSelections = pruneCommitSelections(allRepositories, storedSelections);
    const selectedRepoId = visibleSnapshot.repositories.some((repo) => repo.meta.id === get().selectedRepoId)
      ? get().selectedRepoId : visibleSnapshot.repositories[0]?.meta.id;
    set(workspaceChanged
      ? { snapshot: visibleSnapshot, allRepositories, selectedRepoId, selectedFile: undefined, fileHistoryTarget: undefined, historyFilter: '', historyQuery: { ...EMPTY_HISTORY_QUERY }, diff: undefined, changesDiff: undefined, changes: undefined, merge: undefined, mergeTarget: undefined, mergeEditorDraft: undefined, mergeResolutions: {}, mergeScope: 'all', mergeResult: '', commitMessage: '', mergeMessageSuggestion: undefined, amendRepoIds: [], commitSelections, comparisonTarget: undefined, comparison: undefined, mode: 'history', history: [], historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, subtrees: {}, submodules: {}, worktrees: {}, stashes: {}, shelves: {}, changelists: {}, remotes: {}, unpushedCommits: {}, incomingCommits: {}, selectedCommits: [], selectedPrimaryKey: undefined, commitSelectionAnchorKey: undefined, selectedCommit: undefined, selectedCommitDetails: {}, selectedCommitLoading: {}, selectedCommitError: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, loadErrors: {} }
      : { snapshot: visibleSnapshot, allRepositories, selectedRepoId, commitSelections });
    if (JSON.stringify(commitSelections) !== JSON.stringify(storedSelections)) persistCommitSelections(snapshot.workspace.id, commitSelections);
    checkStatusNotifications(allRepositories, snapshot.workspace.id);
    notifyResolvedOperations(allRepositories, snapshot.workspace.id);
    if (selectedRepoId && (workspaceChanged || reloadRepository)) await get().selectRepo(selectedRepoId, true);
    const requests: Promise<void>[] = [get().loadConflicts(silent)];
    if (workspaceChanged || reloadRepository) requests.push(get().loadStashes(), get().loadShelves(), get().loadWorktrees(), get().loadSubtrees(), get().loadSubmodules(), get().loadUnpushedCommits(), get().loadIncomingCommits());
    await Promise.all(requests);
    promptPendingAutoStashCleanup();
    drainPendingWorkspaceEvents(snapshot.workspace.id);
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
    const pageGen = historyPageGeneration;
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
    if (get().snapshot?.workspace.id !== workspaceId || historyPageGeneration !== pageGen) return;
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
    const workspaceId = get().snapshot?.workspace.id;
    if (!workspaceId || updatingWorkingTree(workspaceId)) return;
    if (watcherRefreshInFlight) {
      watcherRefreshQueued = true;
      return;
    }
    const pending = pendingWorkspaceEvents.get(workspaceId);
    if (!pending?.size) return;
    pendingWorkspaceEvents.delete(workspaceId);
    watcherRefreshInFlight = true;
    const requestGeneration = workspaceRequestGeneration;
    const lifecycle = workingTreeLifecycle;
    const epoch = updateEpoch(workspaceId);
    const interrupted = () => {
      if (lifecycle !== workingTreeLifecycle) return true;
      const workspaceChanged = get().snapshot?.workspace.id !== workspaceId || requestGeneration !== workspaceRequestGeneration;
      const workingTreeChanged = updatingWorkingTree(workspaceId) || updateEpoch(workspaceId) !== epoch;
      if (!workspaceChanged && !workingTreeChanged) return false;
      if (get().snapshot?.workspace.id === workspaceId || get().tabs.some((tab) => tab.id === workspaceId)) {
        for (const [repoId, scopes] of pending) recordPendingWorkspaceEvent(workspaceId, repoId || null, [...scopes]);
        drainPendingWorkspaceEvents(workspaceId);
        if (workingTreeChanged) queueStableRefresh(workspaceId);
      }
      return true;
    };
    try {
      const refreshSnapshot = [...pending.values()].some((scopes) => scopes.has('workspaceSnapshot'));
      if (refreshSnapshot) {
        await get().refresh(true);
        if (interrupted()) return;
      }
      for (const [repoId, scopes] of pending) {
        if (interrupted()) return;
        // Events may outlive a repository removal or a rescan. Never query a
        // repository that is absent from this workspace's current inventory.
        if (!repoId || !get().allRepositories.some((repo) => repo.meta.id === repoId)) continue;
        if (!refreshSnapshot && (scopes.has('status') || scopes.has('index') || scopes.has('operation') || scopes.has('svnRevision') || scopes.has('refs'))) {
          const status = await bridge().request<RepositoryStatus>(
            { type: 'repositoryStatus', payload: { workspace_id: workspaceId, repo_id: repoId } },
            { showProgress: false },
          );
          if (interrupted()) return;
          if (!get().allRepositories.some((repo) => repo.meta.id === repoId)) continue;
          const previous = get().allRepositories.find((repo) => repo.meta.id === repoId);
          if (previous) notifyNewUntrackedFiles([previous], [status], workspaceId);
          set((state) => {
            const allRepositories = state.allRepositories.map((repo) => repo.meta.id === repoId ? status : repo);
            return {
              allRepositories,
              snapshot: state.snapshot ? projectSnapshot({ ...state.snapshot, repositories: allRepositories }, allRepositories, settings()) : undefined,
            };
          });
          checkStatusNotifications(get().allRepositories, workspaceId);
        }
        if (scopes.has('refs') || scopes.has('history')) {
          const [branchesResult, tagsResult] = await Promise.allSettled([
            bridge().request<BranchInfo[]>({ type: 'branches', payload: { workspace_id: workspaceId, repo_id: repoId } }, { showProgress: false, timeoutMs: 12_000 }),
            bridge().request<TagInfo[]>({ type: 'tags', payload: { workspace_id: workspaceId, repo_id: repoId } }, { showProgress: false, timeoutMs: 12_000 }),
          ]);
          if (interrupted()) return;
          if (!get().allRepositories.some((repo) => repo.meta.id === repoId)) continue;
          set((state) => ({
            branchesByRepo: branchesResult.status === 'fulfilled' ? { ...state.branchesByRepo, [repoId]: branchesResult.value } : state.branchesByRepo,
            tagsByRepo: tagsResult.status === 'fulfilled' ? { ...state.tagsByRepo, [repoId]: tagsResult.value } : state.tagsByRepo,
            branches: state.selectedRepoId === repoId && branchesResult.status === 'fulfilled' ? branchesResult.value : state.branches,
            tags: state.selectedRepoId === repoId && tagsResult.status === 'fulfilled' ? tagsResult.value : state.tags,
          }));
          if (!get().historyLoading) await refreshHistoryRepository(workspaceId, repoId);
        }
        if (interrupted()) return;
        if (scopes.has('unpushed') || scopes.has('refs')) {
          const repo = get().snapshot?.repositories.find((item) => item.meta.id === repoId);
          if (repo?.meta.kind === 'git') await Promise.all([
            get().loadUnpushedCommits(repoId), get().loadIncomingCommits(repoId),
            ...(scopes.has('refs') ? [get().loadStashes(repoId)] : []),
          ]);
        }
        if (interrupted()) return;
        if (scopes.has('conflicts')) await get().loadConflicts(true, repoId);
        if (interrupted()) return;
        if (scopes.has('worktrees')) await get().loadWorktrees(repoId);
        if (interrupted()) return;
        if (scopes.has('subtrees')) await get().loadSubtrees(repoId);
        if (interrupted()) return;
        if (scopes.has('submodules') || scopes.has('index') || scopes.has('status') || scopes.has('refs')) {
          await get().loadSubmodules(repoId);
        }
        if (interrupted()) return;
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
    } catch (error) {
      if (!interrupted() && !isAbortError(error)) console.debug('Background repository refresh failed', error);
    } finally {
      if (lifecycle === workingTreeLifecycle) {
        watcherRefreshInFlight = false;
        const activeWorkspace = get().snapshot?.workspace.id;
        if (watcherRefreshQueued || (activeWorkspace && pendingWorkspaceEvents.get(activeWorkspace)?.size)) {
          watcherRefreshQueued = false;
          if (watcherTimer) clearTimeout(watcherTimer);
          watcherTimer = setTimeout(() => void refreshFromWatcher(), 300);
        }
      }
    }
  };

  function drainPendingWorkspaceEvents(workspaceId: string): boolean {
    if (get().snapshot?.workspace.id !== workspaceId) return false;
    const pending = pendingWorkspaceEvents.get(workspaceId);
    if (!pending || pending.size === 0) return false;
    if (watcherTimer) clearTimeout(watcherTimer);
    watcherTimer = setTimeout(() => void refreshFromWatcher(), 300);
    return true;
  };

  return {
    tagBusy: false,
    transferringTabIds: {},
    setMergeEditorDraft: (draft) => {
      if (get().transferringTabIds[get().snapshot?.workspace.id ?? '']) return;
      set({ mergeEditorDraft: draft });
    },
    beginTabTransfer: (id) => {
      if (get().transferringTabIds[id] || !get().tabs.some((tab) => tab.id === id)) return false;
      set((state) => ({ transferringTabIds: { ...state.transferringTabIds, [id]: true } }));
      return true;
    },
    endTabTransfer: (id) => set((state) => {
      const transferringTabIds = { ...state.transferringTabIds };
      delete transferringTabIds[id];
      return { transferringTabIds };
    }),
    exportTabSession: (id) => get().snapshot?.workspace.id === id ? extractCurrentSession(get()) : get().sessions[id],
    importTab: async (transfer, insertionIndex) => {
      const value = await bridge().request<WorkspaceSessionState | null>({
        type: 'windowReadTabSession', payload: { transfer_id: transfer.transferId },
      }, { showProgress: false });
      if (!value?.snapshot) return get().openWorkspace(transfer.paths, true, { skipCrossWindowFocus: true, insertionIndex });
      if (value.snapshot.workspace.id !== transfer.tabId || !workspacePathsEqual(value.snapshot.workspace.paths, transfer.paths)) {
        throw new Error('Transferred workspace session does not match the tab');
      }
      if (get().tabs.some((tab) => tab.id === transfer.tabId)) {
        get().addNotification({ type: 'warning', title: 'Workspace operation failed', message: { raw: 'This workspace is already open in the destination window. Its existing session was preserved.' }, workspaceId: transfer.tabId });
        return false;
      }
      const tabs = [...get().tabs];
      tabs.splice(Math.max(0, Math.min(insertionIndex ?? tabs.length, tabs.length)), 0, value.snapshot.workspace);
      set((state) => ({ tabs, sessions: { ...state.sessions, [transfer.tabId]: value } }));
      await get().switchTab(transfer.tabId);
      // Register ownership before the source can release its watcher references.
      try {
        await persistTabs(get().tabs, get().activeTabId);
      } catch (error) {
        await get().closeTab(transfer.tabId, { closeWindowIfLast: false }).catch((cleanupError) => console.warn('Unable to roll back tab import', cleanupError));
        throw error;
      }
      return get().tabs.some((tab) => tab.id === transfer.tabId)
        && Boolean(get().sessions[transfer.tabId]);
    },
    ready: false, notifications: [], toastNotificationIds: [], notificationCenterOpen: false, identityPanelRepoId: null, remoteManagerRepoId: null, aboutOpen: false, aboutInitialTab: 'about', updateAvailableInfo: null, tabs: [], activeTabId: null, sessions: {}, allRepositories: [], mode: 'history', diffReturnMode: undefined, history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyRepoErrors: {}, historyFilter: '', historyQuery: { ...EMPTY_HISTORY_QUERY }, historyLoading: false, historyTopologyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, selectedCommitError: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], merge: undefined, mergeTarget: undefined, mergeEditorDraft: undefined, mergeResolutions: {}, mergeScope: 'all', mergeResult: '', commitMessage: '', mergeMessageSuggestion: undefined, amendRepoIds: [], commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, incomingCommits: {}, remotes: {}, batchCommitReport: undefined, batchCommitReports: {}, loadErrors: {},
    logPanelOpen: false,
    logPanelHeight: typeof localStorage !== 'undefined' ? Number(localStorage.getItem('versiondock:logPanelHeight') ?? 240) : 240,
    logEntries: [],
    logError: null,
    logStorageError: null,
    activeLogChannel: 'all',
    activeLogLevel: 'info',
    logSearchQuery: '',
    logAutoScroll: true,
    unreadErrorCount: 0,
    lastReadLogTimestamps: {},
    activeLogProject: 'current',
    setLogProject: (project) => set({ activeLogProject: project }),

    operations: {},
    updateChecking: false,

    openAbout: (tab = 'about') => set({ aboutOpen: true, aboutInitialTab: tab }),
    closeAbout: () => set({ aboutOpen: false }),
    setUpdateAvailableInfo: (info) => set({ updateAvailableInfo: info }),
    checkUpdateSilently: async (force = false) => {
      if (get().updateChecking) return;
      const settings = get().bootstrap?.state.settings;
      if (!force && settings?.autoCheckUpdates === false) return;
      set({ updateChecking: true });
      try {
        const result = await checkAppUpdate();
        const currentSettings = get().bootstrap?.state.settings;
        if (!force && currentSettings?.autoCheckUpdates === false) return;
        set({ updateAvailableInfo: result.available && currentSettings?.skippedUpdateVersion === result.latestVersion ? null : result });
      } catch (error) {
        set({ updateAvailableInfo: { available: false, currentVersion: APP_CURRENT_VERSION, error: error instanceof Error ? error.message : String(error) } });
      } finally {
        set({ updateChecking: false });
      }
    },

    initialize: async (value) => {
      resetLogSession();
      const owner = logSession;
      bridgeSubscriptions.splice(0).forEach((dispose) => dispose());
      currentWindowLabel = await value.getWindowLabel().catch(() => currentWindowLabel);
      if (owner !== logSession) return;
      set({ bridge: value });
      const refreshRuntimeOnFocus = () => void get().refreshRuntimeCapabilities();
      const refreshRuntimeOnVisibility = () => {
        if (document.visibilityState === 'visible') refreshRuntimeOnFocus();
      };
      configureTaskProgress((id) => value.cancelOperation(id));
      bridgeSubscriptions.push(value.subscribe((event) => {
        const progress = useTaskProgressStore.getState();
        if ('progressEvent' in event && event.type === 'operation-request') {
          const wid = event.context.workspaceId;
          if (wid && event.command.type === 'sync' && ['pull', 'pullRebase', 'pullFfOnly', 'update'].includes(event.command.payload.action)) {
            workingTreeRequests.get(event.requestId)?.();
            workingTreeRequests.set(event.requestId, holdWorkingTreeRefresh(wid));
          }
          const snapshot = get().snapshot?.workspace.id === wid ? get().snapshot : wid ? get().sessions[wid]?.snapshot : get().snapshot;
          progress.requested(event, {
            workspaceName: get().tabs.find((tab) => tab.id === wid)?.name ?? snapshot?.workspace.name ?? 'VersionDock',
            repoName: snapshot?.repositories.find((repo) => repo.meta.id === event.context.repositoryId)?.meta.name,
            repositories: event.command.type === 'batchCommit' ? [...event.command.payload.targets]
              .sort((a, b) => (snapshot?.repositories.find((repo) => repo.meta.id === b.repoId)?.meta.depth ?? 0) - (snapshot?.repositories.find((repo) => repo.meta.id === a.repoId)?.meta.depth ?? 0))
              .map((target) => ({ id: target.repoId, name: snapshot?.repositories.find((repo) => repo.meta.id === target.repoId)?.meta.name ?? target.repoId })) : undefined,
          });
        } else if ('progressEvent' in event && event.type === 'operation-settled') {
          progress.settled(event);
          workingTreeRequests.get(event.requestId)?.();
          workingTreeRequests.delete(event.requestId);
        }
        else if ('operationId' in event) {
          const wid = event.context.workspaceId;
          if (wid && event.context.domain === 'sync' && ['pulling', 'pullingRebase', 'updating'].includes(event.phase)
            && ACTIVE_OPERATION_STATUSES.has(event.status) && !workingTreeRequests.has(event.operationId)) {
            workingTreeRequests.set(event.operationId, holdWorkingTreeRefresh(wid));
            remoteWorkingTreeRequests.add(event.operationId);
          }
          progress.operation(event);
          if (!ACTIVE_OPERATION_STATUSES.has(event.status) && remoteWorkingTreeRequests.delete(event.operationId)) {
            workingTreeRequests.get(event.operationId)?.();
            workingTreeRequests.delete(event.operationId);
          }
        }
      }));
      bridgeSubscriptions.push(resetTaskProgress);
      window.addEventListener('focus', refreshRuntimeOnFocus);
      document.addEventListener('visibilitychange', refreshRuntimeOnVisibility);
      bridgeSubscriptions.push(() => {
        window.removeEventListener('focus', refreshRuntimeOnFocus);
        document.removeEventListener('visibilitychange', refreshRuntimeOnVisibility);
      });
      void value.onLogEntry((entry) => { if (owner === logSession) enqueueLog(entry); }).then((dispose) => {
        if (owner !== logSession) { dispose(); return; }
        bridgeSubscriptions.push(dispose);
        return get().loadLogs();
      }).catch(() => { if (owner === logSession) set({ logError: 'Unable to load logs.' }); });
      const progressTimers = new Map<string, number>();
      const progressMessages = new Map<string, NotificationText>();
      bridgeSubscriptions.push(() => {
        progressTimers.forEach((timer) => window.clearTimeout(timer));
        progressTimers.clear();
        progressMessages.clear();
        get().notifications.filter((item) => item.operationId).forEach((item) => get().removeNotification(item.id));
      });
      bridgeSubscriptions.push(value.subscribe((event) => {
        if ('operationId' in event) {
          if (event.context.visibility === 'background') return;
          set((state) => ({ operations: { ...state.operations, [event.operationId]: event } }));
          const progress = get().notifications.find((item) => item.operationId === event.operationId);
          if (ACTIVE_OPERATION_STATUSES.has(event.status) && !INTERNAL_PROGRESS_PHASES.has(event.phase)) {
            const progressValue = event.total && event.total > 0
              ? Math.min(100, Math.max(0, (event.completed ?? 0) / event.total * 100))
              : undefined;
            const message: NotificationText = { key: event.message || event.phase };
            progressMessages.set(event.operationId, message);
            if (progress) {
              set((state) => ({ notifications: state.notifications.map((item) => item.id === progress.id ? { ...item, message, progressValue } : item) }));
            } else if (!progressTimers.has(event.operationId)) {
              // Avoid flashing a toast for fast commands; aggregate Update Project already has its own progress.
              progressTimers.set(event.operationId, window.setTimeout(() => {
                const current = get().operations[event.operationId];
                if (!current || !ACTIVE_OPERATION_STATUSES.has(current.status)) return;
                if (get().notifications.some((item) => item.progress && item.title === 'Updating Project' && item.workspaceId === current.context.workspaceId)) return;
                get().addNotification({
                  type: 'info', title: 'VersionDock', message: progressMessages.get(event.operationId) ?? message,
                  workspaceId: current.context.workspaceId ?? undefined,
                  progress: true, operationId: current.operationId,
                  progressValue: current.total && current.total > 0 ? Math.min(100, Math.max(0, (current.completed ?? 0) / current.total * 100)) : undefined,
                  actions: current.cancellable ? [{ type: 'cancelOperation', label: 'Cancel', operationId: current.operationId }] : [],
                });
              }, 250));
            }
          } else if (!ACTIVE_OPERATION_STATUSES.has(event.status)) {
            const timer = progressTimers.get(event.operationId);
            if (timer !== undefined) window.clearTimeout(timer);
            progressTimers.delete(event.operationId);
            progressMessages.delete(event.operationId);
            if (progress) get().removeNotification(progress.id);
          }
          if (!ACTIVE_OPERATION_STATUSES.has(event.status)) {
            window.setTimeout(() => set((state) => {
              const operations = { ...state.operations };
              delete operations[event.operationId];
              return { operations };
            }), 750);
          }
          return;
        }
        const currentWorkspaceId = get().snapshot?.workspace.id ?? get().activeTabId;
        if ('scopes' in event) {
          if (currentWorkspaceId && (event.workspaceId === currentWorkspaceId || event.workspaceId === get().activeTabId)) {
            const generationKey = `${event.workspaceId}:${event.repoId ?? ''}`;
            const previousGeneration = repositoryEventGenerations.get(generationKey) ?? 0;
            if (event.generation < previousGeneration) return;
            repositoryEventGenerations.set(generationKey, event.generation);
            recordPendingWorkspaceEvent(event.workspaceId, event.repoId, event.scopes);
            if (watcherTimer) clearTimeout(watcherTimer);
            watcherTimer = setTimeout(() => void refreshFromWatcher(), 300);
          } else {
            recordPendingWorkspaceEvent(event.workspaceId, event.repoId, event.scopes);
          }
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
        // Keep transfer startup on its tab/loading view until restoration settles.
        set({ bootstrap, ready: !new URLSearchParams(window.location.search).has('tabTransfer') });
        syncNotificationSession(bootstrap.applicationSessionId);
        const launchWorkspace = bootstrap.launchWorkspaceId
          ? bootstrap.state.recentWorkspaces.find((workspace) => workspace.id === bootstrap.launchWorkspaceId)
          : undefined;
        const willFetchOnStartup = Boolean(bootstrap.state.settings?.fetchOnStartup);
        if (willFetchOnStartup) {
          startupFetchPending = true;
        }
        if (launchWorkspace) await get().openWorkspace(launchWorkspace.paths, true, { skipCrossWindowFocus: true });
        else await get().restoreTabsOnStartup();
        set({ ready: true });
        restartAutoRefresh();
        const currentSnapshot = get().snapshot;
        const currentWorkspaceId = currentSnapshot?.workspace.id;
        const isFetchLeader = willFetchOnStartup && currentSnapshot && currentWorkspaceId && claimSchedulerLease(`fetch-on-startup:${currentWorkspaceId}`, 60_000);
        if (isFetchLeader) {
          try {
            const allRepos = get().allRepositories.length ? get().allRepositories : (currentSnapshot.repositories ?? []);
            const gitRepos = allRepos.filter((repo) => repo.meta.kind === 'git' && repo.toolAvailable !== false && !repo.meta.isWorktree);
            await Promise.allSettled(gitRepos.map((repo) => get().sync(repo.meta.id, 'fetch', false)));
            await get().refresh(true);
          } finally {
            startupFetchPending = false;
            const latestSnapshot = get().snapshot;
            if (latestSnapshot) checkStatusNotifications(get().allRepositories, latestSnapshot.workspace.id);
          }
        } else {
          startupFetchPending = false;
          // 若启动 Fetch 正在由其他窗口主导执行（租约仍被其他窗口有效持有），本窗口暂缓以未 Fetch 的旧状态建立基线，等待 Leader 窗口完成 Fetch 并同步基线
          const otherWindowFetching = willFetchOnStartup && currentWorkspaceId && isSchedulerLeaseActive(`fetch-on-startup:${currentWorkspaceId}`);
          if (currentSnapshot && !otherWindowFetching) {
            checkStatusNotifications(get().allRepositories, currentSnapshot.workspace.id);
          }
        }
      }, 'workspace');
      set({ ready: true });
      void get().checkUpdateSilently();
    },

    dispose: () => {
      resetLogSession();
      settingsWriter = undefined;
      workingTreeLifecycle++;
      workingTreeUpdates.clear();
      workingTreeRequests.clear();
      remoteWorkingTreeRequests.clear();
      set({ transferringTabIds: {} });
      cancelRequests();
      bridgeSubscriptions.splice(0).forEach((dispose) => dispose());
      if (watcherTimer) clearTimeout(watcherTimer);
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      if (autoFetchTimer) clearInterval(autoFetchTimer);
      autoFetchTimer = undefined;
      autoFetchController?.abort();
      autoFetchController = undefined;
      commitSelectionSaveTimers.forEach((timer) => clearTimeout(timer));
      commitSelectionSaveTimers.clear();
      watcherTimer = undefined;
      autoRefreshTimer = undefined;
      pendingWorkspaceEvents.clear();
      watcherRefreshInFlight = false;
      watcherRefreshQueued = false;
      repositoryEventGenerations.clear();
      pendingPullAutoStashes.clear();
      activeStashOperations.clear();
      sessionNotifiedCounts.clear();
      sessionObservedCounts.clear();
      sessionNotifiedStates.clear();
      startupFetchPending = false;
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
      const current = get().bootstrap ?? { state: emptyState, tools: snapshot.tools, applicationSessionId: 'frontend-session', capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false } };
      
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

    checkoutSvnRepository: async (url, parentPath, targetName, openInNewWindow = false, username, password) => {
      let authenticationRequired = false;
      const succeeded = (await withBusy(async () => {
        let result: CheckoutRepositoryResult;
        try {
          result = await bridge().request<CheckoutRepositoryResult>({
            type: 'checkoutSvnRepository',
            payload: {
              url,
              parent_path: parentPath,
              target_name: targetName,
              username: username?.trim() || null,
              password: password || null,
            },
          }, { timeoutMs: 600_000 });
        } catch (error) {
          if (error instanceof BridgeError && error.code === 'SVN_AUTH_FAILED') {
            authenticationRequired = true;
            return false;
          }
          throw error;
        }
        if (openInNewWindow) {
          if (!await bridge().focusWorkspaceAcrossWindows([result.path])) await bridge().openInNewWindow([result.path]);
        } else {
          await get().openWorkspace([result.path]);
        }
        return true;
      }, 'workspace', { target: `${parentPath}/${targetName}` })) ?? false;
      return { succeeded, authenticationRequired };
    },

    switchTab: async (workspaceId: string) => {
      if (get().activeTabId === workspaceId && get().snapshot) return;
      const targetTab = get().tabs.find((t) => t.id === workspaceId);
      if (!targetTab) return;

      cancelRequests();
      workspaceRequestGeneration += 1;
      historyPageGeneration += 1;
      historyTopologyGeneration += 1;
      changesDiffGeneration += 1;
      diffRequestGeneration += 1;
      commitSelectionGeneration += 1;
      comparisonRequestGeneration += 1;
      branchWorkingDiffGeneration += 1;

      const currentActiveId = get().activeTabId;
      if (
        currentActiveId &&
        currentActiveId !== workspaceId &&
        get().tabs.some((t) => t.id === currentActiveId)
      ) {
        const currentSession = extractCurrentSession(get());
        if (currentSession) {
          set((state) => ({
            sessions: { ...state.sessions, [currentActiveId]: currentSession },
          }));
        }
      }

      const cachedSession = get().sessions[workspaceId];
      const nextUnreadErrors = calculateWorkspaceUnreadErrors(
        get().logEntries,
        workspaceId,
        get().tabs,
        get().lastReadLogTimestamps,
      );
      if (cachedSession) {
        const missingInRestored = cachedSession.selectedCommits.filter(
          (item) => !cachedSession.selectedCommitDetails[commitKey(item.repoId, item.hash)],
        );
        const restoredLoading = missingInRestored.length > 0
          ? Object.fromEntries(missingInRestored.map((item) => [commitKey(item.repoId, item.hash), true]))
          : {};

        set({
          activeTabId: workspaceId,
          unreadErrorCount: nextUnreadErrors,
          snapshot: cachedSession.snapshot,
          allRepositories: cachedSession.allRepositories,
          selectedRepoId: cachedSession.selectedRepoId,
          selectedFile: cachedSession.selectedFile,
          fileHistoryTarget: cachedSession.fileHistoryTarget,
          mode: cachedSession.mode,
          diffReturnMode: cachedSession.diffReturnMode,
          diff: cachedSession.diff,
          changesDiff: cachedSession.changesDiff,
          changesDiffLoading: false,
          changesDiffError: cachedSession.changesDiffError,
          changesDiffTarget: cachedSession.changesDiffTarget,
          changes: cachedSession.changes,
          history: cachedSession.history,
          historyHasMore: cachedSession.historyHasMore,
          historyByRepo: cachedSession.historyByRepo,
          historyTopology: cachedSession.historyTopology,
          historyTopologyByRepo: cachedSession.historyTopologyByRepo,
          historyHasMoreByRepo: cachedSession.historyHasMoreByRepo,
          historyRepoErrors: cachedSession.historyRepoErrors ?? {},
          historyLoading: false,
          branchesLoading: false,
          historyScope: cachedSession.historyScope,
          historyFilter: cachedSession.historyFilter,
          historyQuery: cachedSession.historyQuery ?? { ...EMPTY_HISTORY_QUERY, text: cachedSession.historyFilter || null },
          selectedCommit: cachedSession.selectedCommit ?? (cachedSession.selectedPrimaryKey ? cachedSession.selectedCommitDetails[cachedSession.selectedPrimaryKey] : (cachedSession.selectedCommits[0] ? cachedSession.selectedCommitDetails[commitKey(cachedSession.selectedCommits[0].repoId, cachedSession.selectedCommits[0].hash)] : undefined)),
          selectedCommits: cachedSession.selectedCommits,
          selectedPrimaryKey: cachedSession.selectedPrimaryKey ?? (cachedSession.selectedCommits[0] ? commitKey(cachedSession.selectedCommits[0].repoId, cachedSession.selectedCommits[0].hash) : undefined),
          commitSelectionAnchorKey: cachedSession.commitSelectionAnchorKey ?? cachedSession.selectedPrimaryKey,
          selectedCommitDetails: cachedSession.selectedCommitDetails,
          selectedCommitLoading: restoredLoading,
          selectedCommitError: cachedSession.selectedCommitError ?? {},
          mergeCommits: cachedSession.mergeCommits,
          mergeCommitsLoading: {},
          mergeParentFiles: cachedSession.mergeParentFiles,
          mergeParentFilesLoading: {},
          mergeParentFilesError: cachedSession.mergeParentFilesError ?? {},
          branches: cachedSession.branches,
          tags: cachedSession.tags,
          branchesByRepo: cachedSession.branchesByRepo,
          tagsByRepo: cachedSession.tagsByRepo,
          conflicts: cachedSession.conflicts,
          merge: cachedSession.merge,
          mergeTarget: cachedSession.mergeTarget,
          mergeResolutions: cachedSession.mergeResolutions ?? {},
          mergeScope: cachedSession.mergeScope ?? 'all',
          mergeResult: cachedSession.mergeResult,
          mergeEditorDraft: cachedSession.mergeEditorDraft,
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
          incomingCommits: cachedSession.incomingCommits ?? {},
          comparisonTarget: cachedSession.comparisonTarget,
          comparison: cachedSession.comparison,
          remotes: cachedSession.remotes,
          batchCommitReport: cachedSession.batchCommitReport,
          loadErrors: cachedSession.loadErrors,
        });
        if (missingInRestored.length > 0) {
          const targetWorkspaceId = workspaceId;
          void (async () => {
            if ((get().snapshot?.workspace.id ?? get().activeTabId ?? '') === targetWorkspaceId) {
              await get().reloadSelectedCommits(targetWorkspaceId);
            }
          })();
        }
        for (const commit of cachedSession.selectedCommits) {
          if (cachedSession.selectedCommitDetails[commitKey(commit.repoId, commit.hash)]?.branchesPending) void get().loadCommitDetail(commit).catch(() => undefined);
        }
        drainPendingWorkspaceEvents(workspaceId);
        try {
          await persistTabs(get().tabs, workspaceId);
        } catch {
          // 标签窗口同步失败不阻塞工作区切回与会话恢复
        }
      } else {
        await withBusy(async () => {
          const controller = beginRequest('workspace');
          const requestGeneration = ++workspaceRequestGeneration;
          const snapshot = await bridge().request<WorkspaceSnapshot>({ type: 'workspaceOpen', payload: { paths: targetTab.paths } }, { signal: controller.signal });
          if (requestGeneration !== workspaceRequestGeneration) return;
          set({ activeTabId: workspaceId, unreadErrorCount: nextUnreadErrors, batchCommitReport: undefined });
          await persistTabs(get().tabs, workspaceId);
          await applySnapshot(snapshot, true);
        }, 'workspace');
      }
    },

    closeTab: async (workspaceId: string, options) => {
      if (get().transferringTabIds[workspaceId]) return;
      if (options?.closeWindowIfLast !== false && get().tabs.length === 1 && get().tabs[0].id === workspaceId) {
        try {
          const hasOtherWindows = await bridge().window.hasOtherWorkspaceWindows();
          // Close before clearing the workspace so the welcome screen cannot flash.
          // Recheck after enumeration: another tab may have arrived in the meantime.
          if (get().transferringTabIds[workspaceId]) return;
          if (hasOtherWindows && get().tabs.length === 1 && get().tabs[0].id === workspaceId) {
            await bridge().window.close();
            return;
          }
        } catch (error) {
          publishError('Workspace operation failed', error, workspaceId);
          return;
        }
      }
      const currentTabs = get().tabs;
      const tabIndex = currentTabs.findIndex((t) => t.id === workspaceId);
      if (tabIndex === -1) return;

      const nextTabs = currentTabs.filter((t) => t.id !== workspaceId);
      const nextSessions = { ...get().sessions };
      delete nextSessions[workspaceId];
      pendingWorkspaceEvents.delete(workspaceId);

      if (get().activeTabId === workspaceId) {
        if (nextTabs.length > 0) {
          const nextActiveIndex = Math.min(tabIndex, nextTabs.length - 1);
          const nextActiveTab = nextTabs[nextActiveIndex];
          set({
            tabs: nextTabs,
            sessions: nextSessions,
            activeTabId: null,
          });
          await get().switchTab(nextActiveTab.id);
          if (get().sessions[workspaceId]) {
            set((state) => {
              const cleaned = { ...state.sessions };
              delete cleaned[workspaceId];
              return { sessions: cleaned };
            });
          }
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
            selectedPrimaryKey: undefined, commitSelectionAnchorKey: undefined,
            selectedCommitDetails: {},
            selectedCommitLoading: {},
            selectedCommitError: {},
            mergeCommits: {},
            mergeCommitsLoading: {},
            mergeParentFiles: {},
            mergeParentFilesLoading: {},
            mergeParentFilesError: {},
            branches: [],
            tags: [],
            branchesByRepo: {},
            tagsByRepo: {},
            conflicts: [],
            merge: undefined,
            mergeTarget: undefined,
            mergeResolutions: {},
            mergeScope: 'all',
            mergeResult: '',
            stashes: {},
            shelves: {},
            changelists: {},
            worktrees: {},
            worktreeDiff: undefined,
            subtrees: {},
            submodules: {},
            unpushedCommits: {},
            incomingCommits: {},
            comparisonTarget: undefined,
            comparison: undefined,
            remotes: {},
            loadErrors: {},
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
      if (Object.keys(get().transferringTabIds).some((id) => id !== workspaceId)) return;
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
      if (Object.keys(get().transferringTabIds).length) return;
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
        selectedPrimaryKey: undefined, commitSelectionAnchorKey: undefined,
        selectedCommitDetails: {},
        selectedCommitLoading: {},
        selectedCommitError: {},
        mergeCommits: {},
        mergeCommitsLoading: {},
        mergeParentFiles: {},
        mergeParentFilesLoading: {},
        mergeParentFilesError: {},
        branches: [],
        tags: [],
        branchesByRepo: {},
        tagsByRepo: {},
        conflicts: [],
        merge: undefined,
        mergeTarget: undefined,
        mergeResolutions: {},
        mergeScope: 'all',
        mergeResult: '',
        stashes: {},
        shelves: {},
        changelists: {},
        worktrees: {},
        worktreeDiff: undefined,
        subtrees: {},
        submodules: {},
        unpushedCommits: {},
        incomingCommits: {},
        comparisonTarget: undefined,
        comparison: undefined,
        remotes: {},
        loadErrors: {},
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
              const accepted = transfer ? await get().importTab(transfer) : await get().openWorkspace(paths, true, { skipCrossWindowFocus: true });
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

    refresh: async (silent = false, options = {}) => {
      const currentWorkspaceId = get().snapshot?.workspace.id;
      if (!currentWorkspaceId) return;
      if (updatingWorkingTree(currentWorkspaceId)) {
        queueStableRefresh(currentWorkspaceId);
        return;
      }
      const operation = async () => {
        const id = workspaceId();
        const epoch = updateEpoch(id);
        const controller = beginRequest(`workspace:${id}`);
        const snapshot = await bridge().request<WorkspaceSnapshot>(
          { type: 'workspaceRefresh', payload: { workspace_id: id } },
          { signal: controller.signal, showProgress: !silent && options.trackBusy !== false },
        );
        if (get().snapshot?.workspace.id !== id) return;
        if (updatingWorkingTree(id) || updateEpoch(id) !== epoch) {
          queueStableRefresh(id);
          return;
        }
        await applySnapshot(snapshot, !silent && options.reloadRepository !== false, silent);
      };
      if (silent) {
        try {
          await operation();
        } catch (error) {
          if (!isAbortError(error)) {
            publishError('Workspace refresh failed', error);
          }
        }
      } else {
        await withBusy(operation, 'workspace', undefined, { trackBusy: options.trackBusy });
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
        abortHistoryRequests();
        for (const key of ['branch-comparison', 'diff', 'changes-diff', 'branch-working-diff']) {
          requestControllers.get(key)?.abort();
        }
      }
      set((state) => ({
        selectedRepoId: repoId,
        ...(repoChanged ? {
          selectedCommit: undefined,
          selectedCommits: [],
          selectedPrimaryKey: undefined, commitSelectionAnchorKey: undefined,
          selectedCommitLoading: {},
          selectedCommitError: {},
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
        const refRequests: Promise<unknown>[] = [];
        if (get().bootstrap?.capabilities.changelist && repo.capabilities?.changelist !== false) requests.push(get().loadChangelists());
        if (repo.meta.kind === 'git' && get().bootstrap?.capabilities.subtree && repo.capabilities?.subtree !== false) requests.push(get().loadSubtrees(repoId));
        const currentWorkspace = workspaceId();
        for (const item of get().snapshot?.repositories ?? []) {
          refRequests.push(bridge().request<BranchInfo[]>({ type: 'branches', payload: { workspace_id: currentWorkspace, repo_id: item.meta.id } }, { showProgress: false, timeoutMs: 12_000 }).then((branches) => {
            if (get().snapshot?.workspace.id !== currentWorkspace) return;
            set((state) => ({
              branchesByRepo: { ...state.branchesByRepo, [item.meta.id]: branches },
              branches: item.meta.id === get().selectedRepoId ? branches : state.branches,
            }));
          }).catch(() => undefined));
          refRequests.push(bridge().request<TagInfo[]>({ type: 'tags', payload: { workspace_id: currentWorkspace, repo_id: item.meta.id } }, { showProgress: false, timeoutMs: 12_000 }).then((tags) => {
            if (get().snapshot?.workspace.id !== currentWorkspace) return;
            set((state) => ({
              tagsByRepo: { ...state.tagsByRepo, [item.meta.id]: tags },
              tags: item.meta.id === get().selectedRepoId ? tags : state.tags,
            }));
          }).catch(() => undefined));
        }
        const otherResults = Promise.allSettled(requests);
        try { await Promise.all(refRequests); }
        finally { if (get().snapshot?.workspace.id === currentWorkspace) set({ branchesLoading: false }); }
        const failures = (await otherResults).filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw failures[0].reason;
      }, `repository:${repoId}`);
    },

    openDiff: async (repoId, path, staged, revision, range) => withBusy(async () => {
      const currentMode = get().mode;
      const diffReturnMode = currentMode !== 'diff' ? currentMode : get().diffReturnMode;
      const generation = ++diffRequestGeneration;
      const controller = beginRequest('diff');
      const diff = await bridge().request<DiffDocument>({ type: 'fileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, relative_path: path, staged, revision: revision ?? null, from_revision: range?.fromRevision ?? null, to_revision: range?.toRevision ?? null } }, { signal: controller.signal });
      if (generation === diffRequestGeneration) set({ diffReveal: undefined, selectedFile: { repoId, path, staged, revision, fromRevision: range?.fromRevision, toRevision: range?.toRevision }, diff, mode: 'diff', diffReturnMode });
    }, `diff:${repoId}`),
    openStashDiff: async (repoId, reference, path) => withBusy(async () => {
      const currentMode = get().mode;
      const diffReturnMode = currentMode !== 'diff' ? currentMode : get().diffReturnMode;
      const controller = beginRequest('diff');
      const diff = await bridge().request<DiffDocument>({ type: 'stashFileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, reference, relative_path: path } }, { signal: controller.signal });
      set({ selectedFile: { repoId, path, staged: false, revision: reference }, diff, mode: 'diff', diffReturnMode });
    }, `diff:${repoId}`),
    openShelfDiff: async (repoId, shelfId, path) => withBusy(async () => {
      const currentMode = get().mode;
      const diffReturnMode = currentMode !== 'diff' ? currentMode : get().diffReturnMode;
      const controller = beginRequest('diff');
      const diff = await bridge().request<DiffDocument>({ type: 'shelfFileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, shelf_id: shelfId, relative_path: path } }, { signal: controller.signal });
      set({ selectedFile: { repoId, path, staged: false, revision: shelfId }, diff, mode: 'diff', diffReturnMode });
    }, `diff:${repoId}`),

    openCommitDetail: () => {
      if (!get().selectedCommits.length) return;
      set({ mode: 'commit-detail' });
    },

    openCommitChanges: () => {
      const state = get();
      if (!state.selectedCommits.length) return;
      const hasUnfinishedCommit = state.selectedCommits.some((commit) => {
        const key = commitKey(commit.repoId, commit.hash);
        return !state.selectedCommitDetails[key] || state.selectedCommitLoading[key] || Boolean(state.selectedCommitError[key]);
      });
      if (hasUnfinishedCommit) return;
      const files = buildCommitFileTargets(state.selectedCommits, state.selectedCommitDetails, state.snapshot?.repositories ?? [], state.historyQuery.path);
      if (!files.length) return;
      set({
        changes: { kind: 'commits', commits: state.selectedCommits, files },
        changesDiff: undefined,
        changesDiffLoading: false,
        changesDiffError: undefined,
        changesDiffTarget: undefined,
        mode: 'changes',
      });
    },

    openWorkingChanges: (repoId, section) => {
      const repo = get().snapshot?.repositories.find((item) => item.meta.id === repoId);
      if (!repo) return;
      const allFiles: WorkingChangeTarget[] = repo.files.flatMap((file) => {
        const targets: WorkingChangeTarget[] = [];
        if (file.staged) targets.push({ repoId, path: file.path, status: file.status, staged: true, section: 'staged' });
        if (file.status === 'untracked') targets.push({ repoId, path: file.path, status: file.status, staged: false, section: 'untracked' });
        else if (file.unstaged) targets.push({ repoId, path: file.path, status: file.status, staged: false, section: 'unstaged' });
        return targets;
      });
      const files = section
        ? (section === 'staged' ? allFiles.filter((f) => f.staged) : allFiles.filter((f) => !f.staged))
        : allFiles;
      set({
        changes: { kind: 'workingTree', repoId, files },
        changesDiff: undefined,
        changesDiffLoading: false,
        changesDiffError: undefined,
        changesDiffTarget: undefined,
        mode: 'changes',
      });
    },

    loadChangesDiff: async (target) => {
      const working = 'section' in target;
      const targetId = working
        ? `${target.repoId}\0${target.section}\0${target.path}`
        : `${target.repoId}\0${target.path}\0${target.fromRevision ?? ''}\0${target.toRevision ?? target.commitHash}`;
      const pending = requestControllers.get('changes-diff');
      if (get().changesDiffLoading && get().changesDiffTarget === targetId && pending && !pending.signal.aborted) return;
      return withBusy(async () => {
        const generation = ++changesDiffGeneration;
        const controller = beginRequest('changes-diff');
        set({
          changesDiff: undefined,
          changesDiffLoading: true,
          changesDiffError: undefined,
          changesDiffTarget: targetId,
        });
        try {
          const diff = await bridge().request<DiffDocument>(
            {
              type: 'fileDiff',
              payload: {
                workspace_id: workspaceId(),
                repo_id: target.repoId,
                relative_path: target.path,
                staged: working ? target.staged : false,
                revision: working ? null : target.toRevision ? null : target.commitHash,
                from_revision: working ? null : target.fromRevision ?? null,
                to_revision: working ? null : target.toRevision ?? null,
              },
            },
            { signal: controller.signal },
          );
          if (generation === changesDiffGeneration) {
            set({
              changesDiff: diff,
              changesDiffLoading: false,
              changesDiffError: undefined,
              changesDiffTarget: targetId,
            });
          }
        } catch (error) {
          if (generation === changesDiffGeneration) {
            if (!isAbortError(error)) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              set({
                changesDiff: undefined,
                changesDiffLoading: false,
                changesDiffError: errorMsg,
                changesDiffTarget: targetId,
              });
              publishError('Diff loading failed', error);
            } else {
              set({ changesDiffLoading: false });
            }
          }
        }
      }, `diff:${target.repoId}`);
    },

    setCommitMessage: (commitMessage) => {
      if (get().transferringTabIds[get().snapshot?.workspace.id ?? '']) return;
      set({ commitMessage });
    },
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

    stage: async (repoId, paths, allowTruncated = false) => withBusy(async () => {
      await bridge().request({ type: 'stage', payload: { workspace_id: workspaceId(), repo_id: repoId, paths, allow_truncated: allowTruncated } });
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

    commit: async (repoId, message, amend, paths, push, noVerify, stagedOnly, targetWorkspaceId) => withBusy(async () => {
      const targetWid = targetWorkspaceId ?? workspaceId();
      await bridge().request({ type: 'commit', payload: { workspace_id: targetWid, repo_id: repoId, message, amend, paths, no_verify: Boolean(noVerify), staged_only: Boolean(stagedOnly) } });
      clearCommittedSelections([repoId], targetWid);
      await notifyDetachedCommit(repoId, targetWid).catch(() => undefined);
      if (push) await bridge().request({ type: 'sync', payload: { workspace_id: targetWid, repo_id: repoId, action: 'push', remote: null, branch: null, force: false } }, { timeoutMs: 600_000 });
      if (push) await get().notifyPushSuccess(repoId, targetWid);
    }, `commit:${repoId}`),

    commitMany: async (targets, message, push, targetWorkspaceId) => withBusy(async () => {
      const workspace_id = targetWorkspaceId ?? workspaceId();
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
            noVerify: Boolean(target.noVerify),
            stagedOnly: Boolean(target.stagedOnly),
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
      const reportId = `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const report: BatchCommitReport = { id: reportId, message, push, targets, results, workspaceId: workspace_id };

      set((state) => ({
        batchCommitReports: { ...state.batchCommitReports, [reportId]: report },
      }));

      if (get().snapshot?.workspace.id === workspace_id) {
        set({ batchCommitReport: report });
      } else {
        set((state) => ({
          sessions: {
            ...state.sessions,
            [workspace_id]: state.sessions[workspace_id]
              ? { ...state.sessions[workspace_id], batchCommitReport: report }
              : state.sessions[workspace_id],
          },
        }));
      }
      clearCommittedSelections(results.filter((result) => result.committed).map((result) => result.repoId), workspace_id);
      await Promise.all(results.filter((result) => result.committed).map(async (result) => {
        await notifyDetachedCommit(result.repoId, workspace_id).catch(() => undefined);
        if (result.pushed) await get().notifyPushSuccess(result.repoId, workspace_id);
      }));
      notifyBatchFailures(results, report, workspace_id);
      return results;
    }, 'commit', {
      repositoryId: targets.length === 1 ? targets[0].repoId : null,
      target: `${REPOSITORY_TARGET_PREFIX}${JSON.stringify(targets.map((target) => target.repoId))}`,
    }),

    retryBatchResult: async (repoId, options) => withBusy(async () => {
      let report: BatchCommitReport | undefined;
      if (options?.reportId) {
        report = get().batchCommitReports[options.reportId];
        // 关键防护：如果指定了 reportId 但在历史池中未找到，说明该报告已完成或已废弃，直接阻断，绝不回退去拿较新的提交！
        if (!report) return;
      } else {
        if (options?.workspaceId && get().sessions[options.workspaceId]?.batchCommitReport?.results.some((r) => r.repoId === repoId)) {
          report = get().sessions[options.workspaceId].batchCommitReport;
        }
        if (!report && get().batchCommitReport?.results.some((r) => r.repoId === repoId)) {
          report = get().batchCommitReport;
        }
        if (!report) {
          const matchingWid = Object.keys(get().sessions).find((wid) => get().sessions[wid].batchCommitReport?.results.some((r) => r.repoId === repoId));
          if (matchingWid) {
            report = get().sessions[matchingWid].batchCommitReport;
          }
        }
      }

      const previous = report?.results.find((result) => result.repoId === repoId);
      const target = report?.targets.find((item) => item.repoId === repoId);
      if (!report || !previous || !target) return;

      const targetWid = options?.workspaceId ?? report.workspaceId ?? workspaceId();

      // 子模块依赖前置强校验：若父仓库拥有从属子模块且在该批次提交中仍有子模块未成功，严禁单独重试父仓库
      const repositories = (targetWid && get().sessions[targetWid] ? get().sessions[targetWid].allRepositories : undefined)
        ?? (targetWid && get().sessions[targetWid]?.snapshot ? get().sessions[targetWid].snapshot.repositories : undefined)
        ?? (get().snapshot?.workspace.id === targetWid ? get().allRepositories : undefined)
        ?? get().allRepositories
        ?? [];
      const allMetas = repositories.map((r) => r.meta);
      const isDescendantOf = (childId: string, parentId: string): boolean => {
        let curr = allMetas.find((m) => m.id === childId);
        while (curr?.parentRepoId) {
          const nextParentId = curr.parentRepoId;
          if (nextParentId === parentId) return true;
          curr = allMetas.find((m) => m.id === nextParentId);
        }
        return false;
      };

      const failedChild = report.results.find((res) => {
        if (res.repoId === repoId) return false;
        if (!isDescendantOf(res.repoId, repoId)) return false;
        return !res.committed || (Boolean(report?.push) && !res.pushed) || Boolean(res.error);
      });

      if (failedChild) {
        const childMeta = allMetas.find((m) => m.id === failedChild.repoId);
        const parentMeta = allMetas.find((m) => m.id === repoId);
        const childName = childMeta?.name ?? failedChild.repoId;
        const parentName = parentMeta?.name ?? repoId;
        const isPushIssue = failedChild.committed && Boolean(report.push) && !failedChild.pushed;
        get().addNotification({
          type: 'warning',
          urgent: true,
          title: 'Commit retry blocked',
          message: isPushIssue
            ? {
                key: 'Cannot retry "{0}" because submodule "{1}" has not been pushed yet. Push the submodule first.',
                args: [parentName, childName],
              }
            : {
                key: 'Cannot retry "{0}" because submodule "{1}" has not been committed yet. Commit the submodule first.',
                args: [parentName, childName],
              },
          workspaceId: targetWid,
        });
        return;
      }

      let next: RepositoryOperationResult;
      if (previous.committed && previous.pushAttempted && !previous.pushed) {
        try {
          await bridge().request({ type: 'sync', payload: { workspace_id: targetWid, repo_id: repoId, action: 'push', remote: null, branch: null, force: false } }, { timeoutMs: 600_000 });
          next = { ...previous, pushed: true, failedStage: null, recoveryHint: null, error: null };
        } catch (error) {
          next = { ...previous, error: error instanceof BridgeError ? error : previous.error };
        }
      } else {
        [next] = await bridge().request<RepositoryOperationResult[]>({
          type: 'batchCommit',
          payload: {
            workspace_id: targetWid,
            targets: [{
              repoId,
              message: report.message,
              amend: target.amend,
              paths: target.paths,
              unstagePaths: target.unstagePaths,
              noVerify: Boolean(target.noVerify),
              stagedOnly: Boolean(target.stagedOnly),
            }],
            push: report.push,
          },
        }, { timeoutMs: 600_000 });
      }
      const nextReport: BatchCommitReport = { ...report, results: report.results.map((item) => item.repoId === repoId ? next : item), workspaceId: targetWid };
      const remainingFailures = nextReport.results.filter((result) => result.error);
      const updatedReport = remainingFailures.length ? nextReport : undefined;

      if (report.id) {
        set((state) => ({
          batchCommitReports: remainingFailures.length
            ? { ...state.batchCommitReports, [report.id!]: nextReport }
            : Object.fromEntries(Object.entries(state.batchCommitReports).filter(([k]) => k !== report.id)),
        }));
      }

      if (get().snapshot?.workspace.id === targetWid && get().batchCommitReport?.id === report.id) {
        set({ batchCommitReport: updatedReport });
      }
      set((state) => ({
        sessions: {
          ...state.sessions,
          [targetWid]: state.sessions[targetWid]?.batchCommitReport?.id === report.id
            ? { ...state.sessions[targetWid], batchCommitReport: updatedReport }
            : state.sessions[targetWid],
        },
      }));
      if (next.committed) {
        clearCommittedSelections([repoId], targetWid);
      }
      if (!remainingFailures.length && report.id) {
        set((state) => ({
          notifications: state.notifications.map((n) =>
            n.actions.some((a) => a.type === 'retryBatchResult' && a.reportId === report.id)
              ? { ...n, read: true }
              : n
          ),
          toastNotificationIds: (state.toastNotificationIds ?? []).filter((id) => {
            const notif = state.notifications.find((n) => n.id === id);
            return !notif?.actions.some((a) => a.type === 'retryBatchResult' && a.reportId === report.id);
          }),
        }));
      }
      notifyBatchFailures(remainingFailures, updatedReport, targetWid);
    }, `commit:${repoId}`),
    dismissBatchReport: () => {
      const activeWid = get().snapshot?.workspace.id;
      set((state) => ({
        batchCommitReport: undefined,
        sessions: activeWid && state.sessions[activeWid]
          ? { ...state.sessions, [activeWid]: { ...state.sessions[activeWid], batchCommitReport: undefined } }
          : state.sessions,
      }));
    },

    notifyPushSuccess: async (repoId, wid, remote, branchName) => {
      try {
        const current = get().snapshot?.workspace.id === wid ? get().snapshot : get().sessions[wid]?.snapshot;
        const repo = current?.repositories.find((item) => item.meta.id === repoId);
        if (!repo || repo.meta.kind !== 'git') return;
        const refs = await bridge().request<BranchInfo[]>({ type: 'branches', payload: { workspace_id: wid, repo_id: repoId } }, { showProgress: false });
        const branch = branchName ?? refs.find((item) => item.current)?.name ?? repo.branch;
        if (!branch || branch === 'HEAD') return;
        const remotes = await bridge().request<RemoteInfo[]>({ type: 'remotes', payload: { workspace_id: wid, repo_id: repoId } }, { showProgress: false });
        const target = remote ? remotes.find((item) => item.name === remote) : remotes[0];
        const pr = target ? buildPullRequestUrl(target.pushUrl || target.fetchUrl || '', branch) : undefined;
        get().addNotification({
          type: 'success', title: 'Branch Pushed', workspaceId: wid,
          message: pr
            ? { key: 'VersionDock [{0}]: Branch "{1}" pushed to {2}.', args: [repo.meta.name, branch, pr.platform] }
            : { key: 'VersionDock [{0}]: Branch "{1}" pushed successfully to "{2}".', args: [repo.meta.name, branch, remote ?? target?.name ?? 'remote'] },
          actions: pr ? [{ type: 'openExternal', label: 'Create Pull Request', url: pr.url }, { type: 'dismiss', label: 'Dismiss' }] : [],
        });
      } catch {
        // Failure to build a convenience link must not turn a successful push into a failed operation.
      }
    },

    fetchRepositories: async (repoIds, notifyCompletion = true, targetWorkspaceId) => {
      const wid = targetWorkspaceId ?? get().snapshot?.workspace.id;
      if (!wid) return;
      const current = get().snapshot?.workspace.id === wid ? get().snapshot : get().sessions[wid]?.snapshot;
      const repositories = (get().snapshot?.workspace.id === wid && get().allRepositories.length ? get().allRepositories : current?.repositories ?? [])
        .filter((repo) => repoIds.includes(repo.meta.id) && repo.meta.kind === 'git' && !repo.meta.isWorktree);
      if (!repositories.length) return;
      const message: NotificationText = repositories.length === 1
        ? { key: 'VersionDock [{0}]: Fetching all remotes…', args: [repositories[0].meta.name] }
        : 'VersionDock: Fetching all remotes…';
      const progressId = get().addNotification({ type: 'info', title: 'Fetch All', message, workspaceId: wid, progress: true });
      const taskProgress = useTaskProgressStore.getState();
      const taskId = taskProgress.beginGroup('Fetch All', wid, current?.workspace.name ?? 'VersionDock', repositories.map((repo) => ({ id: repo.meta.id, name: repo.meta.name })));
      try {
        const results = await Promise.allSettled(repositories.map(async (repo) => {
          if (taskProgress.isStopped(taskId)) return;
          try {
            await get().sync(repo.meta.id, 'fetch', true, { rethrow: true, showProgress: false, onOperationId: (id) => taskProgress.bindChild(taskId, repo.meta.id, id) }, wid);
            taskProgress.completeChild(taskId, repo.meta.id, 'succeeded');
          } catch (error) {
            taskProgress.completeChild(taskId, repo.meta.id, isAbortError(error) ? 'cancelled' : 'failed', isAbortError(error) ? undefined : errorText(error));
            throw error;
          }
        }));
        if (get().snapshot?.workspace.id === wid) await get().refresh(true);
        if (!taskProgress.isStopped(taskId) && notifyCompletion && results.every((result) => result.status === 'fulfilled')) get().addNotification({
          type: 'info', title: 'Fetch All', workspaceId: wid,
          message: repositories.length === 1 ? { key: 'VersionDock [{0}]: Fetch complete.', args: [repositories[0].meta.name] } : 'VersionDock: Fetch complete.',
        });
      } finally {
        get().removeNotification(progressId);
        taskProgress.finishGroup(taskId);
      }
    },

    sync: async (repoId, action, notify = true, options = {}, targetWorkspaceId) => {
      const wid = targetWorkspaceId ?? get().snapshot?.workspace.id ?? workspaceId();
      return withBusy(async () => {
        const capability = action === 'fetch' ? 'syncFetch' : action === 'push' || action === 'pushTags' ? 'syncPush' : action === 'update' ? 'sync' : 'syncPull';
        if (!ensureRepositoryCapability(repoId, capability, wid)) {
          if (options.rethrow) throw new Error(`Capability ${capability} unavailable`);
          return undefined;
        }
        let result: SyncResult;
        // Manual fetch keeps its existing silent notification behavior, while the
        // independent task entry still tracks the foreground operation.
        const onOperationId = options.onOperationId ?? (action === 'fetch' && notify && options.showProgress !== false
          ? (id: string) => useTaskProgressStore.getState().trackForegroundRequest(id) : undefined);
        try {
          result = await bridge().request<SyncResult>({ type: 'sync', payload: { workspace_id: wid, repo_id: repoId, action, remote: options.remote ?? null, branch: options.branch ?? null, force: options.force ?? false } }, { timeoutMs: 600_000, showProgress: action === 'fetch' ? false : (options.showProgress ?? notify), onOperationId });
        } catch (error) {
          if (error instanceof BridgeError) await notifyUpdateRestoreWarning(error.restoreWarning, wid, repoId);
          if (await handlePullAutoStashError(error, wid)) {
            if (options.rethrow) throw error;
            return undefined;
          }
          throw error;
        }
        await notifyUpdateRestoreWarning(result.restoreWarning, wid, repoId);
        if (notify && action === 'fetch') {
          const refs = await bridge().request<BranchInfo[]>({ type: 'branches', payload: { workspace_id: wid, repo_id: repoId } }, { showProgress: false }).catch(() => []);
          notifyGoneBranches(repoId, refs, wid);
        }
        if (notify && action === 'push') await get().notifyPushSuccess(repoId, wid, options.remote, options.branch);
        if (notify && result.update) {
          const summary = result.update.summary;
          const commitCount = summary?.commitCount ?? 0;
          const fileCount = summary?.fileCount ?? 0;
          const message: NotificationText = result.update.summaryError
            ? { key: 'VersionDock: Update completed, but update details could not be calculated for {0} repositories.', args: [1] }
            : summary?.kind === 'noChanges'
              ? 'VersionDock: Already up to date. No files updated.'
              : { key: 'VersionDock: Updated {0} files in {1} commits.', args: [fileCount, commitCount] };
          get().addNotification({
            type: result.update.summaryError ? 'warning' : 'success',
            title: 'Repository update',
            message,
            workspaceId: wid,
            actions: commitCount ? [{ type: 'viewUpdateDetails', label: 'View update details', result: result.update }] : [],
          });
        }
        if (action !== 'update') {
          await Promise.all([get().loadUnpushedCommits(repoId, wid), get().loadIncomingCommits(repoId, wid)]);
        }
        return result.update ?? undefined;
      }, `sync:${repoId}`, { workspaceId: wid, repositoryId: repoId, remote: options.remote, branch: options.branch }, {
        rethrow: options.rethrow,
        notifyError: action !== 'fetch' || notify || Boolean(options.rethrow),
        // Automatic fetch runs silently, as in the plugin, without disabling
        // sync or commit actions. Manual fetch and all writes retain their guard.
        trackBusy: action !== 'fetch' || notify,
      });
    },

    updateProject: async (strategy) => {
      const repositories = (get().allRepositories.length ? get().allRepositories : (get().snapshot?.repositories ?? [])).filter((repo) => !repo.meta.isWorktree);
      const wid = get().snapshot?.workspace.id;
      if (!wid || !repositories.length) return;
      const currentSettings = settings();
      const t = createTranslator(resolveLanguage(currentSettings.language));
      if (!strategy && repositories.some((repo) => repo.meta.kind === 'git')) {
        const configuredMethod = currentSettings.updateProjectMethod ?? 'rebase';
        if (configuredMethod === 'prompt') {
          const selected = await choiceDialog({
            title: t('Update Project — Strategy'),
            message: t('Choose how incoming Git changes are integrated.'),
            choices: [
              { id: 'rebase', label: t('Rebase the current branch on top of incoming changes'), icon: 'repo-forked' },
              { id: 'merge', label: t('Merge incoming changes into the current branch'), icon: 'git-merge' },
            ],
          });
          if (!selected) return;
          strategy = selected === 'rebase' ? 'rebase' : 'merge';
        } else {
          strategy = configuredMethod;
        }
      }
      if (get().snapshot?.workspace.id !== wid) return;
      const releaseStableRefresh = holdWorkingTreeRefresh(wid);
      const gitAction: 'pull' | 'pullRebase' = strategy === 'rebase' ? 'pullRebase' : 'pull';
      const count = repositories.length;
      const progressTitle: NotificationText = count === 1
        ? { key: 'VersionDock [{0}]: Updating project…', args: [repositories[0].meta.name] }
        : 'VersionDock: Updating all projects…';

      const progressId = get().addNotification({
        type: 'info',
        title: 'Updating Project',
        message: progressTitle,
        workspaceId: wid,
        progress: true,
        progressValue: 0,
      });

      const taskProgress = useTaskProgressStore.getState();
      const taskId = taskProgress.beginGroup('Update Project', wid, get().snapshot!.workspace.name, repositories.map((repo) => ({ id: repo.meta.id, name: repo.meta.name })));
      let completedCount = 0;
      const reportProgress = (repoName: string, complete = false) => {
        if (complete) completedCount++;
        const progressMsg: NotificationText = {
          key: '({0}/{1}) {2}',
          args: [Math.min(completedCount + (complete ? 0 : 1), count), count, repoName],
        };
        const progressValue = count > 0 ? Math.round((completedCount / count) * 100) : 100;
        set((state) => ({
          notifications: state.notifications.map((n) =>
            n.id === progressId ? { ...n, progressMessage: progressMsg, progressValue } : n
          ),
        }));
      };

      const settled: Array<{ repoId: string; repoName: string; result?: RepositoryUpdateResult; output?: string; error?: string; details?: string; conflict?: boolean }> = [];
      try {
        for (const repo of repositories) {
          if (taskProgress.isStopped(taskId)) break;
          reportProgress(repo.meta.name);
          try {
            const value = await bridge().request<SyncResult>({
              type: 'sync',
              payload: {
                workspace_id: wid,
                repo_id: repo.meta.id,
                action: repo.meta.kind === 'git' ? gitAction : 'update',
                remote: null,
                branch: null,
              },
            }, { timeoutMs: 45_000, timeoutGraceMs: 1_000, onOperationId: (id) => taskProgress.bindChild(taskId, repo.meta.id, id) });
            await notifyUpdateRestoreWarning(value.restoreWarning, wid, repo.meta.id);
            taskProgress.completeChild(taskId, repo.meta.id, 'succeeded');
            reportProgress(repo.meta.name, true);
            settled.push({ repoId: repo.meta.id, repoName: repo.meta.name, result: value.update ?? undefined, output: value.output, error: undefined });
          }
          catch (error) {
            if (error instanceof BridgeError) await notifyUpdateRestoreWarning(error.restoreWarning, wid, repo.meta.id);
            taskProgress.completeChild(taskId, repo.meta.id, isAbortError(error) ? 'cancelled' : 'failed', isAbortError(error) ? undefined : errorText(error));
            reportProgress(repo.meta.name, true);
            if (taskProgress.isStopped(taskId) && isAbortError(error)) break;
            await handlePullAutoStashError(error, wid);
            const timedOut = error instanceof BridgeError && error.code === 'REQUEST_TIMEOUT';
            // Raw command output matches the plugin's failure message. Semantic
            // errors (conflicts/recovery) retain their actionable message.
            const message = timedOut
              ? [t('Operation timed out after 45 seconds.'), error.stderr?.trim()].filter(Boolean).join('\n')
              : error instanceof BridgeError && error.stderr?.trim() && error.message === error.stderr.split('\n')[0]
                ? error.stderr.trim() : errorText(error);
            settled.push({ repoId: repo.meta.id, repoName: repo.meta.name, conflict: error instanceof BridgeError && error.restoreWarning?.conflicted === true, error: message, details: errorDetails(error) });
          }
        }
        releaseStableRefresh();
        if (get().snapshot?.workspace.id === wid) await get().refresh();
        if (taskProgress.isStopped(taskId)) return;

        // 移除临时进度通知，避免污染通知历史
        get().dismissToast(progressId);
        set((state) => ({
          notifications: state.notifications.filter((n) => n.id !== progressId),
        }));
        const updated = settled.filter((item) => !repositories.find((repo) => repo.meta.id === item.repoId)?.meta.isSubmodule).flatMap((item) => item.result ? [item.result] : []);
        const commits = updated.reduce((sum, item) => sum + (item.summary?.commitCount ?? 0), 0);
        const files = updated.reduce((sum, item) => sum + (item.summary?.fileCount ?? 0), 0);
        const failedItems = settled.filter((item) => item.error);
        const failed = failedItems.length;
        const summaryFailures = updated.filter((item) => item.summaryError).length;
        const failureDescription = failedItems.map((item) => `${item.repoName}: ${item.error}`).join('; ');
        const updatedRepoCount = new Set(updated.flatMap((item) => item.summary?.detail.commits.map((commit) => commit.repoId) ?? [])).size;
        const updatedRepoId = updated.flatMap((item) => item.summary?.detail.commits ?? [])[0]?.repoId;
        const singleRepoName = settled.length === 1 ? settled[0]?.repoName : updatedRepoCount === 1
          ? repositories.find((repo) => repo.meta.id === updatedRepoId)?.meta.name ?? updatedRepoId
          : undefined;
        const isNoUpstream = (item: { output?: string; error?: string }) =>
          /no remote tracking branch|no upstream|tracking information/i.test(item.output ?? '') ||
          /no remote tracking branch|no upstream|tracking information/i.test(item.error ?? '');
        const noUpstreamItem = settled.find((item) => !repositories.find((repo) => repo.meta.id === item.repoId)?.meta.isSubmodule && isNoUpstream(item));
        const message: NotificationText = updated.length === 0 && failed > 0
          ? (settled.length === 1 && failedItems[0]
              ? { key: 'VersionDock [{0}]: Update failed: {1}', args: [failedItems[0].repoName, failedItems[0].error ?? ''] }
              : { key: 'VersionDock: Update failed: {0}', args: [failureDescription] })
          : failed > 0
            ? { key: 'VersionDock: {0} repositories updated, {1} failed; {2} files changed in {3} commits. {4}', args: [updated.length, failed, files, commits, failureDescription] }
          : summaryFailures > 0
            ? commits > 0
              ? { key: 'VersionDock: Updated {0} files in {1} commits; details could not be calculated for {2} repositories.', args: [files, commits, summaryFailures] }
              : { key: 'VersionDock: Update completed, but update details could not be calculated for {0} repositories.', args: [summaryFailures] }
            : commits > 0
              ? updatedRepoCount > 1
                ? { key: 'VersionDock: {0} repositories updated {1} files in {2} commits.', args: [updatedRepoCount, files, commits] }
                : singleRepoName
                  ? { key: 'VersionDock [{0}]: Updated {1} files in {2} commits.', args: [singleRepoName, files, commits] }
                  : { key: 'VersionDock: Updated {0} files in {1} commits.', args: [files, commits] }
              : noUpstreamItem
                ? (settled.length === 1
                    ? { key: 'VersionDock [{0}]: Update skipped because the current branch has no remote tracking branch.', args: [noUpstreamItem.repoName] }
                    : 'VersionDock: Update skipped because the current branch has no remote tracking branch.')
                : settled.length === 1
                  ? { key: 'VersionDock [{0}]: Already up to date. No files updated.', args: [settled[0].repoName] }
                  : 'VersionDock: Already up to date. No files updated.';
        const detailed = updated.filter((item) => (item.summary?.commitCount ?? 0) > 0);
        if (failed === 0 && summaryFailures === 0 && commits > 0 && (currentSettings.updateProjectShowNotification ?? true) === false) {
          return;
        }
        const hasConflict = failedItems.some((r) => r.conflict || /conflict|冲突/i.test(r.error ?? ''));

        const actions: AppNotificationAction[] = [
          ...(hasConflict ? [{ type: 'openConflicts' as const, label: 'Resolve Conflicts' }] : []),
          ...(noUpstreamItem && failed === 0 && summaryFailures === 0 && commits === 0 ? [{ type: 'pushToRemote' as const, label: 'Push to Remote', repoId: noUpstreamItem.repoId }] : []),
          ...(detailed.length ? [{ type: 'viewUpdateResults' as const, label: 'View update details', results: detailed }] : []),
        ];

        get().addNotification({
          type: updated.length === 0 && failed > 0 ? 'error' : failed || summaryFailures || (noUpstreamItem && commits === 0) ? 'warning' : 'info',
          urgent: failed > 0,
          title: message,
          message,
          details: failed ? failedItems.map((item) => `${item.repoName}: ${item.details ?? item.error}`).join('\n\n') : undefined,
          workspaceId: wid,
          actions,
        });
      } finally {
        get().removeNotification(progressId);
        taskProgress.finishGroup(taskId);
        releaseStableRefresh();
      }
    },

    openUpdateDetails: async (result) => {
      const commits = result.summary?.detail.commits ?? [];
      if (!commits.length) return;
      const details = await mapWithConcurrency(commits, 4, (commit) => get().loadCommitDetail(commit));
      const byKey = Object.fromEntries(details.map(detail => {
        const key = commitKey(detail.commit.repoId, detail.commit.hash);
        return [key, get().selectedCommitDetails[key] ?? detail];
      }));
      const { hadPathFilter, historyScope, historyQuery, historyFilter } = resetHistoryPathFilterState(get());
      set({
        selectedCommits: commits,
        selectedPrimaryKey: commitKey(commits[0].repoId, commits[0].hash),
        commitSelectionAnchorKey: commitKey(commits[0].repoId, commits[0].hash),
        selectedCommit: byKey[commitKey(commits[0].repoId, commits[0].hash)],
        selectedCommitDetails: { ...get().selectedCommitDetails, ...byKey },
        historyScope,
        historyQuery,
        historyFilter,
      });
      if (hadPathFilter) {
        void get().loadHistory(true);
      }
      if (commits.length === 1) get().openCommitDetail(); else get().openCommitChanges();
    },
    openUpdateResults: async (results) => {
      const commits = results.flatMap((result) => result.summary?.detail.commits ?? []);
      if (!commits.length) return;
      const details = await mapWithConcurrency(commits, 4, (commit) => get().loadCommitDetail(commit));
      const byKey = Object.fromEntries(details.map(detail => {
        const key = commitKey(detail.commit.repoId, detail.commit.hash);
        return [key, get().selectedCommitDetails[key] ?? detail];
      }));
      const { hadPathFilter, historyScope, historyQuery, historyFilter } = resetHistoryPathFilterState(get());
      set({
        selectedCommits: commits,
        selectedPrimaryKey: commitKey(commits[0].repoId, commits[0].hash),
        commitSelectionAnchorKey: commitKey(commits[0].repoId, commits[0].hash),
        selectedCommit: byKey[commitKey(commits[0].repoId, commits[0].hash)],
        selectedCommitDetails: { ...get().selectedCommitDetails, ...byKey },
        historyScope,
        historyQuery,
        historyFilter,
      });
      if (hadPathFilter) {
        void get().loadHistory(true);
      }
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
        if (reset) {
          abortHistoryRequests();
          set({ history: [], historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMore: false, historyHasMoreByRepo: {}, historyRepoErrors: {}, historyLoading: false, historyTopologyLoading: false });
        }
        return;
      }
      if (!reset && get().historyLoading) return;
      const historyMaxCommits = settings().maximumGraphCommits;
      if (!reset && get().history.length >= historyMaxCommits) {
        set({ historyHasMore: false });
        return;
      }
      const pageGeneration = ++historyPageGeneration;
      const requestWorkspace = workspaceId();
      const pageController = beginRequest('history:page');
      const visibleLimit = Math.min((reset ? 0 : get().history.length) + HISTORY_PAGE_SIZE, historyMaxCommits);
      if (!silent) set({ historyLoading: true });
      if (reset) {
        set({ historyTopologyByRepo: {}, historyTopology: [] });
      }
      try {
        // VersionDock fetches the prefix needed from every repository using allSettled,
        // so that a single repository failure does not crash the entire workspace log.
        const pageSettled = await Promise.allSettled(repos.map(async (repo) => {
          const page = await bridge().request<HistoryPage>({
            type: 'history',
            payload: {
              workspace_id: requestWorkspace,
              repo_id: repo.meta.id,
              skip: 0,
              limit: visibleLimit,
              query: { ...get().historyQuery, text: get().historyFilter || get().historyQuery.text, revision: scope.revisionsByRepo[repo.meta.id] ?? null },
            },
          }, { signal: pageController.signal, showProgress: false });
          return { repoId: repo.meta.id, page };
        }));

        if (pageGeneration !== historyPageGeneration || get().snapshot?.workspace.id !== requestWorkspace) return;

        const repoErrors: Record<string, string> = reset ? {} : { ...(get().historyRepoErrors ?? {}) };
        const pages: Array<{ repoId: string; page: HistoryPage }> = [];
        for (let i = 0; i < pageSettled.length; i++) {
          const res = pageSettled[i];
          const repo = repos[i];
          if (res.status === 'fulfilled') {
            pages.push(res.value);
            delete repoErrors[repo.meta.id];
          } else {
            if (isAbortError(res.reason)) return;
            const errorMsg = res.reason instanceof Error ? res.reason.message : String(res.reason);
            repoErrors[repo.meta.id] = errorMsg;
          }
        }

        if (pages.length === 0 && repos.length > 0) {
          const firstErr = Object.values(repoErrors)[0];
          publishError('History loading failed', new Error(firstErr || 'Failed to load history'));
          set({ historyRepoErrors: repoErrors, historyLoading: false });
          return;
        }

        const nextByRepo: Record<string, CommitNode[]> = reset ? {} : { ...get().historyByRepo };
        const nextHasMore: Record<string, boolean> = reset ? {} : { ...get().historyHasMoreByRepo };
        for (const { repoId, page } of pages) {
          nextByRepo[repoId] = page.commits;
          nextHasMore[repoId] = page.hasMore;
        }
        const mergedHistory = interleaveHistory(nextByRepo);
        const history = mergedHistory.slice(0, visibleLimit);
        const historyHasMore = visibleLimit < historyMaxCommits
          && (mergedHistory.length > visibleLimit || Object.values(nextHasMore).some(Boolean));

        // 提交列表就绪后立即展示，先行渲染出首屏列表，并立即清除 historyLoading 状态允许分页滚动！
        set({
          historyByRepo: nextByRepo,
          historyHasMoreByRepo: nextHasMore,
          history,
          historyHasMore,
          historyRepoErrors: repoErrors,
          historyLoading: false,
        });

        // Match the plugin: start selected-file loading as soon as the log page
        // is visible, before refs, auxiliary tabs or topology finish loading.
        if (history[0] && get().mode === 'history' && !get().selectedCommits.length) void get().selectCommit(history[0]);

        // 异步后台加载图谱拓扑并限制最大抓取量，拓扑返回后平滑更新泳道排线
        // 使用独立的 topologyGeneration 与 'history:topology' 控制器，绝不与后续滚动分页冲突
        const breaking = get().historyQuery.text || get().historyQuery.author || get().historyQuery.fromDate || get().historyQuery.toDate || get().historyQuery.path || get().historyQuery.lineRange;
        if (reset && !breaking) {
          const topologyGeneration = ++historyTopologyGeneration;
          const topologyController = beginRequest('history:topology');
          set({ historyTopologyLoading: true });
          const topologyLimit = Math.max(historyMaxCommits, 2000);
          try {
            const topologyResults = await Promise.allSettled(repos.map(async (repo) => ({
              repoId: repo.meta.id,
              commits: await bridge().request<GraphCommitNode[]>({
                type: 'historyTopology',
                payload: {
                  workspace_id: requestWorkspace,
                  repo_id: repo.meta.id,
                  limit: topologyLimit,
                  svn_limit: 1000,
                  revision: scope.revisionsByRepo[repo.meta.id] ?? null,
                },
              }, { signal: topologyController.signal, showProgress: false }).catch((error) => isAbortError(error) ? Promise.reject(error) : []),
            })));

            if (topologyGeneration === historyTopologyGeneration && get().snapshot?.workspace.id === requestWorkspace) {
              const historyTopologyByRepo: Record<string, GraphCommitNode[]> = {};
              for (const res of topologyResults) {
                if (res.status === 'fulfilled') {
                  historyTopologyByRepo[res.value.repoId] = res.value.commits;
                }
              }
              set({
                historyTopologyByRepo,
                historyTopology: interleaveLogs(historyTopologyByRepo),
              });
            }
          } catch (error) {
            if (!isAbortError(error)) {
              // Topology 加载失败仅降级为按列表排线，不影响列表渲染
            }
          } finally {
            if (topologyGeneration === historyTopologyGeneration) {
              set({ historyTopologyLoading: false });
            }
          }
        }
      } catch (error) {
        if (!isAbortError(error)) {
          publishError('History loading failed', error);
          throw error;
        }
      } finally {
        if (!silent && pageGeneration === historyPageGeneration) set({ historyLoading: false });
      }
    },

    setHistoryFilter: (value) => {
      abortHistoryRequests();
      set((state) => ({ historyFilter: value, historyQuery: { ...state.historyQuery, text: value || null }, historyLoading: false, historyTopologyLoading: false }));
    },
    revealHistoryCommit: (repoId, hash) => {
      const wid = get().snapshot?.workspace.id;
      if (!wid) return;
      get().backToHistory();
      set({ mode: 'history', diffReturnMode: undefined, historyRevealTarget: { workspaceId: wid, repoId, hash } });
    },
    setHistoryQuery: (historyQuery) => {
      abortHistoryRequests();
      if (!historyQuery.path) { historyPathPreviousScope = undefined; historyPathPreviousQuery = undefined; }
      set({ historyQuery, historyFilter: historyQuery.text ?? '', history: [], historyByRepo: {}, historyHasMore: false, historyTopology: [], historyTopologyByRepo: {}, historyLoading: false, historyTopologyLoading: false });
    },
    openHistoryForPath: async (repoId, path) => {
      abortHistoryRequests();
      if (!get().historyQuery.path) {
        historyPathPreviousScope = get().historyScope;
        historyPathPreviousQuery = get().historyQuery;
      }
      set((state) => ({
        historyScope: { repoIds: [repoId], revisionsByRepo: {} },
        historyQuery: { ...state.historyQuery, path, lineRange: null, revision: null },
        selectedRepoId: repoId,
        mode: 'history',
      }));
      await get().loadHistory(true);
    },
    openHistoryForLineRange: async (repoId, path, lineRange, revision) => {
      abortHistoryRequests();
      if (!get().historyQuery.path) {
        historyPathPreviousScope = get().historyScope;
        historyPathPreviousQuery = get().historyQuery;
      }
      const targetRevision = normalizeHistoryRevision(revision);
      set((state) => {
        const nextRevisions = targetRevision
          ? { [repoId]: targetRevision }
          : {};
        return {
          historyScope: { repoIds: [repoId], revisionsByRepo: nextRevisions },
          historyQuery: { ...state.historyQuery, path, lineRange, revision: targetRevision ?? null },
          selectedRepoId: repoId,
          mode: 'history',
        };
      });
      await get().loadHistory(true);
    },
    clearHistoryPath: async () => {
      abortHistoryRequests();
      const { historyScope, historyQuery } = get();
      const revisionsByRepo = { ...historyScope.revisionsByRepo };
      if (historyQuery.lineRange && historyQuery.revision) {
        for (const [repoId, revision] of Object.entries(revisionsByRepo)) {
          if (revision === historyQuery.revision) delete revisionsByRepo[repoId];
        }
      }
      historyPathPreviousScope = undefined;
      historyPathPreviousQuery = undefined;
      set({ historyScope: { ...historyScope, revisionsByRepo }, historyQuery: { ...historyQuery, path: null, lineRange: null, revision: null } });
      await get().loadHistory(true);
    },
    setHistoryScope: (historyScope) => set({ historyScope }),

    loadCommitDetail: async (commit, force = false) => {
      const key = commitKey(commit.repoId, commit.hash);
      const targetWorkspaceId = workspaceId();
      if (!force) {
        const isCurrent = (get().snapshot?.workspace.id ?? get().activeTabId ?? '') === targetWorkspaceId;
        const cached = isCurrent ? get().selectedCommitDetails[key] : get().sessions[targetWorkspaceId]?.selectedCommitDetails[key];
        if (cached) {
          if (cached.branchesPending) void enrichCommitBranches(targetWorkspaceId, key, cached);
          return cached;
        }
      }
      const branchesRequestKey = `commit-branches:${targetWorkspaceId}:${key}`;
      requestControllers.get(branchesRequestKey)?.abort();
      requestControllers.delete(branchesRequestKey);
      const isCurrentInitial = (get().snapshot?.workspace.id ?? get().activeTabId ?? '') === targetWorkspaceId;
      if (isCurrentInitial) {
        set((state) => ({
          selectedCommitLoading: { ...state.selectedCommitLoading, [key]: true },
          selectedCommitError: { ...state.selectedCommitError, [key]: '' },
        }));
      } else {
        const targetSession = get().sessions[targetWorkspaceId];
        if (targetSession) {
          set((state) => ({
            sessions: {
              ...state.sessions,
              [targetWorkspaceId]: {
                ...targetSession,
                selectedCommitLoading: { ...targetSession.selectedCommitLoading, [key]: true },
                selectedCommitError: { ...targetSession.selectedCommitError, [key]: '' },
              },
            },
          }));
        }
      }

      const requestKey = `commit-detail:${targetWorkspaceId}:${key}`;
      const controller = beginRequest(requestKey);
      try {
        const detail = await bridge().request<CommitDetail>(
          { type: 'commitDetail', payload: { workspace_id: targetWorkspaceId, repo_id: commit.repoId, revision: commit.hash } },
          { signal: controller.signal },
        );
        const hasExtraRefs = commit.refs?.some((ref) => !(detail.commit?.refs ?? []).includes(ref));
        let mergedDetail = detail;
        if (hasExtraRefs || detail.branchesPending) {
          const resolvedRefs = Array.from(new Set([...(commit.refs ?? []), ...(detail.commit?.refs ?? [])]));
          const localBranches = new Set(detail.branches?.local ?? []);
          const remoteBranches = new Set(detail.branches?.remote ?? []);
          const tags = new Set(detail.branches?.tags ?? []);
          let isHead = Boolean(detail.branches?.isHead);

          for (const raw of resolvedRefs) {
            if (raw === 'HEAD') {
              isHead = true;
            } else if (raw.startsWith('HEAD -> ')) {
              isHead = true;
              const branch = raw.slice('HEAD -> '.length).replace(/^refs\/heads\//, '').trim();
              if (branch) localBranches.add(branch);
            } else if (raw.startsWith('tag: ') || raw.startsWith('refs/tags/')) {
              const tag = raw.replace(/^(tag:\s*|refs\/tags\/)/, '').replace(/^refs\/tags\//, '').trim();
              if (tag) tags.add(tag);
            } else if (raw.startsWith('refs/remotes/')) {
              const rem = raw.slice('refs/remotes/'.length).trim();
              if (rem) remoteBranches.add(rem);
            } else if (raw.startsWith('refs/heads/')) {
              const loc = raw.slice('refs/heads/'.length).trim();
              if (loc) localBranches.add(loc);
            } else if (raw === 'BASE') {
              // SVN BASE marker: keep in commit.refs, not a branch or tag
            } else if (raw.includes('/')) {
              // Remote-style branch, e.g. origin/main
              remoteBranches.add(raw.trim());
            } else {
              // Local branch name, e.g. main, feature-x
              const loc = raw.trim();
              if (loc) localBranches.add(loc);
            }
          }

          mergedDetail = {
            ...detail,
            commit: {
              ...detail.commit,
              refs: resolvedRefs,
            },
            branches: {
              local: Array.from(localBranches),
              remote: Array.from(remoteBranches),
              tags: Array.from(tags),
              ...(isHead || detail.branches?.isHead !== undefined ? { isHead } : {}),
            },
          };
        }

        const isCurrent = isCurrentRequest(requestKey, controller);
        if (isCurrent) {
          endRequest(requestKey, controller);
        }

        const isCurrentWorkspace = (get().snapshot?.workspace.id ?? get().activeTabId ?? '') === targetWorkspaceId;
        if (isCurrentWorkspace) {
          set((state) => {
            const nextLoading = isCurrent ? { ...state.selectedCommitLoading } : state.selectedCommitLoading;
            if (isCurrent) delete (nextLoading as Record<string, boolean>)[key];
            const nextError = isCurrent ? { ...state.selectedCommitError } : state.selectedCommitError;
            if (isCurrent) delete (nextError as Record<string, string>)[key];
            return {
              selectedCommitDetails: { ...state.selectedCommitDetails, [key]: mergedDetail },
              selectedCommitLoading: nextLoading,
              selectedCommitError: nextError,
              selectedCommit: state.selectedPrimaryKey === key ? mergedDetail : state.selectedCommit,
            };
          });
        } else {
          const targetSession = get().sessions[targetWorkspaceId];
          if (targetSession) {
            set((state) => {
              const nextLoading = isCurrent ? { ...targetSession.selectedCommitLoading } : targetSession.selectedCommitLoading;
              if (isCurrent) delete (nextLoading as Record<string, boolean>)[key];
              const nextError = isCurrent ? { ...targetSession.selectedCommitError } : targetSession.selectedCommitError;
              if (isCurrent) delete (nextError as Record<string, string>)[key];
              return {
                sessions: {
                  ...state.sessions,
                  [targetWorkspaceId]: {
                    ...targetSession,
                    selectedCommitDetails: { ...targetSession.selectedCommitDetails, [key]: mergedDetail },
                    selectedCommitLoading: nextLoading,
                    selectedCommitError: nextError,
                    selectedCommit: targetSession.selectedPrimaryKey === key ? mergedDetail : targetSession.selectedCommit,
                  },
                },
              };
            });
          }
        }
        if (isCurrent && !controller.signal.aborted && mergedDetail.branchesPending) void enrichCommitBranches(targetWorkspaceId, key, mergedDetail);
        return mergedDetail;
      } catch (error) {
        const isCurrent = isCurrentRequest(requestKey, controller);
        if (!isCurrent) {
          throw error;
        }
        endRequest(requestKey, controller);

        const isCurrentWorkspace = (get().snapshot?.workspace.id ?? get().activeTabId ?? '') === targetWorkspaceId;
        const aborted = isAbortError(error);
        const errorMessage = errorText(error);

        if (isCurrentWorkspace) {
          set((state) => {
            const nextLoading = { ...state.selectedCommitLoading };
            delete nextLoading[key];
            const nextError = aborted ? state.selectedCommitError : { ...state.selectedCommitError, [key]: errorMessage };
            return {
              selectedCommitLoading: nextLoading,
              selectedCommitError: nextError,
            };
          });
          if (!aborted) {
            publishError('Commit detail loading failed', error, targetWorkspaceId);
          }
        } else {
          const targetSession = get().sessions[targetWorkspaceId];
          if (targetSession) {
            set((state) => {
              const nextLoading = { ...targetSession.selectedCommitLoading };
              delete nextLoading[key];
              const nextError = aborted ? targetSession.selectedCommitError : { ...targetSession.selectedCommitError, [key]: errorMessage };
              return {
                sessions: {
                  ...state.sessions,
                  [targetWorkspaceId]: {
                    ...targetSession,
                    selectedCommitLoading: nextLoading,
                    selectedCommitError: nextError,
                  },
                },
              };
            });
          }
        }
        throw error;
      }
    },

    // Selecting a commit only reads details. Its own loading state must not
    // temporarily disable sync actions as a history rewrite would.
    selectCommit: async (commit, mode = 'single', rangeSource) => withBusy(async () => {
      const state = get();
      const clickedKey = commitKey(commit.repoId, commit.hash);
      const source = rangeSource ?? state.history;
      let selected: CommitNode[];
      let anchorKey = state.commitSelectionAnchorKey ?? state.selectedPrimaryKey ?? clickedKey;
      if (mode === 'single') {
        selected = [commit];
        anchorKey = clickedKey;
      } else if (mode === 'toggle') {
        const selectedKeys = new Set(state.selectedCommits.map((item) => commitKey(item.repoId, item.hash)));
        if (selectedKeys.has(clickedKey)) selectedKeys.delete(clickedKey);
        else selectedKeys.add(clickedKey);
        if (selectedKeys.size === 0) selectedKeys.add(clickedKey);
        selected = source.filter((item) => selectedKeys.has(commitKey(item.repoId, item.hash)));
        if (!selectedKeys.has(anchorKey)) anchorKey = clickedKey;
      } else {
        const anchorIndex = source.findIndex((item) => commitKey(item.repoId, item.hash) === anchorKey);
        const clickedIndex = source.findIndex((item) => commitKey(item.repoId, item.hash) === clickedKey);
        if (anchorIndex < 0 || clickedIndex < 0) { selected = [commit]; anchorKey = clickedKey; }
        else {
          const start = Math.min(anchorIndex, clickedIndex);
          const end = Math.max(anchorIndex, clickedIndex);
          selected = source.slice(start, end + 1);
        }
      }

      const primary = selected.length ? (selected.find((item) => commitKey(item.repoId, item.hash) === clickedKey) ?? selected[selected.length - 1]) : undefined;
      const primaryKey = primary ? commitKey(primary.repoId, primary.hash) : undefined;
      const selectionChanged = primaryKey !== state.selectedPrimaryKey
        || selected.length !== state.selectedCommits.length
        || selected.some((item, index) => commitKey(item.repoId, item.hash) !== commitKey(state.selectedCommits[index].repoId, state.selectedCommits[index].hash));
      if (selectionChanged) {
        diffRequestGeneration += 1;
        requestControllers.get('diff')?.abort();
      }
      const generation = ++commitSelectionGeneration;
      const targetWorkspaceId = workspaceId();
      const loading = Object.fromEntries(selected.filter((item) => !state.selectedCommitDetails[commitKey(item.repoId, item.hash)]).map((item) => [commitKey(item.repoId, item.hash), true]));
      set({ selectedCommits: selected, selectedPrimaryKey: primaryKey, commitSelectionAnchorKey: anchorKey, ...(selectionChanged ? { selectedFile: undefined, diff: undefined } : {}), selectedCommit: primaryKey ? state.selectedCommitDetails[primaryKey] : undefined, selectedCommitLoading: loading, selectedCommitError: {}, changes: undefined, changesDiff: undefined, mode: 'history', diffReturnMode: undefined });
      const missing = selected.filter((item) => !state.selectedCommitDetails[commitKey(item.repoId, item.hash)]);
      const results = await mapWithConcurrency(missing, 4, async (item) => {
        try {
          const detail = await get().loadCommitDetail(item);
          return { key: commitKey(item.repoId, item.hash), detail };
        } catch {
          return null;
        }
      });
      if (generation !== commitSelectionGeneration) return;
      const isCurrentWorkspace = (get().snapshot?.workspace.id ?? get().activeTabId ?? '') === targetWorkspaceId;
      if (isCurrentWorkspace) {
        const details = { ...get().selectedCommitDetails };
        for (const res of results) {
          if (res) details[res.key] ??= res.detail;
        }
        set({
          selectedCommitDetails: details,
          selectedCommit: primaryKey ? details[primaryKey] : undefined,
          selectedCommitLoading: {},
        });
        if (primary?.parents.length && primary.parents.length >= 2) void get().loadMergeCommits(primary);
      }
    }, `history:${commit.repoId}`, undefined, { trackBusy: false }),

    reloadSelectedCommits: async (requestedWorkspaceId?: string) => {
      const activeWorkspaceId = get().snapshot?.workspace.id ?? get().activeTabId ?? '';
      if (requestedWorkspaceId && activeWorkspaceId !== requestedWorkspaceId) return;
      const state = get();
      const selected = state.selectedCommits;
      if (!selected.length) return;
      const targetWorkspaceId = requestedWorkspaceId ?? workspaceId();
      const generation = ++commitSelectionGeneration;
      const primary = state.selectedPrimaryKey
        ? selected.find((item) => commitKey(item.repoId, item.hash) === state.selectedPrimaryKey)
        : (selected[selected.length - 1] ?? selected[0]);
      const primaryKey = primary ? commitKey(primary.repoId, primary.hash) : undefined;

      const keys = selected.map((item) => commitKey(item.repoId, item.hash));
      const loading = Object.fromEntries(keys.map((k) => [k, true]));
      const errorMap = { ...get().selectedCommitError };
      keys.forEach((k) => delete errorMap[k]);
      set({ selectedCommitLoading: loading, selectedCommitError: errorMap });

      const results = await mapWithConcurrency(selected, 4, async (item) => {
        try {
          const detail = await get().loadCommitDetail(item, true);
          return { key: commitKey(item.repoId, item.hash), detail };
        } catch {
          return null;
        }
      });

      if (generation !== commitSelectionGeneration) return;
      const isCurrentWorkspace = (get().snapshot?.workspace.id ?? get().activeTabId ?? '') === targetWorkspaceId;
      if (isCurrentWorkspace) {
        const details = { ...get().selectedCommitDetails };
        for (const res of results) {
          if (res?.detail) details[res.key] ??= res.detail;
        }
        set({
          selectedCommitDetails: details,
          selectedCommit: primaryKey ? details[primaryKey] : undefined,
          selectedCommitLoading: {},
        });
        if (primary && primary.parents.length >= 2) void get().loadMergeCommits(primary);
      }
    },

    loadMergeCommits: async (commit) => {
      const key = commitKey(commit.repoId, commit.hash);
      if (get().mergeCommits[key] || get().mergeCommitsLoading[key] || commit.parents.length < 2) return;
      const targetWorkspaceId = workspaceId();
      const requestKey = `merge-commit:${targetWorkspaceId}:${key}`;
      const controller = beginRequest(requestKey);
      set((state) => ({ mergeCommitsLoading: { ...state.mergeCommitsLoading, [key]: true } }));
      try {
        const values = await bridge().request<MergeCommitSummary[]>({
          type: 'commitMergeCommits',
          payload: { workspace_id: targetWorkspaceId, repo_id: commit.repoId, revision: commit.hash, parents: commit.parents },
        }, { signal: controller.signal });
        const isCurrent = isCurrentRequest(requestKey, controller);
        if (isCurrent) endRequest(requestKey, controller);
        const isCurrentWorkspace = (get().snapshot?.workspace.id ?? get().activeTabId ?? '') === targetWorkspaceId;
        if (isCurrentWorkspace) {
          set((state) => ({
            mergeCommits: { ...state.mergeCommits, [key]: values },
            mergeCommitsLoading: isCurrent ? { ...state.mergeCommitsLoading, [key]: false } : state.mergeCommitsLoading,
          }));
        } else {
          const targetSession = get().sessions[targetWorkspaceId];
          if (targetSession) {
            set((state) => ({
              sessions: {
                ...state.sessions,
                [targetWorkspaceId]: {
                  ...targetSession,
                  mergeCommits: { ...targetSession.mergeCommits, [key]: values },
                  mergeCommitsLoading: isCurrent ? { ...targetSession.mergeCommitsLoading, [key]: false } : targetSession.mergeCommitsLoading,
                },
              },
            }));
          }
        }
      } catch (error) {
        const isCurrent = isCurrentRequest(requestKey, controller);
        if (!isCurrent) return;
        endRequest(requestKey, controller);

        const isCurrentWorkspace = (get().snapshot?.workspace.id ?? get().activeTabId ?? '') === targetWorkspaceId;
        if (!isAbortError(error)) {
          if (isCurrentWorkspace) {
            set((state) => ({ mergeCommitsLoading: { ...state.mergeCommitsLoading, [key]: false } }));
            publishError('Merge commit loading failed', error, targetWorkspaceId);
          } else {
            const targetSession = get().sessions[targetWorkspaceId];
            if (targetSession) {
              set((state) => ({
                sessions: {
                  ...state.sessions,
                  [targetWorkspaceId]: {
                    ...targetSession,
                    mergeCommitsLoading: { ...targetSession.mergeCommitsLoading, [key]: false },
                  },
                },
              }));
            }
          }
        } else {
          if (isCurrentWorkspace) {
            set((state) => ({ mergeCommitsLoading: { ...state.mergeCommitsLoading, [key]: false } }));
          } else {
            const targetSession = get().sessions[targetWorkspaceId];
            if (targetSession) {
              set((state) => ({
                sessions: {
                  ...state.sessions,
                  [targetWorkspaceId]: {
                    ...targetSession,
                    mergeCommitsLoading: { ...targetSession.mergeCommitsLoading, [key]: false },
                  },
                },
              }));
            }
          }
        }
      }
    },

    loadMergeParentFiles: async (repoId, revision, parentHash) => {
      const key = `${repoId}\0${revision}\0${parentHash}`;
      const targetWorkspaceId = workspaceId();
      const cached = get().mergeParentFiles[key];
      if (cached) return cached;
      const requestKey = `merge-parent:${targetWorkspaceId}:${key}`;
      const controller = beginRequest(requestKey);
      set((state) => ({
        mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: true },
        mergeParentFilesError: { ...state.mergeParentFilesError, [key]: '' },
      }));
      try {
        const values = await bridge().request<CommitFile[]>({
          type: 'commitMergeParentFiles',
          payload: {
            workspace_id: targetWorkspaceId,
            repo_id: repoId,
            revision,
            parent_hash: parentHash,
          },
        }, { signal: controller.signal });
        const isCurrent = isCurrentRequest(requestKey, controller);
        if (isCurrent) endRequest(requestKey, controller);
        const isCurrentWorkspace = (get().snapshot?.workspace.id ?? get().activeTabId ?? '') === targetWorkspaceId;
        if (isCurrentWorkspace) {
          set((state) => ({
            mergeParentFiles: { ...state.mergeParentFiles, [key]: values },
            mergeParentFilesLoading: isCurrent ? { ...state.mergeParentFilesLoading, [key]: false } : state.mergeParentFilesLoading,
            mergeParentFilesError: isCurrent ? { ...state.mergeParentFilesError, [key]: '' } : state.mergeParentFilesError,
          }));
        } else {
          const targetSession = get().sessions[targetWorkspaceId];
          if (targetSession) {
            set((state) => ({
              sessions: {
                ...state.sessions,
                [targetWorkspaceId]: {
                  ...targetSession,
                  mergeParentFiles: { ...targetSession.mergeParentFiles, [key]: values },
                  mergeParentFilesLoading: isCurrent ? { ...targetSession.mergeParentFilesLoading, [key]: false } : targetSession.mergeParentFilesLoading,
                  mergeParentFilesError: isCurrent ? { ...targetSession.mergeParentFilesError, [key]: '' } : targetSession.mergeParentFilesError,
                },
              },
            }));
          }
        }
        return values;
      } catch (error) {
        const isCurrent = isCurrentRequest(requestKey, controller);
        if (!isCurrent) throw error;
        endRequest(requestKey, controller);

        const errorMessage = (error as Error).message || String(error);
        const isCurrentWorkspace = (get().snapshot?.workspace.id ?? get().activeTabId ?? '') === targetWorkspaceId;
        if (!isAbortError(error)) {
          if (isCurrentWorkspace) {
            set((state) => ({
              mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: false },
              mergeParentFilesError: { ...state.mergeParentFilesError, [key]: errorMessage },
            }));
            publishError('Merge parent loading failed', error, targetWorkspaceId);
          } else {
            const targetSession = get().sessions[targetWorkspaceId];
            if (targetSession) {
              set((state) => ({
                sessions: {
                  ...state.sessions,
                  [targetWorkspaceId]: {
                    ...targetSession,
                    mergeParentFilesLoading: { ...targetSession.mergeParentFilesLoading, [key]: false },
                    mergeParentFilesError: { ...targetSession.mergeParentFilesError, [key]: errorMessage },
                  },
                },
              }));
            }
          }
          throw error;
        }
        if (isCurrentWorkspace) {
          set((state) => ({
            mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: false },
          }));
        } else {
          const targetSession = get().sessions[targetWorkspaceId];
          if (targetSession) {
            set((state) => ({
              sessions: {
                ...state.sessions,
                [targetWorkspaceId]: {
                  ...targetSession,
                  mergeParentFilesLoading: { ...targetSession.mergeParentFilesLoading, [key]: false },
                },
              },
            }));
          }
        }
        throw error;
      }
    },

    clearCommitSelection: () => {
      commitSelectionGeneration += 1;
      set({ selectedCommit: undefined, selectedCommits: [], selectedPrimaryKey: undefined, commitSelectionAnchorKey: undefined, selectedCommitLoading: {}, selectedCommitError: {}, changes: undefined, changesDiff: undefined, mode: 'history' });
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
        get().addNotification({
          type: 'warning', urgent: true, workspaceId: get().snapshot?.workspace.id,
          title: 'Merge conflicts detected',
          message: { key: '{0}: resolve conflicts before committing', args: [repo?.meta.name ?? repoId] },
          actions: [{ type: 'openConflicts', label: 'Open Conflicts' }],
        });
      };
      try {
        const result = await bridge().request<BranchOperationResult>({ type: 'branchOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation: operation as never } });
        if (result.conflicted) suggestMergeMessage();
        else {
          const repoName = get().snapshot?.repositories.find((item) => item.meta.id === repoId)?.meta.name ?? repoId;
          const branch = operation as { type: string; name?: string; old_name?: string; new_name?: string };
          const messages: Record<string, NotificationText | undefined> = {
            create: branch.name ? { key: 'VersionDock [{0}]: branch "{1}" created.', args: [repoName, branch.name] } : undefined,
            checkout: branch.name ? { key: 'VersionDock [{0}]: switched to "{1}"', args: [repoName, branch.name] } : undefined,
            merge: branch.name ? { key: 'VersionDock [{0}]: merged "{1}".', args: [repoName, branch.name] } : undefined,
            rebase: branch.name ? { key: 'VersionDock [{0}]: rebased onto "{1}".', args: [repoName, branch.name] } : undefined,
            rename: branch.old_name && branch.new_name ? { key: 'VersionDock [{0}]: renamed "{1}" → "{2}".', args: [repoName, branch.old_name, branch.new_name] } : undefined,
            delete: branch.name ? { key: 'VersionDock [{0}]: deleted "{1}".', args: [repoName, branch.name] } : undefined,
          };
          const message = messages[branch.type];
          if (message) get().addNotification({ type: 'success', title: 'Branch operation completed', message, workspaceId: get().snapshot?.workspace.id });
          await get().refresh();
          await get().selectRepo(repoId, true);
        }
        return result;
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== 'DIRTY_WORKTREE' || !value.name || (value.type !== 'checkout' && value.type !== 'merge')) {
          publishError('Branch operation failed', error, get().snapshot?.workspace.id, repoId);
          return undefined;
        }
        const target = value.name;
        let recoveryResult: BranchRecoveryResult | undefined;
        await queueBranchRecoveryDialog(async () => {
          if (value.type === 'merge') {
            const selected = await choiceDialog({ title: t('Uncommitted changes'), message: t('Local changes would be overwritten by merging "{0}".', target), choices: [{ id: 'stash', label: t('Stash and merge'), description: t('Save all local changes to a retained stash, then merge.'), icon: 'archive' }, { id: 'cancel', label: t('Cancel'), icon: 'close' }] });
            if (selected === 'stash') {
              const recovery = await get().branchRecovery(repoId, { type: 'stashAndMerge', target });
              recoveryResult = recovery;
              if (recovery?.status === 'conflicted') suggestMergeMessage();
            }
            return;
          }
          const selected = await choiceDialog({ title: t('Uncommitted changes'), message: t('Choose how to handle local changes before switching to "{0}".', target), choices: [{ id: 'stash', label: t('Stash and checkout'), description: t('Keep changes in a stash and switch branches.'), icon: 'archive' }, { id: 'carry', label: t('Carry changes'), description: t('Switch branches and apply the changes there.'), icon: 'arrow-right' }, { id: 'force', label: t('Force checkout'), description: t('Discard tracked local changes and switch branches.'), icon: 'warning', danger: true }, { id: 'cancel', label: t('Cancel'), icon: 'close' }] });
          const recovery = selected === 'stash' ? { type: 'stashAndCheckout', target } as const : selected === 'carry' ? { type: 'carryChanges', target } as const : selected === 'force' ? { type: 'forceCheckout', target } as const : undefined;
          if (recovery) {
            recoveryResult = await get().branchRecovery(repoId, recovery);
          }
        });
        if (recoveryResult && recoveryResult.status !== 'partialFailure') {
          return {
            completed: recoveryResult.status === 'completed',
            conflicted: recoveryResult.status === 'conflicted',
          };
        }
        return undefined;
      }
    },
    branchRecovery: async (repoId, operation) => {
      try {
        const result = await bridge().request<BranchRecoveryResult>({ type: 'branchRecovery', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, { timeoutMs: 600_000 });
        if (result.status === 'partialFailure') get().addNotification({ type: 'warning', urgent: true, workspaceId: get().snapshot?.workspace.id, title: 'Branch recovery needs attention', message: result.recoveryHint ? { key: result.recoveryHint } : result.error?.message ? { raw: result.error.message } : 'Review the repository and retained stash.' });
        else if (result.stashReference) get().addNotification({ type: result.status === 'conflicted' ? 'warning' : 'success', urgent: result.status === 'conflicted', workspaceId: get().snapshot?.workspace.id, title: result.status === 'conflicted' ? 'Merge conflicts detected' : 'Branch operation completed', message: { key: '{0} was retained for recovery.', args: [result.stashReference] }, actions: result.status === 'conflicted' ? [{ type: 'openConflicts', label: 'Open Conflicts' }] : [] });
        await get().refresh(true);
        return result;
      } catch (error) {
        get().addNotification({ type: 'error', title: 'Branch operation failed', message: { raw: errorText(error) }, details: errorDetails(error), workspaceId: get().snapshot?.workspace.id });
        return undefined;
      }
    },

    runTagWorkflow: async (request) => {
      if (get().tagBusy) return { outcome: 'cancelled', targets: [] };
      const snapshot = get().snapshot;
      if (!snapshot || !get().bridge) return { outcome: 'failed', targets: [] };
      const wid = snapshot.workspace.id;
      const t = createTranslator(resolveLanguage(settings().language));
      set({ tagBusy: true });
      try {
        return await runGitTagWorkflow(request, {
          bridge: bridge(), workspaceId: wid, repositories: snapshot.repositories, t,
          isAvailable: (repo) => get().snapshot?.workspace.id === wid && get().snapshot!.repositories.some(item => item.meta.id === repo.meta.id && item.meta.kind === 'git' && item.meta.rootPath === repo.meta.rootPath),
          manageRemotes: (repoId) => get().openRemoteManager(repoId),
          created: (repoId, name) => { get().addNotification({ type: 'success', title: 'Tag operation completed', message: { key: 'Tag "{0}" created locally.', args: [name] }, workspaceId: wid, actions: [{ type: 'pushTag', label: 'Push this tag', repoId, tagName: name }] }); },
          notify: (outcome, detail) => { get().addNotification({ type: outcome === 'success' ? 'success' : outcome === 'partial' ? 'warning' : 'error', title: { key: 'Tag operation result: {0}', args: [t(outcome)] }, message: detail, workspaceId: wid }); },
          refresh: async (repoIds) => {
            if (get().snapshot?.workspace.id !== wid) return;
            await get().refresh(true, { reloadRepository: false });
            await Promise.allSettled(repoIds.map(async (repoId) => {
              const [branches, tags] = await Promise.all([
                bridge().request<BranchInfo[]>({ type: 'branches', payload: { workspace_id: wid, repo_id: repoId } }, { showProgress: false }),
                bridge().request<TagInfo[]>({ type: 'tags', payload: { workspace_id: wid, repo_id: repoId } }, { showProgress: false }),
              ]);
              if (get().snapshot?.workspace.id !== wid) return;
              set(state => ({ branchesByRepo: { ...state.branchesByRepo, [repoId]: branches }, tagsByRepo: { ...state.tagsByRepo, [repoId]: tags }, ...(state.selectedRepoId === repoId ? { branches, tags } : {}) }));
            }));
            if (get().snapshot?.workspace.id === wid) await get().loadHistory(true, true);
          },
        });
      } finally { set({ tagBusy: false }); }
    },

    tagOperation: async (operation, requestedRepoId) => {
      const repoId = requestedRepoId ?? get().selectedRepoId;
      if (!repoId) return false;
      const result = await withBusy(async () => {
        await bridge().request({ type: 'tagOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation: operation as never } });
        const repoName = get().snapshot?.repositories.find((item) => item.meta.id === repoId)?.meta.name ?? repoId;
        const tag = operation as { type: string; name: string; remote?: string };
        const messages: Record<string, NotificationText | undefined> = {
          create: tag.name ? { key: 'VersionDock [{0}]: tag "{1}" created.', args: [repoName, tag.name] } : undefined,
          push: tag.remote ? { key: 'VersionDock [{0}]: tag "{1}" pushed to "{2}".', args: [repoName, tag.name, tag.remote] } : undefined,
          checkout: { key: 'VersionDock [{0}]: checked out tag "{1}" (detached HEAD).', args: [repoName, tag.name] },
          merge: { key: 'VersionDock [{0}]: merged tag "{1}".', args: [repoName, tag.name] },
          delete: { key: 'VersionDock [{0}]: tag "{1}" deleted.', args: [repoName, tag.name] },
        };
        const message = messages[tag.type];
        if (message) get().addNotification({ type: 'success', title: 'Tag operation completed', message, workspaceId: get().snapshot?.workspace.id });
        await get().refresh();
        await get().selectRepo(repoId, true);
        return true;
      }, `repository:${repoId}`);
      return result === true;
    },

    loadStashes: async (repoId, targetWorkspaceId) => {
      const b = get().bridge;
      const wid = targetWorkspaceId ?? get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        try {
          const values = await b.request<StashEntry[]>({ type: 'stashes', payload: { workspace_id: wid, repo_id: repoId } });
          const isCurrent = get().snapshot?.workspace.id === wid;
          set((state) => ({
            ...(isCurrent ? {
              stashes: { ...state.stashes, [repoId]: values },
              loadErrors: { ...state.loadErrors, [`stashes:${repoId}`]: null },
            } : {}),
            sessions: state.sessions[wid] ? {
              ...state.sessions,
              [wid]: {
                ...state.sessions[wid],
                stashes: { ...(state.sessions[wid].stashes ?? {}), [repoId]: values },
                loadErrors: { ...(state.sessions[wid].loadErrors ?? {}), [`stashes:${repoId}`]: null },
              },
            } : state.sessions,
          }));
        } catch (error) {
          const isCurrent = get().snapshot?.workspace.id === wid;
          set((state) => ({
            ...(isCurrent ? {
              loadErrors: { ...state.loadErrors, [`stashes:${repoId}`]: errorText(error) },
            } : {}),
            sessions: state.sessions[wid] ? {
              ...state.sessions,
              [wid]: {
                ...state.sessions[wid],
                loadErrors: { ...(state.sessions[wid].loadErrors ?? {}), [`stashes:${repoId}`]: errorText(error) },
              },
            } : state.sessions,
          }));
        }
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const results = await Promise.allSettled(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        stashes: await b.request<StashEntry[]>({ type: 'stashes', payload: { workspace_id: wid, repo_id: repo.meta.id } }),
      })));
      const isCurrent = get().snapshot?.workspace.id === wid;
      set((state) => {
        const nextStashes = isCurrent ? { ...state.stashes } : {};
        const nextErrors = isCurrent ? { ...state.loadErrors } : {};
        const sessionStashes = { ...(state.sessions[wid]?.stashes ?? {}) };
        const sessionErrors = { ...(state.sessions[wid]?.loadErrors ?? {}) };
        results.forEach((res, index) => {
          const rId = repositories[index].meta.id;
          if (res.status === 'fulfilled') {
            if (isCurrent) {
              nextStashes[rId] = res.value.stashes;
              nextErrors[`stashes:${rId}`] = null;
            }
            sessionStashes[rId] = res.value.stashes;
            sessionErrors[`stashes:${rId}`] = null;
          } else {
            if (isCurrent) {
              nextErrors[`stashes:${rId}`] = errorText(res.reason);
            }
            sessionErrors[`stashes:${rId}`] = errorText(res.reason);
          }
        });
        return {
          ...(isCurrent ? { stashes: nextStashes, loadErrors: nextErrors } : {}),
          sessions: state.sessions[wid] ? {
            ...state.sessions,
            [wid]: {
              ...state.sessions[wid],
              stashes: sessionStashes,
              loadErrors: sessionErrors,
            },
          } : state.sessions,
        };
      });
    },
    stashOperation: async (repoId, operation, targetWorkspaceId) => {
      const wid = targetWorkspaceId ?? workspaceId();
      const lockKey = `${wid}:${repoId}`;
      if (activeStashOperations.has(lockKey)) {
        return false;
      }
      activeStashOperations.add(lockKey);
      try {
        return (await withBusy(async () => {
          await bridge().request({ type: 'stashOperation', payload: { workspace_id: wid, repo_id: repoId, operation } });
          await get().loadStashes(repoId, wid);
          return true;
        }, `stash:${repoId}`)) ?? false;
      } finally {
        activeStashOperations.delete(lockKey);
      }
    },
    loadShelves: async (repoId, targetWorkspaceId) => {
      const b = get().bridge;
      const wid = targetWorkspaceId ?? get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        try {
          const values = await b.request<ShelfEntry[]>({ type: 'shelves', payload: { workspace_id: wid, repo_id: repoId } });
          const isCurrent = get().snapshot?.workspace.id === wid;
          set((state) => ({
            ...(isCurrent ? {
              shelves: { ...state.shelves, [repoId]: values },
              loadErrors: { ...state.loadErrors, [`shelves:${repoId}`]: null },
            } : {}),
            sessions: state.sessions[wid] ? {
              ...state.sessions,
              [wid]: {
                ...state.sessions[wid],
                shelves: { ...(state.sessions[wid].shelves ?? {}), [repoId]: values },
                loadErrors: { ...(state.sessions[wid].loadErrors ?? {}), [`shelves:${repoId}`]: null },
              },
            } : state.sessions,
          }));
        } catch (error) {
          const isCurrent = get().snapshot?.workspace.id === wid;
          set((state) => ({
            ...(isCurrent ? {
              loadErrors: { ...state.loadErrors, [`shelves:${repoId}`]: errorText(error) },
            } : {}),
            sessions: state.sessions[wid] ? {
              ...state.sessions,
              [wid]: {
                ...state.sessions[wid],
                loadErrors: { ...(state.sessions[wid].loadErrors ?? {}), [`shelves:${repoId}`]: errorText(error) },
              },
            } : state.sessions,
          }));
        }
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const results = await Promise.allSettled(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        shelves: await b.request<ShelfEntry[]>({ type: 'shelves', payload: { workspace_id: wid, repo_id: repo.meta.id } }),
      })));
      const isCurrent = get().snapshot?.workspace.id === wid;
      set((state) => {
        const nextShelves = isCurrent ? { ...state.shelves } : {};
        const nextErrors = isCurrent ? { ...state.loadErrors } : {};
        const sessionShelves = { ...(state.sessions[wid]?.shelves ?? {}) };
        const sessionErrors = { ...(state.sessions[wid]?.loadErrors ?? {}) };
        results.forEach((res, index) => {
          const rId = repositories[index].meta.id;
          if (res.status === 'fulfilled') {
            if (isCurrent) {
              nextShelves[rId] = res.value.shelves;
              nextErrors[`shelves:${rId}`] = null;
            }
            sessionShelves[rId] = res.value.shelves;
            sessionErrors[`shelves:${rId}`] = null;
          } else {
            if (isCurrent) {
              nextErrors[`shelves:${rId}`] = errorText(res.reason);
            }
            sessionErrors[`shelves:${rId}`] = errorText(res.reason);
          }
        });
        return {
          ...(isCurrent ? { shelves: nextShelves, loadErrors: nextErrors } : {}),
          sessions: state.sessions[wid] ? {
            ...state.sessions,
            [wid]: {
              ...state.sessions[wid],
              shelves: sessionShelves,
              loadErrors: sessionErrors,
            },
          } : state.sessions,
        };
      });
    },
    shelfOperation: async (repoId, operation, targetWorkspaceId) => {
      const wid = targetWorkspaceId ?? workspaceId();
      return (await withBusy(async () => {
        await bridge().request({ type: 'shelfOperation', payload: { workspace_id: wid, repo_id: repoId, operation } });
        await get().loadShelves(repoId, wid);
        return true;
      }, `shelf:${repoId}`)) ?? false;
    },
    loadChangelists: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        try {
          const values = await b.request<ChangelistEntry[]>({ type: 'changelists', payload: { workspace_id: wid, repo_id: repoId } });
          if (get().snapshot?.workspace.id !== wid) return;
          set((state) => ({
            changelists: { ...state.changelists, [repoId]: values },
            loadErrors: { ...state.loadErrors, [`changelists:${repoId}`]: null },
          }));
        } catch (error) {
          if (get().snapshot?.workspace.id !== wid) return;
          set((state) => ({
            loadErrors: { ...state.loadErrors, [`changelists:${repoId}`]: errorText(error) },
          }));
        }
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => capabilityAvailable(repo.capabilities, 'changelist', true));
      const results = await Promise.allSettled(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        changelists: await b.request<ChangelistEntry[]>({ type: 'changelists', payload: { workspace_id: wid, repo_id: repo.meta.id } }),
      })));
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => {
        const nextChangelists = { ...state.changelists };
        const nextErrors = { ...state.loadErrors };
        results.forEach((res, index) => {
          const rId = repositories[index].meta.id;
          if (res.status === 'fulfilled') {
            nextChangelists[rId] = res.value.changelists;
            nextErrors[`changelists:${rId}`] = null;
          } else {
            nextErrors[`changelists:${rId}`] = errorText(res.reason);
          }
        });
        return { changelists: nextChangelists, loadErrors: nextErrors };
      });
    },
    changelistOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'changelistOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await get().loadChangelists();
    }, `changelist:${repoId}`),
    loadWorktrees: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        try {
          const values = await b.request<WorktreeEntry[]>({ type: 'worktrees', payload: { workspace_id: wid, repo_id: repoId } });
          if (get().snapshot?.workspace.id !== wid) return;
          set((state) => ({
            worktrees: { ...state.worktrees, [repoId]: values },
            loadErrors: { ...state.loadErrors, [`worktrees:${repoId}`]: null },
          }));
        } catch (error) {
          if (get().snapshot?.workspace.id !== wid) return;
          set((state) => ({
            loadErrors: { ...state.loadErrors, [`worktrees:${repoId}`]: errorText(error) },
          }));
        }
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const results = await Promise.allSettled(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        worktrees: await b.request<WorktreeEntry[]>({ type: 'worktrees', payload: { workspace_id: wid, repo_id: repo.meta.id } }),
      })));
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => {
        const nextWorktrees = { ...state.worktrees };
        const nextErrors = { ...state.loadErrors };
        results.forEach((res, index) => {
          const rId = repositories[index].meta.id;
          if (res.status === 'fulfilled') {
            nextWorktrees[rId] = res.value.worktrees;
            nextErrors[`worktrees:${rId}`] = null;
          } else {
            nextErrors[`worktrees:${rId}`] = errorText(res.reason);
          }
        });
        return { worktrees: nextWorktrees, loadErrors: nextErrors };
      });
    },
    worktreeOperation: async (repoId, operation) => withBusy(async () => {
      if (!ensureRepositoryCapability(repoId, 'worktreeWrite')) return;
      const previousPaths = new Set((get().worktrees[repoId] ?? []).map((item) => item.path));
      await bridge().request({ type: 'worktreeOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await get().loadWorktrees(repoId);
      if (operation.type === 'create') {
        const created = (get().worktrees[repoId] ?? []).find((item) => !previousPaths.has(item.path));
        get().addNotification({ type: 'success', title: 'Worktree operation completed', message: created ? { key: 'VersionDock: Worktree created at {0}', args: [created.path] } : 'VersionDock: Worktree created.', workspaceId: get().snapshot?.workspace.id });
      }
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
      const currentMode = get().mode;
      const diffReturnMode = currentMode !== 'diff' ? currentMode : get().diffReturnMode;
      const diff = await bridge().request<DiffDocument>({ type: 'worktreeFileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, path, base_ref: baseRef, relative_path: relativePath } });
      if (get().snapshot?.workspace.id !== wid) return;
      set({ selectedFile: { repoId, path: relativePath, staged: false, fromRevision: baseRef, toRevision: 'WORKTREE' }, diff, mode: 'diff', diffReturnMode });
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
      const currentMode = get().mode;
      const diffReturnMode = currentMode !== 'diff' ? currentMode : get().diffReturnMode;
      const diff = await bridge().request<DiffDocument>({ type: 'branchWorkingFileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, base_ref: baseRef, relative_path: relativePath } });
      if (get().snapshot?.workspace.id !== wid) return;
      set({ selectedFile: { repoId, path: relativePath, staged: false, fromRevision: baseRef, toRevision: 'WORKING' }, diff, mode: 'diff', diffReturnMode });
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
        try {
          const values = await b.request<SubtreeEntry[]>({ type: 'subtrees', payload: { workspace_id: wid, repo_id: repoId } });
          if (get().snapshot?.workspace.id !== wid) return;
          set((state) => ({
            subtrees: { ...state.subtrees, [repoId]: values },
            loadErrors: { ...state.loadErrors, [`subtrees:${repoId}`]: null },
          }));
        } catch (error) {
          if (get().snapshot?.workspace.id !== wid) return;
          set((state) => ({
            loadErrors: { ...state.loadErrors, [`subtrees:${repoId}`]: errorText(error) },
          }));
        }
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const results = await Promise.allSettled(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        subtrees: await b.request<SubtreeEntry[]>({ type: 'subtrees', payload: { workspace_id: wid, repo_id: repo.meta.id } }),
      })));
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => {
        const nextSubtrees = { ...state.subtrees };
        const nextErrors = { ...state.loadErrors };
        results.forEach((res, index) => {
          const rId = repositories[index].meta.id;
          if (res.status === 'fulfilled') {
            nextSubtrees[rId] = res.value.subtrees;
            nextErrors[`subtrees:${rId}`] = null;
          } else {
            nextErrors[`subtrees:${rId}`] = errorText(res.reason);
          }
        });
        return { subtrees: nextSubtrees, loadErrors: nextErrors };
      });
    },
    subtreeOperation: async (repoId, operation) => withBusy(async () => {
      if (!ensureRepositoryCapability(repoId, 'subtreeWrite')) return;
      const networkOperation = operation.type === 'add' || operation.type === 'pull' || operation.type === 'push';
      const previous = 'subtree_id' in operation ? get().subtrees[repoId]?.find((item) => item.id === operation.subtree_id) : undefined;
      await bridge().request({ type: 'subtreeOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, networkOperation ? { timeoutMs: 600_000 } : undefined);
      await get().loadSubtrees(repoId);
      const prefix = 'prefix' in operation ? operation.prefix : previous?.prefix ?? operation.subtree_id;
      const messages: Partial<Record<typeof operation.type, NotificationText>> = {
        add: { key: 'VersionDock: Subtree "{0}" added.', args: [prefix] }, register: { key: 'VersionDock: Subtree "{0}" registered.', args: [prefix] },
        edit: { key: 'VersionDock: Subtree "{0}" updated.', args: [prefix] }, pull: { key: 'VersionDock: Subtree "{0}" pulled.', args: [prefix] },
        push: { key: 'VersionDock: Subtree "{0}" pushed.', args: [prefix] }, removeFiles: { key: 'VersionDock: Subtree "{0}" removed from working tree.', args: [prefix] },
        split: operation.type === 'split' && operation.branch ? { key: 'VersionDock: Subtree "{0}" split to branch "{1}".', args: [prefix, operation.branch] } : { key: 'VersionDock: Subtree "{0}" split.', args: [prefix] },
        merge: { key: 'VersionDock: Subtree "{0}" merged.', args: [prefix] }, deleteRegistry: { key: 'VersionDock: Subtree "{0}" registry deleted.', args: [prefix] },
      };
      const message = messages[operation.type];
      if (message) get().addNotification({ type: 'success', title: 'Subtree operation completed', message, workspaceId: get().snapshot?.workspace.id });
    }, `subtree:${repoId}`),
    loadSubmodules: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git' && !repo.meta.isSubmodule && (!repoId || repo.meta.id === repoId));
      const results = await Promise.allSettled(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        submodules: await b.request<SubmoduleEntry[]>({ type: 'submodules', payload: { workspace_id: wid, repo_id: repo.meta.id } }),
      })));
      if (get().snapshot?.workspace.id !== wid) return;
      set((state) => {
        const nextSubmodules = { ...state.submodules };
        const nextErrors = { ...state.loadErrors };
        results.forEach((res, index) => {
          const rId = repositories[index].meta.id;
          if (res.status === 'fulfilled') {
            nextSubmodules[rId] = res.value.submodules;
            nextErrors[`submodules:${rId}`] = null;
          } else {
            nextErrors[`submodules:${rId}`] = errorText(res.reason);
          }
        });
        return { submodules: nextSubmodules, loadErrors: nextErrors };
      });
    },
    submoduleOperation: async (repoId, operation, options) => withBusy(async () => {
      if (!ensureRepositoryCapability(repoId, 'submoduleWrite')) return;
      const wid = workspaceId();
      await bridge().request({ type: 'submoduleOperation', payload: { workspace_id: wid, repo_id: repoId, operation } }, { timeoutMs: 600_000 });
      if (get().snapshot?.workspace.id === wid) await get().refresh();
    }, `submodule:${repoId}`, undefined, options).then(() => undefined),
    loadUnpushedCommits: async (repoId, targetWorkspaceId) => {
      const b = get().bridge;
      const wid = targetWorkspaceId ?? get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        try {
          const values = await b.request<UnpushedCommit[]>({ type: 'unpushedCommits', payload: { workspace_id: wid, repo_id: repoId } });
          const isCurrent = get().snapshot?.workspace.id === wid;
          set((state) => ({
            ...(isCurrent ? {
              unpushedCommits: { ...state.unpushedCommits, [repoId]: values },
              loadErrors: { ...state.loadErrors, [`unpushed:${repoId}`]: null },
            } : {}),
            sessions: state.sessions[wid] ? {
              ...state.sessions,
              [wid]: {
                ...state.sessions[wid],
                unpushedCommits: { ...(state.sessions[wid].unpushedCommits ?? {}), [repoId]: values },
                loadErrors: { ...(state.sessions[wid].loadErrors ?? {}), [`unpushed:${repoId}`]: null },
              },
            } : state.sessions,
          }));
        } catch (error) {
          const isCurrent = get().snapshot?.workspace.id === wid;
          set((state) => ({
            ...(isCurrent ? {
              loadErrors: { ...state.loadErrors, [`unpushed:${repoId}`]: errorText(error) },
            } : {}),
            sessions: state.sessions[wid] ? {
              ...state.sessions,
              [wid]: {
                ...state.sessions[wid],
                loadErrors: { ...(state.sessions[wid].loadErrors ?? {}), [`unpushed:${repoId}`]: errorText(error) },
              },
            } : state.sessions,
          }));
        }
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const results = await Promise.allSettled(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        commits: await b.request<UnpushedCommit[]>({ type: 'unpushedCommits', payload: { workspace_id: wid, repo_id: repo.meta.id } }),
      })));
      const isCurrent = get().snapshot?.workspace.id === wid;
      set((state) => {
        const nextCommits = isCurrent ? { ...state.unpushedCommits } : {};
        const nextErrors = isCurrent ? { ...state.loadErrors } : {};
        const sessionCommits = { ...(state.sessions[wid]?.unpushedCommits ?? {}) };
        const sessionErrors = { ...(state.sessions[wid]?.loadErrors ?? {}) };
        results.forEach((res, index) => {
          const rId = repositories[index].meta.id;
          if (res.status === 'fulfilled') {
            if (isCurrent) {
              nextCommits[rId] = res.value.commits;
              nextErrors[`unpushed:${rId}`] = null;
            }
            sessionCommits[rId] = res.value.commits;
            sessionErrors[`unpushed:${rId}`] = null;
          } else {
            if (isCurrent) {
              nextErrors[`unpushed:${rId}`] = errorText(res.reason);
            }
            sessionErrors[`unpushed:${rId}`] = errorText(res.reason);
          }
        });
        return {
          ...(isCurrent ? { unpushedCommits: nextCommits, loadErrors: nextErrors } : {}),
          sessions: state.sessions[wid] ? {
            ...state.sessions,
            [wid]: {
              ...state.sessions[wid],
              unpushedCommits: sessionCommits,
              loadErrors: sessionErrors,
            },
          } : state.sessions,
        };
      });
    },
    loadIncomingCommits: async (repoId, targetWorkspaceId) => {
      const b = get().bridge;
      const wid = targetWorkspaceId ?? get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        try {
          const values = await b.request<IncomingCommit[]>({ type: 'incomingCommits', payload: { workspace_id: wid, repo_id: repoId } });
          const isCurrent = get().snapshot?.workspace.id === wid;
          set((state) => ({
            ...(isCurrent ? {
              incomingCommits: { ...state.incomingCommits, [repoId]: values },
              loadErrors: { ...state.loadErrors, [`incoming:${repoId}`]: null },
            } : {}),
            sessions: state.sessions[wid] ? {
              ...state.sessions,
              [wid]: {
                ...state.sessions[wid],
                incomingCommits: { ...(state.sessions[wid].incomingCommits ?? {}), [repoId]: values },
                loadErrors: { ...(state.sessions[wid].loadErrors ?? {}), [`incoming:${repoId}`]: null },
              },
            } : state.sessions,
          }));
        } catch (error) {
          const isCurrent = get().snapshot?.workspace.id === wid;
          set((state) => ({
            ...(isCurrent ? {
              loadErrors: { ...state.loadErrors, [`incoming:${repoId}`]: errorText(error) },
            } : {}),
            sessions: state.sessions[wid] ? {
              ...state.sessions,
              [wid]: {
                ...state.sessions[wid],
                loadErrors: { ...(state.sessions[wid].loadErrors ?? {}), [`incoming:${repoId}`]: errorText(error) },
              },
            } : state.sessions,
          }));
        }
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const results = await Promise.allSettled(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        commits: await b.request<IncomingCommit[]>({ type: 'incomingCommits', payload: { workspace_id: wid, repo_id: repo.meta.id } }),
      })));
      const isCurrent = get().snapshot?.workspace.id === wid;
      set((state) => {
        const nextCommits = isCurrent ? { ...state.incomingCommits } : {};
        const nextErrors = isCurrent ? { ...state.loadErrors } : {};
        const sessionCommits = { ...(state.sessions[wid]?.incomingCommits ?? {}) };
        const sessionErrors = { ...(state.sessions[wid]?.loadErrors ?? {}) };
        results.forEach((res, index) => {
          const rId = repositories[index].meta.id;
          if (res.status === 'fulfilled') {
            if (isCurrent) {
              nextCommits[rId] = res.value.commits;
              nextErrors[`incoming:${rId}`] = null;
            }
            sessionCommits[rId] = res.value.commits;
            sessionErrors[`incoming:${rId}`] = null;
          } else {
            if (isCurrent) {
              nextErrors[`incoming:${rId}`] = errorText(res.reason);
            }
            sessionErrors[`incoming:${rId}`] = errorText(res.reason);
          }
        });
        return {
          ...(isCurrent ? { incomingCommits: nextCommits, loadErrors: nextErrors } : {}),
          sessions: state.sessions[wid] ? {
            ...state.sessions,
            [wid]: {
              ...state.sessions[wid],
              incomingCommits: sessionCommits,
              loadErrors: sessionErrors,
            },
          } : state.sessions,
        };
      });
    },
    unpushedOperation: async (repoId, operation) => (await withBusy(async () => {
      if (!ensureRepositoryCapability(repoId, 'historyRewrite')) return false;
      const wid = workspaceId();
      await bridge().request({ type: 'unpushedOperation', payload: { workspace_id: wid, repo_id: repoId, operation } }, { timeoutMs: 600_000 });
      await get().loadUnpushedCommits(repoId, wid);
      const repoName = get().snapshot?.repositories.find((item) => item.meta.id === repoId)?.meta.name ?? repoId;
      let message: NotificationText | undefined;
      if (operation.type === 'undoHead') {
        message = { key: 'VersionDock [{0}]: undid last commit. Changes remain staged.', args: [repoName] };
      } else if (operation.type === 'drop') {
        const count = operation.hashes.length;
        message = count === 1
          ? { key: 'VersionDock [{0}]: dropped commit {1}.', args: [repoName, operation.hashes[0].slice(0, 7)] }
          : { key: 'VersionDock [{0}]: dropped {1} commits.', args: [repoName, count] };
      } else if (operation.type === 'squash') {
        message = { key: 'VersionDock [{0}]: squash completed.', args: [repoName] };
      } else if (operation.type === 'editMessage') {
        message = { key: 'VersionDock [{0}]: commit message updated.', args: [repoName] };
      }
      if (message) {
        get().addNotification({ type: 'success', title: 'History operation completed', message, workspaceId: get().snapshot?.workspace.id });
      }
      await get().refresh();
      await get().loadHistory(true);
      return true;
    }, `history:${repoId}`)) ?? false,
    historyOperation: async (repoId, operation) => (await withBusy(async () => {
      if (operation.type === 'reset' && !ensureRepositoryCapability(repoId, 'historyRewrite')) return false;
      await bridge().request({ type: 'historyOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, { timeoutMs: 600_000 });
      const repoName = get().snapshot?.repositories.find((item) => item.meta.id === repoId)?.meta.name ?? repoId;
      let message: NotificationText | undefined;
      if (operation.type === 'checkout') {
        const short = operation.revision.slice(0, 7);
        message = { key: 'VersionDock [{0}]: checked out revision {1}.', args: [repoName, short] };
      } else if (operation.type === 'svnUpdateTo') {
        message = { key: 'VersionDock [{0}]: updated to revision {1}.', args: [repoName, operation.revision] };
      } else if (operation.type === 'cherryPick') {
        const short = operation.revision.slice(0, 7);
        message = { key: 'VersionDock [{0}]: cherry-picked commit {1}.', args: [repoName, short] };
      } else if (operation.type === 'revert') {
        const count = operation.revisions.length;
        message = count === 1
          ? { key: 'VersionDock [{0}]: reverted commit {1}.', args: [repoName, operation.revisions[0].slice(0, 7)] }
          : { key: 'VersionDock [{0}]: reverted {1} commits.', args: [repoName, count] };
      } else if (operation.type === 'reset') {
        const short = operation.revision.slice(0, 7);
        message = { key: 'VersionDock [{0}]: reset current branch to {1} ({2}).', args: [repoName, short, operation.mode] };
      }
      if (message) {
        get().addNotification({ type: 'success', title: 'History operation completed', message, workspaceId: get().snapshot?.workspace.id });
      }
      await get().refresh();
      await get().loadHistory(true);
      return true;
    }, `history:${repoId}`)) ?? false,
    createPatch: async (repoId, revisions) => bridge().request<PatchDocument>({ type: 'createPatch', payload: { workspace_id: workspaceId(), repo_id: repoId, revisions } }),
    savePatch: async (repoId, revisions, path) => bridge().request<string>({ type: 'savePatch', payload: { workspace_id: workspaceId(), repo_id: repoId, revisions, path } }),
    svnOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'svnOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, { timeoutMs: 600_000 });
      const repoName = get().snapshot?.repositories.find((item) => item.meta.id === repoId)?.meta.name ?? repoId;
      let message: NotificationText | undefined;
      if (operation.type === 'resolveWorking') message = { key: 'VersionDock [{0}]: marked {1} file(s) as resolved.', args: [repoName, operation.paths.length] };
      if (operation.type === 'lock') message = { key: 'VersionDock [{0}]: locked {1} file(s).', args: [repoName, operation.paths.length] };
      if (operation.type === 'unlock') message = { key: 'VersionDock [{0}]: unlocked {1} file(s).', args: [repoName, operation.paths.length] };
      if (operation.type === 'relocate') message = { key: 'VersionDock [{0}]: SVN repository relocated to "{1}".', args: [repoName, operation.to_url] };
      if (message) get().addNotification({ type: 'success', title: 'SVN operation completed', message, workspaceId: get().snapshot?.workspace.id });
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
        selectedCommit: undefined, selectedCommits: [], selectedPrimaryKey: undefined, commitSelectionAnchorKey: undefined, selectedCommitLoading: {},
        selectedCommitError: {},
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
    compareBranchCommits: async (repoId, base, target, side, query, signal) => {
      const requestWorkspace = workspaceId();
      return bridge().request<CommitNode[]>({
        type: 'branchCompareCommits',
        payload: {
          workspace_id: requestWorkspace,
          repo_id: repoId,
          base,
          target,
          side,
          skip: 0,
          limit: 500,
          query,
        },
      }, { signal, showProgress: false });
    },
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
      const repoName = get().snapshot?.repositories.find((item) => item.meta.id === repoId)?.meta.name ?? repoId;
      let message: NotificationText | undefined;
      if (operation.type === 'add') message = { key: 'VersionDock [{0}]: remote "{1}" added.', args: [repoName, operation.name] };
      if (operation.type === 'rename') message = { key: 'VersionDock [{0}]: remote renamed "{1}" → "{2}".', args: [repoName, operation.old_name, operation.new_name] };
      if (operation.type === 'setUrl') message = { key: 'VersionDock [{0}]: URL of "{1}" updated.', args: [repoName, operation.name] };
      if (operation.type === 'remove') message = { key: 'VersionDock [{0}]: remote "{1}" removed.', args: [repoName, operation.name] };
      if (message) get().addNotification({ type: 'success', title: 'Remote operation completed', message, workspaceId: get().snapshot?.workspace.id });
      await get().loadRemotes(repoId);
    }, `remote:${repoId}`),
    systemOpen: async (repoId, relativePath, reveal, external = false) => withBusy(async () => {
      await bridge().request({ type: 'systemOpen', payload: { workspace_id: workspaceId(), repo_id: repoId, relative_path: relativePath, reveal, external } });
    }, `system:${repoId}`),

    loadConflicts: async (silent = false, repoId) => {
      void silent; // Keep the existing call contract; conflict queries are always background reads.
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      try {
        const conflicts = await b.request<ConflictFile[]>(
          { type: 'conflicts', payload: { workspace_id: wid, repo_id: repoId ?? null } },
          { showProgress: false }
        );
        if (get().snapshot?.workspace.id !== wid) return;
        set((state) => ({
          conflicts: repoId
            ? [...state.conflicts.filter((conflict) => conflict.repoId !== repoId), ...conflicts]
            : conflicts,
          loadErrors: { ...state.loadErrors, [`conflicts:${repoId ?? 'all'}`]: null },
        }));
      } catch (error) {
        if (get().snapshot?.workspace.id !== wid) return;
        const msg = error instanceof Error ? error.message : String(error);
        set((state) => ({
          loadErrors: {
            ...state.loadErrors,
            [`conflicts:${repoId ?? 'all'}`]: msg,
          },
        }));
        get().addNotification({
          type: 'error',
          title: 'Failed to load conflicts',
          message: { raw: msg },
          workspaceId: wid,
        });
      }
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

    openConflicts: () => {
      set({ mode: 'conflicts' });
      void get().loadConflicts(false);
    },

    setMode: (mode) => set({ mode }),

    openMerge: async (conflict) => withBusy(async () => {
      if (conflict.conflictType && !['text', 'binary'].includes(conflict.conflictType)) {
        get().addNotification({ type: 'warning', urgent: true, title: 'Conflict requires attention', message: { raw: `${conflict.path}: ${conflict.conflictType} conflict requires an explicit working-copy resolution` }, workspaceId: get().snapshot?.workspace.id, actions: [{ type: 'openConflicts', label: 'Open Conflicts' }] });
        return;
      }
      const targetWorkspaceId = workspaceId();
      const merge = await bridge().request<MergeVersions>({ type: 'conflictVersions', payload: { workspace_id: targetWorkspaceId, repo_id: conflict.repoId, relative_path: conflict.path } });
      if (workspaceId() !== targetWorkspaceId) return;
      const resolutions: Record<number, MergeResolution> = Object.fromEntries((merge.conflicts ?? []).map((item) => [item.index, 'unresolved']));
      const draft = get().mergeEditorDraft;
      const identity = mergeEditorIdentity(targetWorkspaceId, conflict.repoId, merge.path, merge.fingerprint);
      set({
        merge,
        mergeEditorDraft: draft?.identity === identity ? draft : undefined,
        mergeTarget: { repoId: conflict.repoId, path: conflict.path, workspaceId: targetWorkspaceId },
        mergeResolutions: resolutions,
        mergeScope: 'all',
        mergeResult: merge.markerContent || merge.working,
        selectedFile: { repoId: conflict.repoId, path: conflict.path, staged: false },
        mode: 'merge',
      });
    }, `conflict:${conflict.repoId}`),
    resolveConflict: async (conflict, choice) => {
      const result = await withBusy(async () => {
        const res = await bridge().request<ConflictResolutionResult | boolean>({
          type: 'conflictAccept',
          payload: { workspace_id: workspaceId(), repo_id: conflict.repoId, relative_path: conflict.path, choice },
        });
        if (res && typeof res === 'object' && 'autoCommitError' in res && res.autoCommitError) {
          get().addNotification({
            type: 'warning',
            urgent: true,
            title: 'Merge auto-commit failed',
            message: { key: 'Conflict resolved, but merge commit could not be created: {0}', args: [res.autoCommitError] },
            workspaceId: workspaceId(),
          });
        }
        return true;
      }, `conflict:${conflict.repoId}`);
      return Boolean(result);
    },

    setMergeResult: (mergeResult) => {
      if (get().transferringTabIds[get().snapshot?.workspace.id ?? '']) return;
      set({ mergeResult });
    },
    setMergeResolutions: (updater) => set((state) => ({
      mergeResolutions: typeof updater === 'function' ? updater(state.mergeResolutions) : updater,
    })),
    setMergeScope: (mergeScope) => set({ mergeScope }),
    saveMerge: async (options?: { deleteFile?: boolean }) => {
      const result = await withBusy(async () => {
        const merge = get().merge;
        const file = get().mergeTarget ?? get().selectedFile;
        if (!merge || !file) return false;
        const targetWid = ('workspaceId' in file && file.workspaceId) ? file.workspaceId : workspaceId();
        if (workspaceId() !== targetWid) {
          get().addNotification({ type: 'warning', urgent: true, title: 'Workspace changed', message: { raw: 'Cannot save merge: active workspace has changed.' }, workspaceId: workspaceId() });
          return false;
        }
        const res = await bridge().request<ConflictResolutionResult | boolean>({
          type: 'conflictSave',
          payload: {
            workspace_id: targetWid,
            repo_id: file.repoId,
            relative_path: file.path,
            content: get().mergeResult,
            expected_fingerprint: merge.fingerprint,
            delete_file: options?.deleteFile ?? false,
          },
        });
        if (res && typeof res === 'object' && 'autoCommitError' in res && res.autoCommitError) {
          get().addNotification({
            type: 'warning',
            urgent: true,
            title: 'Merge auto-commit failed',
            message: { key: 'Conflict resolved, but merge commit could not be created: {0}', args: [res.autoCommitError] },
            workspaceId: targetWid,
          });
        }
        return true;
      }, 'conflict');
      return result === true;
    },
    acceptConflict: async (choice) => {
      const result = await withBusy(async () => {
        const file = get().mergeTarget ?? get().selectedFile;
        if (!file) return false;
        const targetWid = ('workspaceId' in file && file.workspaceId) ? file.workspaceId : workspaceId();
        if (workspaceId() !== targetWid) {
          get().addNotification({ type: 'warning', urgent: true, title: 'Workspace changed', message: { raw: 'Cannot accept conflict: active workspace has changed.' }, workspaceId: workspaceId() });
          return false;
        }
        const res = await bridge().request<ConflictResolutionResult | boolean>({
          type: 'conflictAccept',
          payload: { workspace_id: targetWid, repo_id: file.repoId, relative_path: file.path, choice },
        });
        if (res && typeof res === 'object' && 'autoCommitError' in res && res.autoCommitError) {
          get().addNotification({
            type: 'warning',
            urgent: true,
            title: 'Merge auto-commit failed',
            message: { key: 'Conflict resolved, but merge commit could not be created: {0}', args: [res.autoCommitError] },
            workspaceId: targetWid,
          });
        }
        return true;
      }, 'conflict');
      return result === true;
    },
    abortRepositoryOperation: async (repoId, operation) => {
      const result = await withBusy(async () => {
        await bridge().request({ type: 'abortRepositoryOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
        return true;
      }, `conflict:${repoId}`);
      return result === true;
    },
    continueRepositoryOperation: async (repoId, operation) => {
      const result = await withBusy(async () => {
        await bridge().request({
          type: 'continueRepositoryOperation',
          payload: { workspace_id: workspaceId(), repo_id: repoId, operation },
        });
        return true;
      }, `conflict:${repoId}`);
      if (!result) {
        const wid = workspaceId();
        await Promise.allSettled([
          (async () => {
            const status = await bridge().request<RepositoryStatus>(
              { type: 'repositoryStatus', payload: { workspace_id: wid, repo_id: repoId } },
              { showProgress: false },
            );
            if (get().snapshot?.workspace.id === wid) {
              set((state) => {
                const allRepositories = state.allRepositories.map((repo) => repo.meta.id === repoId ? status : repo);
                return {
                  allRepositories,
                  snapshot: state.snapshot ? projectSnapshot({ ...state.snapshot, repositories: allRepositories }, allRepositories, settings()) : undefined,
                };
              });
            }
          })(),
          get().loadConflicts(true, repoId),
        ]);
      }
      return result === true;
    },
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
      const current = get();
      const returnMode = current.diffReturnMode ?? 'history';
      const targetMode = returnMode === 'merge' && !current.merge
        ? 'history'
        : returnMode === 'changes' && !current.changes
          ? 'history'
          : returnMode;
      const restoredFile = targetMode === 'merge' && current.mergeTarget
        ? { repoId: current.mergeTarget.repoId, path: current.mergeTarget.path, staged: false }
        : (targetMode === 'changes' ? current.selectedFile : undefined);
      set({
        mode: targetMode,
        diffReturnMode: undefined,
        diff: undefined,
        selectedFile: restoredFile,
        changes: targetMode === 'changes' ? current.changes : undefined,
        changesDiff: targetMode === 'changes' ? current.changesDiff : undefined,
        merge: targetMode === 'merge' ? current.merge : undefined,
        mergeTarget: targetMode === 'merge' ? current.mergeTarget : undefined,
        mergeResolutions: targetMode === 'merge' ? current.mergeResolutions : {},
        mergeScope: targetMode === 'merge' ? current.mergeScope : 'all',
        mergeResult: targetMode === 'merge' ? current.mergeResult : '',
      });
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
    setFileIconTheme: async (fileIconTheme) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      await updateSettings({ fileIconTheme });
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
    setNotificationCenterOpen: (open) => set((state) => ({
      notificationCenterOpen: open,
      toastNotificationIds: open ? [] : state.toastNotificationIds,
    })),
    addNotification: (notification) => {
      const id = crypto.randomUUID();
      const defaultActions: AppNotificationAction[] = notification.type === 'error'
        ? [{ type: 'openLogPanel', label: 'View Log' }]
        : [];
      const currentWorkspaceId = get().snapshot?.workspace.id ?? get().activeTabId ?? undefined;
      const targetWorkspaceId = notification.workspaceId ?? currentWorkspaceId;
      const repositories = targetWorkspaceId && targetWorkspaceId === get().snapshot?.workspace.id
        ? get().allRepositories.length ? get().allRepositories : get().snapshot?.repositories
        : targetWorkspaceId ? get().sessions[targetWorkspaceId]?.allRepositories ?? get().sessions[targetWorkspaceId]?.snapshot?.repositories : undefined;
      const item: AppNotification = {
        id,
        timestamp: Date.now(),
        read: false,
        ...notification,
        repositoryCount: notification.repositoryCount ?? repositories?.filter(repo => !repo.meta.isWorktree).length,
        actions: notification.actions ?? defaultActions,
        workspaceId: targetWorkspaceId,
      };
      set((state) => {
        const nextNotifications = [item, ...state.notifications].slice(0, 100);
        const keptIds = new Set(nextNotifications.map((n) => n.id));
        const nextToastIds = [...(state.toastNotificationIds ?? []), item.id].filter((id) => keptIds.has(id));
        return {
          notifications: nextNotifications,
          toastNotificationIds: state.notificationCenterOpen ? [] : nextToastIds,
        };
      });
      return id;
    },
    dismissToast: (id?: string) => set((state) => ({
      toastNotificationIds: id
        ? (state.toastNotificationIds ?? []).filter((item) => item !== id)
        : (state.toastNotificationIds ?? []).slice(1),
    })),
    performNotificationAction: async (notificationId, actionIndex) => {
      const notification = get().notifications.find((item) => item.id === notificationId);
      const action = notification?.actions[actionIndex];
      if (!notification || !action || notification.actionState?.[actionIndex] === 'done' || Object.values(notification.actionState ?? {}).includes('running')) return;
      set((state) => ({ notifications: state.notifications.map((item) => item.id === notificationId ? { ...item, actionState: { ...item.actionState, [actionIndex]: 'running' as const } } : item) }));
      let actionSucceeded = true;
      try {
        get().markNotificationAsRead(notification.id);
        set((state) => ({ toastNotificationIds: (state.toastNotificationIds ?? []).filter((id) => id !== notification.id) }));
        // 1. 无需依赖特定工作区上下文的全局/关闭操作，直接执行且不切换当前活动工作区
        if (action.type === 'dismiss') {
          return;
        }
        if (action.type === 'openExternal') {
          await openExternalLink(action.url);
          return;
        }
        if (action.type === 'cancelOperation') {
          try {
            await bridge().cancelOperation(action.operationId);
          } catch (error) {
            actionSucceeded = false;
            publishError('Operation failed', error, notification.workspaceId);
          }
          return;
        }
        if (action.type === 'disableIncoming') {
          await get().updateSettings({ notifyIncomingCommits: false });
          return;
        }
        if (action.type === 'openLogPanel') {
          get().setLogPanelOpen(true);
          return;
        }

        // 2. 需要工作区上下文的业务操作，按需切换到通知所属工作区
        if (notification.workspaceId && notification.workspaceId !== get().activeTabId) {
          await get().switchTab(notification.workspaceId);
        }
        const workspaceMismatch = Boolean(notification.workspaceId && get().snapshot?.workspace.id !== notification.workspaceId);
        if (workspaceMismatch) {
          return;
        }
        const t = createTranslator(resolveLanguage(settings().language));
        if (action.type === 'continueOperation' || action.type === 'abortOperation' || action.type === 'skipOperation') {
          const status = await bridge().request<RepositoryStatus>({ type: 'repositoryStatus', payload: { workspace_id: workspaceId(), repo_id: action.repoId } }, { showProgress: false });
          if (status.operation !== action.operation || (action.revision && status.revision !== action.revision) || (notification.workspaceId && get().snapshot?.workspace.id !== notification.workspaceId)) return;
          if (action.type === 'continueOperation') actionSucceeded = await get().continueRepositoryOperation(action.repoId, action.operation);
          else if (action.type === 'abortOperation') actionSucceeded = await get().abortRepositoryOperation(action.repoId, action.operation);
          else await bridge().request({ type: 'continueRepositoryOperation', payload: { workspace_id: workspaceId(), repo_id: action.repoId, operation: action.operation, skip: true } });
          await get().refresh(true);
          return;
        }
        if (action.type === 'recoverPush') {
          const wid = workspaceId();
          if (action.strategy === 'force') {
            const confirmed = await confirmDialog({ title: t('Force Push'), message: t('This may overwrite remote commits. Continue?'), confirmLabel: t('Force Push'), danger: true });
            if (!confirmed || get().snapshot?.workspace.id !== wid) return;
          } else {
            const ref = action.branch ?? get().snapshot?.repositories.find((repo) => repo.meta.id === action.repoId)?.branch;
            const branch = action.remote && ref && !ref.startsWith(`${action.remote}/`) && !ref.startsWith('refs/remotes/') ? `${action.remote}/${ref}` : ref;
            await get().sync(action.repoId, action.strategy === 'merge' ? 'pull' : 'pullRebase', true, { rethrow: true, remote: action.remote ?? undefined, branch }, wid);
          }
          if (get().snapshot?.workspace.id !== wid) return;
          await get().sync(action.repoId, 'push', true, { rethrow: true, force: action.strategy === 'force', remote: action.remote ?? undefined, branch: action.branch ?? undefined }, wid);
          return;
        }
        if (action.type === 'unlockIndex') {
          const wid = workspaceId();
          await bridge().request({ type: 'gitUnlockIndex', payload: { workspace_id: wid, repo_id: action.repoId } });
          await get().refresh(true);
          get().addNotification({ type: 'success', title: 'Unlock', message: 'VersionDock: Git index unlocked successfully.', workspaceId: wid });
          return;
        }
        if (action.type === 'pruneBranches') {
          const wid = workspaceId();
          const selected = await multiChoiceDialog({ title: t('Prune Branches'), message: t('Select branches to delete'), choices: action.branches.map((name) => ({ id: name, label: name, icon: 'git-branch' })) });
          if (!selected?.length || get().snapshot?.workspace.id !== wid) return;
          const refs = await bridge().request<BranchInfo[]>({ type: 'branches', payload: { workspace_id: wid, repo_id: action.repoId } }, { showProgress: false });
          const remotes = new Set(refs.filter((branch) => branch.remote).map((branch) => branch.name));
          for (const name of selected) {
            const branch = refs.find((branch) => !branch.remote && branch.name === name);
            if (get().snapshot?.workspace.id !== wid) return;
            if (branch && !branch.current && branch.upstream && !remotes.has(branch.upstream)) await get().branchOperation({ type: 'delete', name, force: false }, action.repoId);
          }
          return;
        }
        if (action.type === 'createBranch') {
          const wid = workspaceId();
          const name = await promptDialog({ title: t('Create Branch from Current Commit'), message: t('Enter new branch name') });
          if (!name?.trim() || get().snapshot?.workspace.id !== wid) return;
          const current = await bridge().request<RepositoryStatus>({ type: 'repositoryStatus', payload: { workspace_id: wid, repo_id: action.repoId } }, { showProgress: false });
          if (get().snapshot?.workspace.id !== wid || current.revision !== action.revision) return;
          actionSucceeded = Boolean((await get().branchOperation({ type: 'create', name: name.trim(), from: action.revision, checkout: true }, action.repoId))?.completed);
          return;
        }
        switch (action.type) {
          case 'updateProject': await get().updateProject(); break;
          case 'openPush': get().setActiveTab('sync'); break;
          case 'openStash': get().setActiveTab('stash'); break;
          case 'openShelf': get().setActiveTab('shelf'); break;
          case 'openConflicts': get().openConflicts(); break;
          case 'pushTag': {
            const result = await get().runTagWorkflow({ action: 'push', repoId: action.repoId, tagName: action.tagName });
            actionSucceeded = result.outcome === 'success';
            break;
          }
          case 'pushToRemote': {
            try {
              await get().sync(action.repoId, 'push', false, { rethrow: true });
              const repo = get().snapshot?.repositories.find((r) => r.meta.id === action.repoId);
              const repoName = repo?.meta.name;
              const message: NotificationText = repoName
                ? { key: 'VersionDock [{0}]: Pushed and configured remote tracking.', args: [repoName] }
                : 'VersionDock: Pushed and configured remote tracking.';
              get().addNotification({
                type: 'success',
                title: 'Push completed',
                message,
                workspaceId: notification.workspaceId,
              });
            } catch {
              actionSucceeded = false;
              // sync 抛出错误时 withBusy 内部已弹出错误通知，此处不弹出成功通知
            }
            break;
          }
          case 'dropAutoStash': {
            const stash = get().stashes[action.repoId]?.find((entry) => entry.hash === action.hash);
            if (stash) await get().stashOperation(action.repoId, { type: 'drop', reference: stash.reference, expected_hash: action.hash });
            if (!get().stashes[action.repoId]?.some((entry) => entry.hash === action.hash)) pendingPullAutoStashes.delete(`${action.workspaceId}\0${action.repoId}`);
            break;
          }
          case 'keepAutoStash': pendingPullAutoStashes.delete(`${action.workspaceId}\0${action.repoId}`); break;
          case 'openIdentity': get().openIdentityPanel(action.repoId); break;
          case 'refresh': await get().refresh(true); break;
          case 'viewUpdateDetails': await get().openUpdateDetails(action.result); break;
          case 'viewUpdateResults': await get().openUpdateResults(action.results); break;
          case 'addUntracked': {
            const pathsByRepo = new Map<string, string[]>();
            for (const file of action.files) pathsByRepo.set(file.repoId, [...(pathsByRepo.get(file.repoId) ?? []), file.path]);
            for (const [repoId, paths] of pathsByRepo) await get().stage(repoId, paths);
            break;
          }
          case 'retryBatchResult': await get().retryBatchResult(action.repoId, { reportId: action.reportId, workspaceId: action.workspaceId }); break;
          case 'openBranchComparison': {
            const currentWorkspace = get().snapshot;
            if (!currentWorkspace) return;
            if (notification.workspaceId && currentWorkspace.workspace.id !== notification.workspaceId) return;
            if (!currentWorkspace.repositories.some((r) => r.meta.id === action.repoId)) return;

            const wid = currentWorkspace.workspace.id;
            if (get().selectedRepoId !== action.repoId) {
              await get().selectRepo(action.repoId, false);
            }
            if (get().snapshot?.workspace.id !== wid) return;
            if (!get().snapshot?.repositories.some((r) => r.meta.id === action.repoId)) return;

            get().openBranchComparison(action.repoId, action.target);
            break;
          }
        }
      } catch (error) {
        actionSucceeded = false;
        publishError('Operation failed', error, notification.workspaceId);
      } finally {
        set((state) => ({ notifications: state.notifications.map((item) => item.id === notificationId ? { ...item, actionState: { ...Object.fromEntries(Object.entries(item.actionState ?? {}).filter(([index]) => Number(index) !== actionIndex)), ...(actionSucceeded ? { [actionIndex]: 'done' as const } : {}) } } : item) }));
      }
    },
    markNotificationAsRead: (id) => {
      set((state) => ({
        notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
      }));
    },
    markAllNotificationsAsRead: (workspaceId?: string) => {
      set((state) => ({
        notifications: state.notifications.map((n) => {
          if (!workspaceId || n.workspaceId === workspaceId || !n.workspaceId) {
            return { ...n, read: true };
          }
          return n;
        }),
      }));
    },
    removeNotification: (id) => {
      set((state) => ({
        notifications: state.notifications.filter((n) => n.id !== id),
        toastNotificationIds: (state.toastNotificationIds ?? []).filter((item) => item !== id),
      }));
    },
    clearNotifications: (workspaceId?: string) => {
      set((state) => {
        if (!workspaceId) {
          return { notifications: [], toastNotificationIds: [] };
        }
        const filtered = state.notifications.filter((n) => n.workspaceId && n.workspaceId !== workspaceId);
        const keptIds = new Set(filtered.map((n) => n.id));
        return {
          notifications: filtered,
          toastNotificationIds: (state.toastNotificationIds ?? []).filter((id) => keptIds.has(id)),
        };
      });
    },
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
    toggleLogPanel: () => {
      const next = !get().logPanelOpen;
      const activeTabId = get().activeTabId;
      const nextTimestamps = next
        ? { ...get().lastReadLogTimestamps, [activeTabId ?? '__global__']: Date.now() }
        : get().lastReadLogTimestamps;
      set({
        logPanelOpen: next,
        unreadErrorCount: next ? 0 : get().unreadErrorCount,
        lastReadLogTimestamps: nextTimestamps,
      });
    },
    setLogPanelOpen: (open) => {
      const activeTabId = get().activeTabId;
      const nextTimestamps = open
        ? { ...get().lastReadLogTimestamps, [activeTabId ?? '__global__']: Date.now() }
        : get().lastReadLogTimestamps;
      set({
        logPanelOpen: open,
        unreadErrorCount: open ? 0 : get().unreadErrorCount,
        lastReadLogTimestamps: nextTimestamps,
      });
    },
    setLogPanelHeight: (height) => {
      const clamped = Math.max(120, Math.min(height, 600));
      set({ logPanelHeight: clamped });
      try { localStorage.setItem('versiondock:logPanelHeight', String(clamped)); } catch { /* ignore localStorage error */ }
    },
    setLogChannel: (channel) => set({ activeLogChannel: channel }),
    setLogLevel: (level) => set({ activeLogLevel: level }),
    setLogSearchQuery: (query) => set({ logSearchQuery: query }),
    setLogAutoScroll: (autoScroll) => set({ logAutoScroll: autoScroll }),
    clearLogs: async () => {
      if (clearLogPromise) return clearLogPromise;
      flushLogs();
      const previous = get().logEntries;
      const owner = logSession;
      const generation = ++logGeneration;
      set({ logEntries: [], unreadErrorCount: 0, logError: null });
      const request = bridge().clearLogs().catch((error: unknown) => {
        if (owner === logSession && generation === logGeneration) {
          flushLogs();
          commitLogs(previous);
          set({ logError: 'Unable to clear logs.' });
        }
        throw error;
      }).finally(() => { if (owner === logSession) clearLogPromise = undefined; });
      clearLogPromise = request;
      return request;
    },
    addLogEntry: (entry) => { flushLogs(); commitLogs([entry]); },
    loadLogs: async () => {
      const owner = logSession;
      const generation = logGeneration;
      const value = bridge();
      try {
        if (clearLogPromise) await clearLogPromise;
        if (owner !== logSession || generation !== logGeneration) return;
        const [logs, storageError] = await Promise.all([value.getLogs(), value.getLogStorageStatus()]);
        if (owner !== logSession || generation !== logGeneration) return;
        // Apply the historical snapshot first; live records take precedence.
        set({ logEntries: mergeLogEntries(logs, get().logEntries), logStorageError: storageError, logError: null });
        flushLogs();
        commitLogs([]);
      } catch {
        if (owner === logSession && generation === logGeneration) set({ logError: 'Unable to load logs.' });
      }
    },
    openLogFolder: async () => {
      await bridge().openLogFolder();
    },
    exportLogs: async (targetPath) => {
      return await bridge().exportLogs(targetPath);
    },
    resetUnreadErrors: () => {
      const activeTabId = get().activeTabId;
      const nextTimestamps = { ...get().lastReadLogTimestamps, [activeTabId ?? '__global__']: Date.now() };
      set({ unreadErrorCount: 0, lastReadLogTimestamps: nextTimestamps });
    },
  };
});

export const selectedRepository = (state: AppStore): RepositoryStatus | undefined =>
  state.snapshot?.repositories.find((repo) => repo.meta.id === state.selectedRepoId);
