import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Checkpoint, CheckpointActivity, CheckpointListing, TaskWorkspace, WorkspaceSnapshot } from '../../bindings/generated';
import { checkpointWorkspaceChanged, useCheckpointStore } from '../../checkpoints/store';
import { useAppStore } from '../../store/appStore';
import { MockBridge } from '../../platform/bridge';
import { CheckpointCenterHost } from '../CheckpointCenter';
import { closeCheckpointCenter, useCheckpointCenter } from '../../checkpoints/center';
import { CheckpointStatusBarItem } from './CheckpointStatusBarItem';
import { createTranslator, I18nContext } from '../../i18n';

const original = useAppStore.getState();
const snapshot: WorkspaceSnapshot = { workspace: { id: 'ws', name: 'Project', paths: ['/project'], available: true, lastOpenedAt: '' }, repositories: [], tools: { git: true, svn: false, svnadmin: false }, generation: 1 };
const point = (status: string): Checkpoint => ({ id: 'point', name: 'Turn', createdAt: '2026-10-20T01:00:00Z', status, sessionId: null, turnId: null, before: 'before', after: status === 'recording' ? null : 'after', error: null });
const task = (id: string, status?: string): TaskWorkspace => ({ id, workspaceId: 'ws', name: id, path: '/project', roots: ['/project'], repositories: [], mode: 'manual', isolation: 'original', createdAt: '', seed: '', sourceSeed: '', lastApplied: null, checkpoints: status ? [point(status)] : [], hookEvents: [], lastHookAt: null, hookError: null, error: null });
const flush = async () => { await act(async () => {}); };
afterEach(() => { cleanup(); closeCheckpointCenter(); checkpointWorkspaceChanged(null); useAppStore.setState(original, true); vi.restoreAllMocks(); vi.useRealTimers(); });
function setup(initialTasks = [task('Current task', 'recording')], recovery: CheckpointActivity['recovery'] = []) {
  const bridge = new MockBridge(() => []);
  let tasks = initialTasks;
  const request = vi.spyOn(bridge, 'request').mockImplementation(command => {
    if (command.type === 'checkpointCatalog') return Promise.resolve({ projects: [snapshot.workspace], tasks }) as never;
    if (command.type !== 'checkpoint') return Promise.resolve([]) as never;
    if (command.payload.action.type === 'activity') return Promise.resolve({ tasks, recovery } satisfies CheckpointActivity) as never;
    return Promise.resolve({ tasks, recovery } satisfies CheckpointListing) as never;
  });
  useAppStore.setState({ bridge, snapshot });
  const view = render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><CheckpointStatusBarItem /><CheckpointCenterHost /></I18nContext.Provider>);
  return { ...view, request, setTasks: (next: TaskWorkspace[]) => { tasks = next; } };
}
it('polls lightweight metadata while closed, updates on completion, and removes its timer on unmount', async () => {
  vi.useFakeTimers();
  const view = setup();
  expect(screen.queryByRole('button', { name: /Tasks and checkpoints/ })).not.toBeInTheDocument();
  await flush();
  expect(screen.getByRole('button', { name: 'Tasks and checkpoints · Recording' })).toHaveTextContent('Checkpoints · Recording');
  expect(view.request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'activity' } } }), expect.objectContaining({ showProgress: false, timeoutMs: 15000 }));
  view.setTasks([task('Current task', 'completed')]);
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(screen.queryByRole('button', { name: /Tasks and checkpoints/ })).not.toBeInTheDocument();
  view.setTasks([task('Next task', 'recording')]);
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(screen.getByRole('button', { name: 'Tasks and checkpoints · Recording' })).toBeInTheDocument();
  expect(view.request.mock.calls.every(([c]) => c.type === 'checkpoint' && c.payload.action.type === 'activity')).toBe(true);
  view.unmount();
  const calls = view.request.mock.calls.length;
  await act(async () => { vi.advanceTimersByTime(6000); window.dispatchEvent(new Event('focus')); });
  expect(view.request).toHaveBeenCalledTimes(calls);
});
it('opens the project panel on the task needing attention and keeps status updates after closing', async () => {
  const view = setup();
  view.setTasks([task('Idle task'), task('Interrupted task', 'interrupted')]);
  await flush();
  act(() => window.dispatchEvent(new Event('focus')));
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Tasks and checkpoints · Needs finishing' }));
  const panel = await screen.findByRole('dialog', { name: 'Tasks and checkpoints' });
  expect(await within(panel).findByRole('heading', { name: 'Interrupted task' })).toBeInTheDocument();
  expect(useCheckpointStore.getState().selectedTaskId).toBe('Interrupted task');
  fireEvent.click(within(panel).getAllByRole('button', { name: 'Close' }).at(-1)!);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Tasks and checkpoints · Needs finishing' })).toHaveAttribute('aria-expanded', 'false');
});
it('ignores the previous workspace status immediately while retaining the global center', async () => {
  const view = setup();
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Tasks and checkpoints · Recording' }));
  await flush();
  act(() => useAppStore.setState({ snapshot: { ...snapshot, workspace: { ...snapshot.workspace, id: 'other', name: 'Other' } } }));
  view.rerender(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><CheckpointStatusBarItem key="other" /><CheckpointCenterHost /></I18nContext.Provider>);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Tasks and checkpoints ·/ })).not.toBeInTheDocument();
  await flush();
});

it.each([
  ['unconfigured', []],
  ['ready', [task('Ready')]],
  ['completed', [task('Finished', 'completed')]],
  ['undone', [task('Undone', 'undone')]],
  ['abandoned', [task('Abandoned', 'abandoned')]],
  ['waiting for hooks', [{ ...task('Unverified'), mode: 'automatic' as const }]],
] as const)('hides the idle %s state', async (_state, tasks) => {
  setup([...tasks]);
  await flush();
  expect(screen.queryByRole('button', { name: /Tasks and checkpoints/ })).not.toBeInTheDocument();
});

it.each(['incomplete', 'interrupted', 'hook error', 'recovery'] as const)('shows %s and opens the matching task', async state => {
  const attention = task('Needs attention', state === 'incomplete' || state === 'interrupted' ? state : 'completed');
  if (state === 'hook error') { attention.mode = 'automatic'; attention.hookError = 'Hook failed'; }
  setup([task('Idle'), attention], state === 'recovery' ? [{ id: 'restore', taskId: attention.id, status: 'failed', completed: 0, total: 1, error: 'Disk full' }] : []);
  await flush();
  const button = screen.getByRole('button', { name: /Tasks and checkpoints ·/ });
  expect(button).toHaveAttribute('data-checkpoint-status', state === 'recovery' ? 'recovery' : state === 'interrupted' ? 'interrupted' : 'error');
  fireEvent.click(button);
  expect(useCheckpointCenter.getState()).toMatchObject({ open: true, projectId: 'ws', taskId: attention.id });
  await flush();
});

it('shows a polling failure and hides the indicator after a successful idle response', async () => {
  const view = setup([task('Finished', 'completed')]);
  await flush();
  expect(screen.queryByRole('button', { name: /Tasks and checkpoints/ })).not.toBeInTheDocument();
  view.request.mockRejectedValueOnce(new Error('Unavailable'));
  act(() => window.dispatchEvent(new Event('focus')));
  await flush();
  expect(screen.getByRole('button', { name: /Tasks and checkpoints ·/ })).toHaveAttribute('data-checkpoint-status', 'error');
  act(() => window.dispatchEvent(new Event('focus')));
  await flush();
  expect(screen.queryByRole('button', { name: /Tasks and checkpoints/ })).not.toBeInTheDocument();
});
