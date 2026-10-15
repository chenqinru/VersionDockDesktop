import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand, CommitNode, HistoryPage, RefreshScope, WorkspaceSnapshot } from '../bindings/generated';
import { BrowserDevBridge } from '../platform/browserDevBridge';
import type { BridgeEvent } from '../platform/bridge';
import { useAppStore } from './appStore';

const initial = useAppStore.getState();
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const tick = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
let bridge: BrowserDevBridge;
let original: BrowserDevBridge['request'];
const spyRequest = (bridge: BrowserDevBridge) => vi.spyOn(bridge, 'request');
let request: ReturnType<typeof spyRequest>;
let emit: (scopes: RefreshScope[], repoId?: string, workspaceId?: string) => void;
const calls = (type: BridgeCommand['type']) => request.mock.calls.filter(([command]) => command.type === type);

beforeEach(async () => {
  localStorage.clear();
  bridge = new BrowserDevBridge();
  original = bridge.request.bind(bridge);
  const subscribers = new Set<(event: BridgeEvent) => void>();
  const subscribe = bridge.subscribe.bind(bridge);
  vi.spyOn(bridge, 'subscribe').mockImplementation(handler => {
    subscribers.add(handler);
    const dispose = subscribe(handler);
    return () => { subscribers.delete(handler); dispose(); };
  });
  await useAppStore.getState().initialize(bridge);
  await useAppStore.getState().openWorkspace(['/browser-demo']);
  const settings = useAppStore.getState().bootstrap!.state.settings!;
  useAppStore.setState({ bootstrap: { ...useAppStore.getState().bootstrap!, state: { ...useAppStore.getState().bootstrap!.state,
    settings: { ...settings, autoFetchOnFocus: true } } } });
  request = spyRequest(bridge);
  emit = (scopes, repoId = 'api', workspaceId = useAppStore.getState().snapshot!.workspace.id) => {
    for (const subscriber of subscribers) subscriber({ workspaceId, repoId, generation: 1000, source: 'watcher', scopes });
  };
  vi.useFakeTimers();
});
afterEach(() => {
  useAppStore.getState().dispose();
  useAppStore.setState(initial, true);
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

function stubHistory(handler: () => Promise<HistoryPage> | HistoryPage) {
  request.mockImplementation((command, options) => command.type === 'history'
    ? Promise.resolve(handler()) : original(command, options));
}
const commit: CommitNode = { repoId: 'api', hash: 'external-new-commit', shortHash: 'external', parents: [], author: 'Tester', email: '',
  authorDate: '', committerDate: '', message: 'External commit', refs: [] };

describe('watcher catch-up and recovery', () => {
  it.each([false, true])('coalesces events during a history request and refreshes after it settles (silent: %s)', async silent => {
    const pending = deferred<HistoryPage>();
    let count = 0;
    stubHistory(() => ++count === 1 ? pending.promise : { commits: [commit], hasMore: false });
    useAppStore.setState({ historyScope: { repoIds: ['api'], revisionsByRepo: {} }, selectedCommits: [commit] });
    const loading = useAppStore.getState().loadHistory(true, silent);
    expect(useAppStore.getState().historyLoading).toBe(!silent);
    emit(['history']);
    await vi.advanceTimersByTimeAsync(310);
    emit(['history']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls('history')).toHaveLength(1);
    pending.resolve({ commits: [], hasMore: false });
    await loading;
    await vi.advanceTimersByTimeAsync(310);
    expect(calls('history')).toHaveLength(2);
    expect(useAppStore.getState().historyByRepo.api).toEqual([commit]);
    expect(useAppStore.getState().historyLoading).toBe(false);
  });

  it('does not let an old topology request overwrite the deferred refresh', async () => {
    const topology = deferred<[]>();
    let count = 0;
    request.mockImplementation((command, options) => {
      if (command.type === 'history') return Promise.resolve({ commits: count++ ? [commit] : [], hasMore: false });
      if (command.type === 'historyTopology') return count === 1 ? topology.promise : Promise.resolve([]);
      return original(command, options);
    });
    useAppStore.setState({ historyScope: { repoIds: ['api'], revisionsByRepo: {} }, historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null }, selectedCommits: [commit] });
    const loading = useAppStore.getState().loadHistory(true);
    await tick();
    expect(useAppStore.getState().historyTopologyLoading).toBe(true);
    emit(['history']);
    await vi.advanceTimersByTimeAsync(310);
    topology.resolve([]);
    await loading;
    expect(useAppStore.getState().historyByRepo.api).toEqual([commit]);
  });

  it.each(['repositoryStatus', 'branches', 'history', 'incomingCommits'] as const)('retries a failed %s read without needing another filesystem event', async type => {
    let failures = 1;
    request.mockImplementation((command, options) => {
      if (command.type === type && failures-- > 0) return Promise.reject(new Error('temporarily busy'));
      return original(command, options);
    });
    emit(['status', 'refs', 'history', 'unpushed']);
    await vi.advanceTimersByTimeAsync(310);
    expect(calls(type)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(990);
    expect(calls(type)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls(type)).toHaveLength(2);
  });

  it('refreshes the active diff after a transient read failure', async () => {
    const selected = { repoId: 'api', path: 'file.txt', staged: false };
    useAppStore.setState({ mode: 'diff', selectedFile: selected });
    let failures = 1;
    request.mockImplementation((command, options) => command.type === 'fileDiff' && failures-- > 0
      ? Promise.reject(new Error('file being saved')) : original(command, options));
    emit(['diff']);
    await vi.advanceTimersByTimeAsync(1_310);
    expect(calls('fileDiff')).toHaveLength(2);
    expect(useAppStore.getState().selectedFile).toEqual(selected);
    expect(useAppStore.getState().diff).toBeDefined();
  });

  it('preserves deferred history across a project switch without polling it', async () => {
    const first = useAppStore.getState().snapshot!;
    useAppStore.setState({ historyLoading: true });
    emit(['history']);
    await vi.advanceTimersByTimeAsync(310);
    useAppStore.setState({ snapshot: { ...first, workspace: { ...first.workspace, id: 'other-project' } }, historyLoading: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls('history')).toHaveLength(0);
    stubHistory(() => ({ commits: [commit], hasMore: false }));
    useAppStore.setState({ snapshot: first });
    await vi.advanceTimersByTimeAsync(310);
    expect(calls('history')).toHaveLength(1);
    expect(useAppStore.getState().historyByRepo.api).toEqual([commit]);
  });

  it('does not let a failing repository prevent other repositories from refreshing', async () => {
    request.mockImplementation((command, options) => command.type === 'repositoryStatus' && command.payload.repo_id === 'api'
      ? Promise.reject(new Error('busy repository')) : original(command, options));
    emit(['status'], 'api');
    emit(['status'], 'admin');
    await vi.advanceTimersByTimeAsync(310);
    const queried = calls('repositoryStatus').map(([command]) => command.type === 'repositoryStatus' ? command.payload.repo_id : '');
    expect(queried).toEqual(['api', 'admin']);
    await vi.advanceTimersByTimeAsync(990);
    expect(calls('repositoryStatus').filter(([command]) => command.type === 'repositoryStatus' && command.payload.repo_id === 'admin')).toHaveLength(1);
  });

  it('bounds retries, then lets a new filesystem event start a fresh attempt', async () => {
    request.mockImplementation((command, options) => command.type === 'repositoryStatus'
      ? Promise.reject(new Error('offline')) : original(command, options));
    emit(['status']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls('repositoryStatus')).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls('repositoryStatus')).toHaveLength(4);
    request.mockImplementation(original);
    emit(['status']);
    await vi.advanceTimersByTimeAsync(310);
    expect(calls('repositoryStatus')).toHaveLength(5);
  });

  it('retries snapshot refresh errors instead of silently consuming the event', async () => {
    let failures = 1;
    request.mockImplementation((command, options) => command.type === 'workspaceRefresh' && failures-- > 0
      ? Promise.reject(new Error('scan busy')) : original(command, options));
    emit(['workspaceSnapshot']);
    await vi.advanceTimersByTimeAsync(1_310);
    expect(calls('workspaceRefresh')).toHaveLength(2);
  });

  it('keeps recovery scoped to the originating project and cancels it on dispose', async () => {
    request.mockImplementation((command, options) => command.type === 'repositoryStatus'
      ? Promise.reject(new Error('busy')) : original(command, options));
    const current = useAppStore.getState().snapshot!;
    emit(['status']);
    await vi.advanceTimersByTimeAsync(310);
    const other: WorkspaceSnapshot = { ...current, workspace: { ...current.workspace, id: 'other' } };
    useAppStore.setState({ snapshot: other });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls('repositoryStatus')).toHaveLength(1);
    useAppStore.getState().dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls('repositoryStatus')).toHaveLength(1);
  });
});

function configureInterval(minutes: number) {
  return useAppStore.getState().updateSettings({ autoFetchIntervalMinutes: minutes });
}
function focus() { window.dispatchEvent(new Event('focus')); }

describe('unified automatic fetch', () => {
  it('shares per-project cooldown between interval and focus triggers', async () => {
    await configureInterval(1);
    await vi.advanceTimersByTimeAsync(60_000);
    const count = calls('sync').length;
    expect(count).toBeGreaterThan(0);
    focus(); await tick();
    expect(calls('sync')).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(50_000);
    focus(); await tick();
    expect(calls('sync')).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls('sync')).toHaveLength(count * 2);
  });

  it('also avoids fetching twice when focus precedes an interval tick', async () => {
    await configureInterval(15);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    focus(); await tick();
    const count = calls('sync').length;
    expect(count).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls('sync')).toHaveLength(count);
  });

  it('fetches an independent project during another project fetch and ignores the old refresh result', async () => {
    const first = useAppStore.getState().snapshot!;
    const pending = deferred<unknown>();
    request.mockImplementation((command, options) => {
      if (command.type === 'sync' && command.payload.workspace_id === first.workspace.id) return pending.promise;
      if (command.type === 'workspaceRefresh') return Promise.resolve({ ...first, workspace: { ...first.workspace, id: command.payload.workspace_id } });
      return original(command, options);
    });
    focus(); await tick();
    const count = calls('sync').length;
    focus(); await tick();
    expect(calls('sync')).toHaveLength(count);
    const other = { ...first, workspace: { ...first.workspace, id: 'other-project' } };
    useAppStore.setState({ snapshot: other });
    focus(); await tick();
    expect(calls('sync').length).toBeGreaterThan(count);
    const refreshes = calls('workspaceRefresh').length;
    pending.resolve({ output: '', update: null }); await tick();
    expect(calls('workspaceRefresh')).toHaveLength(refreshes);
  });

  it('keeps requests in flight scoped and aborts them when the store is disposed', async () => {
    const pending = deferred<unknown>();
    request.mockImplementation((command, options) => command.type === 'sync' ? pending.promise : original(command, options));
    focus(); await tick();
    const fetches = calls('sync');
    expect(fetches.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    focus(); await tick();
    expect(calls('sync')).toHaveLength(fetches.length);
    useAppStore.getState().dispose();
    expect(fetches.every(([, options]) => options?.signal?.aborted)).toBe(true);
    const refreshes = calls('workspaceRefresh').length;
    pending.resolve({ output: '', update: null }); await tick();
    expect(calls('workspaceRefresh')).toHaveLength(refreshes);
  });

  it('respects both automatic-fetch switches and does not mutate local files', async () => {
    await useAppStore.getState().updateSettings({ autoFetchOnFocus: false, autoFetchIntervalMinutes: 0 });
    focus(); await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls('sync')).toHaveLength(0);
    await useAppStore.getState().updateSettings({ autoFetchOnFocus: true });
    focus(); await tick();
    expect(calls('sync').length).toBeGreaterThan(0);
    expect(calls('sync').every(([command, options]) => command.type === 'sync'
      && command.payload.action === 'fetch' && options?.showProgress === false)).toBe(true);
  });

  it('respects per-project cross-window cooldown, settings, and disposal', async () => {
    const wid = useAppStore.getState().snapshot!.workspace.id;
    localStorage.setItem(`versiondock:auto-fetch-at:${wid}`, String(Date.now()));
    focus(); await tick();
    expect(calls('sync')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    focus(); await tick();
    expect(calls('sync').length).toBeGreaterThan(0);
    const count = calls('sync').length;
    useAppStore.getState().dispose();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    focus(); await tick();
    expect(calls('sync')).toHaveLength(count);
  });
});
