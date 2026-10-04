import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand, OperationEvent } from '../bindings/generated';
import { createOperationRequestEvent } from '../platform/bridge';
import { configureTaskProgress, isTaskActive, resetTaskProgress, sortedTasks, useTaskProgressStore } from './taskProgressStore';

const command: BridgeCommand = { type: 'sync', payload: { workspace_id: 'workspace', repo_id: 'repo', action: 'pullRebase', remote: null, branch: null } };
const metadata = { workspaceName: 'Project', repoName: 'Repository' };
const native = (id: string, status: OperationEvent['status'] = 'running', extra: Partial<OperationEvent> = {}): OperationEvent => ({ operationId: id, context: createOperationRequestEvent(command, {}, id).context, status, phase: 'pulling', message: 'Pulling repository changes', startedAt: '', cancellable: true, completed: null, total: null, error: null, ...extra });
const start = (id: string, options = {}) => useTaskProgressStore.getState().requested(createOperationRequestEvent(command, options, id), metadata);
const finish = (id: string, error?: unknown) => useTaskProgressStore.getState().settled({ progressEvent: true, type: 'operation-settled', requestId: id, error });
const group = () => useTaskProgressStore.getState().beginGroup('Update Project', 'workspace', 'Project', [{ id: 'repo', name: 'Repository' }, { id: 'next', name: 'Next' }]);

beforeEach(() => { vi.useFakeTimers(); configureTaskProgress(async () => true); });
afterEach(() => { resetTaskProgress(); vi.useRealTimers(); });

describe('task progress lifecycle', () => {
  it('ignores passive requests and AI even when their operation is foreground', () => {
    start('silent', { showProgress: false });
    useTaskProgressStore.getState().requested(createOperationRequestEvent({ type: 'workspaceRefresh', payload: { workspace_id: 'workspace' } }, {}, 'refresh'), metadata);
    useTaskProgressStore.getState().requested(createOperationRequestEvent({ type: 'aiComposerApply', payload: {} } as BridgeCommand, {}, 'ai'), metadata);
    expect(useTaskProgressStore.getState().tasks).toEqual({});
  });
  it('captures labels and names, keeps unknown totals unknown, and uses real phase messages', () => {
    start('pull'); useTaskProgressStore.getState().operation(native('pull'));
    expect(useTaskProgressStore.getState().tasks.pull).toMatchObject({ title: 'Pull (Rebase)', workspaceName: 'Project', repoName: 'Repository', completed: null, total: null, message: 'Pulling repository changes' });
  });
  it('keeps an active native operation until its actual request settles', () => {
    start('pull'); useTaskProgressStore.getState().operation(native('pull', 'succeeded', { cancellable: false }));
    expect(isTaskActive(useTaskProgressStore.getState().tasks.pull)).toBe(true);
    finish('pull'); expect(useTaskProgressStore.getState().tasks.pull.status).toBe('succeeded');
    vi.advanceTimersByTime(1999); expect(useTaskProgressStore.getState().tasks.pull).toBeDefined();
    vi.advanceTimersByTime(1); expect(useTaskProgressStore.getState().tasks.pull).toBeUndefined();
  });
  it('preserves native partial failure rather than treating an IPC success as task success', () => {
    start('batch'); useTaskProgressStore.getState().operation(native('batch', 'partial'));
    finish('batch'); expect(useTaskProgressStore.getState().tasks.batch.status).toBe('partial');
  });
  it('classifies native batch results even when the terminal event arrives after the response', () => {
    const batch = { type: 'batchCommit', payload: { workspace_id: 'workspace', targets: [], push: false } } as BridgeCommand;
    const store = useTaskProgressStore.getState();
    const settle = (id: string, errors: Array<unknown>) => {
      store.requested(createOperationRequestEvent(batch, {}, id), metadata);
      store.settled({ progressEvent: true, type: 'operation-settled', requestId: id, result: errors.map((error, i) => ({ repoId: String(i), error })) });
    };
    settle('partial', [null, { code: 'OFFLINE', message: 'offline' }]);
    settle('failed', [{ code: 'OFFLINE', message: 'offline' }]);
    settle('cancelled', [null, { code: 'REQUEST_CANCELLED', message: 'Operation cancelled' }]);
    expect(useTaskProgressStore.getState().tasks.partial.status).toBe('partial');
    expect(useTaskProgressStore.getState().tasks.failed.status).toBe('failed');
    expect(useTaskProgressStore.getState().tasks.cancelled.status).toBe('cancelled');
  });
  it('shows native batch repository phases while waiting for the final results', () => {
    const batch = { type: 'batchCommit', payload: { workspace_id: 'workspace', targets: [{ repoId: 'repo' }, { repoId: 'next' }], push: false } } as BridgeCommand;
    const store = useTaskProgressStore.getState();
    store.requested(createOperationRequestEvent(batch, {}, 'batch'), { ...metadata, repositories: [{ id: 'repo', name: 'First' }, { id: 'next', name: 'Second' }] });
    store.operation(native('batch', 'running', { completed: 1, total: 2, message: 'Preparing selected paths and creating commit' }));
    const task = useTaskProgressStore.getState().tasks.batch;
    expect(task).toMatchObject({ repoName: 'Second', completed: 1, total: 2 });
    expect(task.children[0]).toMatchObject({ status: 'running', message: 'Waiting for operation results' });
    expect(task.children[1]).toMatchObject({ status: 'running', message: 'Preparing selected paths and creating commit' });
    store.settled({ progressEvent: true, type: 'operation-settled', requestId: 'batch', result: [{ repoId: 'repo', error: null }, { repoId: 'next', error: { code: 'COMMIT_FAILED', message: 'hook failed' } }] });
    expect(useTaskProgressStore.getState().tasks.batch.children.map((child) => child.status)).toEqual(['succeeded', 'failed']);
  });
  it('retains completed tasks while details are open and drops their history on close', () => {
    start('pull'); useTaskProgressStore.getState().setOpen(true); finish('pull');
    vi.advanceTimersByTime(4000); expect(useTaskProgressStore.getState().tasks.pull).toBeDefined();
    useTaskProgressStore.getState().setOpen(false); expect(useTaskProgressStore.getState().tasks.pull).toBeUndefined();
  });
  it('prioritizes current-project running tasks and orders equal tasks by their original start', () => {
    start('current'); vi.advanceTimersByTime(5); start('second');
    useTaskProgressStore.getState().operation(native('current'));
    const other = createOperationRequestEvent({ ...command, payload: { ...command.payload, workspace_id: 'other' } }, {}, 'other');
    useTaskProgressStore.getState().requested(other, { workspaceName: 'Other' });
    useTaskProgressStore.getState().operation({ ...native('other'), context: other.context });
    expect(sortedTasks(Object.values(useTaskProgressStore.getState().tasks), 'workspace').map((task) => task.id)).toEqual(['current', 'second', 'other']);
    useTaskProgressStore.getState().operation(native('current', 'running', { completed: 2, total: 5 }));
    expect(useTaskProgressStore.getState().tasks.current.startedAt).toBeLessThan(useTaskProgressStore.getState().tasks.second.startedAt);
  });
  it('prevents duplicate cancellation and waits for native recovery to settle', async () => {
    const cancel = vi.fn(async () => true); configureTaskProgress(cancel);
    start('pull'); useTaskProgressStore.getState().operation(native('pull'));
    await useTaskProgressStore.getState().cancel('pull'); await useTaskProgressStore.getState().cancel('pull');
    expect(cancel).toHaveBeenCalledOnce(); expect(useTaskProgressStore.getState().tasks.pull.status).toBe('cancelling');
    useTaskProgressStore.getState().operation(native('pull', 'cancelled', { cancellable: false }));
    expect(useTaskProgressStore.getState().tasks.pull.status).toBe('cancelling');
    finish('pull', { code: 'REQUEST_CANCELLED', message: 'Operation cancelled' });
    expect(useTaskProgressStore.getState().tasks.pull.status).toBe('cancelled');
    expect(useTaskProgressStore.getState().tasks.pull.error).toBeUndefined();
  });
  it('defers cancellation until a queued request is registered natively', async () => {
    const cancel = vi.fn(async () => true); configureTaskProgress(cancel); start('queued');
    await useTaskProgressStore.getState().cancel('queued'); expect(cancel).not.toHaveBeenCalled();
    useTaskProgressStore.getState().operation(native('queued', 'queued')); await Promise.resolve();
    expect(cancel).toHaveBeenCalledWith('queued');
  });
  it('restores an active task after cancellation was rejected without replaying the operation', async () => {
    const cancel = vi.fn(async () => false); configureTaskProgress(cancel); start('pull'); useTaskProgressStore.getState().operation(native('pull'));
    await useTaskProgressStore.getState().cancel('pull');
    expect(useTaskProgressStore.getState().tasks.pull).toMatchObject({ status: 'running', cancelError: 'Could not cancel the task. Please try again.' });
    await useTaskProgressStore.getState().cancel('pull'); expect(cancel).toHaveBeenCalledTimes(2);
  });
  it('does not overwrite a task that finished during the cancel handshake', async () => {
    let resolve!: (accepted: boolean) => void;
    configureTaskProgress(() => new Promise((done) => { resolve = done; })); start('pull'); useTaskProgressStore.getState().operation(native('pull'));
    const pending = useTaskProgressStore.getState().cancel('pull');
    useTaskProgressStore.getState().operation(native('pull', 'succeeded')); finish('pull'); resolve(false); await pending;
    expect(useTaskProgressStore.getState().tasks.pull.status).toBe('succeeded');
  });
});

describe('aggregate repository operations', () => {
  it('binds native subrequests without duplicating the main task and counts repository results', () => {
    const id = group(), store = useTaskProgressStore.getState();
    store.bindChild(id, 'repo', 'child'); start('child', { showProgress: false });
    store.operation(native('child', 'running', { completed: 99, total: 100 }));
    expect(Object.keys(useTaskProgressStore.getState().tasks)).toEqual([id]);
    store.completeChild(id, 'repo', 'succeeded');
    expect(useTaskProgressStore.getState().tasks[id].completed).toBe(0);
    finish('child'); expect(useTaskProgressStore.getState().tasks[id].completed).toBe(1);
    store.completeChild(id, 'next', 'failed', 'offline'); store.finishGroup(id);
    expect(useTaskProgressStore.getState().tasks[id]).toMatchObject({ status: 'partial', completed: 2, total: 2, error: 'offline' });
  });
  it('stops pending repositories on cancel and keeps recovering requests visible', async () => {
    const id = group(), store = useTaskProgressStore.getState();
    store.bindChild(id, 'repo', 'child'); start('child', { showProgress: false }); store.operation(native('child'));
    await store.cancel(id); expect(store.isStopped(id)).toBe(true);
    store.completeChild(id, 'repo', 'cancelled'); store.finishGroup(id);
    expect(useTaskProgressStore.getState().tasks[id].status).toBe('cancelling');
    finish('child', { code: 'REQUEST_CANCELLED', message: 'Operation cancelled' });
    expect(useTaskProgressStore.getState().tasks[id]).toMatchObject({ status: 'cancelled', completed: 1, total: 2 });
    expect(useTaskProgressStore.getState().tasks[id].children[1].status).toBe('skipped');
  });
  it('does not resume unstarted repositories when cancellation is rejected', async () => {
    const cancel = vi.fn(async () => false); configureTaskProgress(cancel);
    const id = group(), store = useTaskProgressStore.getState();
    store.bindChild(id, 'repo', 'child'); start('child', { showProgress: false }); store.operation(native('child'));
    await store.cancel(id);
    expect(store.isStopped(id)).toBe(true);
    expect(useTaskProgressStore.getState().tasks[id].cancelError).toBeDefined();
    await store.cancel(id); expect(cancel).toHaveBeenCalledTimes(2);
    store.completeChild(id, 'repo', 'succeeded'); store.finishGroup(id); finish('child');
    expect(useTaskProgressStore.getState().tasks[id]).toMatchObject({ status: 'cancelled', completed: 1, total: 2 });
  });

});
