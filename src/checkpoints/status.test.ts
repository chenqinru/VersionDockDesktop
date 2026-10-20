import { expect, it } from 'vitest';
import type { Checkpoint, CheckpointActivity, TaskWorkspace } from '../bindings/generated';
import { checkpointStatus } from './status';

const point = (status: string, createdAt = '2026-10-20T01:00:00Z'): Checkpoint => ({ id: status, name: 'Turn', createdAt, status, sessionId: null, turnId: null, before: 'before', after: status === 'recording' ? null : 'after', error: null });
const task = (id: string, checkpoints: Checkpoint[] = []): TaskWorkspace => ({ id, workspaceId: 'ws', name: id, path: '/project', roots: ['/project'], repositories: [], mode: 'manual', isolation: 'original', createdAt: '', seed: '', sourceSeed: '', lastApplied: null, checkpoints, hookEvents: [], lastHookAt: null, hookError: null, error: null });
const activity = (...tasks: TaskWorkspace[]): CheckpointActivity => ({ tasks, recovery: [] });

it('distinguishes loading, no tasks, idle, and unverified automatic recording', () => {
  expect(checkpointStatus(null, false, null).state).toBe('loading');
  expect(checkpointStatus(activity(), false, null).state).toBe('empty');
  expect(checkpointStatus(activity(task('idle')), false, null).state).toBe('ready');
  expect(checkpointStatus(activity({ ...task('auto'), mode: 'automatic' }), false, null).state).toBe('unverified');
});
it('prioritizes recordings across tasks and reports the count', () => {
  expect(checkpointStatus(activity(task('idle'), task('active', [point('recording')]), task('also-active', [point('recording')])), false, null))
    .toMatchObject({ state: 'recording', taskId: 'active', count: 2 });
});
it('keeps recovery and interrupted/incomplete recordings visible above normal activity', () => {
  const tasks = activity(task('running', [point('recording')]), task('paused', [point('interrupted')]));
  expect(checkpointStatus(tasks, false, null)).toMatchObject({ state: 'interrupted', taskId: 'paused' });
  tasks.tasks.push(task('broken', [point('incomplete')]));
  expect(checkpointStatus(tasks, false, null)).toMatchObject({ state: 'error', taskId: 'broken' });
  tasks.recovery.push({ id: 'recovery', taskId: 'paused', status: 'failed', completed: 1, total: 3, error: 'Disk full' });
  expect(checkpointStatus(tasks, true, null)).toMatchObject({ state: 'recovery', taskId: 'paused' });
});
it.each(['completed', 'undone', 'abandoned'])('shows the most recent record across task boundaries: %s', status => {
  expect(checkpointStatus(activity(task('older', [point('completed')]), task('recent', [point(status, '2026-10-20T02:00:00Z')])), false, null))
    .toMatchObject({ state: status, taskId: 'recent' });
});
it('does not claim successful recording on polling failure, hook failure, or an active operation', () => {
  const data = activity(task('finished', [point('completed')]));
  expect(checkpointStatus(data, false, 'Unavailable').state).toBe('error');
  expect(checkpointStatus(data, true, null).state).toBe('processing');
  data.tasks[0].mode = 'automatic';
  data.tasks[0].hookError = 'Hook failed';
  expect(checkpointStatus(data, false, null)).toMatchObject({ state: 'error', taskId: 'finished' });
});
