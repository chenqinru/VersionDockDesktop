import { afterEach, expect, it, vi } from 'vitest';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { checkpointWorkspaceChanged, refreshCheckpointActivity, refreshCheckpoints, runCheckpointAction, useCheckpointStore } from './store';
import type { CheckpointListing, WorkspaceSnapshot } from '../bindings/generated';
const original = useAppStore.getState();
const workspace = (id: string) => ({ workspace: { id, name: id, paths: ['/tmp'], available: true, lastOpenedAt: '' }, repositories: [], tools: { git: true, svn: false, svnadmin: false }, generation: 1 }) satisfies WorkspaceSnapshot;
const listing: CheckpointListing = { tasks: [], recovery: [], storageBytes: 0, hooksInstalled: false };
afterEach(() => { checkpointWorkspaceChanged(null); useAppStore.setState(original, true); vi.restoreAllMocks(); });
it('does not let an old activity result overwrite a mutation and its refreshed listing', async () => {
  let resolve!: (value: unknown) => void;
  const bridge = new MockBridge(() => []);
  vi.spyOn(bridge, 'request').mockImplementation(command => command.type === 'checkpoint' && command.payload.action.type === 'activity'
    ? new Promise(done => { resolve = done; }) as never : Promise.resolve(listing) as never);
  useAppStore.setState({ bridge, snapshot: workspace('a') }); checkpointWorkspaceChanged('a');
  const pending = refreshCheckpointActivity();
  await runCheckpointAction({ type: 'finish', task_id: 'task' });
  resolve({ tasks: [{ id: 'stale' }], recovery: [] });
  await pending;
  expect(useCheckpointStore.getState().activity?.tasks).toEqual([]);
});
it('reports polling errors without keeping stale status after the next successful refresh', async () => {
  const bridge = new MockBridge(() => []);
  const request = vi.spyOn(bridge, 'request').mockRejectedValue(new Error('Unavailable'));
  useAppStore.setState({ bridge, snapshot: workspace('a') }); checkpointWorkspaceChanged('a');
  await refreshCheckpointActivity();
  expect(useCheckpointStore.getState().listingError).toBe('Unavailable');
  request.mockResolvedValue({ tasks: [], recovery: [] });
  await refreshCheckpointActivity();
  expect(useCheckpointStore.getState()).toMatchObject({ activity: { tasks: [] }, listingError: null });
});
it('ignores late activity responses and failures after switching workspace', async () => {
  let reject!: (error: Error) => void;
  const bridge = new MockBridge(() => []);
  vi.spyOn(bridge, 'request').mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  useAppStore.setState({ bridge, snapshot: workspace('a') }); checkpointWorkspaceChanged('a');
  const pending = refreshCheckpointActivity();
  useAppStore.setState({ snapshot: workspace('b') }); checkpointWorkspaceChanged('b');
  reject(new Error('Old error')); await pending;
  expect(useCheckpointStore.getState()).toMatchObject({ workspaceId: 'b', activity: null, listingError: null });
});
it('does not let a late listing replace a different workspace', async () => {
  let resolve!: (listing: CheckpointListing) => void;
  const bridge = new MockBridge(() => []);
  vi.spyOn(bridge, 'request').mockImplementation(() => new Promise(r => { resolve = r; }));
  useAppStore.setState({ bridge, snapshot: workspace('a') }); checkpointWorkspaceChanged('a');
  const pending = refreshCheckpoints();
  useAppStore.setState({ snapshot: workspace('b') }); checkpointWorkspaceChanged('b');
  resolve(listing); await pending;
  expect(useCheckpointStore.getState()).toMatchObject({ workspaceId: 'b', listing: null });
});
it('aborts an in-flight mutation on workspace change and ignores its result', async () => {
  let resolve!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  const bridge = new MockBridge(() => []);
  vi.spyOn(bridge, 'request').mockImplementation((_cmd, options) => { signal = options?.signal; return new Promise(r => { resolve = r; }); });
  useAppStore.setState({ bridge, snapshot: workspace('a') }); checkpointWorkspaceChanged('a');
  const pending = runCheckpointAction({ type: 'preview', task_id: 'task', checkpoint_id: null, bring_back: false });
  useAppStore.setState({ snapshot: workspace('b') }); checkpointWorkspaceChanged('b');
  expect(signal?.aborted).toBe(true);
  resolve({ id: 'stale' }); await pending;
  expect(useCheckpointStore.getState()).toMatchObject({ busy: false, preview: null, workspaceId: 'b' });
});
it('prevents overlapping mutations and surfaces backend failures', async () => {
  const bridge = new MockBridge(() => []);
  let reject!: (error: Error) => void;
  const request = vi.spyOn(bridge, 'request').mockImplementation(cmd => cmd.type === 'checkpoint' && cmd.payload.action.type === 'overview' ? Promise.resolve(listing) as never : new Promise((_r, fail) => { reject = fail; }));
  useAppStore.setState({ bridge, snapshot: workspace('a') }); checkpointWorkspaceChanged('a');
  const first = runCheckpointAction({ type: 'begin', task_id: 'task', name: 'turn' });
  await runCheckpointAction({ type: 'begin', task_id: 'task', name: 'duplicate' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]).toMatchObject({ showProgress: false });
  reject(new Error('Disk is full')); await first;
  expect(useCheckpointStore.getState()).toMatchObject({ busy: false, error: 'Disk is full' });
});

it('does not let late cleanup previews or reports replace a different workspace', async () => {
  for (const type of ['previewCleanup', 'cleanup'] as const) {
    let resolve!: (value: unknown) => void;
    const bridge = new MockBridge(() => []);
    vi.spyOn(bridge, 'request').mockImplementation(() => new Promise(r => { resolve = r; }));
    useAppStore.setState({ bridge, snapshot: workspace('a') }); checkpointWorkspaceChanged('a');
    const pending = runCheckpointAction(type === 'cleanup' ? { type, task_id: 't', keep_recent: 10, fingerprint: 'fp' } : { type, task_id: 't', keep_recent: 10 });
    useAppStore.setState({ snapshot: workspace('b') }); checkpointWorkspaceChanged('b');
    resolve({ taskId: 't', status: 'succeeded' }); await pending;
    expect(useCheckpointStore.getState()).toMatchObject({ workspaceId: 'b', cleanupPreview: null, cleanupReport: null, busy: false });
  }
});

it('keeps the displayed checkpoint on preview failure and preserves its identity in a successful preview', async () => {
  const bridge = new MockBridge(() => []);
  let fail = true;
  vi.spyOn(bridge, 'request').mockImplementation(command => {
    if (command.type === 'checkpoint' && command.payload.action.type === 'preview') return (fail ? Promise.reject(new Error('Snapshot is unavailable')) : Promise.resolve({ id: 'preview', taskId: 'task', files: [], conflicts: [], bringBack: false, fingerprint: 'fp' })) as never;
    return Promise.resolve(listing) as never;
  });
  useAppStore.setState({ bridge, snapshot: workspace('a') }); checkpointWorkspaceChanged('a');
  const files = [{ repository: '/tmp/repo', layer: 'working', path: 'map.ts', status: 'modified', before: 'old', after: 'new' }];
  useCheckpointStore.setState({ selectedTaskId: 'task', details: files, detailsCheckpointId: 'displayed-turn' });
  await runCheckpointAction({ type: 'preview', task_id: 'task', checkpoint_id: 'displayed-turn', bring_back: false });
  expect(useCheckpointStore.getState()).toMatchObject({ details: files, detailsCheckpointId: 'displayed-turn', preview: null, error: 'Snapshot is unavailable' });
  fail = false;
  await runCheckpointAction({ type: 'preview', task_id: 'task', checkpoint_id: 'displayed-turn', bring_back: false });
  expect(useCheckpointStore.getState()).toMatchObject({ details: null, detailsCheckpointId: 'displayed-turn', preview: { id: 'preview' }, error: null });
});

it('loads file metadata without refreshing all history afterwards and exposes the active record', async () => {
  const bridge = new MockBridge(() => []);
  let resolve!: (value: unknown) => void;
  const request = vi.spyOn(bridge, 'request').mockImplementation(() => new Promise(done => { resolve = done; }));
  useAppStore.setState({ bridge, snapshot: workspace('a') }); checkpointWorkspaceChanged('a');
  const pending = runCheckpointAction({ type: 'detail', task_id: 'task', checkpoint_id: 'point' });
  expect(useCheckpointStore.getState()).toMatchObject({ busy: true, loadingDetailsId: 'point' });
  resolve([{ repository: '/tmp/repo', path: 'map.ts', layer: 'working', status: 'modified', before: null, after: null }]);
  await pending;
  expect(useCheckpointStore.getState()).toMatchObject({ busy: false, loadingDetailsId: null, detailsCheckpointId: 'point', details: [{ path: 'map.ts' }] });
  expect(request).toHaveBeenCalledTimes(1);
});
it('clears the active detail indicator when switching workspace and ignores the late response', async () => {
  const bridge = new MockBridge(() => []);
  let resolve!: (value: unknown) => void;
  vi.spyOn(bridge, 'request').mockImplementation(() => new Promise(done => { resolve = done; }));
  useAppStore.setState({ bridge, snapshot: workspace('a') }); checkpointWorkspaceChanged('a');
  const pending = runCheckpointAction({ type: 'detail', task_id: 'task', checkpoint_id: 'point' });
  useAppStore.setState({ snapshot: workspace('b') }); checkpointWorkspaceChanged('b');
  resolve([]); await pending;
  expect(useCheckpointStore.getState()).toMatchObject({ workspaceId: 'b', busy: false, loadingDetailsId: null, details: null, detailsCheckpointId: null });
});
