import { create } from 'zustand';
import type {
  AppStateSnapshot, BootstrapData, BranchInfo, CommitDetail, CommitFile, CommitNode, ConflictFile, DiffDocument, GraphCommitNode,
  BranchCompareResult, HistoryPage, MergeVersions, RemoteInfo, RemoteOperation, RepositoryStatus, TagInfo, ThemePreference, LanguagePreference, UiFontSizePreference,
  WorkspaceSnapshot, StashEntry, StashOperation, ShelfEntry, ShelfOperation, ChangelistEntry, ChangelistOperation, WorktreeEntry, WorktreeOperation, SubtreeEntry, SubtreeOperation,
  UnpushedCommit, MergeCommitSummary,
} from '../bindings/generated';
import type { VersionDockBridge } from '../platform/bridge';
import { buildCommitFileTargets, commitKey, type DetailFileTarget } from '../history/commitDetails';

export type WorkspaceMode = 'history' | 'diff' | 'changes' | 'merge';
export type CommitSelectionMode = 'single' | 'toggle' | 'range';
export type DiffRange = { fromRevision: string; toRevision: string };
export type CommitChangesModel = { commits: CommitNode[]; files: DetailFileTarget[] };
export type HistoryScope = {
  repoIds: string[] | null;
  revisionsByRepo: Record<string, string>;
};

const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_COMMITS = 1_000;

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

export interface AppStore {
  bridge?: VersionDockBridge;
  ready: boolean;
  busy: boolean;
  error?: string;
  bootstrap?: BootstrapData;
  snapshot?: WorkspaceSnapshot;
  selectedRepoId?: string;
  selectedFile?: { repoId: string; path: string; staged: boolean; revision?: string; fromRevision?: string; toRevision?: string };
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
  subtrees: Record<string, SubtreeEntry[]>;
  unpushedCommits: Record<string, UnpushedCommit[]>;
  comparison?: BranchCompareResult;
  remotes: Record<string, RemoteInfo[]>;
  initialize: (bridge: VersionDockBridge) => Promise<void>;
  openWorkspace: (paths: string[]) => Promise<void>;
  restoreLastWorkspace: () => Promise<void>;
  removeRecent: (workspaceId: string) => Promise<void>;
  refresh: (silent?: boolean) => Promise<void>;
  selectRepo: (repoId: string, reload?: boolean) => Promise<void>;
  openDiff: (repoId: string, path: string, staged: boolean, revision?: string, range?: DiffRange) => Promise<void>;
  openCommitChanges: () => void;
  loadChangesDiff: (target: DetailFileTarget) => Promise<void>;
  stage: (repoId: string, paths: string[]) => Promise<void>;
  unstage: (repoId: string, paths: string[]) => Promise<void>;
  discard: (repoId: string, paths: string[]) => Promise<void>;
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
  loadSubtrees: (repoId?: string) => Promise<void>;
  subtreeOperation: (repoId: string, operation: SubtreeOperation) => Promise<void>;
  loadUnpushedCommits: (repoId?: string) => Promise<void>;
  compareBranches: (repoId: string, base: string, target: string) => Promise<void>;
  clearComparison: () => void;
  loadRemotes: (repoId?: string) => Promise<void>;
  remoteOperation: (repoId: string, operation: RemoteOperation) => Promise<void>;
  systemOpen: (repoId: string, path: string, reveal: boolean, external?: boolean) => Promise<void>;
  loadConflicts: () => Promise<void>;
  openMerge: (conflict: ConflictFile) => Promise<void>;
  setMergeResult: (value: string) => void;
  saveMerge: () => Promise<void>;
  acceptConflict: (choice: 'mine' | 'theirs' | 'working') => Promise<void>;
  backToHistory: () => void;
  setTheme: (value: ThemePreference) => Promise<void>;
  setLanguage: (value: LanguagePreference) => Promise<void>;
  setUiFontSize: (value: UiFontSizePreference) => void;
  setExternalEditor: (executable: string, args: string[]) => void;
  setFileViewMode: (value: 'tree' | 'list') => void;
  setStashViewMode: (value: 'tree' | 'list') => void;
  setActiveTab: (value: 'changes' | 'shelf' | 'stash' | 'worktree' | 'subtree' | 'push') => void;
  setPanelSize: (key: 'commit' | 'branches' | 'detail', value: number) => void;
  setBranchSidebarState: (collapsed: boolean, collapsedSections: string[]) => void;
  clearError: () => void;
}

const emptyState: AppStateSnapshot = {
  theme: 'system', language: 'system', uiFontSize: 'standard', lastWorkspaceId: null, recentWorkspaces: [],
  panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', stashViewMode: 'tree', externalEditor: null,
  branchSidebarCollapsed: false, branchSidebarCollapsedSections: [],
};

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let watcherTimer: ReturnType<typeof setTimeout> | undefined;
let workspaceRequestGeneration = 0;
let watcherRefreshInFlight = false;
let watcherRefreshQueued = false;
let commitSelectionGeneration = 0;
let changesDiffGeneration = 0;
let historyRequestGeneration = 0;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export const useAppStore = create<AppStore>((set, get) => {
  const withBusy = async (operation: () => Promise<void>) => {
    set({ busy: true, error: undefined });
    try { await operation(); } catch (error) { set({ error: errorText(error) }); } finally { set({ busy: false }); }
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

  const persist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const state = get().bootstrap?.state;
      if (state) bridge().send({ type: 'saveAppState', payload: { state } });
    }, 250);
  };

  const applySnapshot = async (snapshot: WorkspaceSnapshot, reloadRepository = true) => {
    const current = get().snapshot;
    if (current?.workspace.id === snapshot.workspace.id && current.generation > snapshot.generation) return;
    const workspaceChanged = current?.workspace.id !== snapshot.workspace.id;
    const selectedRepoId = snapshot.repositories.some((repo) => repo.meta.id === get().selectedRepoId)
      ? get().selectedRepoId : snapshot.repositories[0]?.meta.id;
      set(workspaceChanged
      ? { snapshot, selectedRepoId, selectedFile: undefined, diff: undefined, changesDiff: undefined, changes: undefined, merge: undefined, mode: 'history', history: [], historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, subtrees: {}, worktrees: {}, stashes: {}, shelves: {}, changelists: {}, remotes: {}, unpushedCommits: {}, selectedCommits: [], selectedPrimaryKey: undefined, selectedCommit: undefined, selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {} }
      : { snapshot, selectedRepoId });
    if (selectedRepoId && (workspaceChanged || reloadRepository)) await get().selectRepo(selectedRepoId, true);
    await Promise.all([
      get().loadConflicts(),
      get().loadStashes(),
      get().loadShelves(),
      get().loadWorktrees(),
      get().loadSubtrees(),
      get().loadUnpushedCommits(),
    ]);
  };

  const refreshFromWatcher = async () => {
    if (watcherRefreshInFlight) {
      watcherRefreshQueued = true;
      return;
    }
    watcherRefreshInFlight = true;
    try {
      await get().refresh(true);
    } finally {
      watcherRefreshInFlight = false;
      if (watcherRefreshQueued) {
        watcherRefreshQueued = false;
        watcherTimer = setTimeout(() => void refreshFromWatcher(), 300);
      }
    }
  };

  return {
    ready: false, busy: false, mode: 'history', history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyFilter: '', historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, unpushedCommits: {}, remotes: {},

    initialize: async (value) => {
      set({ bridge: value });
      value.subscribe((event) => {
        if ('workspaceId' in event && event.reason === 'file-change' && event.workspaceId === get().snapshot?.workspace.id) {
          if (watcherTimer) clearTimeout(watcherTimer);
          watcherTimer = setTimeout(() => void refreshFromWatcher(), 300);
        }
      });
      await withBusy(async () => {
        const bootstrap = await value.request<BootstrapData>({ type: 'bootstrap' });
        value.setState(bootstrap.state);
        set({ bootstrap, ready: true });
        await get().restoreLastWorkspace();
      });
      set({ ready: true });
    },

    openWorkspace: async (paths) => withBusy(async () => {
      if (!paths.length) return;
      const requestGeneration = ++workspaceRequestGeneration;
      const snapshot = await bridge().request<WorkspaceSnapshot>({ type: 'workspaceOpen', payload: { paths } });
      if (requestGeneration !== workspaceRequestGeneration) return;
      const bootstrap = get().bootstrap ?? { state: emptyState, tools: snapshot.tools, capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false } };
      bootstrap.state.recentWorkspaces = [snapshot.workspace, ...bootstrap.state.recentWorkspaces.filter((item) => item.id !== snapshot.workspace.id)].slice(0, 10);
      bootstrap.state.lastWorkspaceId = snapshot.workspace.id;
      set({ bootstrap: { ...bootstrap } });
      await applySnapshot(snapshot);
    }),

    restoreLastWorkspace: async () => {
      const state = get().bootstrap?.state;
      const recent = state?.recentWorkspaces.find((item) => item.id === state.lastWorkspaceId && item.available);
      if (recent) await get().openWorkspace(recent.paths);
    },

    removeRecent: async (id) => withBusy(async () => {
      await bridge().request({ type: 'workspaceRemoveRecent', payload: { workspace_id: id } });
      const bootstrap = get().bootstrap;
      if (bootstrap) {
        bootstrap.state.recentWorkspaces = bootstrap.state.recentWorkspaces.filter((item) => item.id !== id);
        if (bootstrap.state.lastWorkspaceId === id) bootstrap.state.lastWorkspaceId = null;
        set({ bootstrap: { ...bootstrap } });
      }
    }),

    refresh: async (silent = false) => {
      const operation = async () => {
        const id = workspaceId();
        const snapshot = await bridge().request<WorkspaceSnapshot>({ type: 'workspaceRefresh', payload: { workspace_id: id } });
        if (get().snapshot?.workspace.id !== id) return;
        await applySnapshot(snapshot, !silent);
      };
      if (silent) {
        try { await operation(); } catch (error) { set({ error: errorText(error) }); }
      } else {
        await withBusy(operation);
      }
    },

    selectRepo: async (repoId, reload = false) => {
      const repo = get().snapshot?.repositories.find((item) => item.meta.id === repoId);
      if (!repo) return;
      const repoChanged = get().selectedRepoId !== repoId;
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
          mode: 'history' as const,
        } : {}),
        branches: state.branchesByRepo[repoId] ?? [],
        tags: state.tagsByRepo[repoId] ?? [],
        comparison: undefined,
      }));
      if (!reload && Object.keys(get().historyByRepo).length > 0) return;
      await withBusy(async () => {
        set({ branchesLoading: true });
        const requests: Promise<unknown>[] = [get().loadHistory(true)];
        if (get().bootstrap?.capabilities.changelist) requests.push(get().loadChangelists(repoId));
        if (repo.meta.kind === 'git' && get().bootstrap?.capabilities.subtree) requests.push(get().loadSubtrees(repoId));
        for (const item of get().snapshot?.repositories ?? []) {
          requests.push(bridge().request<BranchInfo[]>({ type: 'branches', payload: { workspace_id: workspaceId(), repo_id: item.meta.id } }).then((branches) => set((state) => ({
            branchesByRepo: { ...state.branchesByRepo, [item.meta.id]: branches },
            branches: item.meta.id === get().selectedRepoId ? branches : state.branches,
          }))));
          requests.push(bridge().request<TagInfo[]>({ type: 'tags', payload: { workspace_id: workspaceId(), repo_id: item.meta.id } }).then((tags) => set((state) => ({
            tagsByRepo: { ...state.tagsByRepo, [item.meta.id]: tags },
            tags: item.meta.id === get().selectedRepoId ? tags : state.tags,
          }))));
        }
        try {
          await Promise.all(requests);
        } finally {
          set({ branchesLoading: false });
        }
        const firstCommit = get().history[0];
        if (firstCommit && !get().selectedCommits.length) await get().selectCommit(firstCommit);
      });
    },

    openDiff: async (repoId, path, staged, revision, range) => withBusy(async () => {
      const diff = await bridge().request<DiffDocument>({ type: 'fileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, relative_path: path, staged, revision: revision ?? null, from_revision: range?.fromRevision ?? null, to_revision: range?.toRevision ?? null } });
      set({ selectedFile: { repoId, path, staged, revision, fromRevision: range?.fromRevision, toRevision: range?.toRevision }, diff, mode: 'diff' });
    }),

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
    }),

    stage: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'stage', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
      await get().refresh();
    }),

    unstage: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'unstage', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
      await get().refresh();
    }),

    discard: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'discard', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
      await get().refresh();
    }),

    commit: async (repoId, message, amend, paths, push) => withBusy(async () => {
      await bridge().request({ type: 'commit', payload: { workspace_id: workspaceId(), repo_id: repoId, message, amend, paths } });
      if (push) await bridge().request({ type: 'sync', payload: { workspace_id: workspaceId(), repo_id: repoId, action: 'push', remote: null } }, { timeoutMs: 600_000 });
      await get().refresh();
    }),

    commitMany: async (targets, message, push) => withBusy(async () => {
      const workspace_id = workspaceId();
      await Promise.all(targets.map(async (target) => {
        if (target.unstagePaths.length > 0) {
          await bridge().request({ type: 'unstage', payload: { workspace_id, repo_id: target.repoId, paths: target.unstagePaths } });
        }
        await bridge().request({ type: 'commit', payload: { workspace_id, repo_id: target.repoId, message, amend: target.amend, paths: target.paths } });
        if (push) {
          await bridge().request({ type: 'sync', payload: { workspace_id, repo_id: target.repoId, action: 'push', remote: null } }, { timeoutMs: 600_000 });
        }
      }));
      await get().refresh();
    }),

    sync: async (repoId, action) => withBusy(async () => {
      await bridge().request({ type: 'sync', payload: { workspace_id: workspaceId(), repo_id: repoId, action, remote: null } }, { timeoutMs: 600_000 });
      await get().refresh();
    }),

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
      if (!reset && get().history.length >= HISTORY_MAX_COMMITS) {
        set({ historyHasMore: false });
        return;
      }
      const requestGeneration = reset ? ++historyRequestGeneration : historyRequestGeneration;
      const requestWorkspace = workspaceId();
      const visibleLimit = Math.min((reset ? 0 : get().history.length) + HISTORY_PAGE_SIZE, HISTORY_MAX_COMMITS);
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
        const historyHasMore = visibleLimit < HISTORY_MAX_COMMITS
          && (mergedHistory.length > visibleLimit || Object.values(nextHasMore).some(Boolean));
        if (topology) {
          const historyTopologyByRepo = Object.fromEntries(topology.map((item) => [item.repoId, item.commits]));
          set({ historyByRepo: nextByRepo, historyHasMoreByRepo: nextHasMore, history, historyHasMore, historyTopologyByRepo, historyTopology: interleaveLogs(historyTopologyByRepo) });
        } else {
          set({ historyByRepo: nextByRepo, historyHasMoreByRepo: nextHasMore, history, historyHasMore });
        }
      } catch (error) {
        set({ error: errorText(error) });
        throw error;
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
        set((state) => ({ error: errorText(error), selectedCommitLoading: { ...state.selectedCommitLoading, [key]: false } }));
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
    }),

    loadMergeCommits: async (commit) => {
      const key = commitKey(commit.repoId, commit.hash);
      if (get().mergeCommits[key] || get().mergeCommitsLoading[key] || commit.parents.length < 2) return;
      set((state) => ({ mergeCommitsLoading: { ...state.mergeCommitsLoading, [key]: true } }));
      try {
        const values = await bridge().request<MergeCommitSummary[]>({ type: 'commitMergeCommits', payload: { workspace_id: workspaceId(), repo_id: commit.repoId, revision: commit.hash, parents: commit.parents } });
        set((state) => ({ mergeCommits: { ...state.mergeCommits, [key]: values }, mergeCommitsLoading: { ...state.mergeCommitsLoading, [key]: false } }));
      } catch (error) {
        set((state) => ({ error: errorText(error), mergeCommitsLoading: { ...state.mergeCommitsLoading, [key]: false } }));
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
        set((state) => ({
          error: errorText(error),
          mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: false },
        }));
        throw error;
      }
    },

    clearCommitSelection: () => {
      commitSelectionGeneration += 1;
      set({ selectedCommit: undefined, selectedCommits: [], selectedPrimaryKey: undefined, selectedCommitLoading: {}, changes: undefined, changesDiff: undefined, mode: 'history' });
    },

    branchOperation: async (operation, requestedRepoId) => withBusy(async () => {
      const repoId = requestedRepoId ?? get().selectedRepoId; if (!repoId) return;
      await bridge().request({ type: 'branchOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation: operation as never } });
      await get().refresh();
    }),

    tagOperation: async (operation, requestedRepoId) => withBusy(async () => {
      const repoId = requestedRepoId ?? get().selectedRepoId; if (!repoId) return;
      await bridge().request({ type: 'tagOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation: operation as never } });
      await get().selectRepo(repoId, true);
    }),

    loadStashes: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        const values = await b.request<StashEntry[]>({ type: 'stashes', payload: { workspace_id: wid, repo_id: repoId } }).catch(() => []);
        set((state) => ({ stashes: { ...state.stashes, [repoId]: values } }));
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const values = await Promise.all(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        stashes: await b.request<StashEntry[]>({ type: 'stashes', payload: { workspace_id: wid, repo_id: repo.meta.id } }).catch(() => []),
      })));
      set((state) => ({ stashes: values.reduce((next, value) => ({ ...next, [value.repoId]: value.stashes }), state.stashes) }));
    },
    stashOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'stashOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await Promise.all([get().loadStashes(repoId), get().refresh()]);
    }),
    loadShelves: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        const values = await b.request<ShelfEntry[]>({ type: 'shelves', payload: { workspace_id: wid, repo_id: repoId } }).catch(() => []);
        set((state) => ({ shelves: { ...state.shelves, [repoId]: values } }));
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const values = await Promise.all(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        shelves: await b.request<ShelfEntry[]>({ type: 'shelves', payload: { workspace_id: wid, repo_id: repo.meta.id } }).catch(() => []),
      })));
      set((state) => ({ shelves: values.reduce((next, value) => ({ ...next, [value.repoId]: value.shelves }), state.shelves) }));
    },
    shelfOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'shelfOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await Promise.all([get().loadShelves(repoId), get().refresh()]);
    }),
    loadChangelists: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      const id = repoId ?? get().selectedRepoId;
      if (!b || !wid || !id) return;
      const values = await b.request<ChangelistEntry[]>({ type: 'changelists', payload: { workspace_id: wid, repo_id: id } }).catch(() => []);
      set((state) => ({ changelists: { ...state.changelists, [id]: values } }));
    },
    changelistOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'changelistOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await get().loadChangelists(repoId);
    }),
    loadWorktrees: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        const values = await b.request<WorktreeEntry[]>({ type: 'worktrees', payload: { workspace_id: wid, repo_id: repoId } }).catch(() => []);
        set((state) => ({ worktrees: { ...state.worktrees, [repoId]: values } }));
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const values = await Promise.all(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        worktrees: await b.request<WorktreeEntry[]>({ type: 'worktrees', payload: { workspace_id: wid, repo_id: repo.meta.id } }).catch(() => []),
      })));
      set((state) => ({ worktrees: values.reduce((next, value) => ({ ...next, [value.repoId]: value.worktrees }), state.worktrees) }));
    },
    worktreeOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'worktreeOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await Promise.all([get().loadWorktrees(repoId), get().refresh()]);
    }),
    loadSubtrees: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        const values = await b.request<SubtreeEntry[]>({ type: 'subtrees', payload: { workspace_id: wid, repo_id: repoId } }).catch(() => []);
        set((state) => ({ subtrees: { ...state.subtrees, [repoId]: values } }));
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const values = await Promise.all(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        subtrees: await b.request<SubtreeEntry[]>({ type: 'subtrees', payload: { workspace_id: wid, repo_id: repo.meta.id } }).catch(() => []),
      })));
      set((state) => ({ subtrees: values.reduce((next, value) => ({ ...next, [value.repoId]: value.subtrees }), state.subtrees) }));
    },
    subtreeOperation: async (repoId, operation) => withBusy(async () => {
      const networkOperation = operation.type === 'add' || operation.type === 'pull' || operation.type === 'push';
      await bridge().request({ type: 'subtreeOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, networkOperation ? { timeoutMs: 600_000 } : undefined);
      await Promise.all([get().loadSubtrees(repoId), get().refresh()]);
    }),
    loadUnpushedCommits: async (repoId) => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      if (repoId) {
        const values = await b.request<UnpushedCommit[]>({ type: 'unpushedCommits', payload: { workspace_id: wid, repo_id: repoId } }).catch(() => []);
        set((state) => ({ unpushedCommits: { ...state.unpushedCommits, [repoId]: values } }));
        return;
      }
      const repositories = (get().snapshot?.repositories ?? []).filter((repo) => repo.meta.kind === 'git');
      const values = await Promise.all(repositories.map(async (repo) => ({
        repoId: repo.meta.id,
        commits: await b.request<UnpushedCommit[]>({ type: 'unpushedCommits', payload: { workspace_id: wid, repo_id: repo.meta.id } }).catch(() => []),
      })));
      set((state) => ({ unpushedCommits: values.reduce((next, value) => ({ ...next, [value.repoId]: value.commits }), state.unpushedCommits) }));
    },
    compareBranches: async (repoId, base, target) => withBusy(async () => {
      const comparison = await bridge().request<BranchCompareResult>({ type: 'branchCompare', payload: { workspace_id: workspaceId(), repo_id: repoId, base, target } });
      if (get().selectedRepoId === repoId) set({ comparison });
    }),
    clearComparison: () => set({ comparison: undefined }),
    loadRemotes: async (repoId) => {
      const id = repoId ?? get().selectedRepoId; if (!id) return;
      const values = await bridge().request<RemoteInfo[]>({ type: 'remotes', payload: { workspace_id: workspaceId(), repo_id: id } });
      set((state) => ({ remotes: { ...state.remotes, [id]: values } }));
    },
    remoteOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'remoteOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, operation.type === 'prune' ? { timeoutMs: 600_000 } : undefined);
      await Promise.all([get().loadRemotes(repoId), get().selectRepo(repoId, true)]);
    }),
    systemOpen: async (repoId, relativePath, reveal, external = false) => withBusy(async () => {
      await bridge().request({ type: 'systemOpen', payload: { workspace_id: workspaceId(), repo_id: repoId, relative_path: relativePath, reveal, external } });
    }),

    loadConflicts: async () => {
      const b = get().bridge;
      const wid = get().snapshot?.workspace.id;
      if (!b || !wid) return;
      const conflicts = await b.request<ConflictFile[]>({ type: 'conflicts', payload: { workspace_id: wid } }).catch(() => []);
      set({ conflicts });
    },

    openMerge: async (conflict) => withBusy(async () => {
      const merge = await bridge().request<MergeVersions>({ type: 'conflictVersions', payload: { workspace_id: workspaceId(), repo_id: conflict.repoId, relative_path: conflict.path } });
      set({ merge, mergeResult: merge.working, selectedFile: { repoId: conflict.repoId, path: conflict.path, staged: false }, mode: 'merge' });
    }),

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

    backToHistory: () => set({ mode: 'history', diff: undefined, changes: undefined, changesDiff: undefined, merge: undefined }),

    setTheme: async (theme) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.theme = theme; set({ bootstrap: { ...bootstrap } }); persist();
    },
    setLanguage: async (language) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.language = language; set({ bootstrap: { ...bootstrap } }); persist();
    },
    setUiFontSize: (uiFontSize) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.uiFontSize = uiFontSize; set({ bootstrap: { ...bootstrap } }); persist();
    },
    setExternalEditor: (executable, args) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.externalEditor = executable.trim() ? { executable: executable.trim(), args } : null;
      set({ bootstrap: { ...bootstrap } }); persist();
    },
    setFileViewMode: (fileViewMode) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.fileViewMode = fileViewMode; set({ bootstrap: { ...bootstrap } }); persist();
    },
    setStashViewMode: (stashViewMode) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.stashViewMode = stashViewMode; set({ bootstrap: { ...bootstrap } }); persist();
    },
    setActiveTab: (activeTab) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.activeTab = activeTab; set({ bootstrap: { ...bootstrap } }); persist();
    },
    setPanelSize: (key, value) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.panelSizes[key] = Math.round(value); set({ bootstrap: { ...bootstrap } }); persist();
    },
    setBranchSidebarState: (collapsed, collapsedSections) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.branchSidebarCollapsed = collapsed;
      bootstrap.state.branchSidebarCollapsedSections = [...new Set(collapsedSections)];
      set({ bootstrap: { ...bootstrap } }); persist();
    },
    clearError: () => set({ error: undefined }),
  };
});

export const selectedRepository = (state: AppStore): RepositoryStatus | undefined =>
  state.snapshot?.repositories.find((repo) => repo.meta.id === state.selectedRepoId);
