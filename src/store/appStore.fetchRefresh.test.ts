import { afterEach, expect, it, vi } from 'vitest';
import type { BootstrapData, BranchInfo, BridgeCommand, OperationEvent, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge, createOperationRequestEvent, type RequestOptions } from '../platform/bridge';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import { useAppStore } from './appStore';

const original = useAppStore.getState();
const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

async function setup(branches: BranchInfo[] = []) {
  vi.useFakeTimers();
  const repo = (id: string): RepositoryStatus => ({
    meta: { id, name: id, rootPath: `/tmp/fetch/${id}`, kind: 'git', color: '#aaa', depth: 0, parentRepoId: null, isSubmodule: false, isWorktree: id === 'other' },
    branch: 'main', revision: 'before', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
  });
  const ws: WorkspaceSnapshot = {
    workspace: { id: 'fetch-coalescing', name: 'Fetch', paths: ['/tmp/fetch'], available: true, lastOpenedAt: '' },
    generation: 1, repositories: ['a', 'b', 'other'].map(repo), tools: { git: true, svn: true, svnadmin: true },
  };
  const data: BootstrapData = {
    applicationSessionId: 'fetch-test', tools: ws.tools,
    capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false },
    state: { recentWorkspaces: [], lastWorkspaceId: null, settings: { ...DEFAULT_SETTINGS, autoFetchIntervalMinutes: 1, autoRefreshInterval: 0, fetchOnStartup: false, autoCheckUpdates: false } },
  };
  const gates = { a: deferred(), b: deferred() };
  const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
  const bridge = new MockBridge((command, options) => {
    requests.push({ command, options });
    if (command.type === 'bootstrap') return data;
    if (command.type === 'sync') return gates[command.payload.repo_id as 'a' | 'b'].promise;
    if (command.type === 'repositoryStatus') return ws.repositories.find(repo => repo.meta.id === command.payload.repo_id);
    if (command.type === 'workspaceRefresh' || command.type === 'workspaceOpen') return ws;
    if (command.type === 'history') return { commits: [], hasMore: false };
    if (command.type === 'branches') return branches;
    return [];
  });
  await useAppStore.getState().initialize(bridge);
  useAppStore.setState({ snapshot: ws, allRepositories: ws.repositories, tabs: [ws.workspace], activeTabId: ws.workspace.id, selectedRepoId: 'a' });
  requests.length = 0;
  const count = (type: string, repoId?: string) => requests.filter(({ command }) => command.type === type
    && (!repoId || ('payload' in command && 'repo_id' in command.payload && command.payload.repo_id === repoId))).length;
  const change = (repoId: string, source: 'watcher' | 'operation' = 'watcher') => bridge.emit({
    workspaceId: ws.workspace.id, repoId, generation: 1, source, scopes: ['status', 'refs', 'history', 'unpushed'],
  });
  const remoteFetch = (status: OperationEvent['status']) => {
    const context = createOperationRequestEvent({ type: 'sync', payload: { workspace_id: ws.workspace.id, repo_id: 'a', action: 'fetch', remote: null, branch: null, force: false } }, { showProgress: false }, 'remote-fetch').context;
    bridge.emit({ operationId: 'remote-fetch', context, startedAt: '', status, phase: 'fetching', message: 'Fetching remote references', completed: null, total: null, cancellable: true, error: null });
  };
  return { ws, data, bridge, gates, requests, count, change, remoteFetch };
}

afterEach(() => {
  useAppStore.getState().dispose();
  useAppStore.setState(original, true);
  localStorage.clear();
  vi.useRealTimers();
});

it.each(['macos', 'windows', 'linux'] as const)('coalesces scheduled multi-repository fetch refreshes on %s', async platform => {
  const { bridge, gates, count, change, requests } = await setup();
  vi.spyOn(bridge, 'platform').mockReturnValue(platform);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(count('sync')).toBe(2);
  for (let round = 0; round < 3; round++) {
    change('a'); change('b');
    await vi.advanceTimersByTimeAsync(350);
  }
  expect(count('branches')).toBe(0);
  expect(count('history')).toBe(0);
  expect(count('repositoryStatus', 'a')).toBeGreaterThan(0);
  change('other');
  await vi.advanceTimersByTimeAsync(350);
  expect(count('history', 'other')).toBe(1);
  change('a', 'operation'); gates.a.resolve({ output: '', update: null });
  await vi.advanceTimersByTimeAsync(350);
  expect(count('history', 'a')).toBe(1);
  expect(count('history', 'b')).toBe(0);
  change('b', 'operation'); gates.b.resolve({ output: '', update: null });
  await vi.advanceTimersByTimeAsync(350);
  for (const id of ['a', 'b']) {
    for (const type of ['history', 'historyTopology', 'branches', 'tags', 'remotes', 'unpushedCommits', 'incomingCommits']) expect(count(type, id)).toBe(1);
  }
  expect(count('workspaceRefresh')).toBe(0);
  expect(requests.filter(({ command }) => command.type === 'branches').every(({ options }) => !options?.signal?.aborted)).toBe(true);
});

it('coalesces manual fetch, retains branch pruning notices and refreshes the final status before completion', async () => {
  const { ws, gates, count, change } = await setup([{ name: 'old', current: false, remote: false, upstream: 'origin/old',
    remoteName: null, ahead: 0, behind: 0, detachedTag: null, detachedHash: null, lastCommitMessage: '', lastCommitDate: null }]);
  const pending = useAppStore.getState().fetchRepositories(['a', 'b']);
  for (let round = 0; round < 3; round++) { change('a'); change('b'); await vi.advanceTimersByTimeAsync(350); }
  expect(count('history')).toBe(0);
  ws.repositories[0] = { ...ws.repositories[0], behind: 2 };
  change('a', 'operation'); change('b', 'operation');
  gates.a.resolve({ output: '', update: null }); gates.b.resolve({ output: '', update: null });
  await pending;
  await vi.advanceTimersByTimeAsync(350);
  expect(count('history', 'a')).toBe(1);
  expect(count('history', 'b')).toBe(1);
  expect(count('unpushedCommits', 'a')).toBe(1);
  expect(count('incomingCommits', 'a')).toBe(1);
  expect(count('workspaceRefresh')).toBe(0);
  expect(useAppStore.getState().allRepositories[0].behind).toBe(2);
  expect(useAppStore.getState().notifications.some(item => item.title === 'Prune Branches')).toBe(true);
});

it.each(['succeeded', 'failed', 'cancelled'] as const)('coalesces native events from another window and releases on %s', async status => {
  const { remoteFetch, change, count } = await setup();
  remoteFetch('running');
  for (let round = 0; round < 3; round++) { change('a'); await vi.advanceTimersByTimeAsync(350); }
  expect(count('history', 'a')).toBe(0);
  change('a', 'operation'); remoteFetch(status);
  await vi.advanceTimersByTimeAsync(350);
  expect(count('history', 'a')).toBe(1);
  change('a'); await vi.advanceTimersByTimeAsync(350);
  expect(count('history', 'a')).toBe(2);
});

it.each(['failure', 'cancel'] as const)('refreshes partially changed refs after a local fetch ends in %s', async reason => {
  const { gates, change, count } = await setup();
  const pending = useAppStore.getState().sync('a', 'fetch', false);
  change('a'); await vi.advanceTimersByTimeAsync(350);
  expect(count('history')).toBe(0);
  gates.a.reject(reason === 'cancel' ? new DOMException('Cancelled', 'AbortError') : new Error('Network unavailable'));
  await pending; await vi.advanceTimersByTimeAsync(350);
  expect(count('history', 'a')).toBe(1);
});

it('does not apply the old workspace fetch refresh after switching tabs', async () => {
  const { ws, gates, change, count } = await setup();
  const pending = useAppStore.getState().sync('a', 'fetch', false);
  change('a'); await vi.advanceTimersByTimeAsync(350);
  const other = { ...ws, workspace: { ...ws.workspace, id: 'new-workspace' } };
  useAppStore.setState({ snapshot: other, activeTabId: other.workspace.id, tabs: [ws.workspace, other.workspace] });
  gates.a.resolve({ output: '', update: null }); await pending; await vi.advanceTimersByTimeAsync(350);
  expect(count('history')).toBe(0);
  expect(useAppStore.getState().snapshot?.workspace.id).toBe('new-workspace');
});

it('uses the same coalesced refresh for startup fetch without another workspace scan', async () => {
  const { ws, data, bridge, gates, requests, count, change } = await setup();
  useAppStore.getState().dispose();
  useAppStore.setState(original, true);
  data.launchWorkspaceId = ws.workspace.id;
  data.state.recentWorkspaces = [ws.workspace];
  data.state.settings!.fetchOnStartup = true;
  requests.length = 0;
  const initializing = useAppStore.getState().initialize(bridge);
  await vi.advanceTimersByTimeAsync(0);
  expect(count('sync')).toBe(2);
  const initialHistory = count('history');
  for (let round = 0; round < 3; round++) { change('a'); change('b'); await vi.advanceTimersByTimeAsync(350); }
  expect(count('history')).toBe(initialHistory);
  change('a', 'operation'); change('b', 'operation');
  gates.a.resolve({ output: '', update: null }); gates.b.resolve({ output: '', update: null });
  await initializing;
  await vi.advanceTimersByTimeAsync(350);
  expect(count('history')).toBe(initialHistory + 2);
  expect(count('workspaceRefresh')).toBe(0);
});
