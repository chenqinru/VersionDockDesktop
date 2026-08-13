import { create } from 'zustand';
import type {
  AppStateSnapshot, BootstrapData, BranchInfo, CommitDetail, CommitNode, ConflictFile, DiffDocument,
  BranchCompareResult, HistoryPage, MergeVersions, RemoteInfo, RemoteOperation, RepositoryStatus, TagInfo, ThemePreference, LanguagePreference,
  WorkspaceSnapshot, StashEntry, StashOperation, ShelfEntry, ShelfOperation, ChangelistEntry, ChangelistOperation, WorktreeEntry, WorktreeOperation, SubtreeEntry, SubtreeOperation,
} from '../bindings/generated';
import type { VersionDockBridge } from '../platform/bridge';

export type WorkspaceMode = 'history' | 'diff' | 'merge';

interface AppStore {
  bridge?: VersionDockBridge;
  ready: boolean;
  busy: boolean;
  error?: string;
  bootstrap?: BootstrapData;
  snapshot?: WorkspaceSnapshot;
  selectedRepoId?: string;
  selectedFile?: { repoId: string; path: string; staged: boolean };
  mode: WorkspaceMode;
  diff?: DiffDocument;
  history: CommitNode[];
  historyHasMore: boolean;
  historyByRepo: Record<string, CommitNode[]>;
  historyHasMoreByRepo: Record<string, boolean>;
  historyFilter: string;
  selectedCommit?: CommitDetail;
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
  comparison?: BranchCompareResult;
  remotes: Record<string, RemoteInfo[]>;
  initialize: (bridge: VersionDockBridge) => Promise<void>;
  openWorkspace: (paths: string[]) => Promise<void>;
  restoreLastWorkspace: () => Promise<void>;
  removeRecent: (workspaceId: string) => Promise<void>;
  refresh: (silent?: boolean) => Promise<void>;
  selectRepo: (repoId: string, reload?: boolean) => Promise<void>;
  openDiff: (repoId: string, path: string, staged: boolean, revision?: string) => Promise<void>;
  stage: (repoId: string, paths: string[]) => Promise<void>;
  unstage: (repoId: string, paths: string[]) => Promise<void>;
  commit: (repoId: string, message: string, amend: boolean, paths: string[], push: boolean) => Promise<void>;
  sync: (repoId: string, action: 'fetch' | 'pull' | 'push' | 'update') => Promise<void>;
  loadHistory: (reset?: boolean) => Promise<void>;
  setHistoryFilter: (value: string) => void;
  selectCommit: (commit: CommitNode) => Promise<void>;
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
  setExternalEditor: (executable: string, args: string[]) => void;
  setFileViewMode: (value: 'tree' | 'list') => void;
  setActiveTab: (value: 'changes' | 'shelf' | 'stash' | 'worktree' | 'subtree') => void;
  setPanelSize: (key: 'commit' | 'branches' | 'detail', value: number) => void;
  clearError: () => void;
}

const emptyState: AppStateSnapshot = {
  theme: 'system', language: 'system', lastWorkspaceId: null, recentWorkspaces: [],
  panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null,
};

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let watcherTimer: ReturnType<typeof setTimeout> | undefined;
let workspaceRequestGeneration = 0;
let watcherRefreshInFlight = false;
let watcherRefreshQueued = false;

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
      ? { snapshot, selectedRepoId, selectedFile: undefined, diff: undefined, merge: undefined, mode: 'history', history: [], historyByRepo: {}, historyHasMoreByRepo: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, subtrees: {} }
      : { snapshot, selectedRepoId });
    if (selectedRepoId && (workspaceChanged || reloadRepository)) await get().selectRepo(selectedRepoId, true);
    await get().loadConflicts();
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
    ready: false, busy: false, mode: 'history', history: [], historyHasMore: false, historyByRepo: {}, historyHasMoreByRepo: {}, historyFilter: '', branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, remotes: {},

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
      set((state) => ({
        selectedRepoId: repoId,
        selectedCommit: undefined,
        branches: state.branchesByRepo[repoId] ?? [],
        tags: state.tagsByRepo[repoId] ?? [],
        comparison: undefined,
      }));
      if (!reload && Object.keys(get().historyByRepo).length > 0) return;
      await withBusy(async () => {
        const requests: Promise<unknown>[] = [get().loadHistory(true)];
        if (get().bootstrap?.capabilities.changelist) requests.push(get().loadChangelists(repoId));
        if (repo.meta.kind === 'git' && get().bootstrap?.capabilities.subtree) requests.push(get().loadSubtrees(repoId));
        for (const item of get().snapshot?.repositories ?? []) {
          if (item.meta.kind !== 'git') continue;
          requests.push(bridge().request<BranchInfo[]>({ type: 'branches', payload: { workspace_id: workspaceId(), repo_id: item.meta.id } }).then((branches) => set((state) => ({
            branchesByRepo: { ...state.branchesByRepo, [item.meta.id]: branches },
            branches: item.meta.id === get().selectedRepoId ? branches : state.branches,
          }))));
          requests.push(bridge().request<TagInfo[]>({ type: 'tags', payload: { workspace_id: workspaceId(), repo_id: item.meta.id } }).then((tags) => set((state) => ({
            tagsByRepo: { ...state.tagsByRepo, [item.meta.id]: tags },
            tags: item.meta.id === get().selectedRepoId ? tags : state.tags,
          }))));
        }
        await Promise.all(requests);
      });
    },

    openDiff: async (repoId, path, staged, revision) => withBusy(async () => {
      const diff = await bridge().request<DiffDocument>({ type: 'fileDiff', payload: { workspace_id: workspaceId(), repo_id: repoId, relative_path: path, staged, revision: revision ?? null } });
      set({ selectedFile: { repoId, path, staged }, diff, mode: 'diff' });
    }),

    stage: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'stage', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
      await get().refresh();
    }),

    unstage: async (repoId, paths) => withBusy(async () => {
      await bridge().request({ type: 'unstage', payload: { workspace_id: workspaceId(), repo_id: repoId, paths } });
      await get().refresh();
    }),

    commit: async (repoId, message, amend, paths, push) => withBusy(async () => {
      await bridge().request({ type: 'commit', payload: { workspace_id: workspaceId(), repo_id: repoId, message, amend, paths } });
      if (push) await bridge().request({ type: 'sync', payload: { workspace_id: workspaceId(), repo_id: repoId, action: 'push', remote: null } }, { timeoutMs: 600_000 });
      await get().refresh();
    }),

    sync: async (repoId, action) => withBusy(async () => {
      await bridge().request({ type: 'sync', payload: { workspace_id: workspaceId(), repo_id: repoId, action, remote: null } }, { timeoutMs: 600_000 });
      await get().refresh();
    }),

    loadHistory: async (reset = false) => {
      const repos = get().snapshot?.repositories ?? [];
      if (!repos.length) return;
      const requestWorkspace = workspaceId();
      const currentByRepo = reset ? {} : get().historyByRepo;
      const targets = reset ? repos : repos.filter((repo) => get().historyHasMoreByRepo[repo.meta.id] !== false);
      const pages = await Promise.all(targets.map(async (repo) => {
        const existing = currentByRepo[repo.meta.id] ?? [];
        const page = await bridge().request<HistoryPage>({ type: 'history', payload: { workspace_id: requestWorkspace, repo_id: repo.meta.id, skip: existing.length, limit: 100, filter: get().historyFilter || null } });
        return { repoId: repo.meta.id, page, existing };
      }));
      if (get().snapshot?.workspace.id !== requestWorkspace) return;
      const nextByRepo = { ...currentByRepo };
      const nextHasMore = reset ? {} as Record<string, boolean> : { ...get().historyHasMoreByRepo };
      for (const { repoId, page, existing } of pages) {
        nextByRepo[repoId] = [...existing, ...page.commits];
        nextHasMore[repoId] = page.hasMore;
      }
      const history = repos.flatMap((repo) => nextByRepo[repo.meta.id] ?? []);
      set({ historyByRepo: nextByRepo, historyHasMoreByRepo: nextHasMore, history, historyHasMore: Object.values(nextHasMore).some(Boolean) });
    },

    setHistoryFilter: (value) => set({ historyFilter: value }),

    selectCommit: async (commit) => withBusy(async () => {
      const detail = await bridge().request<CommitDetail>({ type: 'commitDetail', payload: { workspace_id: workspaceId(), repo_id: commit.repoId, revision: commit.hash } });
      set({ selectedCommit: detail });
    }),

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
      const id = repoId ?? get().selectedRepoId; if (!id) return;
      const values = await bridge().request<StashEntry[]>({ type: 'stashes', payload: { workspace_id: workspaceId(), repo_id: id } });
      set((state) => ({ stashes: { ...state.stashes, [id]: values } }));
    },
    stashOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'stashOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await Promise.all([get().loadStashes(repoId), get().refresh()]);
    }),
    loadShelves: async (repoId) => {
      const id = repoId ?? get().selectedRepoId; if (!id) return;
      const values = await bridge().request<ShelfEntry[]>({ type: 'shelves', payload: { workspace_id: workspaceId(), repo_id: id } });
      set((state) => ({ shelves: { ...state.shelves, [id]: values } }));
    },
    shelfOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'shelfOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await Promise.all([get().loadShelves(repoId), get().refresh()]);
    }),
    loadChangelists: async (repoId) => {
      const id = repoId ?? get().selectedRepoId; if (!id) return;
      const values = await bridge().request<ChangelistEntry[]>({ type: 'changelists', payload: { workspace_id: workspaceId(), repo_id: id } });
      set((state) => ({ changelists: { ...state.changelists, [id]: values } }));
    },
    changelistOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'changelistOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await get().loadChangelists(repoId);
    }),
    loadWorktrees: async (repoId) => {
      const id = repoId ?? get().selectedRepoId; if (!id) return;
      const values = await bridge().request<WorktreeEntry[]>({ type: 'worktrees', payload: { workspace_id: workspaceId(), repo_id: id } });
      set((state) => ({ worktrees: { ...state.worktrees, [id]: values } }));
    },
    worktreeOperation: async (repoId, operation) => withBusy(async () => {
      await bridge().request({ type: 'worktreeOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } });
      await Promise.all([get().loadWorktrees(repoId), get().refresh()]);
    }),
    loadSubtrees: async (repoId) => {
      const id = repoId ?? get().selectedRepoId; if (!id) return;
      const values = await bridge().request<SubtreeEntry[]>({ type: 'subtrees', payload: { workspace_id: workspaceId(), repo_id: id } });
      set((state) => ({ subtrees: { ...state.subtrees, [id]: values } }));
    },
    subtreeOperation: async (repoId, operation) => withBusy(async () => {
      const networkOperation = operation.type === 'add' || operation.type === 'pull' || operation.type === 'push';
      await bridge().request({ type: 'subtreeOperation', payload: { workspace_id: workspaceId(), repo_id: repoId, operation } }, networkOperation ? { timeoutMs: 600_000 } : undefined);
      await Promise.all([get().loadSubtrees(repoId), get().refresh()]);
    }),
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
      if (!get().snapshot) return;
      const conflicts = await bridge().request<ConflictFile[]>({ type: 'conflicts', payload: { workspace_id: workspaceId() } });
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

    backToHistory: () => set({ mode: 'history', diff: undefined, merge: undefined }),

    setTheme: async (theme) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.theme = theme; set({ bootstrap: { ...bootstrap } }); persist();
    },
    setLanguage: async (language) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.language = language; set({ bootstrap: { ...bootstrap } }); persist();
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
    setActiveTab: (activeTab) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.activeTab = activeTab; set({ bootstrap: { ...bootstrap } }); persist();
    },
    setPanelSize: (key, value) => {
      const bootstrap = get().bootstrap; if (!bootstrap) return;
      bootstrap.state.panelSizes[key] = Math.round(value); set({ bootstrap: { ...bootstrap } }); persist();
    },
    clearError: () => set({ error: undefined }),
  };
});

export const selectedRepository = (state: AppStore): RepositoryStatus | undefined =>
  state.snapshot?.repositories.find((repo) => repo.meta.id === state.selectedRepoId);
