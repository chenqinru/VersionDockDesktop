import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { BrowserDevBridge } from '../platform/browserDevBridge';
import { BridgeError, createOperationRequestEvent, type BridgeEvent } from '../platform/bridge';
import { useAppStore } from './appStore';

const initial = useAppStore.getState();
let emit: (event: BridgeEvent) => void;
const spyRequest = (bridge: BrowserDevBridge) => vi.spyOn(bridge, 'request');
let request: ReturnType<typeof spyRequest>;
let original: BrowserDevBridge['request'];
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const requested = (id = 'updating', wid = useAppStore.getState().snapshot!.workspace.id) => createOperationRequestEvent({ type: 'sync', payload: { workspace_id: wid, repo_id: 'api', action: 'pullRebase', remote: null, branch: null } }, {}, id);
const settled = (id = 'updating') => emit({ progressEvent: true, type: 'operation-settled', requestId: id });
const watcher = () => emit({ workspaceId: useAppStore.getState().snapshot!.workspace.id, repoId: 'api', source: 'watcher', generation: 1000, scopes: ['status', 'index'] });

beforeEach(async () => {
  localStorage.clear();
  const bridge = new BrowserDevBridge();
  original = bridge.request.bind(bridge);
  const subscribers = new Set<(event: BridgeEvent) => void>();
  const subscribe = bridge.subscribe.bind(bridge);
  vi.spyOn(bridge, 'subscribe').mockImplementation((handler) => { subscribers.add(handler); const dispose = subscribe(handler); return () => { subscribers.delete(handler); dispose(); }; });
  emit = (event) => subscribers.forEach((subscriber) => subscriber(event));
  await useAppStore.getState().initialize(bridge);
  await useAppStore.getState().openWorkspace(['/browser-demo']);
  useAppStore.getState().setCommitSelection('api', useAppStore.getState().allRepositories.find((repo) => repo.meta.id === 'api')!.files.map((file) => file.path), true);
  request = spyRequest(bridge);
  vi.useFakeTimers();
});
afterEach(() => { useAppStore.getState().dispose(); useAppStore.setState(initial, true); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('stable commit panel during update and restoration', () => {
  it('retains files and selections while refresh events accumulate, then publishes restored data', async () => {
    const before = useAppStore.getState().allRepositories;
    const selection = structuredClone(useAppStore.getState().commitSelections);
    emit(requested()); watcher();
    emit({ workspaceId: useAppStore.getState().snapshot!.workspace.id, repoId: 'api', source: 'watcher', generation: 1000, scopes: ['refs', 'history'] });
    await vi.advanceTimersByTimeAsync(800); await useAppStore.getState().refresh();
    expect(request.mock.calls.some(([command]) => command.type === 'repositoryStatus' || command.type === 'workspaceRefresh')).toBe(false);
    expect(useAppStore.getState().allRepositories).toEqual(before);
    expect(useAppStore.getState().commitSelections).toEqual(selection);
    settled(); await vi.advanceTimersByTimeAsync(400); await tick();
    expect(request.mock.calls.filter(([command]) => command.type === 'workspaceRefresh')).toHaveLength(1);
    expect(useAppStore.getState().allRepositories.find((repo) => repo.meta.id === 'api')!.files).toEqual(before.find((repo) => repo.meta.id === 'api')!.files);
    expect(useAppStore.getState().commitSelections).toEqual(selection);
    expect(request.mock.calls.some(([command]) => command.type === 'branches')).toBe(true);
  });

  it('discards a repository status request that crossed a backup and refreshes the final state', async () => {
    let resolve!: (status: RepositoryStatus) => void;
    request.mockImplementation((command, options) => command.type === 'repositoryStatus'
      ? new Promise<RepositoryStatus>((done) => { resolve = done; }) : original(command, options));
    const before = useAppStore.getState().allRepositories;
    const selection = structuredClone(useAppStore.getState().commitSelections);
    watcher(); await vi.advanceTimersByTimeAsync(310); expect(resolve).toBeDefined();
    emit(requested()); resolve({ ...before.find((repo) => repo.meta.id === 'api')!, files: [] }); await tick();
    expect(useAppStore.getState().allRepositories).toEqual(before);
    expect(useAppStore.getState().commitSelections).toEqual(selection);
    settled(); await vi.advanceTimersByTimeAsync(400); await tick();
    expect(request.mock.calls.some(([command]) => command.type === 'workspaceRefresh')).toBe(true);
  });

  it('discards stale workspace snapshots even when they arrive after restoration finished', async () => {
    let resolve!: (snapshot: WorkspaceSnapshot) => void;
    request.mockImplementation((command, options) => command.type === 'workspaceRefresh'
      ? new Promise<WorkspaceSnapshot>((done) => { resolve = done; }) : original(command, options));
    const before = useAppStore.getState().snapshot!;
    const selection = structuredClone(useAppStore.getState().commitSelections);
    const pending = useAppStore.getState().refresh(true); await tick();
    emit(requested()); settled();
    resolve({ ...before, generation: before.generation + 1, repositories: before.repositories.map((repo) => ({ ...repo, files: [] })) }); await pending;
    expect(useAppStore.getState().snapshot?.repositories).toEqual(before.repositories);
    expect(useAppStore.getState().commitSelections).toEqual(selection);
  });

  it('waits for every concurrent update and native restoration rather than its early terminal event', async () => {
    emit(requested('first')); emit(requested('second')); watcher();
    const event = requested('second');
    emit({ operationId: 'second', context: event.context, status: 'cancelled', phase: 'pullingRebase', message: 'Operation cancelled', startedAt: '', cancellable: false, completed: null, total: null, error: null });
    settled('first'); await vi.advanceTimersByTimeAsync(500);
    expect(request.mock.calls.some(([command]) => command.type === 'workspaceRefresh')).toBe(false);
    settled('second'); await vi.advanceTimersByTimeAsync(400); await tick();
    expect(request.mock.calls.filter(([command]) => command.type === 'workspaceRefresh')).toHaveLength(1);
  });

  it('also defers watcher status while another window is pulling this workspace', async () => {
    const event = requested();
    emit({ operationId: 'other-window', context: event.context, status: 'running', phase: 'pulling', message: 'Pulling repository changes', startedAt: '', cancellable: true, completed: null, total: null, error: null });
    watcher(); await vi.advanceTimersByTimeAsync(500);
    expect(request.mock.calls.some(([command]) => command.type === 'repositoryStatus')).toBe(false);
    emit({ operationId: 'other-window', context: event.context, status: 'failed', phase: 'pulling', message: 'Failed', startedAt: '', cancellable: false, completed: null, total: null, error: null });
    await vi.advanceTimersByTimeAsync(400); await tick();
    expect(request.mock.calls.filter(([command]) => command.type === 'workspaceRefresh')).toHaveLength(1);
  });

  it('keeps background projects isolated and does not freeze status during fetch', async () => {
    emit(requested('other', 'other-workspace')); watcher(); await vi.advanceTimersByTimeAsync(400); await tick();
    expect(request.mock.calls.some(([command]) => command.type === 'repositoryStatus')).toBe(true);
    request.mockClear();
    const fetch = requested('fetch'); if (fetch.command.type === 'sync') fetch.command.payload.action = 'fetch'; emit(fetch);
    await useAppStore.getState().refresh(true);
    expect(request.mock.calls.filter(([command]) => command.type === 'workspaceRefresh')).toHaveLength(1);
  });

  it('releases a failed batch and refreshes once its restoration has finished', async () => {
    request.mockImplementation((command, options) => command.type === 'sync'
      ? Promise.reject(new BridgeError({ code: 'GIT_PULL_FAILED', message: 'network failed', recoverable: true, command: null, exitCode: null, stderr: null })) : original(command, options));
    await useAppStore.getState().updateProject('merge');
    expect(request.mock.calls.some(([command]) => command.type === 'workspaceRefresh')).toBe(true);
    expect(useAppStore.getState().allRepositories.find((repo) => repo.meta.id === 'api')?.files.length).toBeGreaterThan(0);
  });
});
