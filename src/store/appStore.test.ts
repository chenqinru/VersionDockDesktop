import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapData, DesktopSettings, BridgeCommand, CommitDetail, CommitNode, HistoryPage, ConflictFile, DiffDocument, OperationEvent, RepositoryStatus, SubtreeEntry, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeError, MockBridge, type BridgeEvent, type RequestOptions } from '../platform/bridge';
import { currentDialog, publishDialog } from '../components/dialogService';
import { commitKey } from '../history/commitDetails';
import { interleaveHistory, isOperationActive, isOperationActiveForRepositories, resolveNotificationText, useAppStore, workspacePathsEqual, type WorkingChangeTarget } from './appStore';

const bootstrap: BootstrapData = {
  applicationSessionId: 'test-session',
  state: { theme: 'system', language: 'system', uiFontSize: 'standard', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null },
  tools: { git: true, svn: true, svnadmin: true },
  capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false },
};

const snapshot = (id: string, generation: number): WorkspaceSnapshot => ({
  workspace: { id, name: id, paths: [`/tmp/${id}`], lastOpenedAt: '', available: true },
  generation,
  tools: bootstrap.tools,
  repositories: [],
});

const repository = (id: string, name: string): RepositoryStatus => ({
  meta: { id, name, rootPath: `/tmp/${id}`, color: id === 'a' ? '#4ec9b0' : '#61afef', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

afterEach(() => {
  publishDialog(undefined);
  useAppStore.getState().dispose();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  useAppStore.setState({ bridge: undefined, bootstrap: undefined, snapshot: undefined, tabs: [], activeTabId: null, sessions: {}, selectedRepoId: undefined, history: [], historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, historyFilter: '', historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [], commitSelectionAnchorKey: undefined, selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, selectedCommit: undefined, changes: undefined, changesDiff: undefined, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], merge: undefined, mergeTarget: undefined, mergeResolutions: {}, mergeScope: 'all', mergeResult: '', commitMessage: '', mergeMessageSuggestion: undefined, amendRepoIds: [], commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, worktreeDiff: undefined, subtrees: {}, remotes: {}, comparisonTarget: undefined, comparison: undefined, mode: 'history', diffReturnMode: undefined, operations: {}, notifications: [], toastNotificationIds: [], notificationCenterOpen: false, ready: false });
});

describe('appStore async lifecycle', () => {
  it('destroys the source window when explicitly closing its last project in multi-window mode', async () => {
    const bridge = new MockBridge(() => []);
    const workspace = snapshot('last-project', 1);
    vi.spyOn(bridge.window, 'hasOtherWorkspaceWindows').mockResolvedValue(true);
    const destroy = vi.spyOn(bridge.window, 'destroy');
    const close = vi.spyOn(bridge.window, 'close');
    useAppStore.setState({ bridge, snapshot: workspace, tabs: [workspace.workspace], activeTabId: workspace.workspace.id });
    await useAppStore.getState().closeTab(workspace.workspace.id);
    expect(destroy).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('shows long foreground operation progress, cancels without switching workspace, and removes it on completion', async () => {
    vi.useFakeTimers();
    let listener: ((event: BridgeEvent) => void) | undefined;
    const bridge = new MockBridge((command) => command.type === 'bootstrap' ? bootstrap : []);
    bridge.subscribe = (handler) => { listener = handler; return () => { listener = undefined; }; };
    const cancel = vi.spyOn(bridge, 'cancelOperation');
    try {
      await useAppStore.getState().initialize(bridge);
      const operation: OperationEvent = {
        operationId: 'native-progress',
        context: { generation: 1, domain: 'sync', visibility: 'foreground', workspaceId: 'original', repositoryId: 'repo', target: null },
        status: 'running', phase: 'Fetching remote updates', message: 'Fetching...',
        startedAt: new Date().toISOString(), cancellable: true, completed: 0, total: 10, error: null,
      };
      listener?.(operation);
      vi.advanceTimersByTime(200);
      expect(useAppStore.getState().notifications.filter((n) => n.progress)).toHaveLength(0);
      vi.advanceTimersByTime(50);
      const progress = useAppStore.getState().notifications.find((n) => n.operationId === operation.operationId)!;
      expect(progress.workspaceId).toBe('original');
      listener?.({ ...operation, completed: 5, message: 'Half way' });
      expect(useAppStore.getState().notifications.find((n) => n.id === progress.id)?.progressValue).toBe(50);
      useAppStore.setState({ activeTabId: 'another', snapshot: snapshot('another', 1) });
      await useAppStore.getState().performNotificationAction(progress.id, 0);
      expect(cancel).toHaveBeenCalledWith(operation.operationId);
      expect(useAppStore.getState().activeTabId).toBe('another');
      listener?.({ ...operation, status: 'cancelled' });
      expect(useAppStore.getState().notifications.some((n) => n.id === progress.id)).toBe(false);
      listener?.({ ...operation, operationId: 'fast' });
      listener?.({ ...operation, operationId: 'fast', status: 'succeeded' });
      listener?.({ ...operation, operationId: 'background', context: { ...operation.context, visibility: 'background' } });
      vi.advanceTimersByTime(1_000);
      expect(useAppStore.getState().notifications.filter((n) => n.progress)).toHaveLength(0);
    } finally {
      useAppStore.getState().dispose();
      vi.useRealTimers();
      cancel.mockRestore();
    }
  });

  it('keeps scheduler states out of toast content even while an operation waits', async () => {
    vi.useFakeTimers();
    let listener: ((event: BridgeEvent) => void) | undefined;
    const bridge = new MockBridge((command) => command.type === 'bootstrap' ? bootstrap : []);
    bridge.subscribe = (handler) => { listener = handler; return () => { listener = undefined; }; };
    try {
      await useAppStore.getState().initialize(bridge);
      const operation: OperationEvent = {
        operationId: 'scheduled-job', context: { generation: 1, domain: 'sync', visibility: 'foreground', workspaceId: 'workspace', repositoryId: 'repo', target: null },
        status: 'queued', phase: 'waitingForWriteSlot', message: 'Waiting for a repository write slot', startedAt: new Date().toISOString(), cancellable: true, completed: null, total: null, error: null,
      };
      listener?.(operation);
      vi.advanceTimersByTime(1_000);
      expect(useAppStore.getState().notifications).toHaveLength(0);
      expect(useAppStore.getState().operations[operation.operationId].status).toBe('queued');
      listener?.({ ...operation, status: 'running', phase: 'loadCommits', message: 'Loading repository commits' });
      vi.advanceTimersByTime(1_000);
      expect(useAppStore.getState().notifications).toHaveLength(0);
      listener?.({ ...operation, status: 'running', phase: 'pushing', message: 'Pushing repository changes' });
      listener?.({ ...operation, phase: 'waitingForReadSlot', message: 'Waiting for a repository read slot' });
      vi.advanceTimersByTime(250);
      expect(useAppStore.getState().notifications[0].message).toEqual({ key: 'Pushing repository changes' });
      listener?.({ ...operation, status: 'running', phase: 'readingRepository', message: 'Reading repository data' });
      expect(useAppStore.getState().notifications[0].message).toEqual({ key: 'Pushing repository changes' });
      listener?.({ ...operation, status: 'succeeded' });
      expect(useAppStore.getState().notifications).toHaveLength(0);
    } finally {
      useAppStore.getState().dispose();
      vi.useRealTimers();
    }
  });

  it('sends automatic fetch with progress disabled', async () => {
    const current = snapshot('silent-fetch', 1);
    current.repositories = [repository('repo', 'Repository')];
    const options: RequestOptions[] = [];
    const bridge = new MockBridge((command, requestOptions) => {
      if (command.type === 'sync') { options.push(requestOptions ?? {}); return { output: '', update: null }; }
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: current, allRepositories: current.repositories });
    await useAppStore.getState().sync('repo', 'fetch', false);
    expect(options).toHaveLength(1);
    expect(options[0].showProgress).toBe(false);
    expect(useAppStore.getState().notifications.some((item) => item.progress)).toBe(false);
    useAppStore.setState({ bridge: new MockBridge((command) => { if (command.type === 'sync') throw new Error('Automatic fetch offline'); return []; }) });
    await useAppStore.getState().sync('repo', 'fetch', false);
    expect(useAppStore.getState().notifications).toHaveLength(0);
  });

  it.each([
    { action: 'fetch' as const, notify: false, busy: false },
    { action: 'fetch' as const, notify: true, busy: true },
    { action: 'push' as const, notify: false, busy: true },
    { action: 'pull' as const, notify: false, busy: true },
  ])('keeps the action guard appropriate for $action with notify=$notify until refresh completes', async ({ action, notify, busy }) => {
    const current = snapshot('workspace', 1);
    current.repositories = [repository('repo', 'Repository')];
    let finishSync!: (value: unknown) => void;
    let finishRead!: (value: unknown) => void;
    const pendingSync = new Promise(resolve => { finishSync = resolve; });
    const pendingRead = new Promise(resolve => { finishRead = resolve; });
    let readRequested = false;
    const bridge = new MockBridge(command => {
      if (command.type === 'sync') return pendingSync;
      if (command.type === 'unpushedCommits') { readRequested = true; return pendingRead; }
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: current });
    const request = useAppStore.getState().sync('repo', action, notify);
    const active = () => isOperationActiveForRepositories(useAppStore.getState().operations, ['repo'], { workspaceId: 'workspace', domain: 'sync' });
    expect(active()).toBe(busy);
    finishSync({ output: '', update: null });
    await vi.waitFor(() => expect(readRequested).toBe(true));
    expect(active()).toBe(busy);
    finishRead([]);
    await request;
    expect(active()).toBe(false);
  });

  it.each([false, true])('cleans up a failed fetch with notify=%s', async notify => {
    const current = snapshot('workspace', 1);
    current.repositories = [repository('repo', 'Repository')];
    let fail!: (error: Error) => void;
    const pending = new Promise((_, reject) => { fail = reject; });
    const bridge = new MockBridge(command => command.type === 'sync' ? pending : []);
    useAppStore.setState({ bridge, bootstrap, snapshot: current });
    const request = useAppStore.getState().sync('repo', 'fetch', notify);
    fail(new Error('Remote unavailable'));
    await request;
    expect(useAppStore.getState().operations).toEqual({});
    expect(useAppStore.getState().notifications).toHaveLength(notify ? 1 : 0);
  });

  it('aggregates manual fetch progress and keeps the original workspace through completion', async () => {
    const current = snapshot('fetch-original', 1);
    current.repositories = [repository('a', 'A'), repository('b', 'B')];
    const first = deferred<{ output: string; update: null }>();
    const second = deferred<{ output: string; update: null }>();
    const calls: Array<{ workspaceId: string; repoId: string; showProgress?: boolean }> = [];
    const bridge = new MockBridge((command, options) => {
      if (command.type === 'sync') {
        calls.push({ workspaceId: command.payload.workspace_id, repoId: command.payload.repo_id, showProgress: options?.showProgress });
        return command.payload.repo_id === 'a' ? first.promise : second.promise;
      }
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: current, allRepositories: current.repositories, activeTabId: current.workspace.id });
    const fetching = useAppStore.getState().fetchRepositories(['a', 'b']);
    const progress = useAppStore.getState().notifications.filter((item) => item.progress);
    expect(progress).toHaveLength(1);
    expect(progress[0].message).toBe('VersionDock: Fetching all remotes…');
    expect(progress[0].actions).toEqual([]);
    expect(calls).toEqual([{ workspaceId: current.workspace.id, repoId: 'a', showProgress: false }, { workspaceId: current.workspace.id, repoId: 'b', showProgress: false }]);
    useAppStore.setState({ snapshot: snapshot('another-workspace', 1), activeTabId: 'another-workspace', allRepositories: [] });
    first.resolve({ output: '', update: null });
    second.resolve({ output: '', update: null });
    await fetching;
    expect(useAppStore.getState().notifications.some((item) => item.progress)).toBe(false);
    const completion = useAppStore.getState().notifications.find((item) => item.message === 'VersionDock: Fetch complete.');
    expect(completion?.workspaceId).toBe(current.workspace.id);
  });

  it('removes fetch progress on failure without announcing a successful fetch', async () => {
    const current = snapshot('fetch-failure', 1);
    current.repositories = [repository('repo', 'Repository')];
    const bridge = new MockBridge((command) => {
      if (command.type === 'sync') throw new Error('Remote unavailable');
      if (command.type === 'workspaceRefresh') return current;
      if (command.type === 'history') return { commits: [], hasMore: false };
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: current, allRepositories: current.repositories, activeTabId: current.workspace.id });
    await useAppStore.getState().fetchRepositories(['repo']);
    expect(useAppStore.getState().notifications.some((item) => item.progress)).toBe(false);
    expect(useAppStore.getState().notifications.some((item) => item.title === 'Sync failed')).toBe(true);
    expect(useAppStore.getState().notifications.some((item) => item.title === 'Fetch All')).toBe(false);
  });

  it('notifies unpushed and incoming commits on startup, deduplicates within session on count growth, and notifies new conflicts', async () => {
    let currentWorkspace = snapshot('notifications', 1);
    currentWorkspace.repositories = [
      { ...repository('repo-a', 'A'), ahead: 2, behind: 3, conflicts: 0 },
      { ...repository('repo-b', 'B'), ahead: 1, behind: 1 },
      { ...repository('worktree', 'Worktree'), ahead: 9, behind: 9, meta: { ...repository('worktree', 'Worktree').meta, isWorktree: true } },
    ];
    const bridge = new MockBridge((command) => {
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') return currentWorkspace;
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });
    useAppStore.setState({ bridge, bootstrap: { ...bootstrap, applicationSessionId: `session-${crypto.randomUUID()}` }, ready: true });

    // 首次打开工作区：对齐插件在启动发现未同步提交时立即通知一次，并建立基线
    await useAppStore.getState().openWorkspace(currentWorkspace.workspace.paths);
    expect(useAppStore.getState().notifications).toHaveLength(2);

    // 再次刷新无变化：基线已建立，不重复通知
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications).toHaveLength(2);

    // 状态更新：未推送与传入提交数量增加，且产生了冲突
    currentWorkspace = {
      ...currentWorkspace,
      generation: 2,
      repositories: [
        { ...repository('repo-a', 'A'), ahead: 3, behind: 4, conflicts: 1 },
        { ...repository('repo-b', 'B'), ahead: 1, behind: 1 },
        { ...repository('worktree', 'Worktree'), ahead: 9, behind: 9, meta: { ...repository('worktree', 'Worktree').meta, isWorktree: true } },
      ],
    };
    await useAppStore.getState().refresh(true);

    const all = useAppStore.getState().notifications;
    // 提交通知对齐插件每次启动最多提醒一次（同一会话内增长不再弹窗），新产生的冲突触发警报（总计 2 + 1 = 3 条）
    expect(all).toHaveLength(3);
    const conflictNotif = all.find((n) => n.title === 'Merge conflicts detected');
    expect(conflictNotif).toBeDefined();
    expect(conflictNotif?.message).toBe('VersionDock: Merge conflicts detected. Use the Merge Editor to resolve them.');
  });

  it('notifies with repository name for single repository incoming and unpushed commits when count increases', async () => {
    let currentWorkspace = snapshot('single-repo-notifications', 1);
    currentWorkspace.repositories = [
      { ...repository('repo-solo', 'SoloRepo'), ahead: 0, behind: 0 },
    ];
    const bridge = new MockBridge((command) => {
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') return currentWorkspace;
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });
    useAppStore.setState({ bridge, bootstrap: { ...bootstrap, applicationSessionId: `session-${crypto.randomUUID()}` }, ready: true, notifications: [], toastNotificationIds: [] });

    await useAppStore.getState().openWorkspace(currentWorkspace.workspace.paths);
    expect(useAppStore.getState().notifications).toHaveLength(0);

    // 状态更新：产生了 1 个未推送提交和 1 个传入提交
    currentWorkspace = {
      ...currentWorkspace,
      generation: 2,
      repositories: [
        { ...repository('repo-solo', 'SoloRepo'), ahead: 1, behind: 1 },
      ],
    };
    await useAppStore.getState().refresh(true);

    const notifications = useAppStore.getState().notifications;
    expect(notifications).toHaveLength(2);

    const unpushed = notifications.find((n) => n.title === 'Unpushed Commits');
    expect(unpushed).toBeDefined();
    expect(unpushed?.message).toEqual({
      key: 'VersionDock [{0}]: {1} unpushed commit ready to push.',
      args: ['SoloRepo', 1],
    });
    expect(unpushed?.actions[0]).toEqual({ type: 'openPush', label: 'Go to Push' });

    const incoming = notifications.find((n) => n.title === 'Incoming Commits');
    expect(incoming).toBeDefined();
    expect(incoming?.message).toEqual({
      key: 'VersionDock [{0}]: {1} incoming commit available to update.',
      args: ['SoloRepo', 1],
    });
    expect(incoming?.actions[0]).toEqual({ type: 'updateProject', label: 'Update' });
  });

  it('alerts merge conflicts, unpushed, and incoming commits on initial workspace open without duplicate notifications on subsequent refresh', async () => {
    const workspace = snapshot('conflict-startup-ws', 1);
    workspace.repositories = [
      { ...repository('repo-c', 'ConflictRepo'), ahead: 2, behind: 3, conflicts: 2 },
    ];
    const bridge = new MockBridge((command) => {
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') return workspace;
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });
    useAppStore.setState({ bridge, bootstrap: { ...bootstrap, applicationSessionId: `session-${crypto.randomUUID()}` }, ready: true, notifications: [] });

    await useAppStore.getState().openWorkspace(workspace.workspace.paths);
    const notifications = useAppStore.getState().notifications;
    expect(notifications).toHaveLength(3);
    const conflictNotif = notifications.find((n) => n.title === 'Merge conflicts detected');
    expect(conflictNotif).toBeDefined();
    expect(conflictNotif?.type).toBe('warning');
    expect(conflictNotif?.actions[0]).toEqual({ type: 'openConflicts', label: 'Open Conflict List' });
    expect(notifications.some((n) => n.title === 'Unpushed Commits')).toBe(true);
    expect(notifications.some((n) => n.title === 'Incoming Commits')).toBe(true);

    // 再次刷新，若冲突与未同步数量未增加，不重复弹通知
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications).toHaveLength(3);
  });

  it('notifies immediately on startup when unpushed or incoming commits exist, and avoids repeat notifications during session', async () => {
    const ws = snapshot('startup-instant-notice-ws', 1);
    const repo = { ...repository('repo-instant', 'InstantRepo'), ahead: 3, behind: 5 };
    ws.repositories = [{ ...repo }];

    const bridge = new MockBridge((command) => {
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') return ws;
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });

    useAppStore.setState({
      bridge,
      bootstrap: { ...bootstrap, applicationSessionId: `session-${crypto.randomUUID()}` },
      ready: true,
      notifications: [],
    });

    // 首次打开工作区：启动时立即提醒传入与未推送提交
    await useAppStore.getState().openWorkspace(ws.workspace.paths);
    const initial = useAppStore.getState().notifications;
    expect(initial).toHaveLength(2);
    expect(initial.some((n) => n.title === 'Incoming Commits')).toBe(true);
    expect(initial.some((n) => n.title === 'Unpushed Commits')).toBe(true);

    // 会话中多次刷新（数量未改变）：严禁重复产生弹窗
    await useAppStore.getState().refresh(true);
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications).toHaveLength(2);
  });

  it('updates all non-worktree repositories including hidden ones, and excludes worktrees', async () => {
    const workspace = snapshot('update-targets-ws', 1);
    const repoNormal = repository('repo-normal', 'Normal');
    const repoHidden = repository('repo-hidden', 'Hidden');
    const repoWorktree = { ...repository('repo-wt', 'Worktree'), meta: { ...repository('repo-wt', 'Worktree').meta, isWorktree: true } };
    workspace.repositories = [repoNormal, repoHidden, repoWorktree];

    const pulledRepoIds: string[] = [];
    const bridge = new MockBridge((command) => {
      if (command.type === 'sync') {
        const payload = command.payload as { repo_id: string; action: string };
        pulledRepoIds.push(payload.repo_id);
        return {
          output: 'Already up to date.',
          update: {
            repoId: payload.repo_id,
            beforeRevision: 'rev1',
            afterRevision: 'rev1',
            summary: { kind: 'noChanges', commitCount: 0, fileCount: 0, containsMerge: false, detail: { commits: [], files: [] } },
            summaryError: null,
            beforeStatus: 'clean',
            afterStatus: 'clean',
          },
        };
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      snapshot: { ...workspace, repositories: [repoNormal, repoWorktree] }, // repo-hidden 在可见视图中被隐藏
      allRepositories: [repoNormal, repoHidden, repoWorktree], // allRepositories 包含全部仓库
      bootstrap: { ...bootstrap, state: { ...bootstrap.state, settings: { ...bootstrap.state.settings, hiddenRepositoryIds: ['repo-hidden'] } as any } },
    });

    await useAppStore.getState().updateProject();

    // 验证：包含被隐藏的普通仓库，排除 worktree！
    expect(pulledRepoIds).toContain('repo-normal');
    expect(pulledRepoIds).toContain('repo-hidden');
    expect(pulledRepoIds).not.toContain('repo-wt');
  });

  it('notifies incoming commits once upon startup fetch and establishes baseline to avoid duplicate notifications within session', async () => {
    const workspace = snapshot('fetch-startup-ws', 1);
    const repo = { ...repository('repo-git', 'GitRepo'), ahead: 0, behind: 0 };
    workspace.repositories = [{ ...repo }];

    let behindCount = 0;
    const bridge = new MockBridge((command) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          launchWorkspaceId: 'fetch-startup-ws',
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: true, notifyIncomingCommits: true } as any,
            recentWorkspaces: [workspace.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen') {
        // 初始打开时远端尚未 fetch，behind 为 0
        return {
          ...workspace,
          repositories: [{ ...repo, behind: 0 }],
        };
      }
      if (command.type === 'sync') {
        const payload = command.payload as { action: string };
        if (payload.action === 'fetch') {
          // fetch 完成，远端存在 2 个提交；注意：sync 并不直接原地修改前端对象
          behindCount = 2;
          return { output: 'Fetched 2 new commits from remote' };
        }
      }
      if (command.type === 'workspaceRefresh') {
        return {
          ...workspace,
          repositories: [{ ...repo, behind: behindCount }],
        };
      }
      if (command.type === 'repositoryStatus') {
        return { ...repo, behind: behindCount };
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });

    useAppStore.setState({ notifications: [] });

    // 启动应用
    await useAppStore.getState().initialize(bridge);

    // 验证：启动完成后，启动 Fetch 发现的 2 个传入提交对齐插件立即发出通知，并记录基线
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);

    // 模拟随后即使收到 watcher 的防抖刷新事件（behind 依然是 2），也不重复弹通知
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);

    // 随后运行过程中，远程又增加了提交（2 -> 3）
    behindCount = 3;
    await useAppStore.getState().refresh(true);
    // 对齐插件：同一会话内已通知过，数量再次增加保持静默，绝不重复弹窗打扰！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:fetch-startup-ws:incoming')).toBe('3');

    // 模拟新会话重启：
    const bridgeSession2 = new MockBridge((command) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: 'fetch-startup-ws-session-2',
          launchWorkspaceId: 'fetch-startup-ws',
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: true } as any,
            recentWorkspaces: [workspace.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return {
          ...workspace,
          repositories: [{ ...repo, behind: 3 }],
        };
      }
      return [];
    });
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeSession2);
    // 新会话启动后，检测到未更新的提交，再次发出新会话的 1 次通知！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
  });

  it('notifies unresolved conflicts upon subsequent application launches while deduplicating within the same session', async () => {
    const ws = snapshot('conflict-relaunch-ws', 1);
    const repo = { ...repository('repo-conflict', 'ConflictRepo'), conflicts: 1 };
    ws.repositories = [{ ...repo }];

    const bridge = new MockBridge((command) => {
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return { ...ws, repositories: [{ ...repo }] };
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });

    useAppStore.setState({ notifications: [], bridge });

    // 会话 1：首次打开带冲突的工作区 -> 立即弹出报警
    await useAppStore.getState().openWorkspace(['/repo-conflict']);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Merge conflicts detected')).toHaveLength(1);

    // 会话 1 运行期间：再次刷新（冲突仍为 1） -> 去重不重复报警
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Merge conflicts detected')).toHaveLength(1);

    // 模拟应用退出（清理会话内存状态）：即使 localStorage 可能留有历史值
    useAppStore.getState().dispose();
    useAppStore.setState({ notifications: [], tabs: [], activeTabId: undefined, snapshot: undefined, allRepositories: [], bridge });

    // 会话 2（再次启动应用打开该工作区）：未解决的冲突必须再次提醒用户！
    await useAppStore.getState().openWorkspace(['/repo-conflict']);
    // 会话 2 运行期间：再次刷新（冲突仍为 1） -> 再次去重
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Merge conflicts detected')).toHaveLength(1);
  });

  it('fetches hidden repositories during startup fetch to ensure complete remote status', async () => {
    const ws = snapshot('ws-hidden-fetch', 1);
    const repoVisible = { ...repository('repo-visible', 'VisibleRepo'), ahead: 0, behind: 0 };
    const repoHidden = { ...repository('repo-hidden', 'HiddenRepo'), ahead: 0, behind: 0 };
    ws.repositories = [{ ...repoVisible }, { ...repoHidden }];

    const fetchedRepoIds: string[] = [];
    const bridge = new MockBridge((command) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          launchWorkspaceId: 'ws-hidden-fetch',
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: true, hiddenRepositoryIds: ['repo-hidden'] } as any,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return { ...ws, repositories: [{ ...repoVisible }, { ...repoHidden }] };
      }
      if (command.type === 'sync') {
        const payload = command.payload as { repo_id: string; action: string };
        if (payload.action === 'fetch') {
          fetchedRepoIds.push(payload.repo_id);
          return { output: 'Fetched' };
        }
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });

    useAppStore.setState({ notifications: [] });
    await useAppStore.getState().initialize(bridge);

    expect(fetchedRepoIds).toContain('repo-visible');
    expect(fetchedRepoIds).toContain('repo-hidden');
    useAppStore.getState().dispose();
  });

  it('allows concurrent startup fetch in multiple windows for different workspaces while preventing duplicate fetch and notification for same workspace', async () => {
    class WindowMockBridge extends MockBridge {
      constructor(private readonly windowLabel: string, responder: (command: any) => unknown | Promise<unknown>) {
        super(responder);
      }
      override async getWindowLabel(): Promise<string> {
        return this.windowLabel;
      }
    }

    const wsA = snapshot('ws-multi-window-a', 1);
    const repoA = { ...repository('repo-a', 'RepoA'), ahead: 0, behind: 0 };
    wsA.repositories = [{ ...repoA }];

    const wsB = snapshot('ws-multi-window-b', 1);
    const repoB = { ...repository('repo-b', 'RepoB'), ahead: 0, behind: 0 };
    wsB.repositories = [{ ...repoB }];

    let fetchCallsRepoA = 0;
    let fetchCallsRepoB = 0;
    let behindRepoA = 0;

    const makeResponder = (targetWs: typeof wsA, targetRepo: typeof repoA, onFetch: () => void, getBehind?: () => number) => (command: any) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          launchWorkspaceId: targetWs.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: true, notifyIncomingCommits: true } as any,
            recentWorkspaces: [targetWs.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen') {
        return {
          ...targetWs,
          repositories: [{ ...targetRepo, behind: 0 }],
        };
      }
      if (command.type === 'workspaceRefresh') {
        return {
          ...targetWs,
          repositories: [{ ...targetRepo, behind: getBehind ? getBehind() : 0 }],
        };
      }
      if (command.type === 'repositoryStatus') {
        return { ...targetRepo, behind: getBehind ? getBehind() : 0 };
      }
      if (command.type === 'sync') {
        const payload = command.payload as { action: string };
        if (payload.action === 'fetch') {
          onFetch();
          return { output: 'Fetched' };
        }
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    };

    const bridgeWindow1 = new WindowMockBridge('window-1', makeResponder(wsA, repoA, () => {
      fetchCallsRepoA += 1;
      behindRepoA = 2;
    }, () => behindRepoA));

    const bridgeWindow2 = new WindowMockBridge('window-2', makeResponder(wsB, repoB, () => {
      fetchCallsRepoB += 1;
    }));

    const bridgeWindow3 = new WindowMockBridge('window-3', makeResponder(wsA, repoA, () => {
      fetchCallsRepoA += 1;
    }, () => behindRepoA));

    // 窗口 1：打开项目 A -> 成功获取租约并执行启动 Fetch，远端 2 个提交对齐插件提醒一次，并设为基线 2
    useAppStore.setState({ notifications: [] });
    await useAppStore.getState().initialize(bridgeWindow1);
    expect(fetchCallsRepoA).toBe(1);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);

    // 窗口 2：在 60 秒内打开不同项目 B -> 由于租约按工作区隔离，窗口 2 依然能获取到项目 B 的租约并执行 Fetch！
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindow2);
    expect(fetchCallsRepoB).toBe(1);

    // 窗口 3：在 60 秒内打开相同项目 A -> 跳过项目 A 的重复启动 Fetch，且绝不以旧状态或共享基线误报通知！
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindow3);
    // 启动完成，无重复 Fetch，且无传入提交通知！
    expect(fetchCallsRepoA).toBe(1);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 窗口 3 随后执行状态刷新（获取到 behind = 2）：验证从共享存储同步基线，依然不发通知！
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 随后运行过程中，远程又增加了提交（2 -> 3）：
    // 对齐插件：同一会话内项目 A 已经由窗口 1 提醒过，窗口 3 在会话内不重复弹窗，基线更新为 3！
    behindRepoA = 3;
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);
    expect(localStorage.getItem('versiondock:notification-count:ws-multi-window-a:incoming')).toBe('3');

    useAppStore.getState().dispose();
  });

  it('prevents stale lagging window from overwriting newer baseline count and avoids false notifications across interleaved windows', async () => {
    class WindowMockBridge extends MockBridge {
      constructor(private readonly windowLabel: string, responder: (command: any) => unknown | Promise<unknown>) {
        super(responder);
      }
      override async getWindowLabel(): Promise<string> {
        return this.windowLabel;
      }
    }

    const ws = snapshot('ws-interleaved-counts', 1);
    const repo = { ...repository('repo-interleaved', 'InterleavedRepo'), ahead: 0, behind: 0 };
    ws.repositories = [{ ...repo }];

    let remoteBehind = 2;

    const makeResponder = (currentBehind: () => number) => (command: any) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          launchWorkspaceId: ws.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: true } as any,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return {
          ...ws,
          repositories: [{ ...repo, behind: currentBehind() }],
        };
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    };

    // 窗口 1：状态已经同步为 behind = 2，首次启动提醒一次，建立共享基线 2
    const bridgeWindow1 = new WindowMockBridge('window-1', makeResponder(() => remoteBehind));
    useAppStore.setState({ notifications: [] });
    await useAppStore.getState().initialize(bridgeWindow1);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    // 验证 localStorage 中基线已经成功记录为 2
    expect(localStorage.getItem('versiondock:notification-count:ws-interleaved-counts:incoming')).toBe('2');

    // 窗口 2：模拟一个快照尚未同步的旧窗口（本地依然保留 behind = 0）
    let window2Behind = 0;
    const bridgeWindow2 = new WindowMockBridge('window-2', makeResponder(() => window2Behind));
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindow2);

    // 核心验证：窗口 2 处于滞后状态 (behind = 0)，绝不能将共享存储中的 2 降级改写回 0！
    expect(localStorage.getItem('versiondock:notification-count:ws-interleaved-counts:incoming')).toBe('2');
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 窗口 3：模拟新打开的第三个窗口，读取最新状态 (behind = 2)
    const bridgeWindow3 = new WindowMockBridge('window-3', makeResponder(() => remoteBehind));
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindow3);
    // 核心验证：窗口 3 读到了未被旧窗口污染的基线 2，绝不将已有历史提交误报为新通知！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 窗口 2 自身也随后刷新到了最新状态 (behind = 2)
    window2Behind = 2;
    await useAppStore.getState().refresh(true);
    // 核心验证：窗口 2 也依然零通知！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 随后远端新增提交 (2 -> 3)
    remoteBehind = 3;
    await useAppStore.getState().refresh(true);
    // 对齐插件：同一会话内窗口 1 启动时已提醒过，会话内提交数增加保持静默，不重复弹窗！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);
    // 验证共享存储中的基线已更新为 3
    expect(localStorage.getItem('versiondock:notification-count:ws-interleaved-counts:incoming')).toBe('3');

    useAppStore.getState().dispose();
  });

  it('notifies when incoming commits arrive after app restart where commits were pulled via external Git CLI before launch', async () => {
    const ws = snapshot('ws-restart-git-pull', 1);
    const repo = { ...repository('repo-pulled', 'PulledRepo'), ahead: 0, behind: 3 };
    ws.repositories = [{ ...repo }];

    let currentBehind = 3;

    const makeBridge = (sessionId: string) => new MockBridge((command: any) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: sessionId,
          launchWorkspaceId: ws.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: true } as any,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return {
          ...ws,
          repositories: [{ ...repo, behind: currentBehind }],
        };
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });

    // 会话 1：启动应用，当前存在 3 个传入提交，对齐插件提醒一次，并建立基准线 3
    const bridgeSession1 = makeBridge('session-first-launch');
    useAppStore.setState({ notifications: [] });
    await useAppStore.getState().initialize(bridgeSession1);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:ws-restart-git-pull:incoming')).toBe('3');

    // 模拟应用完全退出关闭
    useAppStore.getState().dispose();
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });

    // 用户在应用关闭期间，使用系统终端 Git CLI 执行 git pull，远端传入提交全部被消除，落后数降为 0
    currentBehind = 0;

    // 会话 2：再次启动应用 (冷启动，新 applicationSessionId)，打开该工作区
    const bridgeSession2 = makeBridge('session-relaunch-after-pull');
    await useAppStore.getState().initialize(bridgeSession2);

    // 核心验证 1：启动完成，真实状态 behind = 0，零通知
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);
    // 核心验证 2：共享基准线已合法降为 0，旧会话的 3 绝不阻断现实基线建立！
    expect(localStorage.getItem('versiondock:notification-count:ws-restart-git-pull:incoming')).toBe('0');

    // 随后运行过程中，远端新增了 1 个提交 (0 -> 1)
    currentBehind = 1;
    await useAppStore.getState().refresh(true);
    // 核心验证 3：远端新提交到达后，正常触发 1 次通知，彻底消除 P1 漏报！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);

    // 随后远端又新增了 1 个提交 (1 -> 2)
    currentBehind = 2;
    await useAppStore.getState().refresh(true);
    // 核心验证 4：对齐插件，同一会话内首次非零已提醒过 (0->1 时已提醒)，数量再次增加时不重复打扰 (依然保持 1 条通知)！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:ws-restart-git-pull:incoming')).toBe('2');

    useAppStore.getState().dispose();
  });

  it('prevents lagging window holding stale higher count from overwriting lowered baseline and notifies when new commits arrive', async () => {
    class WindowMockBridge extends MockBridge {
      constructor(private readonly windowLabel: string, responder: (command: any) => unknown | Promise<unknown>) {
        super(responder);
      }
      override async getWindowLabel(): Promise<string> {
        return this.windowLabel;
      }
    }

    const ws = snapshot('ws-reverse-race', 1);
    const repo = { ...repository('repo-race', 'RaceRepo'), ahead: 0, behind: 2 };
    ws.repositories = [{ ...repo }];

    let behindCount = 2;

    const makeResponder = (getBehind: () => number) => (command: any) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: 'session-reverse-race',
          launchWorkspaceId: ws.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: true } as any,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return {
          ...ws,
          repositories: [{ ...repo, behind: getBehind() }],
        };
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    };

    // 1. 窗口 A 与窗口 B 均在同个项目启动，窗口 A 初始 behind = 2，提醒一次并建立共享基线 2
    const bridgeWindowA = new WindowMockBridge('window-a', makeResponder(() => behindCount));
    useAppStore.setState({ notifications: [] });
    await useAppStore.getState().initialize(bridgeWindowA);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:ws-reverse-race:incoming')).toBe('2');

    // 窗口 B 在同一会话中打开
    let windowBBehind = 2;
    const bridgeWindowB = new WindowMockBridge('window-b', makeResponder(() => windowBBehind));
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindowB);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 2. 窗口 A 拉取提交，仓库客观状态降为 behind = 0，窗口 A 将共享基线成功降为 0
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindowA);
    behindCount = 0;
    await useAppStore.getState().refresh(true);
    expect(localStorage.getItem('versiondock:notification-count:ws-reverse-race:incoming')).toBe('0');
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 3. 关键反向竞态：窗口 B 此时尚未刷新，依然持有旧快照 behind = 2
    // 切换到窗口 B 触发状态检查
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindowB);
    // 窗口 B 刷新，但其仓库依然处于滞后快照 2
    windowBBehind = 2;
    await useAppStore.getState().refresh(true);

    // 核心断言 1：窗口 B 绝不能误报通知！
    expect(useAppStore.getState().notifications.map((n) => n.title)).toEqual([]);
    // 核心断言 2：窗口 B 绝不能凭本地旧记忆把共享基线从 0 写回 2！共享基线必须牢牢保持为 0！
    expect(localStorage.getItem('versiondock:notification-count:ws-reverse-race:incoming')).toBe('0');

    // 4. 随后窗口 B 自身也刷新到了最新状态 behind = 0
    windowBBehind = 0;
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 5. 远端新增了 1 个提交 (0 -> 1)
    // 模拟新会话冷启动打开该项目：
    behindCount = 1;
    const bridgeWindowARelaunch = new WindowMockBridge('window-a', (cmd) => {
      if (cmd.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: 'session-reverse-race-relaunch',
          launchWorkspaceId: ws.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: true } as any,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      return makeResponder(() => behindCount)(cmd);
    });
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindowARelaunch);
    await useAppStore.getState().refresh(true);

    // 核心断言 3：共享基线未被污染，新会话启动且新提交到达时正常触发通知，彻底消除 P1 漏报！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:ws-reverse-race:incoming')).toBe('1');

    useAppStore.getState().dispose();
  });

  it('notifies lagging window when remote commits arrive after another window pulls and closes without lagging window ever seeing zero', async () => {
    class WindowMockBridge extends MockBridge {
      constructor(private readonly windowLabel: string, responder: (command: any) => unknown | Promise<unknown>) {
        super(responder);
      }
      override async getWindowLabel(): Promise<string> {
        return this.windowLabel;
      }
    }

    const ws = snapshot('ws-lagging-close-race', 1);
    const repo = { ...repository('repo-lagging', 'LaggingRepo'), ahead: 0, behind: 2, revision: 'rev1' };
    ws.repositories = [{ ...repo }];

    let behindCount = 2;
    let repoRevision = 'rev1';

    const makeResponder = (getBehind: () => number, getRev: () => string, sessionId = 'session-lagging-close-race') => (command: any) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: sessionId,
          launchWorkspaceId: ws.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: true } as any,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return {
          ...ws,
          repositories: [{ ...repo, behind: getBehind(), revision: getRev() }],
        };
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    };

    // 1. 窗口 A 与窗口 B 均在同个项目启动，窗口 A 初始 behind = 2，提醒一次并建立共享基线 2
    const bridgeWindowA = new WindowMockBridge('window-a', makeResponder(() => behindCount, () => repoRevision));
    useAppStore.setState({ notifications: [] });
    await useAppStore.getState().initialize(bridgeWindowA);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:ws-lagging-close-race:incoming')).toBe('2');

    // 窗口 B 在同一会话中打开并同步基准 2
    let windowBBehind = 2;
    let windowBRevision = 'rev1';
    const bridgeWindowB = new WindowMockBridge('window-b', makeResponder(() => windowBBehind, () => windowBRevision));
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindowB);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 2. 窗口 A 执行拉取，本地仓库 HEAD 演进为 rev2，behind 降为 0
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindowA);
    behindCount = 0;
    repoRevision = 'rev2';
    await useAppStore.getState().refresh(true);
    expect(localStorage.getItem('versiondock:notification-count:ws-lagging-close-race:incoming')).toBe('0');
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 窗口 A 关闭，不再活动
    useAppStore.getState().dispose();

    // 3. 关键 ABA 与漏报时序：
    // 窗口 B 从未看到过 0！此时远端新增了 1 个新提交 (0 -> 1)
    // 本地仓库因为已被窗口 A 拉取过，HEAD 依然是 rev2，当前客观落后数量为 1
    // 用户在新会话中激活窗口 B 重新加载项目
    windowBBehind = 1;
    windowBRevision = 'rev2';

    const bridgeWindowBNewSession = new WindowMockBridge('window-b', makeResponder(() => windowBBehind, () => windowBRevision, 'session-lagging-close-race-relaunch'));
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindowBNewSession);
    await useAppStore.getState().refresh(true);

    // 核心断言：窗口 B 成功识破新纪元的新增提交，绝不因 1 <= 本地旧记忆 2 而漏报！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:ws-lagging-close-race:incoming')).toBe('1');

    // 4. 极端 ABA 场景验证：两个窗口都曾见过 2，A 拉取到 0 后关闭，远端又恰好新增了 2 个提交 (2 -> 0 -> 2)
    // 窗口 B 再次面临 currentCount === 2，但仓库版本签名已演进为 rev3
    windowBBehind = 2;
    windowBRevision = 'rev3';
    useAppStore.setState({ notifications: [] });
    await useAppStore.getState().refresh(true);
    // 对齐插件：同一会话内已提醒过，会话内数量再次增加保持静默不重复打扰，通知为 0，基线更新为 2！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);
    expect(localStorage.getItem('versiondock:notification-count:ws-lagging-close-race:incoming')).toBe('2');

    useAppStore.getState().dispose();
  });

  it('does not falsely notify stale incoming commits of repo A when unrelated repo B commits locally in multi-repo workspace', async () => {
    class WindowMockBridge extends MockBridge {
      constructor(private readonly windowLabel: string, responder: (command: any) => unknown | Promise<unknown>) {
        super(responder);
      }
      override async getWindowLabel(): Promise<string> {
        return this.windowLabel;
      }
    }

    const ws = snapshot('ws-multi-repo-false-alarm', 2);
    const repoA = { ...repository('repo-a', 'RepoA'), ahead: 0, behind: 2, revision: 'revA1' };
    const repoB = { ...repository('repo-b', 'RepoB'), ahead: 0, behind: 0, revision: 'revB1' };
    ws.repositories = [{ ...repoA }, { ...repoB }];

    let repoABehind = 2;
    let repoARevision = 'revA1';
    const repoBBehind = 0;
    const repoBRevision = 'revB1';

    const makeResponder = (
      getSnapshot: () => { repoABehind: number; repoARev: string; repoBBehind: number; repoBRev: string },
      sessionId = 'session-multi-repo-false-alarm',
    ) => (command: any) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: sessionId,
          launchWorkspaceId: ws.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: true } as any,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        const s = getSnapshot();
        return {
          ...ws,
          repositories: [
            { ...repoA, behind: s.repoABehind, revision: s.repoARev },
            { ...repoB, behind: s.repoBBehind, revision: s.repoBRev },
          ],
        };
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    };

    // 1. 窗口 1 与窗口 2 启动，窗口 1 初始仓库 A behind = 2，提醒一次并建立共享基线 2
    const bridgeWindow1 = new WindowMockBridge('window-1', makeResponder(() => ({
      repoABehind,
      repoARev: repoARevision,
      repoBBehind,
      repoBRev: repoBRevision,
    })));
    useAppStore.setState({ notifications: [] });
    await useAppStore.getState().initialize(bridgeWindow1);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:ws-multi-repo-false-alarm:incoming')).toBe('2');

    // 窗口 2 在同一会话中打开并同步基准 2
    let win2RepoABehind = 2;
    let win2RepoARev = 'revA1';
    let win2RepoBBehind = 0;
    let win2RepoBRev = 'revB1';
    const bridgeWindow2 = new WindowMockBridge('window-2', makeResponder(() => ({
      repoABehind: win2RepoABehind,
      repoARev: win2RepoARev,
      repoBBehind: win2RepoBBehind,
      repoBRev: win2RepoBRev,
    })));
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindow2);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 2. 窗口 1 执行拉取仓库 A，仓库 A 降为 behind = 0，revision 演进为 revA2；共享基准成功降为 0
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindow1);
    repoABehind = 0;
    repoARevision = 'revA2';
    await useAppStore.getState().refresh(true);
    expect(localStorage.getItem('versiondock:notification-count:ws-multi-repo-false-alarm:incoming')).toBe('0');
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 3. 关键多仓库时序：
    // 用户此时在【无关的仓库 B】本地提交了代码，仓库 B 的 HEAD 演进为 revB2
    // 而窗口 2 对【仓库 A】依然持有滞后的旧快照 (behind = 2, revision = revA1)
    win2RepoABehind = 2;
    win2RepoARev = 'revA1';
    win2RepoBBehind = 0;
    win2RepoBRev = 'revB2'; // 仓库 B 发生了 HEAD 演进！

    // 切换到窗口 2 触发状态检查
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindow2);
    await useAppStore.getState().refresh(true);

    // 核心断言 1：窗口 2 绝不能因仓库 B 的本地 commit 而误报“仓库 A 有 2 个传入提交”！
    expect(useAppStore.getState().notifications.map((n) => n.title)).toEqual([]);
    // 核心断言 2：共享基线绝不能被旧快照污染写回 2，必须保持为 0！
    expect(localStorage.getItem('versiondock:notification-count:ws-multi-repo-false-alarm:incoming')).toBe('0');

    // 4. 随后窗口 2 自身的仓库 A 也刷新到了最新状态 (behind = 0, revA2)
    win2RepoABehind = 0;
    win2RepoARev = 'revA2';
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 5. 远端随后在仓库 A 新增了 1 个新提交 (behind = 1)
    // 模拟新会话冷启动打开该项目：
    win2RepoABehind = 1;
    const bridgeWindow2NewSession = new WindowMockBridge('window-2', makeResponder(() => ({
      repoABehind: win2RepoABehind,
      repoARev: win2RepoARev,
      repoBBehind: win2RepoBBehind,
      repoBRev: win2RepoBRev,
    }), 'session-multi-repo-false-alarm-relaunch'));
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindow2NewSession);
    await useAppStore.getState().refresh(true);

    // 此时新会话启动且新提交到达，基线为 0 未被旧快照污染，正常触发通知！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:ws-multi-repo-false-alarm:incoming')).toBe('1');

    useAppStore.getState().dispose();
  });

  it('notifies accurate count excluding stale phantom count when another repo has incoming commits in multi-repo workspace', async () => {
    class WindowMockBridge extends MockBridge {
      constructor(private readonly windowLabel: string, responder: (command: any) => unknown | Promise<unknown>) {
        super(responder);
      }
      override async getWindowLabel(): Promise<string> {
        return this.windowLabel;
      }
    }

    const ws = snapshot('ws-multi-repo-accurate-count', 2);
    const repoA = { ...repository('repo-a', 'RepoA'), ahead: 0, behind: 2, revision: 'revA1' };
    const repoB = { ...repository('repo-b', 'RepoB'), ahead: 0, behind: 2, revision: 'revB1' };
    ws.repositories = [{ ...repoA }, { ...repoB }];

    let repoABehind = 2;
    let repoARevision = 'revA1';
    const repoBBehind = 2;
    const repoBRevision = 'revB1';
    const notifyIncoming = false;

    const makeResponder = (
      getSnapshot: () => { repoABehind: number; repoARev: string; repoBBehind: number; repoBRev: string },
      sessionId = 'session-multi-repo-accurate-count',
    ) => (command: any) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: sessionId,
          launchWorkspaceId: ws.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: notifyIncoming } as any,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        const s = getSnapshot();
        return {
          ...ws,
          repositories: [
            { ...repoA, behind: s.repoABehind, revision: s.repoARev },
            { ...repoB, behind: s.repoBBehind, revision: s.repoBRev },
          ],
        };
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    };

    // 1. 窗口 1 与窗口 2 启动，初始仓库 A behind = 2，仓库 B behind = 2，建立共享基线 4
    const bridgeWindow1 = new WindowMockBridge('window-1', makeResponder(() => ({
      repoABehind,
      repoARev: repoARevision,
      repoBBehind,
      repoBRev: repoBRevision,
    })));
    useAppStore.setState({ notifications: [] });
    await useAppStore.getState().initialize(bridgeWindow1);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);
    expect(localStorage.getItem('versiondock:notification-count:ws-multi-repo-accurate-count:incoming')).toBe('4');

    // 窗口 2 在同一会话中打开并同步基线 4
    let win2RepoABehind = 2;
    let win2RepoARev = 'revA1';
    let win2RepoBBehind = 2;
    let win2RepoBRev = 'revB1';
    const bridgeWindow2 = new WindowMockBridge('window-2', makeResponder(() => ({
      repoABehind: win2RepoABehind,
      repoARev: win2RepoARev,
      repoBBehind: win2RepoBBehind,
      repoBRev: win2RepoBRev,
    })));
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindow2);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 2. 窗口 1 执行拉取仓库 A，仓库 A 降为 behind = 0，revision 演进为 revA2；仓库 B 保持 behind = 2；共享基线降为 2
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindow1);
    repoABehind = 0;
    repoARevision = 'revA2';
    await useAppStore.getState().refresh(true);
    expect(localStorage.getItem('versiondock:notification-count:ws-multi-repo-accurate-count:incoming')).toBe('2');
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 3. 关键多仓库时序与数量准确性验证：
    // 远端仓库 B 新增了传入提交 (behind 从 2 增至 3)
    // 切换到窗口 2：仓库 B 刷新到了最新状态 (behind = 3)，但仓库 A 滞后未刷新，仍持有旧快照 (behind = 2, revA1)
    win2RepoABehind = 2;
    win2RepoARev = 'revA1';
    win2RepoBBehind = 3;
    win2RepoBRev = 'revB1';

    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeWindow2);
    await useAppStore.getState().refresh(true);

    // 核心断言 1：同一会话内步骤 1 已提醒过，对齐插件：数量再次增加保持静默不重复弹窗！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 核心断言 2：共享基线精确更新为 3，消除滞后幽灵计数（精确为 3，绝非包含滞后快照的 5）！
    expect(localStorage.getItem('versiondock:notification-count:ws-multi-repo-accurate-count:incoming')).toBe('3');

    // 4. 随后窗口 2 自身的仓库 A 也刷新到了最新状态 (behind = 0, revA2)
    win2RepoABehind = 0;
    win2RepoARev = 'revA2';
    await useAppStore.getState().refresh(true);
    // 仓库 A 正常归零，总数为 3 <= 3，不产生重复通知
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 5. 远端随后在仓库 A 新增了 1 个新提交 (behind 从 0 增至 1，总数变为 4)
    win2RepoABehind = 1;
    await useAppStore.getState().refresh(true);
    // 对齐插件：会话内步骤 1 已发出过提醒，会话内数量再次增加保持静默不重复打扰，通知保持 0 条！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);
    expect(localStorage.getItem('versiondock:notification-count:ws-multi-repo-accurate-count:incoming')).toBe('4');

    useAppStore.getState().dispose();
  });

  it('notifies accurate incoming revisions for SVN repository and updates baseline', async () => {
    const ws = snapshot('ws-svn-incoming-notification', 1);
    const svnRepo: RepositoryStatus = {
      ...repository('repo-svn', 'RepoSVN'),
      meta: {
        ...repository('repo-svn', 'RepoSVN').meta,
        kind: 'svn',
      },
      branch: 'trunk',
      revision: '100',
      ahead: 0,
      behind: 0,
    };
    ws.repositories = [{ ...svnRepo }];

    let currentBehind = 0;
    let currentRevision = '100';
    let currentAhead = 0;

    const bridge = new MockBridge((command: any) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: 'session-svn-incoming-test',
          launchWorkspaceId: ws.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: true, notifyUnpushedCommits: true } as any,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return {
          ...ws,
          repositories: [
            { ...svnRepo, behind: currentBehind, ahead: currentAhead, revision: currentRevision },
          ],
        };
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });

    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridge);

    // 1. 初始 behind 为 0 时，无通知
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // 2. 远端 SVN 有 3 个待更新修订（behind 变为 3）
    currentBehind = 3;
    await useAppStore.getState().refresh(true);

    const incomingNotifications = useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits');
    expect(incomingNotifications).toHaveLength(1);
    expect(incomingNotifications[0].message).toEqual({
      key: 'VersionDock [{0}]: {1} incoming commits available to update.',
      args: ['RepoSVN', 3],
    });
    expect(incomingNotifications[0].actions).toEqual([
      { type: 'updateProject', label: 'Update' },
      { type: 'dismiss', label: 'Dismiss' },
      { type: 'disableIncoming', label: "Don't show again" },
    ]);
    expect(localStorage.getItem('versiondock:notification-count:ws-svn-incoming-notification:incoming')).toBe('3');

    // 3. SVN 不会发出 unpushed 通知（即使由于异常数据设置 ahead > 0）
    currentAhead = 2;
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Unpushed Commits')).toHaveLength(0);

    // 4. SVN 仓库执行更新（update）后 behind 降为 0，revision 演进为 103
    currentBehind = 0;
    currentAhead = 0;
    currentRevision = '103';
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:ws-svn-incoming-notification:incoming')).toBe('0');

    // 5. 远端再次新增 1 个修订（behind 从 0 增至 1）
    currentBehind = 1;
    await useAppStore.getState().refresh(true);
    // 对齐插件：同一会话内步骤 2 已提醒过，会话内数量再次增加保持静默不重复打扰，通知保持 1 条！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:ws-svn-incoming-notification:incoming')).toBe('1');

    useAppStore.getState().dispose();
  });

  it('accurately aggregates incoming commits across Git and SVN multi-repo workspace', async () => {
    const ws = snapshot('ws-mixed-git-svn-notification', 2);
    const gitRepo: RepositoryStatus = {
      ...repository('repo-git', 'RepoGit'),
      meta: { ...repository('repo-git', 'RepoGit').meta, kind: 'git' },
      branch: 'main',
      revision: 'gitrev1',
      ahead: 0,
      behind: 0,
    };
    const svnRepo: RepositoryStatus = {
      ...repository('repo-svn', 'RepoSVN'),
      meta: { ...repository('repo-svn', 'RepoSVN').meta, kind: 'svn' },
      branch: 'trunk',
      revision: '100',
      ahead: 0,
      behind: 0,
    };
    ws.repositories = [{ ...gitRepo }, { ...svnRepo }];

    let gitBehind = 0;
    let svnBehind = 0;

    const bridge = new MockBridge((command: any) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: 'session-mixed-git-svn-test',
          launchWorkspaceId: ws.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: true } as any,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return {
          ...ws,
          repositories: [
            { ...gitRepo, behind: gitBehind },
            { ...svnRepo, behind: svnBehind },
          ],
        };
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });

    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridge);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);

    // Git 出现 2 个待拉取提交，SVN 出现 3 个待更新修订
    gitBehind = 2;
    svnBehind = 3;
    await useAppStore.getState().refresh(true);

    const notifications = useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits');
    expect(notifications).toHaveLength(1);
    // Git(2) + SVN(3) = 5 个待更新，跨 2 个仓库
    expect(notifications[0].message).toEqual({
      key: 'VersionDock: {0} incoming commits across {1} repositories to update.',
      args: [5, 2],
    });
    expect(localStorage.getItem('versiondock:notification-count:ws-mixed-git-svn-notification:incoming')).toBe('5');

    useAppStore.getState().dispose();
  });

  it('notifies SVN incoming revisions when probe completes during workspace open and handles in-flight watcher event', async () => {
    const ws = snapshot('ws-svn-probe-open-race', 1);
    let svnBehind = 0;
    const svnRepo: RepositoryStatus = {
      ...repository('repo-svn-race', 'RepoSVNRace'),
      meta: { ...repository('repo-svn-race', 'RepoSVNRace').meta, kind: 'svn' },
      branch: 'trunk',
      revision: '100',
      ahead: 0,
      behind: 0,
    };
    ws.repositories = [{ ...svnRepo }];

    let subscriber: ((event: any) => void) | undefined;
    const bridge = new MockBridge((command: any) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: 'session-svn-probe-race-test',
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: true } as any,
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return {
          ...ws,
          repositories: [{ ...svnRepo, behind: svnBehind }],
        };
      }
      if (command.type === 'repositoryStatus') {
        return { ...svnRepo, behind: svnBehind };
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });

    bridge.subscribe = (handler: any) => {
      subscriber = handler;
      return () => undefined;
    };

    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridge);

    // 1. 首次打开工作区：初始快照 behind 为 0，基准线正常初始化为 0
    await useAppStore.getState().openWorkspace(ws.workspace.paths);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits')).toHaveLength(0);
    expect(localStorage.getItem('versiondock:notification-count:ws-svn-probe-open-race:incoming')).toBe('0');

    // 2. 后台探测返回，远端落后 3 个修订，后端发射 watcher 事件（在打开交接窗口不被前端丢弃）
    svnBehind = 3;
    subscriber?.({
      workspaceId: ws.workspace.id,
      repoId: svnRepo.meta.id,
      generation: 2,
      source: 'watcher',
      scopes: ['status'],
    });

    // 等待 watcher 300ms 防抖并刷新完成
    await new Promise((resolve) => setTimeout(resolve, 350));

    const notifications = useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toEqual({
      key: 'VersionDock [{0}]: {1} incoming commits available to update.',
      args: ['RepoSVNRace', 3],
    });
    expect(localStorage.getItem('versiondock:notification-count:ws-svn-probe-open-race:incoming')).toBe('3');

    useAppStore.getState().dispose();
  });

  it('buffers and drains watcher events that arrive before workspace snapshot finishes applying during first open', async () => {
    vi.useFakeTimers();
    try {
      const ws = snapshot('ws-svn-probe-inflight-buffer', 1);
      let svnBehind = 0;
      const svnRepo: RepositoryStatus = {
        ...repository('repo-svn-inflight', 'RepoSVNInflight'),
        meta: { ...repository('repo-svn-inflight', 'RepoSVNInflight').meta, kind: 'svn' },
        branch: 'trunk',
        revision: '100',
        ahead: 0,
        behind: 0,
      };
      ws.repositories = [{ ...svnRepo }];

      let subscriber: ((event: any) => void) | undefined;
      const openDeferred = deferred<WorkspaceSnapshot>();

      const bridge = new MockBridge((command: any) => {
        if (command.type === 'bootstrap') {
          return {
            ...bootstrap,
            launchWorkspaceId: undefined,
            applicationSessionId: 'session-svn-probe-inflight-test',
            state: {
              ...bootstrap.state,
              recentWorkspaces: [],
              settings: { ...bootstrap.state.settings, fetchOnStartup: false, notifyIncomingCommits: true } as any,
            },
          };
        }
        if (command.type === 'workspaceOpen') {
          return openDeferred.promise;
        }
        if (command.type === 'workspaceRefresh' || command.type === 'repositoryStatus') {
          return { ...svnRepo, behind: svnBehind };
        }
        if (command.type === 'history') return { commits: [], hasMore: false };
        if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
        return [];
      });

      bridge.subscribe = (handler: any) => {
        subscriber = handler;
        return () => undefined;
      };

      useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
      await useAppStore.getState().initialize(bridge);

      // 1. 发起打开工作区请求（此时请求正在网络传输中，尚未返回快照）
      const openPromise = useAppStore.getState().openWorkspace(ws.workspace.paths);

      // 断言此时前端尚未建立任何快照与当前工作区
      expect(useAppStore.getState().snapshot).toBeUndefined();
      expect(useAppStore.getState().activeTabId).toBeNull();

      // 2. 关键竞态：在快照到达并被前端应用之前，后台探测先行完成并向前端发出了 watcher 事件
      svnBehind = 3;
      subscriber?.({
        workspaceId: ws.workspace.id,
        repoId: svnRepo.meta.id,
        generation: 2,
        source: 'watcher',
        scopes: ['status'],
      });

      // 3. 此时快照终于通过 IPC 传输到达前端（快照生成时仍为旧值 behind = 0）
      openDeferred.resolve({
        ...ws,
        repositories: [{ ...svnRepo, behind: 0 }],
      });
      await openPromise;

      // 初始快照挂载后，因 behind = 0 且基线初始化，初始不应触发通知
      expect(localStorage.getItem('versiondock:notification-count:ws-svn-probe-inflight-buffer:incoming')).toBe('0');

      // 4. 等待挂起的 watcher 事件被自动激活并在 300ms 防抖后完成刷新
      await vi.advanceTimersByTimeAsync(350);

      // 核心断言：先前在快照返回前到达的事件没有被丢弃，成功触发了状态刷新并准确弹出待更新通知！
      const notifications = useAppStore.getState().notifications.filter((n) => n.title === 'Incoming Commits');
      expect(notifications).toHaveLength(1);
      expect(notifications[0].message).toEqual({
        key: 'VersionDock [{0}]: {1} incoming commits available to update.',
        args: ['RepoSVNInflight', 3],
      });
      expect(localStorage.getItem('versiondock:notification-count:ws-svn-probe-inflight-buffer:incoming')).toBe('3');
    } finally {
      vi.useRealTimers();
      useAppStore.getState().dispose();
    }
  });

  it('does not exhaust startup notification if count starts at 0, and notifies when commits arrive later', async () => {
    const workspace = snapshot('lazy-commits-notifications', 1);
    workspace.repositories = [
      { ...repository('repo-x', 'RepoX'), ahead: 0, behind: 0 },
    ];
    let currentWorkspace = workspace;
    const bridge = new MockBridge((command) => {
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') return currentWorkspace;
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });
    useAppStore.setState({ bridge, bootstrap: { ...bootstrap, applicationSessionId: `session-${crypto.randomUUID()}` }, ready: true, notifications: [], toastNotificationIds: [] });

    await useAppStore.getState().openWorkspace(workspace.workspace.paths);
    expect(useAppStore.getState().notifications).toHaveLength(0);

    // Later, fetch completes or status updates to behind: 2
    currentWorkspace = {
      ...workspace,
      generation: 2,
      repositories: [
        { ...repository('repo-x', 'RepoX'), ahead: 0, behind: 2 },
      ],
    };
    await useAppStore.getState().refresh(true);

    const notifications = useAppStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Incoming Commits');
    expect(notifications[0].message).toEqual({
      key: 'VersionDock [{0}]: {1} incoming commits available to update.',
      args: ['RepoX', 2],
    });
  });

  it('dispatches incoming and unpushed actions entirely through in-app notifications', async () => {
    let currentWorkspace = snapshot('ws-native-actions', 1);
    currentWorkspace.repositories = [
      { ...repository('repo-n1', 'RepoN1'), ahead: 0, behind: 0 },
    ];
    const notifyCalls: Array<{ title: string; body: string }> = [];
    let updatedProjectCalled = false;
    const bridge = new MockBridge((command) => {
      if (command.type === 'sync' && (command.payload as any)?.action === 'pullRebase') {
        updatedProjectCalled = true;
        return { output: 'Already up to date.' };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return currentWorkspace;
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'runtimeCapabilities') return { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } };
      return [];
    });
    Object.assign(bridge, { notify: async (title?: string, body?: string) => {
      notifyCalls.push({ title: title ?? '', body: body ?? '' });
      return true;
    } });

    useAppStore.setState({ bridge, bootstrap: { ...bootstrap, applicationSessionId: `session-${crypto.randomUUID()}` }, ready: true, notifications: [], toastNotificationIds: [] });
    await useAppStore.getState().openWorkspace(currentWorkspace.workspace.paths);

    currentWorkspace = {
      ...currentWorkspace,
      generation: 2,
      repositories: [
        { ...repository('repo-n1', 'RepoN1'), ahead: 1, behind: 2 },
      ],
    };
    await useAppStore.getState().refresh(true);

    // 1. 不再向操作系统发送原生系统通知，通知行为完全收拢在应用内
    expect(notifyCalls.length).toBe(0);

    // 2. 真正的业务交互：由应用内 Toast 承载并包含隔离的工作区上下文，与插件完全对齐动作列表
    const incomingNotification = useAppStore.getState().notifications.find((n) => n.title === 'Incoming Commits');
    expect(incomingNotification).toBeDefined();
    expect(incomingNotification?.actions).toEqual([
      { type: 'updateProject', label: 'Update' },
      { type: 'dismiss', label: 'Dismiss' },
      { type: 'disableIncoming', label: "Don't show again" },
    ]);

    const unpushedNotification = useAppStore.getState().notifications.find((n) => n.title === 'Unpushed Commits');
    expect(unpushedNotification).toBeDefined();
    expect(unpushedNotification?.actions).toEqual([
      { type: 'openPush', label: 'Go to Push' },
      { type: 'dismiss', label: 'Dismiss' },
    ]);

    // 触发应用内 incoming Toast 的 update 动作
    if (incomingNotification) {
      await useAppStore.getState().performNotificationAction(incomingNotification.id, 0);
      expect(updatedProjectCalled).toBe(true);
    }

    // 触发应用内 unpushed Toast 的 dismiss 动作
    if (unpushedNotification) {
      expect(useAppStore.getState().toastNotificationIds).toContain(unpushedNotification.id);
      await useAppStore.getState().performNotificationAction(unpushedNotification.id, 1);
      const afterDismiss = useAppStore.getState().notifications.find((n) => n.id === unpushedNotification.id);
      expect(afterDismiss?.read).toBe(true);
      expect(useAppStore.getState().toastNotificationIds).not.toContain(unpushedNotification.id);
    }

    useAppStore.getState().dispose();
  });

  it('includes Resolve Conflicts and Push to Remote actions when Update Project encounters conflicts or missing upstream', async () => {
    const workspace = snapshot('update-actions-ws', 1);
    workspace.repositories = [
      repository('repo-conflict', 'ConflictRepo'),
      repository('repo-no-upstream', 'NoUpstreamRepo'),
    ];
    let pushedRepoId: string | null = null;
    let pushShouldFail = false;
    const bridge = new MockBridge((command) => {
      if (command.type === 'sync') {
        const payload = command.payload as { repo_id: string; action: string };
        if (payload.action === 'push') {
          pushedRepoId = payload.repo_id;
          if (pushShouldFail) {
            throw new BridgeError({ code: 'PUSH_FAILED', message: 'remote rejected', command: 'git push', exitCode: 1, stderr: '', recoverable: true });
          }
          return { output: 'Pushed and tracking configured' };
        }
        if (payload.repo_id === 'repo-conflict') {
          throw new BridgeError({ code: 'CONFLICT', message: 'Automatic merge failed; fix conflicts and commit the result.', command: 'git pull', exitCode: 1, stderr: '', recoverable: true });
        }
        if (payload.repo_id === 'repo-no-upstream') {
          return {
            output: 'No remote tracking branch — skipped',
            update: {
              repoId: 'repo-no-upstream',
              beforeRevision: 'rev1',
              afterRevision: 'rev1',
              summary: { kind: 'noChanges', commitCount: 0, fileCount: 0, containsMerge: false, detail: { commits: [], files: [] } },
              summaryError: null,
              beforeStatus: 'clean',
              afterStatus: 'clean',
            },
          };
        }
      }
      return [];
    });
    useAppStore.setState({ bridge, snapshot: workspace, allRepositories: workspace.repositories, notifications: [], toastNotificationIds: [] });

    await useAppStore.getState().updateProject();
    const notification = useAppStore.getState().notifications[0];
    expect(notification).toBeDefined();
    expect(notification.type).toBe('warning');
    expect(notification.actions).toEqual(expect.arrayContaining([
      { type: 'openConflicts', label: 'Resolve Conflicts' },
    ]));

    // The mixed failure summary only offers conflict resolution, matching the plugin.
    useAppStore.getState().addNotification({ type: 'warning', title: 'Project update', message: 'Missing upstream', actions: [{ type: 'pushToRemote', label: 'Push to Remote', repoId: 'repo-no-upstream' }] });
    const pushNotification = useAppStore.getState().notifications[0];
    // 1. Click "Push to Remote" when it fails
    pushShouldFail = true;
    const pushActionIndex = pushNotification.actions.findIndex((a) => a.type === 'pushToRemote');
    await useAppStore.getState().performNotificationAction(pushNotification.id, pushActionIndex);
    expect(pushedRepoId).toBe('repo-no-upstream');
    expect(useAppStore.getState().notifications.some((n) => n.title === 'Push completed')).toBe(false);

    // 2. Click "Push to Remote" when it succeeds
    pushShouldFail = false;
    await useAppStore.getState().performNotificationAction(pushNotification.id, pushActionIndex);
    const completedNotif = useAppStore.getState().notifications.find((n) => n.title === 'Push completed');
    expect(completedNotif).toBeDefined();
    expect(completedNotif?.message).toEqual({
      key: 'VersionDock [{0}]: Pushed and configured remote tracking.',
      args: ['NoUpstreamRepo'],
    });
  });

  it('correctly tracks status notification counts and enforces single notification per session on count fluctuations', async () => {
    const ws = snapshot('count-ws', 1);
    const repoA = repository('repo-a', 'RepoA');
    ws.repositories = [repoA];
    let currentAhead = 2;
    const session1Id = `test-session-count-${Date.now()}`;
    const bridge = new MockBridge((command) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: session1Id,
          launchWorkspaceId: ws.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, notifyUnpushedCommits: true } as import('../bindings/generated').DesktopSettings,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      if (command.type === 'workspaceRefresh' || command.type === 'workspaceOpen') {
        return {
          ...ws,
          repositories: [{ ...repoA, ahead: currentAhead }],
        };
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      snapshot: ws,
      allRepositories: [repoA],
      notifications: [],
      bootstrap: {
        ...bootstrap,
        applicationSessionId: session1Id,
        state: { ...bootstrap.state, settings: { ...bootstrap.state.settings, notifyUnpushedCommits: true } as import('../bindings/generated').DesktopSettings },
      },
    });

    // 首次启动：发现 2 个未推送提交，对齐插件提醒一次，建立基准线 2
    currentAhead = 2;
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Unpushed Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:count-ws:unpushed')).toBe('2');

    // 再次以 2 触发 -> 不重复通知
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Unpushed Commits')).toHaveLength(1);

    // 2 -> 3：数量增加 -> 对齐插件：会话内已通知过，不重复弹窗，基线更新为 3
    currentAhead = 3;
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Unpushed Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:count-ws:unpushed')).toBe('3');

    // 3 -> 1：数量下降 -> 不通知，但计数更新为 1
    currentAhead = 1;
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Unpushed Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:count-ws:unpushed')).toBe('1');

    // 1 -> 2：数量从 1 回升到 2 -> 会话内已通知过，不重复弹窗，基线更新为 2
    currentAhead = 2;
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Unpushed Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:count-ws:unpushed')).toBe('2');

    // 2 -> 0：数量归零 -> 不通知，计数更新为 0
    currentAhead = 0;
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Unpushed Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:count-ws:unpushed')).toBe('0');

    // 0 -> 1：数量从 0 回升到 1 -> 会话内已通知过，不重复弹窗，计数更新为 1
    currentAhead = 1;
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Unpushed Commits')).toHaveLength(1);
    expect(localStorage.getItem('versiondock:notification-count:count-ws:unpushed')).toBe('1');

    // 重启应用（新会话启动）：
    const session2Id = `test-session-count-relaunch-${Date.now()}`;
    const bridgeSession2 = new MockBridge((command) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          applicationSessionId: session2Id,
          launchWorkspaceId: ws.workspace.id,
          state: {
            ...bootstrap.state,
            settings: { ...bootstrap.state.settings, notifyUnpushedCommits: true } as import('../bindings/generated').DesktopSettings,
            recentWorkspaces: [ws.workspace],
          },
        };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        return {
          ...ws,
          repositories: [{ ...repoA, ahead: 1 }],
        };
      }
      return [];
    });
    useAppStore.setState({ notifications: [], tabs: [], snapshot: undefined, allRepositories: [] });
    await useAppStore.getState().initialize(bridgeSession2);
    // 新会话启动后，检测到未推送提交，发出新会话的 1 次通知！
    expect(useAppStore.getState().notifications.filter((n) => n.title === 'Unpushed Commits')).toHaveLength(1);
  });

  it('keeps notification text translatable until render time and executes actions', async () => {
    const bridge = new MockBridge((command) => command.type === 'updateLayout' ? command.payload.layout : true);
    useAppStore.setState({ bridge, bootstrap, snapshot: snapshot('workspace', 1), activeTabId: 'workspace' });
    const id = useAppStore.getState().addNotification({
      type: 'info', title: 'Incoming Commits', message: { key: '{0} incoming commits', args: [3] }, workspaceId: 'workspace',
      actions: [{ type: 'openPush', label: 'Go to Push' }],
    });
    const item = useAppStore.getState().notifications[0];
    expect(resolveNotificationText(item.message, (key, ...args) => `zh:${key}:${args.join(',')}`)).toBe('zh:{0} incoming commits:3');
    await useAppStore.getState().performNotificationAction(id, 0);
    expect(useAppStore.getState().bootstrap?.state.layout?.activeTab).toBe('sync');
    expect(useAppStore.getState().notifications[0].read).toBe(true);
  });

  it('handles openBranchComparison notification action by switching repo and opening comparison', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo-1', 'Repo 1'), repository('repo-2', 'Repo 2')];
    useAppStore.setState({ snapshot: workspace, selectedRepoId: 'repo-1' });

    const notifId = useAppStore.getState().addNotification({
      type: 'info',
      title: 'Compare feature',
      message: 'Compare result',
      workspaceId: 'workspace',
      actions: [{ type: 'openBranchComparison', label: 'Repo 2', repoId: 'repo-2', target: 'feature/login' }],
    });

    await useAppStore.getState().performNotificationAction(notifId, 0);

    expect(useAppStore.getState().selectedRepoId).toBe('repo-2');
    expect(useAppStore.getState().comparisonTarget).toEqual({ repoId: 'repo-2', target: 'feature/login' });
    expect(useAppStore.getState().mode).toBe('history');
  });

  it('does not open comparison if target workspace has been closed', async () => {
    const currentWorkspace = snapshot('current-ws', 1);
    currentWorkspace.repositories = [repository('repo-current', 'Current Repo')];
    useAppStore.setState({
      snapshot: currentWorkspace,
      activeTabId: 'current-ws',
      tabs: [currentWorkspace.workspace],
      selectedRepoId: 'repo-current',
      comparisonTarget: undefined,
    });

    const notifId = useAppStore.getState().addNotification({
      type: 'info',
      title: 'Compare feature',
      message: 'Compare result',
      workspaceId: 'closed-ws',
      actions: [{ type: 'openBranchComparison', label: 'Old Repo', repoId: 'old-repo', target: 'feature/login' }],
    });

    await useAppStore.getState().performNotificationAction(notifId, 0);

    expect(useAppStore.getState().snapshot?.workspace.id).toBe('current-ws');
    expect(useAppStore.getState().selectedRepoId).toBe('repo-current');
    expect(useAppStore.getState().comparisonTarget).toBeUndefined();
  });

  it('does not open comparison if target repo does not exist in workspace', async () => {
    const currentWorkspace = snapshot('current-ws', 1);
    currentWorkspace.repositories = [repository('repo-a', 'Repo A')];
    useAppStore.setState({
      snapshot: currentWorkspace,
      activeTabId: 'current-ws',
      tabs: [currentWorkspace.workspace],
      selectedRepoId: 'repo-a',
      comparisonTarget: undefined,
    });

    const notifId = useAppStore.getState().addNotification({
      type: 'info',
      title: 'Compare feature',
      message: 'Compare result',
      workspaceId: 'current-ws',
      actions: [{ type: 'openBranchComparison', label: 'Non Existent', repoId: 'repo-nonexistent', target: 'feature/login' }],
    });

    await useAppStore.getState().performNotificationAction(notifId, 0);

    expect(useAppStore.getState().selectedRepoId).toBe('repo-a');
    expect(useAppStore.getState().comparisonTarget).toBeUndefined();
  });

  it('executes global action (such as disableIncoming) even if target workspace has been closed', async () => {
    const bridge = new MockBridge((command) => command.type === 'updateSettings'
      ? { settings: command.payload.settings, effects: { rescanWorkspace: false, reloadHistory: false, restartAutoRefresh: false } }
      : true);
    const currentWorkspace = snapshot('current-ws', 1);
    currentWorkspace.repositories = [repository('repo-current', 'Current Repo')];
    useAppStore.setState({
      bridge,
      snapshot: currentWorkspace,
      activeTabId: 'current-ws',
      tabs: [currentWorkspace.workspace],
      selectedRepoId: 'repo-current',
      bootstrap: { ...bootstrap, state: { ...bootstrap.state, settings: { ...bootstrap.state.settings, notifyIncomingCommits: true } as import('../bindings/generated').DesktopSettings } },
    });

    const notifId = useAppStore.getState().addNotification({
      type: 'info',
      title: 'Incoming Commits',
      message: 'New commits',
      workspaceId: 'closed-ws',
      actions: [{ type: 'disableIncoming', label: "Don't show again" }],
    });

    await useAppStore.getState().performNotificationAction(notifId, 0);

    expect(useAppStore.getState().bootstrap?.state.settings?.notifyIncomingCommits).toBe(false);
  });

  it('does not switch active workspace when dismissing or disabling incoming notification of another workspace', async () => {
    const wsA = snapshot('ws-a', 1);
    wsA.repositories = [repository('repo-a', 'Repo A')];
    const wsB = snapshot('ws-b', 1);
    wsB.repositories = [repository('repo-b', 'Repo B')];

    let switchTabCalled = false;
    const bridge = new MockBridge((command) => {
      if (command.type === 'updateSettings') {
        return { settings: command.payload.settings, effects: { rescanWorkspace: false, reloadHistory: false, restartAutoRefresh: false } };
      }
      if (command.type === 'workspaceOpen' || command.type === 'workspaceRefresh') {
        switchTabCalled = true;
        return wsB;
      }
      return true;
    });

    useAppStore.setState({
      bridge,
      snapshot: wsA,
      activeTabId: 'ws-a',
      tabs: [wsA.workspace, wsB.workspace],
      selectedRepoId: 'repo-a',
      notifications: [],
      toastNotificationIds: [],
      bootstrap: { ...bootstrap, state: { ...bootstrap.state, settings: { ...bootstrap.state.settings, notifyIncomingCommits: true } as import('../bindings/generated').DesktopSettings } },
    });

    const notifId = useAppStore.getState().addNotification({
      type: 'info',
      title: 'Incoming Commits',
      message: 'New commits in Project B',
      workspaceId: 'ws-b',
      actions: [
        { type: 'updateProject', label: 'Update' },
        { type: 'dismiss', label: 'Dismiss' },
        { type: 'disableIncoming', label: "Don't show again" },
      ],
    });

    // 1. 点击 Dismiss：通知被标记为已读，从 Toast 中移除，当前工作区必须保持 ws-a，绝不切换到 ws-b
    expect(useAppStore.getState().toastNotificationIds).toContain(notifId);
    await useAppStore.getState().performNotificationAction(notifId, 1);
    expect(useAppStore.getState().activeTabId).toBe('ws-a');
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('ws-a');
    expect(switchTabCalled).toBe(false);
    const dismissedNotif = useAppStore.getState().notifications.find((n) => n.id === notifId);
    expect(dismissedNotif?.read).toBe(true);
    expect(useAppStore.getState().toastNotificationIds).not.toContain(notifId);

    // 2. 点击 Don't show again：当前工作区保持 ws-a，设置被更新
    const notif2Id = useAppStore.getState().addNotification({
      type: 'info',
      title: 'Incoming Commits',
      message: 'Another commit in Project B',
      workspaceId: 'ws-b',
      actions: [
        { type: 'updateProject', label: 'Update' },
        { type: 'dismiss', label: 'Dismiss' },
        { type: 'disableIncoming', label: "Don't show again" },
      ],
    });

    await useAppStore.getState().performNotificationAction(notif2Id, 2);
    expect(useAppStore.getState().activeTabId).toBe('ws-a');
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('ws-a');
    expect(switchTabCalled).toBe(false);
    expect(useAppStore.getState().bootstrap?.state.settings?.notifyIncomingCommits).toBe(false);
  });

  it('blocks viewUpdateDetails and viewUpdateResults when target workspace is closed to prevent polluting active workspace', async () => {
    const wsA = snapshot('ws-a', 1);
    wsA.repositories = [repository('repo-a', 'Repo A')];

    const bridge = new MockBridge((command) => {
      if (command.type === 'history') return { commits: [], hasMore: false };
      return true;
    });

    useAppStore.setState({
      bridge,
      snapshot: wsA,
      activeTabId: 'ws-a',
      tabs: [wsA.workspace],
      selectedRepoId: 'repo-a',
      selectedCommits: [],
      selectedCommit: undefined,
      selectedCommitDetails: {},
      mode: 'history',
      notifications: [],
      toastNotificationIds: [],
    });

    const fakeCommit: CommitNode = {
      hash: 'b'.repeat(40),
      shortHash: 'bbbbbbb',
      message: 'Commit from workspace B',
      author: 'Author B',
      email: 'b@example.com',
      authorDate: '2026-09-30T10:00:00Z',
      committerDate: '2026-09-30T10:00:00Z',
      parents: [],
      refs: [],
      repoId: 'repo-b',
    };

    const notifId = useAppStore.getState().addNotification({
      type: 'success',
      title: 'Project update',
      message: 'Updated Project B',
      workspaceId: 'ws-b',
      actions: [
        {
          type: 'viewUpdateDetails',
          label: 'View update details',
          result: {
            repoId: 'repo-b',
            beforeRevision: '1',
            afterRevision: '2',
            beforeStatus: '',
            afterStatus: '',
            summaryError: null,
            summary: {
              kind: 'updated',
              containsMerge: false,
              commitCount: 1,
              fileCount: 1,
              detail: {
                commits: [fakeCommit],
                files: [],
              },
            },
          },
        },
      ],
    });

    // 点击 viewUpdateDetails
    await useAppStore.getState().performNotificationAction(notifId, 0);

    // 验证：因为 ws-b 已关闭（workspaceMismatch），操作被安全阻断，工作区 A 状态未被污染
    expect(useAppStore.getState().activeTabId).toBe('ws-a');
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('ws-a');
    expect(useAppStore.getState().selectedCommits).toEqual([]);
    expect(useAppStore.getState().selectedCommit).toBeUndefined();
    expect(useAppStore.getState().selectedCommitDetails).toEqual({});
    expect(useAppStore.getState().mode).toBe('history');
  });

  it('queues every notification for immediate display without overwriting earlier messages', () => {
    const first = useAppStore.getState().addNotification({ type: 'info', title: 'First', message: 'First message' });
    const second = useAppStore.getState().addNotification({ type: 'success', title: 'Second', message: 'Second message' });
    expect(useAppStore.getState().toastNotificationIds).toEqual([first, second]);
    useAppStore.getState().dismissToast();
    expect(useAppStore.getState().toastNotificationIds).toEqual([second]);
  });

  it('prunes toastNotificationIds to stay in sync with the 100-notification limit', () => {
    useAppStore.setState({ notifications: [], toastNotificationIds: [] });
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) {
      ids.push(useAppStore.getState().addNotification({ type: 'warning', title: `W${i}`, message: `Message ${i}` }));
    }
    const state = useAppStore.getState();
    expect(state.notifications).toHaveLength(100);
    // The first 5 notifications should have been trimmed from notifications
    expect(state.notifications.map((n) => n.id)).not.toContain(ids[0]);
    expect(state.notifications.map((n) => n.id)).not.toContain(ids[4]);
    expect(state.notifications.map((n) => n.id)).toContain(ids[5]);
    expect(state.notifications.map((n) => n.id)).toContain(ids[104]);

    // toastNotificationIds should also have been trimmed to exactly match the surviving 100 items
    expect(state.toastNotificationIds).toHaveLength(100);
    expect(state.toastNotificationIds).not.toContain(ids[0]);
    expect(state.toastNotificationIds).not.toContain(ids[4]);
    expect(state.toastNotificationIds).toContain(ids[5]);
    expect(state.toastNotificationIds).toContain(ids[104]);
  });

  it('publishes operation-specific errors as critical notifications and ignores cancellation', async () => {
    const workspace = snapshot('errors', 1);
    workspace.repositories = [repository('repo-a', 'A')];
    const bridge = new MockBridge((command) => {
      if (command.type === 'branchOperation') throw new BridgeError({ code: 'BRANCH_FAILED', message: 'branch failed', command: 'git', exitCode: 1, stderr: 'details', recoverable: true });
      if (command.type === 'stage') throw new DOMException('Operation aborted', 'AbortError');
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'repo-a', notifications: [] });

    await useAppStore.getState().branchOperation({ type: 'delete', name: 'topic', force: false }, 'repo-a');
    expect(useAppStore.getState().notifications[0].title).toBe('Branch operation failed');
    expect(useAppStore.getState().toastNotificationIds).toEqual([useAppStore.getState().notifications[0].id]);

    await useAppStore.getState().stage('repo-a', ['a.ts']);
    expect(useAppStore.getState().notifications).toHaveLength(1);
  });

  it('isolates operation activity by repository and domain', () => {
    const operations = {
      fetchA: {
        operationId: 'fetchA',
        context: { generation: 1, domain: 'sync' as const, visibility: 'foreground' as const, workspaceId: 'workspace', repositoryId: 'repo-a', target: null },
        status: 'running' as const,
        phase: 'sync', message: '', startedAt: '', cancellable: true, completed: null, total: null, error: null,
      },
    };
    expect(isOperationActive(operations, { repositoryId: 'repo-a', domain: 'sync' })).toBe(true);
    expect(isOperationActive(operations, { repositoryId: 'repo-b', domain: 'sync' })).toBe(false);
    expect(isOperationActive(operations, { repositoryId: 'repo-a', domain: 'diff' })).toBe(false);
  });
  it('matches multi-repository operation targets without blocking unrelated repositories', () => {
    const operations = {
      batch: {
        operationId: 'batch',
        context: { generation: 1, domain: 'commit' as const, visibility: 'foreground' as const, workspaceId: 'workspace', repositoryId: null, target: 'repositories:["repo-a","repo-b"]' },
        status: 'running' as const,
        phase: 'commit', message: '', startedAt: '', cancellable: true, completed: null, total: null, error: null,
      },
    };
    expect(isOperationActiveForRepositories(operations, ['repo-b'], { workspaceId: 'workspace', domain: 'commit' })).toBe(true);
    expect(isOperationActiveForRepositories(operations, ['repo-c'], { workspaceId: 'workspace', domain: 'commit' })).toBe(false);
  });
  it('annotates batch commit operations with their exact repository targets', async () => {
    const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
    const bridge = new MockBridge((command, options) => {
      requests.push({ command, options });
      if (command.type === 'batchCommit') return command.payload.targets.map((target) => ({
        repoId: target.repoId, commitAttempted: true, committed: true, revision: 'abc', pushAttempted: false, pushed: false, failedStage: null, recoveryHint: null, error: null,
      }));
      return [];
    });
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo-a', 'A'), repository('repo-b', 'B')];
    useAppStore.setState({ bridge, snapshot: workspace });

    await useAppStore.getState().commitMany([
      { repoId: 'repo-a', paths: ['a.ts'], unstagePaths: [], amend: false, stagedOnly: true },
      { repoId: 'repo-b', paths: ['b.ts'], unstagePaths: [], amend: false, stagedOnly: false },
    ], 'batch targets', false);

    const batch = requests.find((request) => request.command.type === 'batchCommit');
    expect(batch?.options?.context).toMatchObject({ repositoryId: null, target: 'repositories:["repo-a","repo-b"]' });
    expect((batch?.command as any)?.payload?.targets[0]?.stagedOnly).toBe(true);
    expect((batch?.command as any)?.payload?.targets[1]?.stagedOnly).toBe(false);
  });
  it('compares multi-root workspace paths independent of selection order', () => {
    expect(workspacePathsEqual(['/repo/admin', '/repo/api'], ['/repo/api', '/repo/admin'])).toBe(true);
    expect(workspacePathsEqual(['/repo/admin'], ['/repo/api'])).toBe(false);
  });


  it('retains the original Shift selection anchor and clears stale file diffs', async () => {
    const commits: CommitNode[] = Array.from({ length: 4 }, (_, index) => ({ repoId: 'a', hash: `commit-${index}`, shortHash: `c${index}`, parents: [], author: 'Ada', email: '', authorDate: '', committerDate: '', message: `Commit ${index}`, refs: [] }));
    const details = Object.fromEntries(commits.map((commit) => [commitKey('a', commit.hash), { commit, fullMessage: commit.message, branches: { local: [], remote: [], tags: [] }, files: [] }]));
    const workspace = { ...snapshot('workspace', 1), repositories: [repository('a', 'Alpha')] };
    useAppStore.setState({ snapshot: workspace, history: commits, selectedCommitDetails: details, selectedCommits: [], selectedPrimaryKey: undefined, commitSelectionAnchorKey: undefined });
    await useAppStore.getState().selectCommit(commits[2]);
    useAppStore.setState({ selectedFile: { repoId: 'a', path: 'same.txt', staged: false, revision: commits[2].hash } });
    await useAppStore.getState().selectCommit(commits[0], 'range');
    expect(useAppStore.getState().selectedCommits).toEqual(commits.slice(0, 3));
    expect(useAppStore.getState().selectedFile).toBeUndefined();
    await useAppStore.getState().selectCommit(commits[3], 'range');
    expect(useAppStore.getState().selectedCommits).toEqual(commits.slice(2, 4));
    await useAppStore.getState().selectCommit(commits[3]);
    await useAppStore.getState().selectCommit(commits[3], 'toggle');
    expect(useAppStore.getState().selectedCommits).toEqual([commits[3]]);
  });

  it('ignores a file diff that resolves after the commit selection changes', async () => {
    const pending = deferred<DiffDocument>();
    const commit: CommitNode = { repoId: 'a', hash: 'next', shortHash: 'next', parents: [], author: 'Ada', email: '', authorDate: '', committerDate: '', message: 'Next', refs: [] };
    const bridge = new MockBridge((command) => command.type === 'fileDiff' ? pending.promise : []);
    useAppStore.setState({ bridge, snapshot: { ...snapshot('workspace', 1), repositories: [repository('a', 'Alpha')] }, history: [commit], selectedCommits: [], selectedCommitDetails: { [commitKey('a', commit.hash)]: { commit, fullMessage: 'Next', branches: { local: [], remote: [], tags: [] }, files: [] } }, selectedPrimaryKey: undefined });
    const opening = useAppStore.getState().openDiff('a', 'old.txt', false, 'old');
    await useAppStore.getState().selectCommit(commit);
    pending.resolve({ path: 'old.txt', content: 'old diff', language: 'text', binary: false, truncated: false, lineCount: 1 });
    await opening;
    expect(useAppStore.getState().mode).toBe('history');
    expect(useAppStore.getState().selectedFile).toBeUndefined();
    expect(useAppStore.getState().diff).toBeUndefined();
  });

  it('supports single, toggle, and range commit selection with aggregated revision diffs', async () => {
    const commits: CommitNode[] = [
      { repoId: 'a', hash: 'a'.repeat(40), shortHash: 'aaaaaaaa', parents: ['b'.repeat(40)], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-03T00:00:00Z', committerDate: '2026-01-03T00:00:00Z', message: 'third', refs: [] },
      { repoId: 'a', hash: 'b'.repeat(40), shortHash: 'bbbbbbbb', parents: ['c'.repeat(40)], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-02T00:00:00Z', committerDate: '2026-01-02T00:00:00Z', message: 'second', refs: [] },
      { repoId: 'a', hash: 'c'.repeat(40), shortHash: 'cccccccc', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'first', refs: [] },
    ];
    const detail = (commit: CommitNode): CommitDetail => ({ commit, fullMessage: commit.message, branches: { local: ['main'], remote: ['origin/main'], tags: [] }, files: [{ path: `src/${commit.shortHash}.ts`, status: 'M', added: 2, removed: 1 }] });
    const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'commitDetail') return detail(commits.find((commit) => commit.hash === command.payload.revision)!);
      if (command.type === 'fileDiff') return { path: command.payload.relative_path, content: 'diff', language: 'text', binary: false, truncated: false, lineCount: 1 };
      return [];
    });
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('a', 'Alpha')];
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'a', history: commits });

    await useAppStore.getState().selectCommit(commits[1]);
    await useAppStore.getState().selectCommit(commits[0], 'range', commits);
    expect(useAppStore.getState().selectedCommits.map((commit) => commit.hash)).toEqual([commits[0].hash, commits[1].hash]);
    useAppStore.getState().openCommitChanges();
    expect(useAppStore.getState().mode).toBe('changes');
    const target = useAppStore.getState().changes!.files[0];
    await useAppStore.getState().loadChangesDiff(target);
    const rangeCommand = commands.find((command) => command.type === 'fileDiff' && command.payload.from_revision);
    expect(rangeCommand).toMatchObject({ type: 'fileDiff', payload: { from_revision: 'c'.repeat(40), to_revision: 'a'.repeat(40) } });
    expect(useAppStore.getState().changesDiff?.content).toBe('diff');
    await useAppStore.getState().selectCommit(commits[2], 'toggle', commits);
    expect(useAppStore.getState().selectedCommits.map((commit) => commit.hash)).toEqual([commits[0].hash, commits[1].hash, commits[2].hash]);
  });

  it('preserves branch comparison while opening and closing a file diff', async () => {
    const bridge = new MockBridge((command) => command.type === 'fileDiff'
      ? { path: command.payload.relative_path, content: 'diff --git a/src/file.ts b/src/file.ts', language: 'typescript', binary: false, truncated: false, lineCount: 1 }
      : []);
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'repo' });
    useAppStore.getState().openBranchComparison('repo', 'feature/ui');
    useAppStore.setState({ comparison: { base: 'main', target: 'feature/ui', baseCommits: [], targetCommits: [], files: [] } });

    await useAppStore.getState().openDiff('repo', 'src/file.ts', false, 'abcdef');

    expect(useAppStore.getState()).toMatchObject({
      mode: 'diff',
      comparisonTarget: { repoId: 'repo', target: 'feature/ui' },
      comparison: { base: 'main', target: 'feature/ui' },
    });
    useAppStore.getState().backToHistory();
    expect(useAppStore.getState()).toMatchObject({
      mode: 'history',
      comparisonTarget: { repoId: 'repo', target: 'feature/ui' },
      comparison: { base: 'main', target: 'feature/ui' },
    });
  });

  it('returns to commit-detail mode when backToHistory is invoked from commit detail diff', async () => {
    const bridge = new MockBridge((command) => command.type === 'fileDiff'
      ? { path: command.payload.relative_path, content: 'diff content', language: 'typescript', binary: false, truncated: false, lineCount: 1 }
      : []);
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'repo', mode: 'commit-detail' });

    await useAppStore.getState().openDiff('repo', 'src/file.ts', false, 'abcdef');

    expect(useAppStore.getState().mode).toBe('diff');
    expect(useAppStore.getState().diffReturnMode).toBe('commit-detail');

    useAppStore.getState().backToHistory();

    expect(useAppStore.getState().mode).toBe('commit-detail');
    expect(useAppStore.getState().diffReturnMode).toBeUndefined();
  });

  it('returns to merge mode and preserves merge data when backToHistory is invoked from diff', async () => {
    const bridge = new MockBridge((command) => command.type === 'fileDiff'
      ? { path: command.payload.relative_path, content: 'diff content', language: 'typescript', binary: false, truncated: false, lineCount: 1 }
      : []);
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    const dummyMerge = {
      path: 'conflict.txt',
      base: 'base',
      ours: 'ours',
      theirs: 'theirs',
      working: 'working',
      markerContent: 'marker',
      conflicts: [],
      oursLabel: 'ours',
      theirsLabel: 'theirs',
      language: 'text',
      fingerprint: 'fp-123',
      binary: false,
    };
    useAppStore.setState({
      bridge,
      bootstrap,
      snapshot: workspace,
      selectedRepoId: 'repo',
      mode: 'merge',
      merge: dummyMerge,
      mergeResult: 'working',
    });

    await useAppStore.getState().openDiff('repo', 'src/file.ts', false, 'abcdef');
    expect(useAppStore.getState().mode).toBe('diff');
    expect(useAppStore.getState().diffReturnMode).toBe('merge');
    expect(useAppStore.getState().merge).toBe(dummyMerge);

    useAppStore.getState().backToHistory();

    expect(useAppStore.getState().mode).toBe('merge');
    expect(useAppStore.getState().diffReturnMode).toBeUndefined();
    expect(useAppStore.getState().merge).toBe(dummyMerge);
    expect(useAppStore.getState().mergeResult).toBe('working');
  });

  it('preserves diffReturnMode across workspace tab switching', async () => {
    const bridge = new MockBridge(() => []);
    const tabA = snapshot('ws-a', 1).workspace;
    const tabB = snapshot('ws-b', 1).workspace;
    const sessionA = {
      snapshot: snapshot('ws-a', 1),
      allRepositories: [repository('repo-a', 'Repo A')],
      selectedRepoId: 'repo-a',
      mode: 'diff' as const,
      diffReturnMode: 'commit-detail' as const,
      tabs: [tabA, tabB],
      activeTabId: 'ws-a',
    };
    const sessionB = {
      snapshot: snapshot('ws-b', 1),
      allRepositories: [repository('repo-b', 'Repo B')],
      selectedRepoId: 'repo-b',
      mode: 'history' as const,
      tabs: [tabA, tabB],
      activeTabId: 'ws-b',
    };

    useAppStore.setState({
      bridge,
      bootstrap,
      tabs: [tabA, tabB],
      activeTabId: 'ws-a',
      snapshot: sessionA.snapshot,
      allRepositories: sessionA.allRepositories,
      selectedRepoId: 'repo-a',
      mode: 'diff',
      diffReturnMode: 'commit-detail',
      sessions: {
        'ws-a': { ...sessionA, selectedFile: undefined, diff: undefined, changesDiff: undefined, changes: undefined, history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, historyFilter: '', historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', mergeResolutions: {}, mergeScope: 'all', commitMessage: '', amendRepoIds: [], incomingCommits: {}, commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, comparison: undefined, remotes: {}, loadErrors: {} },
        'ws-b': { ...sessionB, selectedFile: undefined, diff: undefined, changesDiff: undefined, changes: undefined, history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, historyFilter: '', historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', mergeResolutions: {}, mergeScope: 'all', commitMessage: '', amendRepoIds: [], incomingCommits: {}, commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, comparison: undefined, remotes: {}, loadErrors: {} },
      },
    });

    // 切换到 ws-b
    await useAppStore.getState().switchTab('ws-b');
    expect(useAppStore.getState().activeTabId).toBe('ws-b');
    expect(useAppStore.getState().mode).toBe('history');

    // 切回 ws-a
    await useAppStore.getState().switchTab('ws-a');
    expect(useAppStore.getState().activeTabId).toBe('ws-a');
    expect(useAppStore.getState().mode).toBe('diff');
    expect(useAppStore.getState().diffReturnMode).toBe('commit-detail');
  });

  it('resets path filter and reloads full history when opening update details', async () => {
    const testCommit: CommitNode = {
      repoId: 'repo',
      hash: 'hash-update',
      shortHash: 'hashup',
      parents: [],
      author: 'Tester',
      email: 'tester@example.test',
      authorDate: '2026-08-16T12:00:00Z',
      committerDate: '2026-08-16T12:00:00Z',
      message: 'update commit',
      refs: [],
    };
    const testDetail: CommitDetail = {
      commit: testCommit,
      fullMessage: 'update commit',
      branches: { local: [], remote: [], tags: [] },
      files: [{ path: 'updated-file.ts', status: 'M', added: 1, removed: 0 }],
    };
    const fullCommit: CommitNode = {
      repoId: 'repo',
      hash: 'full-commit',
      shortHash: 'full1',
      parents: [],
      author: 'Ada',
      email: 'ada@example.test',
      authorDate: '2026-01-01T00:00:00Z',
      committerDate: '2026-01-01T00:00:00Z',
      message: 'full history commit',
      refs: [],
    };
    const pathCommit: CommitNode = {
      repoId: 'repo',
      hash: 'path-commit',
      shortHash: 'path1',
      parents: [],
      author: 'Ada',
      email: 'ada@example.test',
      authorDate: '2026-01-01T00:00:00Z',
      committerDate: '2026-01-01T00:00:00Z',
      message: 'path filtered commit',
      refs: [],
    };
    const bridge = new MockBridge((command) => {
      if (command.type === 'commitDetail') return testDetail;
      if (command.type === 'history') {
        const query = command.payload.query as { path?: string | null };
        return { commits: query?.path ? [pathCommit] : [fullCommit], hasMore: false };
      }
      if (command.type === 'historyTopology') return [];
      return [];
    });

    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    useAppStore.setState({
      bridge,
      bootstrap,
      snapshot: workspace,
      selectedRepoId: 'repo',
    });

    await useAppStore.getState().openHistoryForPath('repo', 'src/filter.ts');
    expect(useAppStore.getState().historyQuery.path).toBe('src/filter.ts');
    expect(useAppStore.getState().history).toEqual([pathCommit]);

    await useAppStore.getState().openUpdateDetails({
      repoId: 'repo',
      beforeRevision: 'rev1',
      afterRevision: 'rev2',
      beforeStatus: '',
      afterStatus: '',
      summaryError: null,
      summary: {
        kind: 'updated',
        commitCount: 1,
        fileCount: 1,
        containsMerge: false,
        detail: {
          commits: [testCommit],
          files: [{ path: 'updated-file.ts', status: 'M', added: 1, removed: 0 }],
        },
      },
    });

    expect(useAppStore.getState().historyQuery.path).toBeNull();
    expect(useAppStore.getState().mode).toBe('commit-detail');

    await vi.waitFor(() => {
      expect(useAppStore.getState().history).toEqual([fullCommit]);
    });

    useAppStore.getState().backToHistory();
    expect(useAppStore.getState().mode).toBe('history');
    expect(useAppStore.getState().historyQuery.path).toBeNull();
    expect(useAppStore.getState().history).toEqual([fullCommit]);
  });



  it('does not let an older workspace response replace the newest workspace', async () => {
    const first = deferred<WorkspaceSnapshot>();
    const second = deferred<WorkspaceSnapshot>();
    const bridge = new MockBridge((command) => {
      if (command.type === 'workspaceOpen') return command.payload.paths[0] === '/tmp/first' ? first.promise : second.promise;
      if (command.type === 'conflicts') return [];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap });
    const firstOpen = useAppStore.getState().openWorkspace(['/tmp/first']);
    const secondOpen = useAppStore.getState().openWorkspace(['/tmp/second']);
    second.resolve(snapshot('second', 2));
    await secondOpen;
    first.resolve(snapshot('first', 1));
    await firstOpen;
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('second');
  });

  it('waits for conflict versions before opening the merge workspace', async () => {
    const versions = deferred<{ path: string; base: string; ours: string; theirs: string; working: string; language: string; fingerprint: string; binary: boolean }>();
    const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'conflictVersions') return versions.promise;
      return [];
    });
    const conflict: ConflictFile = { repoId: 'repo', repoName: 'Repo', repoColor: '#000', path: 'conflict.txt', kind: 'git', binary: false };
    useAppStore.setState({ bridge, bootstrap, snapshot: snapshot('workspace', 1) });
    const opening = useAppStore.getState().openMerge(conflict);
    expect(useAppStore.getState().mode).toBe('history');
    versions.resolve({ path: conflict.path, base: 'base', ours: 'ours', theirs: 'theirs', working: 'working', language: 'text', fingerprint: 'fingerprint', binary: false });
    await opening;
    expect(commands[0]).toEqual({ type: 'conflictVersions', payload: { workspace_id: 'workspace', repo_id: 'repo', relative_path: 'conflict.txt' } });
    expect(useAppStore.getState()).toMatchObject({ mode: 'merge', mergeResult: 'working' });
  });

  it('refreshes watcher changes silently without visible operations or resetting the active workspace mode', async () => {
    const response = deferred<WorkspaceSnapshot>();
    const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
    const bridge = new MockBridge((command, options) => {
      requests.push({ command, options });
      if (command.type === 'workspaceRefresh') return response.promise;
      if (command.type === 'conflicts') return [];
      return [];
    });
    const current = snapshot('workspace', 1);
    useAppStore.setState({ bridge, bootstrap, snapshot: current, mode: 'diff', });
    const refreshing = useAppStore.getState().refresh(true);
    response.resolve(snapshot('workspace', 2));
    await refreshing;
    expect(useAppStore.getState()).toMatchObject({ mode: 'diff', });
    expect(requests.find(({ command }) => command.type === 'workspaceRefresh')?.options?.showProgress).toBe(false);
    expect(requests.find(({ command }) => command.type === 'conflicts')?.options?.showProgress).toBe(false);
  });

  it('keeps first history load inside the history view without a native progress notification', async () => {
    const current = snapshot('first-history-load', 1);
    current.repositories = [repository('repo', 'Repository')];
    const loading = deferred<{ commits: CommitNode[]; hasMore: boolean }>();
    const requestOptions: RequestOptions[] = [];
    const bridge = new MockBridge((command, options) => {
      if (command.type === 'history') { requestOptions.push(options ?? {}); return loading.promise; }
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: current, allRepositories: current.repositories });
    const pending = useAppStore.getState().loadHistory(true);
    expect(useAppStore.getState().historyLoading).toBe(true);
    expect(requestOptions[0].showProgress).toBe(false);
    loading.resolve({ commits: [], hasMore: false });
    await pending;
    expect(useAppStore.getState().historyLoading).toBe(false);
    expect(useAppStore.getState().notifications).toHaveLength(0);
  });

  it('keeps silent history refresh out of loading state and native progress', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
    const bridge = new MockBridge((command, options) => {
      requests.push({ command, options });
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'historyTopology') return [];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'repo', historyLoading: false });

    await useAppStore.getState().loadHistory(true, true);

    expect(useAppStore.getState().historyLoading).toBe(false);
    expect(requests.filter(({ command }) => command.type === 'history' || command.type === 'historyTopology'))
      .toHaveLength(2);
    expect(requests.filter(({ command }) => command.type === 'history' || command.type === 'historyTopology')
      .every(({ options }) => options?.showProgress === false)).toBe(true);
  });

  it('keeps the active view stable when creating a stash in the running workspace', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
    const bridge = new MockBridge((command, options) => {
      requests.push({ command, options });
      if (command.type === 'workspaceRefresh') return { ...workspace, generation: 2 };
      if (command.type === 'stashes' || command.type === 'conflicts') return [];
      return true;
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, allRepositories: workspace.repositories, selectedRepoId: 'repo', mode: 'diff' });

    await useAppStore.getState().stashOperation('repo', { type: 'create', message: 'WIP', paths: ['src/file.ts'], include_untracked: true });

    expect(useAppStore.getState().mode).toBe('diff');
    expect(requests.some(({ command }) => command.type === 'workspaceRefresh')).toBe(false);
  });

  it('loads branch-to-working-tree differences without changing the commit-panel tab', async () => {
    const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'branchWorkingDiff') return { path: '/tmp/repo', baseRef: command.payload.base_ref, currentRef: 'main', files: [{ path: 'src/file.ts', status: 'M', added: 1, removed: 1 }] };
      return [];
    });
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    useAppStore.setState({ bridge, bootstrap: { ...bootstrap, state: { ...bootstrap.state, activeTab: 'stash' } }, snapshot: workspace, selectedRepoId: 'repo' });

    await useAppStore.getState().loadBranchWorkingDiff('repo', 'refs/remotes/origin/feature');

    expect(commands[0]).toEqual({ type: 'branchWorkingDiff', payload: { workspace_id: 'workspace', repo_id: 'repo', base_ref: 'refs/remotes/origin/feature' } });
    expect(useAppStore.getState().bootstrap?.state.activeTab).toBe('stash');
    expect(useAppStore.getState().worktreeDiff).toMatchObject({ repoId: 'repo', source: 'repository', currentRef: 'main' });
  });

  it('rejects an old search response as soon as the search condition changes', async () => {
    const pending = deferred<HistoryPage>();
    const workspace = snapshot('search-race', 1);
    workspace.repositories = [repository('a', 'Alpha')];
    const bridge = new MockBridge((command) => command.type === 'history' ? pending.promise : []);
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, history: [], historyFilter: '' });
    const request = useAppStore.getState().loadHistory(true);
    useAppStore.getState().setHistoryFilter('new search');
    pending.resolve({ commits: [{ repoId: 'a', hash: 'old', shortHash: 'old', parents: [], author: 'Ada', email: '', authorDate: '', committerDate: '', message: 'stale', refs: [] }], hasMore: false });
    await request;
    expect(useAppStore.getState().history).toEqual([]);
    expect(useAppStore.getState().historyLoading).toBe(false);
    expect(useAppStore.getState().historyQuery.text).toBe('new search');
  });

  it('aggregates history from every repository without losing repository scope', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('a', 'Alpha'), repository('b', 'Beta')];
    const bridge = new MockBridge((command) => {
      if (command.type === 'history') return { commits: [{ repoId: command.payload.repo_id, hash: command.payload.repo_id, shortHash: command.payload.repo_id, parents: [], author: 'Ada', email: '', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: command.payload.repo_id, refs: [] }], hasMore: false };
      if (command.type === 'historyTopology') return [{ repoId: command.payload.repo_id, hash: `${command.payload.repo_id}-root`, parents: [], committerDate: '2025-01-01T00:00:00Z', refs: [] }];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'a' });
    await useAppStore.getState().loadHistory(true);
    expect(useAppStore.getState().history.map((commit) => commit.repoId).sort()).toEqual(['a', 'b']);
    expect(Object.keys(useAppStore.getState().historyByRepo)).toEqual(['a', 'b']);
    expect(useAppStore.getState().historyTopology.map((commit) => commit.repoId).sort()).toEqual(['a', 'b']);
  });

  it('applies the 100-commit page boundary after interleaving repositories', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('a', 'Alpha'), repository('b', 'Beta')];
    const make = (repoId: string, index: number): CommitNode => ({
      repoId, hash: `${repoId}-${index}`, shortHash: `${repoId}-${index}`, parents: [], author: 'Ada', email: '',
      authorDate: new Date(Date.UTC(2026, 0, 1, 0, 0, 200 - index * 2 - (repoId === 'b' ? 1 : 0))).toISOString(),
      committerDate: new Date(Date.UTC(2026, 0, 1, 0, 0, 200 - index * 2 - (repoId === 'b' ? 1 : 0))).toISOString(),
      message: `${repoId}-${index}`, refs: [],
    });
    const histories = { a: Array.from({ length: 80 }, (_, index) => make('a', index)), b: Array.from({ length: 80 }, (_, index) => make('b', index)) };
    const limits: number[] = [];
    const bridge = new MockBridge((command) => {
      if (command.type === 'history') {
        limits.push(command.payload.limit);
        const commits = histories[command.payload.repo_id as keyof typeof histories].slice(0, command.payload.limit);
        return { commits, hasMore: commits.length < histories[command.payload.repo_id as keyof typeof histories].length };
      }
      if (command.type === 'historyTopology') return [];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'a' });
    await useAppStore.getState().loadHistory(true);
    expect(limits).toEqual([100, 100]);
    expect(useAppStore.getState().history).toHaveLength(100);
    expect(useAppStore.getState().historyHasMore).toBe(true);
    await useAppStore.getState().loadHistory(false);
    expect(limits).toEqual([100, 100, 200, 200]);
    expect(useAppStore.getState().history).toHaveLength(160);
  });

  it('selects the first history commit and loads its detail when opening a repository', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    const commit: CommitNode = { repoId: 'repo', hash: 'first', shortHash: 'first', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'first commit', refs: [] };
    const detail: CommitDetail = { commit, fullMessage: commit.message, branches: { local: ['main'], remote: [], tags: [] }, files: [{ path: 'README.md', status: 'M', added: 1, removed: 0 }] };
    const bridge = new MockBridge((command) => {
      if (command.type === 'history') return { commits: [commit], hasMore: false };
      if (command.type === 'commitDetail') return detail;
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace });

    await useAppStore.getState().selectRepo('repo', true);

    expect(useAppStore.getState().selectedCommits).toEqual([commit]);
    expect(useAppStore.getState().selectedCommit).toEqual(detail);
  });

  it.each(['git', 'svn'] as const)('keeps %s reference queries silent and preserves old data when the bridge rejects', async (kind) => {
    const workspace = snapshot('svn-reference-parity', 1);
    const svn = repository('svn', 'Reference Repository'); svn.meta.kind = kind;
    workspace.repositories = [svn];
    const branch = { name: 'release', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0, detachedTag: null, detachedHash: null, lastCommitMessage: null, lastCommitDate: null };
    const tag = { name: 'v1', hash: 'r1', date: '' };
    const bridge = new MockBridge((command) => {
      if (command.type === 'branches' || command.type === 'tags') throw new BridgeError({ code: 'SVN_AUTHORIZATION_FAILED', message: 'Authorization failed', command: 'svn', exitCode: 1, stderr: null, recoverable: true });
      if (command.type === 'history') return { commits: [], hasMore: false };
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, notifications: [], selectedRepoId: 'svn', branchesByRepo: { svn: [branch] }, tagsByRepo: { svn: [tag] } });
    await useAppStore.getState().selectRepo('svn', true);
    expect(useAppStore.getState().branchesByRepo.svn).toEqual([branch]);
    expect(useAppStore.getState().tagsByRepo.svn).toEqual([tag]);
    expect(useAppStore.getState().notifications).toEqual([]);
  });

  it.each(['git', 'svn'] as const)('does not publish %s branch or tag notifications during background refresh', async (kind) => {
    vi.useFakeTimers();
    try {
      let subscriber: ((event: BridgeEvent) => void) | undefined;
      const commands: BridgeCommand[] = [];
      const bridge = new MockBridge((command) => {
        commands.push(command);
        if (command.type === 'bootstrap') return bootstrap;
        if (command.type === 'repositoryStatus') {
          const svn = repository('svn', 'Reference Repository'); svn.meta.kind = kind; return svn;
        }
        if (command.type === 'branches' || command.type === 'tags') throw new BridgeError({ code: 'SVN_AUTHORIZATION_FAILED', message: 'Authorization failed', command: 'svn', exitCode: 1, stderr: null, recoverable: true });
        if (command.type === 'history') return { commits: [], hasMore: false };
        return [];
      });
      bridge.subscribe = (handler) => { subscriber = handler; return () => undefined; };
      await useAppStore.getState().initialize(bridge);
      const current = snapshot('svn-background-parity', 1);
      const svn = repository('svn', 'Reference Repository'); svn.meta.kind = kind;
      current.repositories = [svn];
      useAppStore.setState({ snapshot: current, allRepositories: [svn], selectedRepoId: 'svn', notifications: [], historyByRepo: { svn: [] }, historyTopologyByRepo: { svn: [] }, historyScope: { repoIds: null, revisionsByRepo: {} } });
      subscriber?.({ workspaceId: current.workspace.id, repoId: 'svn', generation: 1, source: 'watcher', scopes: ['refs', 'history'] });
      await vi.advanceTimersByTimeAsync(301);
      expect(commands.some((command) => command.type === 'branches')).toBe(true);
      expect(commands.some((command) => command.type === 'tags')).toBe(true);
      expect(useAppStore.getState().notifications).toEqual([]);
    } finally { useAppStore.getState().dispose(); vi.useRealTimers(); }
  });

  it('interleaves repository heads without breaking each repository order', () => {
    const make = (repoId: string, hash: string, date: string): CommitNode => ({
      repoId, hash, shortHash: hash, parents: [], author: 'Ada', email: '', authorDate: date, committerDate: date, message: hash, refs: [],
    });
    const result = interleaveHistory({
      a: [make('a', 'a-new', '2026-01-01T10:00:00Z'), make('a', 'a-old', '2026-01-01T08:00:00Z')],
      b: [make('b', 'b-new', '2026-01-01T09:00:00Z'), make('b', 'b-old', '2026-01-01T07:00:00Z')],
    });
    expect(result.map((commit) => commit.hash)).toEqual(['a-new', 'b-new', 'a-old', 'b-old']);
  });

  it('uses a stable JetBrains-compatible tie break for equal commit timestamps', () => {
    const make = (repoId: string, hash: string): CommitNode => ({
      repoId, hash, shortHash: hash, parents: [], author: 'Ada', email: '', authorDate: '2026-01-01T10:00:00Z', committerDate: '2026-01-01T10:00:00Z', message: hash, refs: [],
    });
    const historyByRepo = { a: [make('a', 'aaaaaaaa')], b: [make('b', 'bbbbbbbb')] };
    expect(interleaveHistory(historyByRepo).map((commit) => commit.hash)).toEqual(
      interleaveHistory({ b: historyByRepo.b, a: historyByRepo.a }).map((commit) => commit.hash),
    );
  });

  it('loads a branch revision from the backend so its ancestor chain stays connected', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('a', 'Alpha'), repository('b', 'Beta')];
    const commands: BridgeCommand[] = [];
    const commits: CommitNode[] = [
      { repoId: 'a', hash: 'feature', shortHash: 'feature', parents: ['root'], author: 'Ada', email: '', authorDate: '2026-01-02T00:00:00Z', committerDate: '2026-01-02T00:00:00Z', message: 'feature', refs: ['refs/heads/feature/x'] },
      { repoId: 'a', hash: 'root', shortHash: 'root', parents: [], author: 'Ada', email: '', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'root', refs: [] },
    ];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'history') return { commits, hasMore: false };
      if (command.type === 'historyTopology') return commits.map(({ repoId, hash, parents, committerDate, refs }) => ({ repoId, hash, parents, committerDate, refs }));
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'a', historyScope: { repoIds: ['a'], revisionsByRepo: { a: 'refs/heads/feature/x' } } });
    await useAppStore.getState().loadHistory(true);
    expect(commands.find((command) => command.type === 'history')).toMatchObject({ type: 'history', payload: { repo_id: 'a', query: { revision: 'refs/heads/feature/x' } } });
    expect(commands.some((command) => command.type === 'history' && command.payload.repo_id === 'b')).toBe(false);
    expect(useAppStore.getState().history.map((commit) => commit.hash)).toEqual(['feature', 'root']);
  });

  it('loads branch and tag refs for SVN repositories as well as Git', async () => {
    const svn = { ...repository('svn', 'SVN'), meta: { ...repository('svn', 'SVN').meta, kind: 'svn' as const } };
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [svn];
    const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'branches') return [{ name: 'trunk', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }];
      if (command.type === 'tags') return [{ name: 'v1.0.0', hash: 'r4', date: '' }];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'svn' });
    await useAppStore.getState().selectRepo('svn', true);
    expect(commands.some((command) => command.type === 'branches' && command.payload.repo_id === 'svn')).toBe(true);
    expect(commands.some((command) => command.type === 'tags' && command.payload.repo_id === 'svn')).toBe(true);
    expect(useAppStore.getState().branchesByRepo.svn[0].name).toBe('trunk');
    expect(useAppStore.getState().tagsByRepo.svn[0].hash).toBe('r4');
  });

  it('uses a repository-scoped subtree command without cwd and refreshes registered entries', async () => {
    const commands: BridgeCommand[] = [];
    const entries: SubtreeEntry[] = [{ id: 'entry', prefix: 'vendor/api', remote: 'origin', branch: 'main', squash: true, state: 'active' }];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'subtrees') return entries;
      if (command.type === 'workspaceRefresh') return snapshot('workspace', 2);
      if (command.type === 'conflicts') return [];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: snapshot('workspace', 1), selectedRepoId: 'repo' });
    await useAppStore.getState().subtreeOperation('repo', { type: 'pull', subtree_id: 'entry' });
    expect(commands[0]).toEqual({ type: 'subtreeOperation', payload: { workspace_id: 'workspace', repo_id: 'repo', operation: { type: 'pull', subtree_id: 'entry' } } });
    expect(commands[0]).not.toHaveProperty('cwd');
    expect(useAppStore.getState().subtrees.repo).toEqual(entries);
  });

  it('manages multiple workspace tabs with session state isolation, switching, and closing', async () => {
    const ws1 = snapshot('ws-1', 1);
    ws1.repositories = [repository('repo-1', 'Project 1')];
    const ws2 = snapshot('ws-2', 1);
    ws2.repositories = [repository('repo-2', 'Project 2')];

    const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'workspaceOpen') {
        return command.payload.paths[0] === '/tmp/ws-1' ? ws1 : ws2;
      }
      if (command.type === 'workspaceRefresh') {
        return command.payload.workspace_id === 'ws-1' ? ws1 : ws2;
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'branches') return [];
      if (command.type === 'tags') return [];
      if (command.type === 'conflicts') return [];
      return [];
    });

    useAppStore.setState({ bridge, bootstrap });

    // 1. 打开第一个工作区
    await useAppStore.getState().openWorkspace(['/tmp/ws-1']);
    expect(useAppStore.getState().tabs.length).toBe(1);
    expect(useAppStore.getState().activeTabId).toBe('ws-1');
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('ws-1');

    // 修改第一个工作区的状态（如历史筛选器）
    useAppStore.getState().setHistoryFilter('filter-1');
    expect(useAppStore.getState().historyFilter).toBe('filter-1');

    // 2. 打开第二个工作区
    await useAppStore.getState().openWorkspace(['/tmp/ws-2']);
    expect(useAppStore.getState().tabs.length).toBe(2);
    expect(useAppStore.getState().activeTabId).toBe('ws-2');
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('ws-2');
    expect(useAppStore.getState().historyFilter).toBe('');

    // 3. 再次尝试打开 ws-1 路径，应该直接聚焦并恢复状态而不会产生重复 Tab
    await useAppStore.getState().openWorkspace(['/tmp/ws-1']);
    expect(useAppStore.getState().tabs.length).toBe(2);
    expect(useAppStore.getState().activeTabId).toBe('ws-1');
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('ws-1');
    expect(useAppStore.getState().historyFilter).toBe('filter-1');

    // 4. 测试 reorderTabs
    useAppStore.getState().reorderTabs(0, 1);
    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(['ws-2', 'ws-1']);

    // 5. 关闭当前激活的 ws-1 标签页，应自动切换激活剩余的 ws-2
    await useAppStore.getState().closeTab('ws-1');
    expect(useAppStore.getState().tabs.length).toBe(1);
    expect(useAppStore.getState().activeTabId).toBe('ws-2');
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('ws-2');

    // 6. 关闭最后一个标签页，应清空工作区回到欢迎页
    await useAppStore.getState().closeTab('ws-2');
    expect(useAppStore.getState().tabs.length).toBe(0);
    expect(useAppStore.getState().activeTabId).toBeNull();
    expect(useAppStore.getState().snapshot).toBeUndefined();
  });

  it('opens to the welcome chooser without restoring previous workspace tabs on startup', async () => {
    const savedWorkspace = snapshot('saved', 1).workspace;
    const secondarySyncs: Array<{ paths: string[][]; activeId: string | null }> = [];
    class StartupBridge extends MockBridge {
      override async syncWindowTabs(paths: string[][], activeId: string | null): Promise<void> {
        secondarySyncs.push({ paths, activeId });
      }
    }
    const bridge = new StartupBridge(() => []);
    useAppStore.setState({
      bridge,
      bootstrap: {
        ...bootstrap,
        state: {
          ...bootstrap.state,
          recentWorkspaces: [savedWorkspace],
          openWorkspaceIds: [savedWorkspace.id],
          activeWorkspaceId: savedWorkspace.id,
        },
      },
    });

    await useAppStore.getState().restoreTabsOnStartup();

    expect(useAppStore.getState().tabs).toEqual([]);
    expect(useAppStore.getState().snapshot).toBeUndefined();
    expect(secondarySyncs).toEqual([{ paths: [], activeId: null }]);
  });

  it('can force an explicit new window to open a workspace already registered elsewhere', async () => {
    const target = snapshot('forced', 1);
    let crossWindowFocusCalls = 0;
    class ExplicitWindowBridge extends MockBridge {
      override async focusWorkspaceAcrossWindows(): Promise<boolean> {
        crossWindowFocusCalls += 1;
        return true;
      }
    }
    const bridge = new ExplicitWindowBridge((command) => command.type === 'workspaceOpen' ? target : []);
    useAppStore.setState({ bridge, bootstrap });

    const opened = await useAppStore.getState().openWorkspace(target.workspace.paths, true, { skipCrossWindowFocus: true });

    expect(opened).toBe(true);
    expect(crossWindowFocusCalls).toBe(0);
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(['forced']);
  });

  it('does not throw or set error when refreshing with no open workspace', async () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({ bridge, bootstrap, snapshot: undefined, notifications: [] });

    await expect(useAppStore.getState().refresh(true)).resolves.toBeUndefined();
    await expect(useAppStore.getState().refresh(false)).resolves.toBeUndefined();

    expect(useAppStore.getState().notifications).toHaveLength(0);
  });

  it('ignores background watcher events and cleans startup errors when no workspace is open', async () => {
    let subscriber: ((event: BridgeEvent) => void) | undefined;
    const bridge = new MockBridge((command) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          state: {
            ...bootstrap.state,
            openWorkspaceIds: [],
            activeWorkspaceId: null,
            lastWorkspaceId: null,
          },
        };
      }
      return [];
    });
    bridge.subscribe = (handler) => {
      subscriber = handler;
      return () => undefined;
    };

    await useAppStore.getState().initialize(bridge);

    expect(useAppStore.getState().snapshot).toBeUndefined();
    expect(useAppStore.getState().notifications).toHaveLength(0);

    // 发送其他工作区的事件，不应触发错误
    subscriber?.({
      workspaceId: 'other-workspace',
      repoId: 'repo',
      generation: 1,
      source: 'watcher',
      scopes: ['status'],
    });
    expect(useAppStore.getState().notifications).toHaveLength(0);
  });

  it('keeps watcher status requests and their operation events in the background', async () => {
    vi.useFakeTimers();
    try {
      let subscriber: ((event: BridgeEvent) => void) | undefined;
      const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
      const updated = { ...repository('repo', 'Repository'), revision: 'updated' };
      const bridge = new MockBridge((command, options) => {
        requests.push({ command, options });
        if (command.type === 'bootstrap') return { ...bootstrap, state: { ...bootstrap.state, openWorkspaceIds: [], activeWorkspaceId: null, lastWorkspaceId: null } };
        if (command.type === 'repositoryStatus') return updated;
        return [];
      });
      bridge.subscribe = (handler) => {
        subscriber = handler;
        return () => undefined;
      };
      await useAppStore.getState().initialize(bridge);
      const current = snapshot('workspace', 1);
      current.repositories = [repository('repo', 'Repository')];
      useAppStore.setState({ snapshot: current, allRepositories: current.repositories, selectedRepoId: 'repo', mode: 'diff' });

      subscriber?.({
        operationId: 'background-status',
        context: { generation: 1, domain: 'status', visibility: 'background', workspaceId: 'workspace', repositoryId: 'repo', target: null },
        status: 'running', phase: 'status', message: '', startedAt: '', cancellable: true, completed: null, total: null, result: null, error: null,
      });
      subscriber?.({ workspaceId: 'workspace', repoId: 'repo', generation: 1, source: 'watcher', scopes: ['status'] });
      await vi.advanceTimersByTimeAsync(301);

      expect(useAppStore.getState().operations).not.toHaveProperty('background-status');
      expect(useAppStore.getState().mode).toBe('diff');
      expect(useAppStore.getState().snapshot?.repositories[0].revision).toBe('updated');
      expect(requests.find(({ command }) => command.type === 'repositoryStatus')?.options?.showProgress).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes history, unpushed commits, and conflicts only for the event repository', async () => {
    vi.useFakeTimers();
    try {
      let subscriber: ((event: BridgeEvent) => void) | undefined;
      const requests: BridgeCommand[] = [];
      const commit: CommitNode = {
        repoId: 'a', hash: 'new-a', shortHash: 'new-a', parents: [], author: 'A', email: '',
        authorDate: '2026-08-30T00:00:00Z', committerDate: '2026-08-30T00:00:00Z',
        message: 'updated A', refs: [], incoming: false, unpushed: true,
      };
      const bridge = new MockBridge((command) => {
        requests.push(command);
        if (command.type === 'bootstrap') return bootstrap;
        if (command.type === 'repositoryStatus') return repository('a', 'A');
        if (command.type === 'branches' || command.type === 'tags' || command.type === 'historyTopology' || command.type === 'unpushedCommits') return [];
        if (command.type === 'history') return { commits: [commit], hasMore: false };
        if (command.type === 'conflicts') return [{ repoId: 'a', repoName: 'A', repoColor: '#000', path: 'conflict.txt', kind: 'git', binary: false, conflictType: 'text', actions: ['mine'] }];
        return [];
      });
      bridge.subscribe = (handler) => { subscriber = handler; return () => undefined; };
      await useAppStore.getState().initialize(bridge);
      const current = snapshot('workspace', 1);
      current.repositories = [repository('a', 'A'), repository('b', 'B')];
      useAppStore.setState({
        snapshot: current,
        allRepositories: current.repositories,
        selectedRepoId: 'a',
        historyByRepo: { a: [], b: [] },
        historyTopologyByRepo: { a: [], b: [] },
        historyScope: { repoIds: null, revisionsByRepo: {} },
      });
      requests.length = 0;

      subscriber?.({ workspaceId: 'workspace', repoId: 'a', generation: 1, source: 'watcher', scopes: ['refs', 'history', 'conflicts'] });
      await vi.advanceTimersByTimeAsync(301);
      await Promise.resolve();
      await Promise.resolve();

      expect(requests.filter((command) => command.type === 'history').map((command) => command.payload.repo_id)).toEqual(['a']);
      expect(requests.some((command) => command.type === 'unpushedCommits' && command.payload.repo_id === 'a')).toBe(true);
      expect(requests.some((command) => command.type === 'conflicts' && command.payload.repo_id === 'a')).toBe(true);
      expect(useAppStore.getState().historyByRepo.a?.[0]?.hash).toBe('new-a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes runtime capabilities without replacing workspace state', async () => {
    const bridge = new MockBridge((command) => command.type === 'runtimeCapabilities' ? {
      systemNotifications: { available: false, reasonCode: 'NOTIFICATION_PERMISSION_DENIED', detail: 'Denied' },
      notificationPermission: 'denied',
      secureCredentials: { status: { available: true, reasonCode: null, detail: null }, backend: 'test', passwordStdinSupported: true },
    } : []);
    const currentSnapshot = snapshot('workspace', 1);
    useAppStore.setState({ bridge, bootstrap, snapshot: currentSnapshot });

    await useAppStore.getState().refreshRuntimeCapabilities();

    expect(useAppStore.getState().snapshot).toBe(currentSnapshot);
    expect(useAppStore.getState().bootstrap?.runtime?.notificationPermission).toBe('denied');
    expect(useAppStore.getState().bootstrap?.capabilities.systemNotifications).toBe(false);
  });

  it('sends every history condition to the backend and clears only the file history condition', async () => {
    const requests: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      requests.push(command);
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'historyTopology') return [];
      return [];
    });
    const current = snapshot('workspace', 1);
    current.repositories = [repository('a', 'A'), repository('b', 'B')];
    useAppStore.setState({ bridge, bootstrap, snapshot: current, selectedRepoId: 'a', historyScope: { repoIds: ['a'], revisionsByRepo: { a: 'refs/heads/main' } } });
    useAppStore.getState().setHistoryQuery({ text: 'needle', author: 'Ada', fromDate: '2026-01-01', toDate: '2026-01-31', path: null, revision: null });
    await useAppStore.getState().openHistoryForPath('b', 'src/file.ts');
    expect(requests.find((command) => command.type === 'history')).toMatchObject({ type: 'history', payload: { repo_id: 'b', query: { text: 'needle', author: 'Ada', fromDate: '2026-01-01', toDate: '2026-01-31', path: 'src/file.ts' } } });
    await useAppStore.getState().clearHistoryPath();
    expect(useAppStore.getState().historyScope).toEqual({ repoIds: ['b'], revisionsByRepo: {} });
    expect(useAppStore.getState().historyQuery).toMatchObject({ path: null, author: 'Ada', text: 'needle' });
  });
  it('keeps per-repository facts when Update Project partially fails', async () => {
    const current = snapshot('workspace', 1); current.repositories = [repository('a', 'A'), repository('b', 'B')];
    const bridge = new MockBridge((command) => {
      if (command.type === 'sync' && command.payload.repo_id === 'b') throw new Error('offline');
      if (command.type === 'sync') return { output: '', update: { repoId: 'a', beforeRevision: '1', afterRevision: '2', beforeStatus: 'x', afterStatus: 'x', summary: { kind: 'fastForward', commitCount: 1, fileCount: 2, containsMerge: false, detail: { commits: [], files: [] } }, summaryError: null } };
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: current, allRepositories: current.repositories });
    await useAppStore.getState().updateProject('merge');
    const notification = useAppStore.getState().notifications.find((item) => item.actions.some((action) => action.type === 'viewUpdateResults'));
    expect(notification).toBeDefined();
    expect(notification?.details).toContain('B: offline');
    const action = notification?.actions.find((item) => item.type === 'viewUpdateResults');
    expect(action).toMatchObject({ type: 'viewUpdateResults', results: [expect.objectContaining({ repoId: 'a' })] });
  });

  it('creates progress notification during Update Project, reports each repo progress, and dismisses progress toast when complete', async () => {
    const current = snapshot('progress-ws', 1);
    current.repositories = [repository('repo-1', 'Repo 1'), repository('repo-2', 'Repo 2')];

    const capturedProgressMessages: unknown[] = [];
    const unsubscribe = useAppStore.subscribe((state) => {
      const progressNotif = state.notifications.find((n) => n.title === 'Updating Project');
      if (progressNotif) {
        capturedProgressMessages.push(progressNotif.progressMessage);
      }
    });

    const bridge = new MockBridge((command) => {
      if (command.type === 'sync') {
        return {
          output: '',
          update: {
            repoId: command.payload.repo_id,
            beforeRevision: '1',
            afterRevision: '2',
            beforeStatus: 'x',
            afterStatus: 'x',
            summary: { kind: 'fastForward', commitCount: 1, fileCount: 2, containsMerge: false, detail: { commits: [], files: [] } },
            summaryError: null,
          },
        };
      }
      return [];
    });

    useAppStore.setState({ bridge, bootstrap, snapshot: current, allRepositories: current.repositories, notifications: [], toastNotificationIds: [] });
    try {
      await useAppStore.getState().updateProject('merge');
    } finally {
      unsubscribe();
    }

    // 验证过程中成功上报并更新了进度
    expect(capturedProgressMessages).toContainEqual({
      key: '({0}/{1}) {2}',
      args: [1, 2, expect.any(String)],
    });

    // 验证更新全部完成后，临时进度通知已从列表中自动清理
    const progressNotif = useAppStore.getState().notifications.find((n) => n.title === 'Updating Project');
    expect(progressNotif).toBeUndefined();

    // 验证最终产生了汇总结果通知
    const summaryNotif = useAppStore.getState().notifications.find((n) => n.actions.some((a) => a.type === 'viewUpdateResults'));
    expect(summaryNotif).toBeDefined();
  });

  it('sends the selected branch and rebase strategy to the sync backend', async () => {
    const requests: BridgeCommand[] = [];
    const current = snapshot('workspace', 1);
    const bridge = new MockBridge((command) => {
      requests.push(command);
      if (command.type === 'sync') return { output: 'pulled', update: null };
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: current, allRepositories: current.repositories, selectedRepoId: 'repo' });
    await useAppStore.getState().sync('repo', 'pullRebase', false, { remote: 'origin', branch: 'origin/main' });
    expect(requests.find((command) => command.type === 'sync')).toMatchObject({
      type: 'sync',
      payload: { repo_id: 'repo', action: 'pullRebase', remote: 'origin', branch: 'origin/main' },
    });
  });

  it('uses the selected Update Project strategy for every Git repository', async () => {
    const requests: BridgeCommand[] = [];
    const current = snapshot('workspace', 1);
    current.repositories = [repository('a', 'A'), repository('b', 'B')];
    const bridge = new MockBridge((command) => {
      requests.push(command);
      if (command.type === 'sync') return { output: '', update: { repoId: command.payload.repo_id, beforeRevision: '1', afterRevision: '1', beforeStatus: '', afterStatus: '', summary: { kind: 'noChanges', commitCount: 0, fileCount: 0, containsMerge: false, detail: { commits: [], files: [] } }, summaryError: null } };
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: current, allRepositories: current.repositories });
    await useAppStore.getState().updateProject('rebase');
    expect(requests.filter((command) => command.type === 'sync')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ repo_id: 'a', action: 'pullRebase' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ repo_id: 'b', action: 'pullRebase' }) }),
    ]);
  });

  it('opens conflicts and preserves recovery guidance when pull auto-stash restoration conflicts', async () => {
    const current = snapshot('workspace', 1);
    current.repositories = [{ ...repository('a', 'A'), conflicts: 1 }];
    const stashHash = 'abcdef1234567890';
    const bridge = new MockBridge((command) => {
      if (command.type === 'sync') throw new BridgeError({
        code: 'GIT_AUTO_STASH_CONFLICT',
        message: 'Update completed, but local changes conflicted. The stash was kept.',
        command: 'git',
        exitCode: 1,
        stderr: 'conflict',
        recoverable: true,
        repositoryId: 'a',
        subject: `stash:${stashHash}`,
      });
      if (command.type === 'workspaceRefresh') return current;
      if (command.type === 'stashes') return [{ reference: 'stash@{0}', hash: stashHash, branch: 'main', message: 'auto', fullMessage: 'auto', date: '', files: [] }];
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'historyTopology') return [];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: current, allRepositories: current.repositories, selectedRepoId: 'a' });

    await useAppStore.getState().sync('a', 'pull');

    const notification = useAppStore.getState().notifications.find((item) => item.title === 'Restoring local changes needs attention');
    expect(notification?.actions.map((action) => action.type)).toEqual(['openConflicts']);
    expect(useAppStore.getState().bootstrap?.state.layout?.activeTab).toBe('changes');
    expect(useAppStore.getState().notifications.filter((item) => item.title === 'Sync failed')).toHaveLength(0);

    current.generation = 2;
    current.repositories = [{ ...repository('a', 'A'), conflicts: 0 }];
    await useAppStore.getState().refresh(true);
    expect(useAppStore.getState().snapshot?.repositories[0]?.conflicts).toBe(0);
    expect(useAppStore.getState().stashes.a?.[0]?.hash).toBe(stashHash);
    const cleanupNotification = useAppStore.getState().notifications.find((item) => item.title === 'Automatic stash recovery completed');
    expect(cleanupNotification?.actions.map((action) => action.type)).toEqual(['dropAutoStash', 'keepAutoStash']);
  });

  it('persists commit selections per workspace and leaves new files unselected', async () => {
    vi.useFakeTimers();
    try {
      const requests: BridgeCommand[] = [];
      const bridge = new MockBridge((command) => { requests.push(command); return command.type === 'saveCommitSelections' ? command.payload.selections : []; });
      const current = snapshot('workspace', 1);
      current.repositories = [{ ...repository('a', 'A'), files: [{ path: 'kept.ts', status: 'modified', staged: false, unstaged: true, conflicted: false }, { path: 'new.ts', status: 'untracked', staged: false, unstaged: true, conflicted: false }] }];
      useAppStore.setState({ bridge, snapshot: current, allRepositories: current.repositories, commitSelections: { a: ['kept.ts'] } });
      useAppStore.getState().setCommitSelection('a', ['new.ts'], true);
      useAppStore.getState().setCommitSelection('a', ['new.ts'], false);
      await vi.advanceTimersByTimeAsync(121);
      expect(useAppStore.getState().commitSelections).toEqual({ a: ['kept.ts'] });
      expect(requests.find((command) => command.type === 'saveCommitSelections')).toMatchObject({ payload: { workspace_id: 'workspace', selections: [{ repoId: 'a', paths: ['kept.ts'] }] } });
    } finally { vi.useRealTimers(); }
  });

  it('reports newly detected untracked files non-modally outside simplified view', async () => {
    const previous = snapshot('workspace', 1);
    previous.repositories = [repository('a', 'A')];
    const next = snapshot('workspace', 2);
    next.repositories = [{ ...repository('a', 'A'), files: [{ path: 'new.ts', status: 'untracked', staged: false, unstaged: true, conflicted: false }] }];
    const requests: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      requests.push(command);
      if (command.type === 'workspaceRefresh') return next;
      return [];
    });
    const configured: BootstrapData = {
      ...bootstrap,
      state: {
        ...bootstrap.state,
        settings: {
          theme: 'system', language: 'system', uiFontSize: 'standard', changesDisplayMode: 'changelists', defaultCommitAction: 'commit', defaultSaveAction: 'stash',
          promptBeforeAddingUntracked: true, suppressDivergedWarning: false, autoRefreshInterval: 0, fetchOnStartup: false, resetViewLocationsOnStartup: false,
          notifyIncomingCommits: false, notifyUnpushedCommits: false, repositoryScanDepth: 4, ignoredFolders: [], maximumGraphCommits: 1000,
          projectColors: {}, externalEditor: null,
        },
      },
    };
    useAppStore.setState({ bridge, bootstrap: configured, snapshot: previous, allRepositories: previous.repositories, selectedRepoId: 'a' });
    await useAppStore.getState().refresh(true);
    expect(currentDialog()).toBeUndefined();
    const notification = useAppStore.getState().notifications.find((item) => item.actions.some((action) => action.type === 'addUntracked'));
    expect(notification).toBeDefined();
    await useAppStore.getState().performNotificationAction(notification!.id, 0);
    expect(requests.find((command) => command.type === 'stage')).toMatchObject({ payload: { repo_id: 'a', paths: ['new.ts'] } });
  });

  it('does not overwrite a non-empty commit draft when merge enters conflicts', async () => {
    const current = snapshot('workspace', 1); current.repositories = [repository('a', 'A')];
    const bridge = new MockBridge((command) => command.type === 'branchOperation' ? { completed: false, conflicted: true } : []);
    useAppStore.setState({ bridge, snapshot: current, allRepositories: current.repositories, selectedRepoId: 'a', commitMessage: 'user draft' });
    await useAppStore.getState().branchOperation({ type: 'merge', name: 'feature' }, 'a');
    expect(useAppStore.getState().commitMessage).toBe('user draft');
    expect(useAppStore.getState().mergeMessageSuggestion).toBe("Merge branch 'feature' into 'main'");
    useAppStore.getState().applyMergeMessageSuggestion();
    expect(useAppStore.getState().commitMessage).toBe("Merge branch 'feature' into 'main'");
  });

  it('offers dirty checkout recovery and dispatches the selected strategy', async () => {
    const current = snapshot('workspace', 1); current.repositories = [repository('a', 'A')];
    const operations: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      operations.push(command);
      if (command.type === 'branchOperation') throw new BridgeError({ code: 'DIRTY_WORKTREE', message: 'dirty', command: 'git', exitCode: 1, stderr: null, recoverable: true });
      if (command.type === 'branchRecovery') return { status: 'completed', target: 'feature', stashReference: 'stash@{0}', changesRestored: false, error: null, recoveryHint: null };
      if (command.type === 'workspaceRefresh') return current;
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: current, allRepositories: current.repositories, selectedRepoId: 'a' });
    const operation = useAppStore.getState().branchOperation({ type: 'checkout', name: 'feature' }, 'a');
    await vi.waitFor(() => expect(currentDialog()?.kind).toBe('choice'));
    currentDialog()?.resolve('stash');
    const result = await operation;
    expect(result).toEqual({ completed: true, conflicted: false });
    expect(operations.find((command) => command.type === 'branchRecovery')).toMatchObject({ payload: { operation: { type: 'stashAndCheckout', target: 'feature' } } });
  });

  it('runs force checkout after the recovery choice without a second confirmation', async () => {
    const current = snapshot('workspace', 1); current.repositories = [repository('a', 'A')];
    const operations: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      operations.push(command);
      if (command.type === 'branchOperation') throw new BridgeError({ code: 'DIRTY_WORKTREE', message: 'dirty', command: 'git', exitCode: 1, stderr: null, recoverable: true });
      if (command.type === 'branchRecovery') return { status: 'completed', target: 'feature', stashReference: null, changesRestored: false, error: null, recoveryHint: null };
      if (command.type === 'workspaceRefresh') return current;
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: current, allRepositories: current.repositories, selectedRepoId: 'a' });
    const operation = useAppStore.getState().branchOperation({ type: 'checkout', name: 'feature' }, 'a');
    await vi.waitFor(() => expect(currentDialog()?.kind).toBe('choice'));
    const dialog = currentDialog();
    publishDialog(undefined);
    dialog?.resolve('force');
    const result = await operation;
    expect(result).toEqual({ completed: true, conflicted: false });
    expect(currentDialog()).toBeUndefined();
    expect(operations.find((command) => command.type === 'branchRecovery')).toMatchObject({ payload: { operation: { type: 'forceCheckout', target: 'feature' } } });
  });

  it('handles multi-repo partial history failure gracefully with historyRepoErrors', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('a', 'Alpha'), repository('b', 'Beta')];
    const bridge = new MockBridge((command) => {
      if (command.type === 'history') {
        if ((command.payload as { repo_id: string }).repo_id === 'b') throw new Error('Git repository corrupted');
        return { commits: [{ repoId: 'a', hash: 'a1', shortHash: 'a1', parents: [], author: 'Ada', email: '', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'a1', refs: [] }], hasMore: false };
      }
      if (command.type === 'historyTopology') return [];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'a' });
    await useAppStore.getState().loadHistory(true);
    expect(useAppStore.getState().history.map((c) => c.hash)).toEqual(['a1']);
    expect(useAppStore.getState().historyRepoErrors).toEqual({ b: 'Git repository corrupted' });
  });

  it('supports openHistoryForLineRange and restores lineRange after clearing path', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('a', 'Alpha')];
    const queries: Array<{ lineRange?: unknown }> = [];
    const bridge = new MockBridge((command) => {
      if (command.type === 'history') {
        queries.push((command.payload as { query: { lineRange?: unknown } }).query);
        return { commits: [], hasMore: false };
      }
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'a' });
    await useAppStore.getState().openHistoryForLineRange('a', 'src/main.rs', { start: 10, end: 25 });
    expect(useAppStore.getState().historyQuery.lineRange).toEqual({ start: 10, end: 25 });
    expect(queries[queries.length - 1].lineRange).toEqual({ start: 10, end: 25 });

    await useAppStore.getState().clearHistoryPath();
    expect(useAppStore.getState().historyQuery.lineRange).toBeNull();
    expect(useAppStore.getState().historyQuery.path).toBeNull();
  });

  it('merges extra commit refs into detail branches categorized by ref kind without polluting local branches', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    const commit: CommitNode = {
      repoId: 'repo',
      hash: 'commit-with-refs',
      shortHash: 'c1',
      parents: [],
      author: 'Ada',
      email: 'ada@example.test',
      authorDate: '2026-01-01T00:00:00Z',
      committerDate: '2026-01-01T00:00:00Z',
      message: 'test commit',
      refs: ['HEAD -> feature/ui', 'origin/main', 'tag: v1.2.0', 'BASE'],
    };
    const detailFromBackend: CommitDetail = {
      commit: { ...commit, refs: [] },
      fullMessage: 'test commit',
      branches: { local: ['feature/ui'], remote: [], tags: [] },
      files: [{ path: 'README.md', status: 'M', added: 1, removed: 0 }],
    };
    const bridge = new MockBridge((command) => {
      if (command.type === 'commitDetail') return detailFromBackend;
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace });

    const result = await useAppStore.getState().loadCommitDetail(commit);

    expect(result.branches.isHead).toBe(true);
    expect(result.branches.local).toEqual(['feature/ui']);
    expect(result.branches.remote).toEqual(['origin/main']);
    expect(result.branches.tags).toEqual(['v1.2.0']);
    expect(result.commit.refs).toEqual(['HEAD -> feature/ui', 'origin/main', 'tag: v1.2.0', 'BASE']);
  });

  it('restores merge target and preserves resolutions/draft when returning from diff to merge view', async () => {
    const workspace = snapshot('workspace', 1);
    const repo = repository('repo', 'Repository');
    workspace.repositories = [repo];

    let savedPayload: unknown = null;
    const mockVersions = {
      base: 'base',
      ours: 'ours',
      theirs: 'theirs',
      working: 'ours',
      conflicts: [{ index: 0, base: { start: 1, end: 2 }, ours: { start: 1, end: 2 }, theirs: { start: 1, end: 2 } }],
      fingerprint: 'fp-1',
      markerContent: 'marker content',
    };
    const bridge = new MockBridge((command) => {
      if (command.type === 'conflictVersions') {
        return mockVersions;
      }
      if (command.type === 'conflictSave') {
        savedPayload = command.payload;
        return undefined;
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      bootstrap,
      snapshot: workspace,
      selectedRepoId: 'repo',
    });

    const conflict: ConflictFile = {
      repoId: 'repo',
      repoName: 'Repository',
      repoColor: '#123456',
      path: 'conflict.txt',
      kind: 'git',
      binary: false,
    };

    await useAppStore.getState().openMerge(conflict);
    expect(useAppStore.getState().mode).toBe('merge');
    expect(useAppStore.getState().mergeTarget).toEqual({ repoId: 'repo', path: 'conflict.txt', workspaceId: 'workspace' });
    expect(useAppStore.getState().selectedFile).toEqual({ repoId: 'repo', path: 'conflict.txt', staged: false });
    expect(useAppStore.getState().mergeResolutions).toEqual({ 0: 'unresolved' });

    // 用户在合并编辑器中做出了解决选择并修改了内容
    useAppStore.getState().setMergeResolutions({ 0: 'ours' });
    useAppStore.getState().setMergeScope('left');
    useAppStore.getState().setMergeResult('resolved content');

    // 用户从侧边栏打开了一个外部文件的 diff
    useAppStore.setState({
      mode: 'diff',
      diffReturnMode: 'merge',
      selectedFile: { repoId: 'repo', path: 'unrelated.txt', staged: false },
    });

    expect(useAppStore.getState().mode).toBe('diff');
    expect(useAppStore.getState().selectedFile).toEqual({ repoId: 'repo', path: 'unrelated.txt', staged: false });

    // 用户点击返回
    useAppStore.getState().backToHistory();

    // 验证返回后的状态
    expect(useAppStore.getState().mode).toBe('merge');
    // selectedFile 精确恢复为 conflict.txt
    expect(useAppStore.getState().selectedFile).toEqual({ repoId: 'repo', path: 'conflict.txt', staged: false });
    expect(useAppStore.getState().mergeTarget).toEqual({ repoId: 'repo', path: 'conflict.txt', workspaceId: 'workspace' });
    // 草稿和解决记录完整保留
    expect(useAppStore.getState().mergeResult).toBe('resolved content');
    expect(useAppStore.getState().mergeResolutions).toEqual({ 0: 'ours' });
    expect(useAppStore.getState().mergeScope).toBe('left');

    // 执行保存合并，验证保存的是 conflict.txt 而非 unrelated.txt
    await useAppStore.getState().saveMerge();
    expect(savedPayload).toEqual({
      workspace_id: 'workspace',
      repo_id: 'repo',
      relative_path: 'conflict.txt',
      content: 'resolved content',
      expected_fingerprint: 'fp-1',
      delete_file: false,
    });
  });

  it('discards openMerge result if workspace changed during conflictVersions request', async () => {
    const workspace1 = snapshot('workspace-1', 1);
    const workspace2 = snapshot('workspace-2', 2);
    const repo = repository('repo', 'Repository');
    workspace1.repositories = [repo];
    workspace2.repositories = [repo];

    const mockVersions = {
      base: 'base',
      ours: 'ours',
      theirs: 'theirs',
      working: 'ours',
      conflicts: [{ index: 0, base: { start: 1, end: 2 }, ours: { start: 1, end: 2 }, theirs: { start: 1, end: 2 } }],
      fingerprint: 'fp-1',
      markerContent: 'marker content',
    };
    const bridge = new MockBridge(async (command) => {
      if (command.type === 'conflictVersions') {
        // 模拟在异步等待期间工作区发生了切换
        useAppStore.setState({ snapshot: workspace2 });
        return mockVersions;
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      bootstrap,
      snapshot: workspace1,
      selectedRepoId: 'repo',
      mode: 'history',
      merge: undefined,
      mergeTarget: undefined,
    });

    const conflict: ConflictFile = {
      repoId: 'repo',
      repoName: 'Repository',
      repoColor: '#123456',
      path: 'conflict.txt',
      kind: 'git',
      binary: false,
    };

    await useAppStore.getState().openMerge(conflict);
    expect(useAppStore.getState().mode).toBe('history');
    expect(useAppStore.getState().merge).toBeUndefined();
    expect(useAppStore.getState().mergeTarget).toBeUndefined();
  });

  it('blocks saveMerge if current workspace does not match merge target workspace', async () => {
    const workspace2 = snapshot('workspace-2', 2);
    let savedCalled = false;
    const bridge = new MockBridge((command) => {
      if (command.type === 'conflictSave') {
        savedCalled = true;
        return undefined;
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      bootstrap,
      snapshot: workspace2,
      mode: 'merge',
      mergeTarget: { repoId: 'repo', path: 'conflict.txt', workspaceId: 'workspace-1' },
      mergeResult: 'resolved content',
    });

    await useAppStore.getState().saveMerge();
    expect(savedCalled).toBe(false);
  });

  it('preserves existing conflicts and records error when loadConflicts fails', async () => {
    const workspace = snapshot('workspace', 1);
    const existingConflicts: ConflictFile[] = [{
      repoId: 'repo',
      repoName: 'Repository',
      repoColor: '#123456',
      path: 'existing.txt',
      kind: 'git',
      binary: false,
    }];

    const bridge = new MockBridge((command) => {
      if (command.type === 'conflicts') {
        throw new Error('Network error');
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      bootstrap,
      snapshot: workspace,
      conflicts: existingConflicts,
      loadErrors: {},
    });

    await useAppStore.getState().loadConflicts(true);

    expect(useAppStore.getState().conflicts).toEqual(existingConflicts);
    expect(useAppStore.getState().loadErrors['conflicts:all']).toBe('Network error');
  });

  it('manages merge parent files loading state and captures failure error', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];

    let shouldFail = true;
    const bridge = new MockBridge((command) => {
      if (command.type === 'commitMergeParentFiles') {
        if (shouldFail) {
          throw new Error('Connection refused');
        }
        return [{ path: 'src/file.ts', status: 'M', added: 1, removed: 0 }];
      }
      return [];
    });

    useAppStore.setState({ bridge, bootstrap, snapshot: workspace });

    const cacheKey = 'repo\0rev-1\0parent-1';
    await expect(useAppStore.getState().loadMergeParentFiles('repo', 'rev-1', 'parent-1')).rejects.toThrow('Connection refused');

    expect(useAppStore.getState().mergeParentFilesLoading[cacheKey]).toBe(false);
    expect(useAppStore.getState().mergeParentFilesError[cacheKey]).toBe('Connection refused');
    expect(useAppStore.getState().mergeParentFiles[cacheKey]).toBeUndefined();

    shouldFail = false;
    const files = await useAppStore.getState().loadMergeParentFiles('repo', 'rev-1', 'parent-1');
    expect(files).toHaveLength(1);
    expect(useAppStore.getState().mergeParentFilesLoading[cacheKey]).toBe(false);
    expect(useAppStore.getState().mergeParentFilesError[cacheKey]).toBe('');
    expect(useAppStore.getState().mergeParentFiles[cacheKey]).toEqual(files);
  });

  it('isolates merge parent files request and avoids polluting active store when tab switched', async () => {
    const tabA = snapshot('ws-a', 1).workspace;
    const tabB = snapshot('ws-b', 1).workspace;
    const repoA = repository('repo-a', 'Repo A');
    const repoB = repository('repo-b', 'Repo B');

    const parentFiles = [{ path: 'src/file-a.ts', status: 'M' as const, added: 2, removed: 1 }];
    const parentGate = deferred<typeof parentFiles>();
    let observedSignal: AbortSignal | undefined;

    const bridge = new MockBridge((command, options) => {
      if (command.type === 'commitMergeParentFiles') {
        observedSignal = options?.signal;
        return parentGate.promise;
      }
      return [];
    });

    const sessionA = {
      snapshot: { ...snapshot('ws-a', 1), repositories: [repoA] },
      allRepositories: [repoA],
      selectedRepoId: 'repo-a',
      mode: 'history' as const,
      tabs: [tabA, tabB],
      activeTabId: 'ws-a',
    };
    const sessionB = {
      snapshot: { ...snapshot('ws-b', 1), repositories: [repoB] },
      allRepositories: [repoB],
      selectedRepoId: 'repo-b',
      mode: 'history' as const,
      tabs: [tabA, tabB],
      activeTabId: 'ws-b',
    };

    useAppStore.setState({
      bridge,
      bootstrap,
      tabs: [tabA, tabB],
      activeTabId: 'ws-a',
      snapshot: sessionA.snapshot,
      allRepositories: sessionA.allRepositories,
      selectedRepoId: 'repo-a',
      mode: 'history',
      sessions: {
        'ws-a': { ...sessionA, selectedFile: undefined, diff: undefined, changesDiff: undefined, changes: undefined, history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, historyFilter: '', historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', mergeResolutions: {}, mergeScope: 'all', commitMessage: '', amendRepoIds: [], incomingCommits: {}, commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, comparison: undefined, remotes: {}, loadErrors: {} },
        'ws-b': { ...sessionB, selectedFile: undefined, diff: undefined, changesDiff: undefined, changes: undefined, history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, historyFilter: '', historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', mergeResolutions: {}, mergeScope: 'all', commitMessage: '', amendRepoIds: [], incomingCommits: {}, commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, comparison: undefined, remotes: {}, loadErrors: {} },
      },
    });

    const cacheKey = 'repo-a\0rev-1\0parent-1';
    const pendingRequest = useAppStore.getState().loadMergeParentFiles('repo-a', 'rev-1', 'parent-1');

    // 验证发出请求时绑定了 AbortSignal
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);

    // 切换到 ws-b 工作区
    await useAppStore.getState().switchTab('ws-b');
    expect(useAppStore.getState().activeTabId).toBe('ws-b');
    // 切换标签触发 cancelRequests，原请求 signal 被 abort
    expect(observedSignal?.aborted).toBe(true);

    // 让原请求成功返回（模拟响应在切换后完成到达）
    parentGate.resolve(parentFiles);
    await pendingRequest;

    // 验证当前激活的工作区 ws-b 的 store 没有被旧工作区 ws-a 的结果污染
    expect(useAppStore.getState().mergeParentFiles[cacheKey]).toBeUndefined();

    // 验证旧工作区 ws-a 的 session 记录了正确的结果
    expect(useAppStore.getState().sessions['ws-a'].mergeParentFiles[cacheKey]).toEqual(parentFiles);

    // 切回 ws-a，验证成功恢复该缓存
    await useAppStore.getState().switchTab('ws-a');
    expect(useAppStore.getState().activeTabId).toBe('ws-a');
    expect(useAppStore.getState().mergeParentFiles[cacheKey]).toEqual(parentFiles);
  });

  it('isolates merge parent files failure and updates originating session when tab switched', async () => {
    const tabA = snapshot('ws-a', 1).workspace;
    const tabB = snapshot('ws-b', 1).workspace;
    const repoA = repository('repo-a', 'Repo A');
    const repoB = repository('repo-b', 'Repo B');

    const parentGate = deferred<never>();

    const bridge = new MockBridge((command) => {
      if (command.type === 'commitMergeParentFiles') {
        return parentGate.promise;
      }
      return [];
    });

    const sessionA = {
      snapshot: { ...snapshot('ws-a', 1), repositories: [repoA] },
      allRepositories: [repoA],
      selectedRepoId: 'repo-a',
      mode: 'history' as const,
      tabs: [tabA, tabB],
      activeTabId: 'ws-a',
    };
    const sessionB = {
      snapshot: { ...snapshot('ws-b', 1), repositories: [repoB] },
      allRepositories: [repoB],
      selectedRepoId: 'repo-b',
      mode: 'history' as const,
      tabs: [tabA, tabB],
      activeTabId: 'ws-b',
    };

    useAppStore.setState({
      bridge,
      bootstrap,
      tabs: [tabA, tabB],
      activeTabId: 'ws-a',
      snapshot: sessionA.snapshot,
      allRepositories: sessionA.allRepositories,
      selectedRepoId: 'repo-a',
      mode: 'history',
      sessions: {
        'ws-a': { ...sessionA, selectedFile: undefined, diff: undefined, changesDiff: undefined, changes: undefined, history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, historyFilter: '', historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', mergeResolutions: {}, mergeScope: 'all', commitMessage: '', amendRepoIds: [], incomingCommits: {}, commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, comparison: undefined, remotes: {}, loadErrors: {} },
        'ws-b': { ...sessionB, selectedFile: undefined, diff: undefined, changesDiff: undefined, changes: undefined, history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, historyFilter: '', historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', mergeResolutions: {}, mergeScope: 'all', commitMessage: '', amendRepoIds: [], incomingCommits: {}, commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, comparison: undefined, remotes: {}, loadErrors: {} },
      },
    });

    const cacheKey = 'repo-a\0rev-1\0parent-1';
    const pendingRequest = useAppStore.getState().loadMergeParentFiles('repo-a', 'rev-1', 'parent-1');

    // 切换到 ws-b 工作区
    await useAppStore.getState().switchTab('ws-b');
    expect(useAppStore.getState().activeTabId).toBe('ws-b');

    // 让原请求失败抛出错误
    parentGate.reject(new Error('Network timeout'));
    await expect(pendingRequest).rejects.toThrow('Network timeout');

    // 验证当前激活的工作区 ws-b 的 store 没有被旧工作区 ws-a 的错误状态污染
    expect(useAppStore.getState().mergeParentFilesError[cacheKey]).toBeUndefined();

    // 验证旧工作区 ws-a 的 session 记录了该错误状态
    expect(useAppStore.getState().sessions['ws-a'].mergeParentFilesError[cacheKey]).toBe('Network timeout');

    // 切回 ws-a，验证成功恢复该错误状态
    await useAppStore.getState().switchTab('ws-a');
    expect(useAppStore.getState().activeTabId).toBe('ws-a');
    expect(useAppStore.getState().mergeParentFilesError[cacheKey]).toBe('Network timeout');
  });

  it('isolates commit detail loading and automatically recovers unfinished commit detail when switching back to workspace', async () => {
    const tabA = snapshot('ws-a', 1).workspace;
    const tabB = snapshot('ws-b', 1).workspace;
    const repoA = repository('repo-a', 'Repo A');
    const repoB = repository('repo-b', 'Repo B');

    const commitA: CommitNode = {
      repoId: 'repo-a',
      hash: 'commit-a-123456',
      shortHash: 'commita',
      parents: [],
      author: 'Alice',
      email: 'alice@example.com',
      authorDate: '2026-08-16T10:00:00Z',
      committerDate: '2026-08-16T10:00:00Z',
      message: 'feat: something on repo A',
      refs: ['HEAD -> main'],
    };

    const detailA: CommitDetail = {
      commit: commitA,
      fullMessage: 'feat: something on repo A',
      branches: { local: ['main'], remote: [], tags: [] },
      files: [{ path: 'file-a.ts', status: 'M', added: 1, removed: 0 }],
    };

    let detailGate = deferred<CommitDetail>();

    const bridge = new MockBridge((command) => {
      if (command.type === 'commitDetail') {
        return detailGate.promise;
      }
      return [];
    });

    const sessionA = {
      snapshot: { ...snapshot('ws-a', 1), repositories: [repoA] },
      allRepositories: [repoA],
      selectedRepoId: 'repo-a',
      mode: 'history' as const,
      tabs: [tabA, tabB],
      activeTabId: 'ws-a',
    };
    const sessionB = {
      snapshot: { ...snapshot('ws-b', 1), repositories: [repoB] },
      allRepositories: [repoB],
      selectedRepoId: 'repo-b',
      mode: 'history' as const,
      tabs: [tabA, tabB],
      activeTabId: 'ws-b',
    };

    useAppStore.setState({
      bridge,
      bootstrap,
      tabs: [tabA, tabB],
      activeTabId: 'ws-a',
      snapshot: sessionA.snapshot,
      allRepositories: sessionA.allRepositories,
      selectedRepoId: 'repo-a',
      selectedCommits: [commitA],
      selectedPrimaryKey: commitKey(commitA.repoId, commitA.hash),
      mode: 'history',
      sessions: {
        'ws-a': { ...sessionA, selectedFile: undefined, diff: undefined, changesDiff: undefined, changes: undefined, history: [commitA], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, historyFilter: '', historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [commitA], selectedPrimaryKey: commitKey(commitA.repoId, commitA.hash), selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', mergeResolutions: {}, mergeScope: 'all', commitMessage: '', amendRepoIds: [], incomingCommits: {}, commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, comparison: undefined, remotes: {}, loadErrors: {} },
        'ws-b': { ...sessionB, selectedFile: undefined, diff: undefined, changesDiff: undefined, changes: undefined, history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, historyFilter: '', historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', mergeResolutions: {}, mergeScope: 'all', commitMessage: '', amendRepoIds: [], incomingCommits: {}, commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, comparison: undefined, remotes: {}, loadErrors: {} },
      },
    });

    const keyA = commitKey(commitA.repoId, commitA.hash);
    const pending = useAppStore.getState().loadCommitDetail(commitA);

    // 切换到 ws-b
    await useAppStore.getState().switchTab('ws-b');
    expect(useAppStore.getState().activeTabId).toBe('ws-b');

    // 响应在切换后完成
    detailGate.resolve(detailA);
    await pending;

    // 验证 ws-b 没有被写入 commitA 详情
    expect(useAppStore.getState().selectedCommitDetails[keyA]).toBeUndefined();
    // 验证 ws-a 的 session 写入了该结果
    expect(useAppStore.getState().sessions['ws-a'].selectedCommitDetails[keyA]).toEqual(detailA);

    // 切回 ws-a，验证成功恢复
    await useAppStore.getState().switchTab('ws-a');
    expect(useAppStore.getState().activeTabId).toBe('ws-a');
    expect(useAppStore.getState().selectedCommitDetails[keyA]).toEqual(detailA);
    expect(useAppStore.getState().selectedCommit).toEqual(detailA);

    // 测试未加载完就切走，切回时自动触发 reloadSelectedCommits 恢复
    detailGate = deferred<CommitDetail>();
    useAppStore.setState({
      selectedCommitDetails: {},
      selectedCommit: undefined,
      sessions: {
        ...useAppStore.getState().sessions,
        'ws-a': {
          ...useAppStore.getState().sessions['ws-a'],
          selectedCommits: [commitA],
          selectedCommitDetails: {},
          selectedCommit: undefined,
        },
      },
    });

    // 切换到 ws-b
    await useAppStore.getState().switchTab('ws-b');
    expect(useAppStore.getState().activeTabId).toBe('ws-b');

    // 切回 ws-a，由于缺少详情，自动触发 reloadSelectedCommits 并呈现 loading 状态
    await useAppStore.getState().switchTab('ws-a');
    expect(useAppStore.getState().selectedCommitLoading[keyA]).toBe(true);

    // 完成 reload
    detailGate.resolve(detailA);
    await new Promise((r) => setTimeout(r, 20));
    expect(useAppStore.getState().selectedCommitDetails[keyA]).toEqual(detailA);
    expect(useAppStore.getState().selectedCommit).toEqual(detailA);
  });

  it('records selectedCommitError on failure and supports reloadSelectedCommits retry', async () => {
    const tabA = snapshot('ws-a', 1).workspace;
    const repoA = repository('repo-a', 'Repo A');

    const commitA: CommitNode = {
      repoId: 'repo-a',
      hash: 'commit-error-1234',
      shortHash: 'error12',
      parents: [],
      author: 'Alice',
      email: 'alice@example.com',
      authorDate: '2026-08-16T10:00:00Z',
      committerDate: '2026-08-16T10:00:00Z',
      message: 'fix: error test',
      refs: [],
    };

    const detailA: CommitDetail = {
      commit: commitA,
      fullMessage: 'fix: error test',
      branches: { local: [], remote: [], tags: [] },
      files: [],
    };

    let shouldFail = true;
    const bridge = new MockBridge((command) => {
      if (command.type === 'commitDetail') {
        if (shouldFail) {
          return Promise.reject(new Error('Backend error: commit not found'));
        }
        return Promise.resolve(detailA);
      }
      return [];
    });

    const key = commitKey(commitA.repoId, commitA.hash);
    useAppStore.setState({
      bridge,
      bootstrap,
      tabs: [tabA],
      activeTabId: 'ws-a',
      snapshot: { ...snapshot('ws-a', 1), repositories: [repoA] },
      allRepositories: [repoA],
      selectedRepoId: 'repo-a',
      selectedCommits: [commitA],
      selectedPrimaryKey: key,
      selectedCommitDetails: {},
      selectedCommitLoading: {},
      selectedCommitError: {},
      mode: 'history',
    });

    // 首次加载失败
    await expect(useAppStore.getState().loadCommitDetail(commitA)).rejects.toThrow('Backend error: commit not found');
    expect(useAppStore.getState().selectedCommitError[key]).toBe('Backend error: commit not found');
    expect(useAppStore.getState().selectedCommitLoading[key]).toBeUndefined();

    // 允许后端恢复，并触发 reloadSelectedCommits
    shouldFail = false;
    await useAppStore.getState().reloadSelectedCommits();

    expect(useAppStore.getState().selectedCommitError[key]).toBeUndefined();
    expect(useAppStore.getState().selectedCommitDetails[key]).toEqual(detailA);
    expect(useAppStore.getState().selectedCommit).toEqual(detailA);
  });

  it('does not block commit detail reload when persistTabs fails or is delayed', async () => {
    const tabA = snapshot('ws-a', 1).workspace;
    const tabB = snapshot('ws-b', 1).workspace;
    const repoA = repository('repo-a', 'Repo A');
    const repoB = repository('repo-b', 'Repo B');

    const commitA: CommitNode = {
      repoId: 'repo-a',
      hash: 'commit-sync-fail',
      shortHash: 'syncfail',
      parents: [],
      author: 'Alice',
      email: 'alice@example.com',
      authorDate: '2026-08-16T10:00:00Z',
      committerDate: '2026-08-16T10:00:00Z',
      message: 'feat: sync test',
      refs: [],
    };

    const detailA: CommitDetail = {
      commit: commitA,
      fullMessage: 'feat: sync test',
      branches: { local: [], remote: [], tags: [] },
      files: [],
    };

    const key = commitKey(commitA.repoId, commitA.hash);
    const bridge = new MockBridge((command) => {
      if (command.type === 'commitDetail') {
        return Promise.resolve(detailA);
      }
      return [];
    });

    // 模拟 syncWindowTabs 发生异常
    bridge.syncWindowTabs = vi.fn().mockRejectedValue(new Error('IPC sync error'));

    const sessionA = {
      snapshot: { ...snapshot('ws-a', 1), repositories: [repoA] },
      allRepositories: [repoA],
      selectedRepoId: 'repo-a',
      mode: 'history' as const,
      tabs: [tabA, tabB],
      activeTabId: 'ws-a',
    };
    const sessionB = {
      snapshot: { ...snapshot('ws-b', 1), repositories: [repoB] },
      allRepositories: [repoB],
      selectedRepoId: 'repo-b',
      mode: 'history' as const,
      tabs: [tabA, tabB],
      activeTabId: 'ws-b',
    };

    useAppStore.setState({
      bridge,
      bootstrap,
      tabs: [tabA, tabB],
      activeTabId: 'ws-b',
      snapshot: sessionB.snapshot,
      allRepositories: sessionB.allRepositories,
      selectedRepoId: 'repo-b',
      mode: 'history',
      sessions: {
        'ws-a': { ...sessionA, selectedFile: undefined, diff: undefined, changesDiff: undefined, changes: undefined, history: [commitA], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, historyFilter: '', historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [commitA], selectedPrimaryKey: key, selectedCommitDetails: {}, selectedCommitLoading: {}, selectedCommitError: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', mergeResolutions: {}, mergeScope: 'all', commitMessage: '', amendRepoIds: [], incomingCommits: {}, commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, comparison: undefined, remotes: {}, loadErrors: {} },
        'ws-b': { ...sessionB, selectedFile: undefined, diff: undefined, changesDiff: undefined, changes: undefined, history: [], historyHasMore: false, historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, historyFilter: '', historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, mergeParentFiles: {}, mergeParentFilesLoading: {}, mergeParentFilesError: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], mergeResult: '', mergeResolutions: {}, mergeScope: 'all', commitMessage: '', amendRepoIds: [], incomingCommits: {}, commitSelections: {}, stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, comparison: undefined, remotes: {}, loadErrors: {} },
      },
    });

    // 切回 ws-a，即使 syncWindowTabs 抛错，详情补载依然独立执行并成功更新
    await useAppStore.getState().switchTab('ws-a');

    await new Promise((r) => setTimeout(r, 20));
    expect(useAppStore.getState().selectedCommitDetails[key]).toEqual(detailA);
    expect(useAppStore.getState().selectedCommit).toEqual(detailA);
    expect(useAppStore.getState().selectedCommitLoading[key]).toBeUndefined();
  });

  it('checks target workspace and ignores stale reload when rapidly switching tabs', async () => {
    const tabA = snapshot('ws-a', 1).workspace;
    const tabB = snapshot('ws-b', 1).workspace;
    const repoB = repository('repo-b', 'Repo B');

    const commitA: CommitNode = {
      repoId: 'repo-a',
      hash: 'commit-rapid-a',
      shortHash: 'rapida',
      parents: [],
      author: 'Alice',
      email: 'alice@example.com',
      authorDate: '2026-08-16T10:00:00Z',
      committerDate: '2026-08-16T10:00:00Z',
      message: 'feat: rapid test A',
      refs: [],
    };

    const detailA: CommitDetail = {
      commit: commitA,
      fullMessage: 'feat: rapid test A',
      branches: { local: [], remote: [], tags: [] },
      files: [],
    };

    let detailCalls = 0;
    const bridge = new MockBridge((command) => {
      if (command.type === 'commitDetail') {
        detailCalls += 1;
        return Promise.resolve(detailA);
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      bootstrap,
      tabs: [tabA, tabB],
      activeTabId: 'ws-b',
      snapshot: { ...snapshot('ws-b', 1), repositories: [repoB] },
      allRepositories: [repoB],
      selectedRepoId: 'repo-b',
      selectedCommits: [],
      selectedCommitDetails: {},
      selectedCommitLoading: {},
      selectedCommitError: {},
      mode: 'history',
    });

    // 如果针对 ws-a 请求补载，但当前激活的是 ws-b，应当直接忽略，不执行补载
    await useAppStore.getState().reloadSelectedCommits('ws-a');
    expect(detailCalls).toBe(0);
  });

  it('preserves selectedCommitLoading when older request is aborted by subsequent request for the same commit', async () => {
    const tabA = snapshot('ws-a', 1).workspace;
    const repoA = repository('repo-a', 'Repo A');

    const commitA: CommitNode = {
      repoId: 'repo-a',
      hash: 'commit-concurrent-1',
      shortHash: 'concur1',
      parents: [],
      author: 'Alice',
      email: 'alice@example.com',
      authorDate: '2026-08-16T10:00:00Z',
      committerDate: '2026-08-16T10:00:00Z',
      message: 'feat: concurrent test',
      refs: [],
    };

    const detailA: CommitDetail = {
      commit: commitA,
      fullMessage: 'feat: concurrent test',
      branches: { local: [], remote: [], tags: [] },
      files: [],
    };

    let requestCount = 0;
    const request1Gate = deferred<CommitDetail>();
    const request2Gate = deferred<CommitDetail>();

    const bridge = new MockBridge((command, options) => {
      if (command.type === 'commitDetail') {
        requestCount += 1;
        if (requestCount === 1) {
          return new Promise((resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Operation aborted', 'AbortError'));
            });
            request1Gate.promise.then(resolve, reject);
          });
        }
        return request2Gate.promise;
      }
      return [];
    });

    const key = commitKey(commitA.repoId, commitA.hash);
    useAppStore.setState({
      bridge,
      bootstrap,
      tabs: [tabA],
      activeTabId: 'ws-a',
      snapshot: { ...snapshot('ws-a', 1), repositories: [repoA] },
      allRepositories: [repoA],
      selectedRepoId: 'repo-a',
      selectedCommits: [commitA],
      selectedPrimaryKey: key,
      selectedCommitDetails: {},
      selectedCommitLoading: {},
      selectedCommitError: {},
      mode: 'history',
    });

    // 1. 模拟悬停发起请求 1
    const pending1 = useAppStore.getState().loadCommitDetail(commitA, true);
    expect(useAppStore.getState().selectedCommitLoading[key]).toBe(true);

    // 2. 在请求 1 未完成时，模拟点击同一提交发起请求 2
    const pending2 = useAppStore.getState().loadCommitDetail(commitA, true);

    // 等待请求 1 被 abort 并进入 catch 块
    await pending1.catch(() => undefined);

    // 3. 核心验证：请求 1 绝不能清除请求 2 正在维持的 loading 状态，也不能写入错误
    expect(useAppStore.getState().selectedCommitLoading[key]).toBe(true);
    expect(useAppStore.getState().selectedCommitError[key]).toBeFalsy();

    // 4. 让请求 2 成功返回
    request2Gate.resolve(detailA);
    const result2 = await pending2;
    expect(result2).toEqual(detailA);

    // 请求 2 完成后，loading 被正常清除，detail 被正常写入
    expect(useAppStore.getState().selectedCommitLoading[key]).toBeUndefined();
    expect(useAppStore.getState().selectedCommitDetails[key]).toEqual(detailA);
  });

  it('allows newest request to record error when older aborted request bails out safely', async () => {
    const tabA = snapshot('ws-a', 1).workspace;
    const repoA = repository('repo-a', 'Repo A');

    const commitA: CommitNode = {
      repoId: 'repo-a',
      hash: 'commit-concurrent-2',
      shortHash: 'concur2',
      parents: [],
      author: 'Alice',
      email: 'alice@example.com',
      authorDate: '2026-08-16T10:00:00Z',
      committerDate: '2026-08-16T10:00:00Z',
      message: 'feat: concurrent error test',
      refs: [],
    };

    let requestCount = 0;
    const request1Gate = deferred<CommitDetail>();
    const request2Gate = deferred<CommitDetail>();

    const bridge = new MockBridge((command, options) => {
      if (command.type === 'commitDetail') {
        requestCount += 1;
        if (requestCount === 1) {
          return new Promise((resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Operation aborted', 'AbortError'));
            });
            request1Gate.promise.then(resolve, reject);
          });
        }
        return request2Gate.promise;
      }
      return [];
    });

    const key = commitKey(commitA.repoId, commitA.hash);
    useAppStore.setState({
      bridge,
      bootstrap,
      tabs: [tabA],
      activeTabId: 'ws-a',
      snapshot: { ...snapshot('ws-a', 1), repositories: [repoA] },
      allRepositories: [repoA],
      selectedRepoId: 'repo-a',
      selectedCommits: [commitA],
      selectedPrimaryKey: key,
      selectedCommitDetails: {},
      selectedCommitLoading: {},
      selectedCommitError: {},
      mode: 'history',
    });

    const pending1 = useAppStore.getState().loadCommitDetail(commitA, true);
    const pending2 = useAppStore.getState().loadCommitDetail(commitA, true);

    await pending1.catch(() => undefined);
    expect(useAppStore.getState().selectedCommitLoading[key]).toBe(true);

    // 让请求 2 发生真实后端错误
    request2Gate.reject(new Error('Network timeout during click'));
    await expect(pending2).rejects.toThrow('Network timeout during click');

    // 新请求完成失败后，正常清除 loading 并记录该真实错误
    expect(useAppStore.getState().selectedCommitLoading[key]).toBeUndefined();
    expect(useAppStore.getState().selectedCommitError[key]).toBe('Network timeout during click');
  });

  it('refuses to open incomplete changes when some selected commits are loading or failed', () => {
    const tabA = snapshot('ws-a', 1).workspace;
    const repoA = repository('repo-a', 'Repo A');
    const commitA: CommitNode = {
      repoId: 'repo-a',
      hash: 'commit-agg-1',
      shortHash: 'agg1',
      parents: [],
      author: 'Alice',
      email: 'alice@example.com',
      authorDate: '2026-08-16T10:00:00Z',
      committerDate: '2026-08-16T10:00:00Z',
      message: 'feat: first commit',
      refs: [],
    };
    const commitB: CommitNode = {
      repoId: 'repo-a',
      hash: 'commit-agg-2',
      shortHash: 'agg2',
      parents: ['commit-agg-1'],
      author: 'Bob',
      email: 'bob@example.com',
      authorDate: '2026-08-16T11:00:00Z',
      committerDate: '2026-08-16T11:00:00Z',
      message: 'feat: second commit',
      refs: [],
    };

    const keyA = commitKey('repo-a', 'commit-agg-1');
    const keyB = commitKey('repo-a', 'commit-agg-2');

    const detailA: CommitDetail = {
      commit: commitA,
      fullMessage: 'feat: first commit',
      branches: { local: [], remote: [], tags: [] },
      files: [{ path: 'file-a.txt', status: 'added', added: 10, removed: 0 }],
    };
    const detailB: CommitDetail = {
      commit: commitB,
      fullMessage: 'feat: second commit',
      branches: { local: [], remote: [], tags: [] },
      files: [{ path: 'file-b.txt', status: 'added', added: 5, removed: 0 }],
    };

    useAppStore.setState({
      tabs: [tabA],
      activeTabId: 'ws-a',
      snapshot: { ...snapshot('ws-a', 1), repositories: [repoA] },
      allRepositories: [repoA],
      selectedRepoId: 'repo-a',
      selectedCommits: [commitA, commitB],
      selectedCommitDetails: { [keyA]: detailA },
      selectedCommitLoading: { [keyB]: true },
      selectedCommitError: {},
      mode: 'history',
      changes: undefined,
    });

    // 1. commitB 仍在 loading 时，openCommitChanges 应当拒绝进入
    useAppStore.getState().openCommitChanges();
    expect(useAppStore.getState().mode).toBe('history');
    expect(useAppStore.getState().changes).toBeUndefined();

    // 2. commitB 加载失败时，openCommitChanges 也应当拒绝进入
    useAppStore.setState({
      selectedCommitLoading: {},
      selectedCommitError: { [keyB]: 'Failed to load' },
    });
    useAppStore.getState().openCommitChanges();
    expect(useAppStore.getState().mode).toBe('history');
    expect(useAppStore.getState().changes).toBeUndefined();

    // 3. 所有提交详情就绪后，成功进入 changes 模式并构建完整文件集合
    useAppStore.setState({
      selectedCommitDetails: { [keyA]: detailA, [keyB]: detailB },
      selectedCommitLoading: {},
      selectedCommitError: {},
    });
    useAppStore.getState().openCommitChanges();
    expect(useAppStore.getState().mode).toBe('changes');
    const changesModel = useAppStore.getState().changes;
    expect(changesModel?.kind).toBe('commits');
    if (changesModel?.kind === 'commits') {
      expect(changesModel.commits).toHaveLength(2);
      expect(changesModel.files).toHaveLength(2);
    }
  });

  it('loadChangesDiff immediately clears previous diff and captures diff error on failure', async () => {
    const tabA = snapshot('ws-a', 1).workspace;
    const repoA = repository('repo-a', 'Repo A');

    let shouldFail = false;
    const diffGate = deferred<DiffDocument>();

    const bridge = new MockBridge((command) => {
      if (command.type === 'fileDiff') {
        if (shouldFail) {
          return Promise.reject(new Error('Diff parse error'));
        }
        return diffGate.promise;
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      bootstrap,
      tabs: [tabA],
      activeTabId: 'ws-a',
      snapshot: { ...snapshot('ws-a', 1), repositories: [repoA] },
      allRepositories: [repoA],
      selectedRepoId: 'repo-a',
      mode: 'changes',
      changesDiff: { path: 'old.txt', content: 'old diff content', language: 'text', binary: false, truncated: false, lineCount: 1 },
      changesDiffLoading: false,
      changesDiffError: undefined,
      changesDiffTarget: 'repo-a\0old.txt\0\0rev-1',
    });

    const newTarget: WorkingChangeTarget = {
      repoId: 'repo-a',
      path: 'new.txt',
      section: 'staged',
      status: 'modified',
      staged: true,
    };

    // 1. 发起新文件请求
    const pending = useAppStore.getState().loadChangesDiff(newTarget);

    // 2. 核心验证：旧差异在发起时立即被清空，loading 被激活，target 被更新
    expect(useAppStore.getState().changesDiff).toBeUndefined();
    expect(useAppStore.getState().changesDiffLoading).toBe(true);
    expect(useAppStore.getState().changesDiffTarget).toBe('repo-a\0staged\0new.txt');
    expect(useAppStore.getState().changesDiffError).toBeUndefined();

    // 3. 正常返回
    diffGate.resolve({ path: 'new.txt', content: 'new diff content', language: 'text', binary: false, truncated: false, lineCount: 1 });
    await pending;

    expect(useAppStore.getState().changesDiffLoading).toBe(false);
    expect(useAppStore.getState().changesDiff?.path).toBe('new.txt');
    expect(useAppStore.getState().changesDiff?.content).toBe('new diff content');

    // 4. 再次请求且发生失败
    shouldFail = true;
    await useAppStore.getState().loadChangesDiff(newTarget).catch(() => undefined);

    // 失败后旧内容依然不残留，记录错误状态
    expect(useAppStore.getState().changesDiff).toBeUndefined();
    expect(useAppStore.getState().changesDiffLoading).toBe(false);
    expect(useAppStore.getState().changesDiffError).toBe('Diff parse error');
  });

  it('retryBatchResult preserves stagedOnly flag and target workspace id', async () => {
    const workspace1 = snapshot('workspace-1', 1);
    workspace1.repositories = [repository('repo-a', 'Repo A')];

    const requests: Array<{ type: string; payload: any }> = [];
    const bridge = new MockBridge((command) => {
      requests.push(command as any);
      if (command.type === 'batchCommit') {
        return [{
          repoId: 'repo-a',
          committed: true,
          commitHash: 'commit-123',
          pushed: false,
          pushAttempted: false,
          failedStage: null,
          recoveryHint: null,
          error: null,
        }];
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      snapshot: workspace1,
      commitSelections: { 'repo-a': ['file.ts'] },
      batchCommitReport: {
        workspaceId: 'workspace-1',
        message: 'fix: staged bug',
        push: false,
        targets: [{
          repoId: 'repo-a',
          paths: ['file.ts'],
          unstagePaths: [],
          amend: false,
          stagedOnly: true,
        }],
        results: [{
          repoId: 'repo-a',
          commitAttempted: true,
          committed: false,
          revision: null,
          pushed: false,
          pushAttempted: false,
          failedStage: 'commit',
          recoveryHint: null,
          error: { code: 'HOOK_FAILED', message: 'pre-commit hook failed', command: 'git commit', exitCode: 1, stderr: '', recoverable: false },
        }],
      },
    });

    await useAppStore.getState().retryBatchResult('repo-a');

    const retryBatch = requests.find((r) => r.type === 'batchCommit');
    expect(retryBatch).toBeDefined();
    expect(retryBatch?.payload.workspace_id).toBe('workspace-1');
    expect(retryBatch?.payload.targets[0]).toMatchObject({
      repoId: 'repo-a',
      message: 'fix: staged bug',
      stagedOnly: true,
    });
    // 重试成功后清除勾选
    expect(useAppStore.getState().commitSelections['repo-a']).toBeUndefined();
    // 报告已清空
    expect(useAppStore.getState().batchCommitReport).toBeUndefined();
  });

  it('isolates commit report and clears committed selections on origin workspace when workspace switches mid-commit', async () => {
    const workspace1 = snapshot('workspace-1', 1);
    const workspace2 = snapshot('workspace-2', 2);
    workspace1.repositories = [repository('repo-1', 'Repo 1')];
    workspace2.repositories = [repository('repo-2', 'Repo 2')];

    const bridge = new MockBridge(async (command) => {
      if (command.type === 'batchCommit') {
        // 模拟提交在飞行过程中，用户切换到了 workspace-2
        useAppStore.setState({
          snapshot: workspace2,
          commitSelections: { 'repo-2': ['other.ts'] },
        });
        return [{
          repoId: 'repo-1',
          committed: true,
          commitHash: 'hash-1',
          pushed: false,
          pushAttempted: false,
          failedStage: null,
          recoveryHint: null,
          error: null,
        }];
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      snapshot: workspace1,
      commitSelections: { 'repo-1': ['staged.ts'] },
      sessions: {
        'workspace-1': {
          snapshot: workspace1,
          allRepositories: workspace1.repositories,
          commitSelections: { 'repo-1': ['staged.ts'] },
        } as any,
      },
    });

    await useAppStore.getState().commitMany([
      { repoId: 'repo-1', paths: ['staged.ts'], unstagePaths: [], amend: false, stagedOnly: true },
    ], 'commit on ws1', false);

    // 当前前台是 workspace-2，workspace-2 的 selections 不受影响，报告不显示在 workspace-2
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('workspace-2');
    expect(useAppStore.getState().commitSelections).toEqual({ 'repo-2': ['other.ts'] });
    expect(useAppStore.getState().batchCommitReport).toBeUndefined();

    // workspace-1 的 session 中保存了 report，且 selections 被正确清除
    const ws1Session = useAppStore.getState().sessions['workspace-1'];
    expect(ws1Session?.commitSelections?.['repo-1']).toBeUndefined();
    expect(ws1Session?.batchCommitReport).toMatchObject({
      workspaceId: 'workspace-1',
      message: 'commit on ws1',
    });
  });

  it('retryBatchResult routes to original report when multiple failures occur for the same repository', async () => {
    const workspace = snapshot('workspace-1', 1);
    workspace.repositories = [repository('repo-a', 'Repo A')];

    const requests: Array<{ type: string; payload: any }> = [];
    const bridge = new MockBridge((command) => {
      requests.push(command as any);
      if (command.type === 'batchCommit') {
        return [{
          repoId: 'repo-a',
          commitAttempted: true,
          committed: false,
          revision: null,
          pushed: false,
          pushAttempted: false,
          failedStage: 'commit',
          recoveryHint: null,
          error: { code: 'FAIL', message: 'failed', command: 'git commit', exitCode: 1, stderr: '', recoverable: false },
        }];
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      snapshot: workspace,
      notifications: [],
      batchCommitReports: {},
    });

    // 1. 第一次提交失败
    await useAppStore.getState().commitMany([
      { repoId: 'repo-a', paths: ['a.txt'], unstagePaths: [], amend: false, stagedOnly: true },
    ], 'commit message 1', false);

    // 2. 第二次提交失败
    await useAppStore.getState().commitMany([
      { repoId: 'repo-a', paths: ['b.txt'], unstagePaths: [], amend: false, stagedOnly: true },
    ], 'commit message 2', false);

    const notifications = useAppStore.getState().notifications;
    expect(notifications.length).toBe(2);

    // notifications 是按时间倒序存放的，最新的在第 0 位，第一次通知在第 1 位
    const firstNotification = notifications[1];
    const firstAction = firstNotification.actions.find((a) => a.type === 'retryBatchResult');
    expect(firstAction).toBeDefined();

    // 清空抓取到的 requests
    requests.length = 0;

    // 3. 点击第一次通知的重试 action
    await useAppStore.getState().performNotificationAction(firstNotification.id, 0);

    // 4. 核心断言：重试使用的 message 必须是第一次的 'commit message 1'，paths 是 ['a.txt']，绝不被第二次覆盖！
    const retryRequest = requests.find((r) => r.type === 'batchCommit');
    expect(retryRequest).toBeDefined();
    expect(retryRequest?.payload.targets[0].message).toBe('commit message 1');
    expect(retryRequest?.payload.targets[0].paths).toEqual(['a.txt']);
  });

  it('commitMany respects explicit targetWorkspaceId independent of active tab', async () => {
    const workspace1 = snapshot('workspace-1', 1);
    const workspace2 = snapshot('workspace-2', 2);
    workspace1.repositories = [repository('repo-1', 'Repo 1')];
    workspace2.repositories = [repository('repo-2', 'Repo 2')];

    const requests: Array<{ type: string; payload: any }> = [];
    const bridge = new MockBridge((command) => {
      requests.push(command as any);
      return [];
    });

    // 当前活跃工作区是 workspace-2
    useAppStore.setState({
      bridge,
      snapshot: workspace2,
    });

    // 显式指定 targetWorkspaceId = 'workspace-1' 发起提交
    await useAppStore.getState().commitMany([
      { repoId: 'repo-1', paths: ['staged.ts'], unstagePaths: [], amend: false, stagedOnly: true },
    ], 'commit on ws1', false, 'workspace-1');

    const commitRequest = requests.find((r) => r.type === 'batchCommit');
    expect(commitRequest).toBeDefined();
    expect(commitRequest?.payload.workspace_id).toBe('workspace-1');
  });

  it('retryBatchResult blocks execution and never falls back when specified reportId is absent', async () => {
    const workspace = snapshot('workspace-1', 1);
    workspace.repositories = [repository('repo-a', 'Repo A')];

    const requests: Array<{ type: string; payload: any }> = [];
    const bridge = new MockBridge((command) => {
      requests.push(command as any);
      return [];
    });

    useAppStore.setState({
      bridge,
      snapshot: workspace,
      batchCommitReport: {
        id: 'new-report-id',
        workspaceId: 'workspace-1',
        message: 'new message',
        push: false,
        results: [{
          repoId: 'repo-a',
          commitAttempted: true,
          committed: false,
          revision: null,
          pushed: false,
          pushAttempted: false,
          failedStage: 'commit',
          recoveryHint: null,
          error: { code: 'FAIL', message: 'err', command: 'git commit', exitCode: 1, stderr: '', recoverable: false },
        }],
        targets: [{ repoId: 'repo-a', paths: ['new.txt'], unstagePaths: [], amend: false, stagedOnly: true }],
      },
      batchCommitReports: {
        'new-report-id': {
          id: 'new-report-id',
          workspaceId: 'workspace-1',
          message: 'new message',
          push: false,
          results: [{
            repoId: 'repo-a',
            commitAttempted: true,
            committed: false,
            revision: null,
            pushed: false,
            pushAttempted: false,
            failedStage: 'commit',
            recoveryHint: null,
            error: { code: 'FAIL', message: 'err', command: 'git commit', exitCode: 1, stderr: '', recoverable: false },
          }],
          targets: [{ repoId: 'repo-a', paths: ['new.txt'], unstagePaths: [], amend: false, stagedOnly: true }],
        },
      },
    });

    // 调用已不存在的旧报告 ID 进行重试
    await useAppStore.getState().retryBatchResult('repo-a', { reportId: 'obsolete-report-id' });

    // 验证绝不发起任何 batchCommit 请求，严禁 fallback 到 new-report-id
    const retryRequest = requests.find((r) => r.type === 'batchCommit');
    expect(retryRequest).toBeUndefined();
  });

  it('closeTab removes session and prevents switchTab from restoring closed workspace into sessions cache', async () => {
    const ws1 = snapshot('ws-1', 1);
    const ws2 = snapshot('ws-2', 1);

    const bridge = new MockBridge((command) => {
      if (command.type === 'workspaceOpen') {
        const payload = (command as any).payload;
        if (payload?.paths?.[0]?.[0]?.includes('ws-1')) return ws1;
        return ws2;
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      tabs: [ws1.workspace, ws2.workspace],
      activeTabId: 'ws-1',
      snapshot: ws1,
      sessions: {
        'ws-1': {
          snapshot: ws1,
          allRepositories: ws1.repositories,
          selectedRepoId: ws1.repositories[0]?.meta.id,
          selectedFile: undefined,
          fileHistoryTarget: undefined,
          historyFilter: '',
          historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null },
          diff: undefined,
          changesDiff: undefined,
          changes: undefined,
          merge: undefined,
          mergeTarget: undefined,
          mergeResolutions: {},
          mergeScope: 'all',
          mergeResult: '',
          commitMessage: '',
          mergeMessageSuggestion: undefined,
          amendRepoIds: [],
          commitSelections: {},
          comparisonTarget: undefined,
          comparison: undefined,
          mode: 'history',
          diffReturnMode: undefined,
          history: [],
          historyHasMore: false,
          historyByRepo: {},
          historyTopology: [],
          historyTopologyByRepo: {},
          historyHasMoreByRepo: {},
          historyLoading: false,
          branchesLoading: false,
          historyScope: { repoIds: null, revisionsByRepo: {} },
          branches: [],
          tags: [],
          branchesByRepo: {},
          tagsByRepo: {},
          conflicts: [],
          subtrees: {},
          submodules: {},
          worktrees: {},
          stashes: {},
          shelves: {},
          changelists: {},
          remotes: {},
          unpushedCommits: {},
          incomingCommits: {},
          selectedCommits: [],
          selectedPrimaryKey: undefined,
          selectedCommit: undefined,
          selectedCommitDetails: {},
          selectedCommitLoading: {},
          selectedCommitError: {},
          mergeCommits: {},
          mergeCommitsLoading: {},
          mergeParentFiles: {},
          mergeParentFilesLoading: {},
          mergeParentFilesError: {},
          loadErrors: {},
        },
        'ws-2': {
          snapshot: ws2,
          allRepositories: ws2.repositories,
          selectedRepoId: ws2.repositories[0]?.meta.id,
          selectedFile: undefined,
          fileHistoryTarget: undefined,
          historyFilter: '',
          historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null },
          diff: undefined,
          changesDiff: undefined,
          changes: undefined,
          merge: undefined,
          mergeTarget: undefined,
          mergeResolutions: {},
          mergeScope: 'all',
          mergeResult: '',
          commitMessage: '',
          mergeMessageSuggestion: undefined,
          amendRepoIds: [],
          commitSelections: {},
          comparisonTarget: undefined,
          comparison: undefined,
          mode: 'history',
          diffReturnMode: undefined,
          history: [],
          historyHasMore: false,
          historyByRepo: {},
          historyTopology: [],
          historyTopologyByRepo: {},
          historyHasMoreByRepo: {},
          historyLoading: false,
          branchesLoading: false,
          historyScope: { repoIds: null, revisionsByRepo: {} },
          branches: [],
          tags: [],
          branchesByRepo: {},
          tagsByRepo: {},
          conflicts: [],
          subtrees: {},
          submodules: {},
          worktrees: {},
          stashes: {},
          shelves: {},
          changelists: {},
          remotes: {},
          unpushedCommits: {},
          incomingCommits: {},
          selectedCommits: [],
          selectedPrimaryKey: undefined,
          selectedCommit: undefined,
          selectedCommitDetails: {},
          selectedCommitLoading: {},
          selectedCommitError: {},
          mergeCommits: {},
          mergeCommitsLoading: {},
          mergeParentFiles: {},
          mergeParentFilesLoading: {},
          mergeParentFilesError: {},
          loadErrors: {},
        },
      },
    });

    // 关闭当前活动的 ws-1 标签页
    await useAppStore.getState().closeTab('ws-1');

    // 验证激活标签切换为 ws-2
    expect(useAppStore.getState().activeTabId).toBe('ws-2');
    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(['ws-2']);

    // 关键断言：已关闭的 ws-1 绝不应该被 switchTab 写回 sessions 中！
    expect(useAppStore.getState().sessions['ws-1']).toBeUndefined();
    expect(useAppStore.getState().sessions['ws-2']).toBeDefined();
  });

  it('retryBatchResult blocks retrying parent repository when child submodule is not committed or pushed', async () => {
    const parentRepo = repository('repo-parent', 'Parent Repo');
    const childRepo: RepositoryStatus = {
      ...repository('repo-child', 'Child Submodule'),
      meta: {
        ...repository('repo-child', 'Child Submodule').meta,
        parentRepoId: 'repo-parent',
        depth: 1,
        isSubmodule: true,
      },
    };
    const workspace = snapshot('ws-1', 1);
    workspace.repositories = [parentRepo, childRepo];

    const requests: Array<{ type: string; payload: any }> = [];
    const bridge = new MockBridge((command) => {
      requests.push(command as any);
      if (command.type === 'batchCommit') {
        const payload = (command as any).payload;
        return payload.targets.map((t: any) => ({
          repoId: t.repoId,
          commitAttempted: true,
          committed: true,
          revision: 'rev-success',
          pushed: Boolean(payload.push),
          pushAttempted: Boolean(payload.push),
          failedStage: null,
          recoveryHint: null,
          error: null,
        }));
      }
      return [];
    });

    const reportId = 'batch-report-submodule';
    useAppStore.setState({
      bridge,
      snapshot: workspace,
      allRepositories: [parentRepo, childRepo],
      batchCommitReports: {
        [reportId]: {
          id: reportId,
          workspaceId: 'ws-1',
          message: 'feat: update parent and submodule',
          push: true,
          targets: [
            { repoId: 'repo-child', paths: ['child.txt'], unstagePaths: [], amend: false, stagedOnly: true },
            { repoId: 'repo-parent', paths: ['parent.txt'], unstagePaths: [], amend: false, stagedOnly: true },
          ],
          results: [
            {
              repoId: 'repo-child',
              commitAttempted: true,
              committed: false,
              revision: null,
              pushed: false,
              pushAttempted: false,
              failedStage: 'commit',
              recoveryHint: null,
              error: { code: 'FAIL', message: 'Submodule pre-commit failed', command: 'git commit', exitCode: 1, stderr: '', recoverable: false },
            },
            {
              repoId: 'repo-parent',
              commitAttempted: false,
              committed: false,
              revision: null,
              pushed: false,
              pushAttempted: false,
              failedStage: 'dependency',
              recoveryHint: 'Fix child submodule issues and retry',
              error: { code: 'SUBMODULE_DEPENDENCY_FAILED', message: 'Skipped because child submodule "Child Submodule" failed to commit.', command: 'batch_commit', exitCode: 1, stderr: '', recoverable: false },
            },
          ],
        },
      },
    });

    // 1. 尝试直接重试父仓库
    await useAppStore.getState().retryBatchResult('repo-parent', { reportId });

    // 关键安全断言：子模块尚未提交/推送，父仓库重试必须被坚决拦截！绝不能向 bridge 发出 batchCommit
    expect(requests.filter((r) => r.type === 'batchCommit')).toHaveLength(0);
    // 并且产生了一条警告通知
    const notifications = useAppStore.getState().notifications;
    expect(notifications.some((n) => n.title === 'Commit retry blocked')).toBe(true);

    // 2. 现在先重试子模块
    await useAppStore.getState().retryBatchResult('repo-child', { reportId });
    expect(requests.filter((r) => r.type === 'batchCommit')).toHaveLength(1);
    expect(requests.find((r) => r.type === 'batchCommit')!.payload.targets[0].repoId).toBe('repo-child');

    // 此时子模块已成功提交且已推送，report 中的子模块状态已更新为成功
    requests.length = 0;

    // 3. 再次重试父仓库
    await useAppStore.getState().retryBatchResult('repo-parent', { reportId });

    // 此时子模块依赖已满足，父仓库重试应顺利放行
    expect(requests.filter((r) => r.type === 'batchCommit')).toHaveLength(1);
    expect(requests.find((r) => r.type === 'batchCommit')!.payload.targets[0].repoId).toBe('repo-parent');
  });

  it('persistCommitSelections maintains separate debounce timers per workspace and does not cancel adjacent workspace saves', async () => {
    vi.useFakeTimers();
    try {
      const sentRequests: Array<{ type: string; payload: any }> = [];
      const bridge = {
        send: (command: any) => sentRequests.push(command),
        request: vi.fn().mockResolvedValue([]),
        subscribe: () => () => undefined,
      };

      useAppStore.setState({
        bridge: bridge as any,
        snapshot: snapshot('workspace-1', 1),
        sessions: {
          'workspace-1': { commitSelections: { 'repo-1': ['a.ts'] } } as any,
          'workspace-2': { commitSelections: { 'repo-2': ['b.ts'] } } as any,
        },
      });

      // 1. workspace-1 触发选中变更
      useAppStore.getState().setCommitSelection('repo-1', ['a.ts'], true);

      // 2. 在 120ms 防抖计时器触发前（50ms），切换至 workspace-2 并触发选中变更
      vi.advanceTimersByTime(50);
      useAppStore.setState({ snapshot: snapshot('workspace-2', 2) });
      useAppStore.getState().setCommitSelection('repo-2', ['b.ts'], true);

      // 3. 时间前进 150ms，使得两个工作区的防抖定时器均到达执行时间
      vi.advanceTimersByTime(150);

      // 4. 核心断言：两个工作区的 saveCommitSelections 均被发送，未被取消
      const ws1Save = sentRequests.find((r) => r.type === 'saveCommitSelections' && r.payload.workspace_id === 'workspace-1');
      const ws2Save = sentRequests.find((r) => r.type === 'saveCommitSelections' && r.payload.workspace_id === 'workspace-2');
      expect(ws1Save).toBeDefined();
      expect(ws2Save).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stashOperation prevents concurrent operations on the same repository in the same workspace', async () => {
    let pendingResolve: (val: any) => void = () => undefined;
    const pendingPromise = new Promise((resolve) => {
      pendingResolve = resolve;
    });

    const requests: any[] = [];
    const bridge = new MockBridge((command) => {
      if (command.type === 'stashOperation') {
        requests.push(command);
        return pendingPromise;
      }
      return [];
    });

    useAppStore.setState({
      bridge,
      snapshot: snapshot('workspace-1', 1),
    });

    // 第一次调用进入 pending
    const firstCall = useAppStore.getState().stashOperation('repo-1', { type: 'pop', reference: 'stash@{0}' });

    // 第二次并发调用相同仓库相同工作区
    const secondCall = useAppStore.getState().stashOperation('repo-1', { type: 'pop', reference: 'stash@{0}' });

    // 核心断言：第二次调用直接返回 false，被并发锁阻断
    const secondResult = await secondCall;
    expect(secondResult).toBe(false);
    expect(requests.length).toBe(1);

    // 完成第一次调用
    pendingResolve([]);
    const firstResult = await firstCall;
    expect(firstResult).toBe(true);
  });

  it('stashOperation and shelfOperation respect targetWorkspaceId independent of active tab', async () => {
    const requests: any[] = [];
    const bridge = new MockBridge((command) => {
      requests.push(command);
      return [];
    });

    // 当前活跃工作区是 workspace-2
    useAppStore.setState({
      bridge,
      snapshot: snapshot('workspace-2', 2),
    });

    // 显式指定 targetWorkspaceId = 'workspace-1' 调用 stashOperation
    await useAppStore.getState().stashOperation('repo-1', { type: 'create', message: 'test', paths: ['a.ts'], include_untracked: true }, 'workspace-1');

    const stashReq = requests.find((r) => r.type === 'stashOperation');
    expect(stashReq).toBeDefined();
    expect(stashReq?.payload.workspace_id).toBe('workspace-1');

    // 显式指定 targetWorkspaceId = 'workspace-1' 调用 shelfOperation
    await useAppStore.getState().shelfOperation('repo-1', { type: 'create', name: 'shelf-1', paths: ['a.ts'] }, 'workspace-1');

    const shelfReq = requests.find((r) => r.type === 'shelfOperation');
    expect(shelfReq).toBeDefined();
    expect(shelfReq?.payload.workspace_id).toBe('workspace-1');
  });

  it('sync isolates targetWorkspaceId for requests, notifications, and commit reload across workspace switches', async () => {
    const requests: any[] = [];
    const updateResult = {
      update: {
        summary: {
          kind: 'incoming',
          commitCount: 1,
          fileCount: 2,
          detail: { commits: [{ repoId: 'repo-1', hash: 'c1', shortHash: 'c1', author: 'a', message: 'm', date: '', parents: [] }] },
        },
      },
    };

    let resolveSync: (val: any) => void = () => undefined;
    const syncPromise = new Promise((resolve) => {
      resolveSync = resolve;
    });

    const bridge = new MockBridge((command) => {
      requests.push(command);
      if (command.type === 'sync') {
        return syncPromise;
      }
      if (command.type === 'unpushedCommits') {
        return [{ hash: 'u1', shortHash: 'u1', author: 'u', message: 'unpushed', date: '', repoId: command.payload.repo_id }];
      }
      if (command.type === 'incomingCommits') {
        return [{ hash: 'i1', shortHash: 'i1', author: 'i', message: 'incoming', date: '', repoId: command.payload.repo_id }];
      }
      return [];
    });

    const session1 = {
      unpushedCommits: {},
      incomingCommits: {},
      stashes: {},
      shelves: {},
    } as any;

    useAppStore.setState({
      bridge,
      snapshot: snapshot('workspace-1', 1),
      allRepositories: [repository('repo-1', 'Repo 1')],
      sessions: {
        'workspace-1': session1,
      },
    });

    // 在 workspace-1 发起 fetch，但中途切换到 workspace-2
    const syncCall = useAppStore.getState().sync('repo-1', 'fetch', true, {}, 'workspace-1');

    // 模拟用户在等待期间切换到了 workspace-2
    useAppStore.setState({
      snapshot: snapshot('workspace-2', 2),
      sessions: {
        'workspace-1': session1,
        'workspace-2': { unpushedCommits: {}, incomingCommits: {} } as any,
      },
    });

    // 完成 sync
    resolveSync(updateResult);
    await syncCall;

    // 1. sync 请求的 workspace_id 必须是 workspace-1
    const syncReq = requests.find((r) => r.type === 'sync');
    expect(syncReq?.payload.workspace_id).toBe('workspace-1');

    // 2. 随后的 unpushedCommits 与 incomingCommits 请求也必须是 workspace-1
    const unpushedReq = requests.find((r) => r.type === 'unpushedCommits');
    expect(unpushedReq?.payload.workspace_id).toBe('workspace-1');
    const incomingReq = requests.find((r) => r.type === 'incomingCommits');
    expect(incomingReq?.payload.workspace_id).toBe('workspace-1');

    // 3. 通知的 workspaceId 必须是 workspace-1，绝不能被标成切走后的 workspace-2
    const notification = useAppStore.getState().notifications.find((n) => n.title === 'Repository update');
    expect(notification).toBeDefined();
    expect(notification?.workspaceId).toBe('workspace-1');

    // 4. sessions['workspace-1'] 成功更新了 unpushedCommits 和 incomingCommits
    const updatedSession1 = useAppStore.getState().sessions['workspace-1'];
    expect(updatedSession1.unpushedCommits['repo-1']?.[0]?.hash).toBe('u1');
    expect(updatedSession1.incomingCommits['repo-1']?.[0]?.hash).toBe('i1');
  });

  it('handlePullAutoStashError records pending auto-stash under target workspace and does not hijack active tab of another workspace', async () => {
    const stashHash = 'abcdef1234567890';
    const bridge = new MockBridge((command) => {
      if (command.type === 'sync') {
        throw new BridgeError({
          code: 'GIT_PULL_CONFLICT_WITH_AUTO_STASH',
          message: 'Conflict with auto stash',
          command: 'git',
          exitCode: 1,
          stderr: 'conflict',
          recoverable: true,
          repositoryId: 'repo-1',
          subject: `stash:${stashHash}`,
        });
      }
      if (command.type === 'stashes') {
        return [{ reference: 'stash@{0}', hash: stashHash, branch: 'main', message: 'auto', fullMessage: 'auto', date: '', files: [] }];
      }
      return [];
    });

    const bootstrap = {
      state: { layout: { activeTab: 'sync' } },
    } as any;

    useAppStore.setState({
      bridge,
      bootstrap,
      snapshot: snapshot('workspace-1', 1),
      allRepositories: [repository('repo-1', 'Repo 1')],
      sessions: {
        'workspace-1': { stashes: {} } as any,
        'workspace-2': { stashes: {} } as any,
      },
    });

    // 模拟在 workspace-1 发起 pull，但切到 workspace-2（当前前台标签为 'sync'）
    useAppStore.setState({ snapshot: snapshot('workspace-2', 2) });

    await useAppStore.getState().sync('repo-1', 'pull', true, {}, 'workspace-1');

    // 1. 产生错误恢复提示，所属工作区必须是 workspace-1
    const notification = useAppStore.getState().notifications.find((n) => n.title === 'Restoring local changes needs attention');
    expect(notification).toBeDefined();
    expect(notification?.workspaceId).toBe('workspace-1');

    // 2. 当前前台（workspace-2）的活跃页签未被篡改，依然保持 'sync'（不会被强制切成 'changes' 或 'stash'）
    expect(useAppStore.getState().bootstrap?.state.layout?.activeTab).toBe('sync');
  });

  it('reloads repository status and conflicts when continueRepositoryOperation fails', async () => {
    let statusRequested = false;
    let conflictsRequested = false;
    const bridge = new MockBridge((command) => {
      if (command.type === 'continueRepositoryOperation') {
        throw new BridgeError({
          code: 'OPERATION_FAILED',
          message: 'rebase failed due to conflict',
          command: 'git',
          exitCode: 1,
          stderr: 'CONFLICT (content): Merge conflict in file.txt',
          recoverable: true,
          repositoryId: 'repo-1',
        });
      }
      if (command.type === 'repositoryStatus') {
        statusRequested = true;
        return {
          meta: { id: 'repo-1', name: 'Repo 1', rootPath: '/tmp/repo-1', color: '#ff0000', kind: 'git', depth: 0, isSubmodule: false, isWorktree: false, parentRepoId: null },
          branch: 'feature',
          revision: 'abc',
          ahead: 0,
          behind: 0,
          files: [{ path: 'file.txt', status: 'modified', staged: false, unstaged: false, conflicted: true }],
          conflicts: 1,
          operation: 'rebase',
        };
      }
      if (command.type === 'conflicts') {
        conflictsRequested = true;
        return [
          { repoId: 'repo-1', repoName: 'Repo 1', repoColor: '#ff0000', path: 'file.txt', kind: 'git', binary: false, conflictType: 'text' },
        ];
      }
      return [];
    });

    const repo = repository('repo-1', 'Repo 1');
    useAppStore.setState({
      bridge,
      snapshot: { ...snapshot('workspace-1', 1), repositories: [repo] },
      allRepositories: [repo],
      conflicts: [],
    });

    const ok = await useAppStore.getState().continueRepositoryOperation('repo-1', 'rebase');
    expect(ok).toBe(false);
    expect(statusRequested).toBe(true);
    expect(conflictsRequested).toBe(true);
    expect(useAppStore.getState().conflicts).toHaveLength(1);
    expect(useAppStore.getState().conflicts[0].path).toBe('file.txt');
  });
});

describe('scheduled background fetch', () => {
  it('uses the configured interval, excludes SVN/worktrees, stays background and does not overlap', async () => {
    vi.useFakeTimers();
    const data = structuredClone(bootstrap); data.state.settings = { autoFetchIntervalMinutes: 1, autoRefreshInterval: 0, fetchOnStartup: false } as DesktopSettings;
    const ws = { ...snapshot('auto-fetch', 1), repositories: [repository('git', 'Git'), { ...repository('svn', 'SVN'), meta: { ...repository('svn', 'SVN').meta, kind: 'svn' as const } }, { ...repository('tree', 'Tree'), meta: { ...repository('tree', 'Tree').meta, isWorktree: true } }] };
    const fetches: Array<{ command: BridgeCommand; options: RequestOptions | undefined }> = [];
    const gate = deferred<unknown>();
    const bridge = new MockBridge((command, options) => {
      if (command.type === 'bootstrap') return data;
      if (command.type === 'workspaceRefresh' || command.type === 'workspaceOpen') return ws;
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'sync') { fetches.push({ command, options }); return gate.promise; }
      return [];
    });
    try {
      await useAppStore.getState().initialize(bridge); useAppStore.setState({ snapshot: ws, allRepositories: ws.repositories });
      await vi.advanceTimersByTimeAsync(59_999); expect(fetches).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1); expect(fetches).toHaveLength(1);
      expect(fetches[0].command).toMatchObject({ type: 'sync', payload: { action: 'fetch', repo_id: 'git' } });
      expect(fetches[0].options).toMatchObject({ showProgress: false, timeoutMs: 600_000 });
      await vi.advanceTimersByTimeAsync(120_000); expect(fetches).toHaveLength(1);
      const lease = JSON.parse(localStorage.getItem('versiondock:scheduler:auto-fetch:auto-fetch')!);
      expect(lease.expiresAt).toBeGreaterThan(Date.now());
      gate.resolve({ output: '', update: null }); await vi.advanceTimersByTimeAsync(0);
      useAppStore.getState().dispose(); await vi.advanceTimersByTimeAsync(60_000); expect(fetches).toHaveLength(1);
    } finally { gate.resolve(null); useAppStore.getState().dispose(); vi.useRealTimers(); }
  });
  it('disables scheduled fetch when interval is zero', async () => {
    vi.useFakeTimers(); const data = structuredClone(bootstrap); data.state.settings = { autoFetchIntervalMinutes: 0, autoRefreshInterval: 0, fetchOnStartup: false } as DesktopSettings;
    const fetch = vi.fn(); const bridge = new MockBridge((command) => { if (command.type === 'bootstrap') return data; if (command.type === 'sync') fetch(); return []; });
    try { await useAppStore.getState().initialize(bridge); const ws = { ...snapshot('disabled', 1), repositories: [repository('git', 'Git')] }; useAppStore.setState({ snapshot: ws, allRepositories: ws.repositories }); await vi.advanceTimersByTimeAsync(3_600_000); expect(fetch).not.toHaveBeenCalled(); }
    finally { useAppStore.getState().dispose(); vi.useRealTimers(); }
  });
});

it('external commit refs events clear committed files and refresh ahead without a manual workspace reload', async () => {
  vi.useFakeTimers();
  let subscriber: ((event: BridgeEvent) => void) | undefined;
  const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
  const previous = { ...repository('external', 'External'), files: [{ path: 'file.txt', status: 'modified', staged: false, unstaged: true, conflicted: false, conflictType: null, conflictTypes: null, conflictStatus: null, submodule: false, isTruncated: false, truncationReason: null }] };
  const updated = { ...repository('external', 'External'), revision: 'external-commit', ahead: 1 };
  const commit: CommitNode = { repoId: 'external', hash: 'external-commit', shortHash: 'external', parents: [], author: 'External', email: '', authorDate: '', committerDate: '', message: 'external commit', refs: [], unpushed: true };
  const bridge = new MockBridge((command, options) => {
    requests.push({ command, options });
    if (command.type === 'bootstrap') return bootstrap;
    if (command.type === 'repositoryStatus') return updated;
    if (command.type === 'history') return { commits: [commit], hasMore: false };
    if (command.type === 'branches') return [{ name: 'main', current: true, remote: false, remoteName: null, upstream: 'origin/main', ahead: 1, behind: 0, detachedTag: null, detachedHash: null, lastCommitMessage: 'external commit', lastCommitDate: null }];
    return [];
  });
  bridge.subscribe = (handler) => { subscriber = handler; return () => { subscriber = undefined; }; };
  try {
    await useAppStore.getState().initialize(bridge);
    const current = { ...snapshot('external-workspace', 1), repositories: [previous] };
    useAppStore.setState({ snapshot: current, allRepositories: current.repositories, selectedRepoId: 'external', historyByRepo: { external: [] }, historyTopologyByRepo: { external: [] }, mode: 'history' });
    requests.length = 0;
    // Also accept old/race-coalesced refs-only events, not just the new richer native scopes.
    subscriber?.({ workspaceId: current.workspace.id, repoId: 'external', generation: 1, source: 'watcher', scopes: ['refs', 'history'] });
    await vi.advanceTimersByTimeAsync(301);
    const state = useAppStore.getState();
    expect(state.snapshot?.repositories[0]).toMatchObject({ revision: 'external-commit', ahead: 1, files: [] });
    expect(state.branchesByRepo.external[0]).toMatchObject({ name: 'main', ahead: 1 });
    expect(state.historyByRepo.external[0].hash).toBe('external-commit');
    expect(state.mode).toBe('history');
    expect(requests.find(({ command }) => command.type === 'repositoryStatus')?.options?.showProgress).toBe(false);
    expect(requests.some(({ command }) => command.type === 'unpushedCommits')).toBe(true);
    expect(requests.some(({ command }) => command.type === 'workspaceRefresh')).toBe(false);
    expect(requests.some(({ command }) => command.type === 'sync')).toBe(false);
  } finally { useAppStore.getState().dispose(); vi.useRealTimers(); }
});
