import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CheckpointPanel } from './CheckpointPanel';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { checkpointWorkspaceChanged } from '../checkpoints/store';
import type { CheckpointListing, TaskWorkspace, WorkspaceSnapshot } from '../bindings/generated';
import * as dialogs from './dialogService';
const original = useAppStore.getState();
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const snapshot: WorkspaceSnapshot = { workspace: { id: 'ws', name: 'project', paths: ['/project'], available: true, lastOpenedAt: '' }, repositories: [{ meta: { id: 'repo', name: 'repo', kind: 'git', rootPath: '/project/repo', color: '#888', depth: 0, parentRepoId: null, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null }], tools: { git: true, svn: false, svnadmin: false }, generation: 1 };
const listing: CheckpointListing = { tasks: [], recovery: [] };
afterEach(() => { cleanup(); checkpointWorkspaceChanged(null); useAppStore.setState(original, true); vi.restoreAllMocks(); vi.useRealTimers(); if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor); else Reflect.deleteProperty(navigator, 'clipboard'); });
it.each([
  ['interrupted', 'The next message in this chat will finish this recording and start a new one. Stop background writes before sending.'],
  ['incomplete', 'This recording is incomplete. Stop file writes, then finish or abandon it manually before continuing.'],
] as const)('explains how to continue a %s automatic recording', async (status, notice) => {
  const bridge = new MockBridge(() => []);
  const task: TaskWorkspace = { id: 't', workspaceId: 'ws', name: 'Paused task', path: '/project', roots: ['/project'], repositories: [], mode: 'automatic', isolation: 'original', createdAt: '', seed: '', sourceSeed: '', lastApplied: null, checkpoints: [{ id: 'p', name: 'Turn', createdAt: '', status, sessionId: 'chat', turnId: '1', before: 'snapshot', after: null, error: null }], hookEvents: ['UserPromptSubmit', 'Interrupt'], lastHookAt: null, hookError: null, error: null };
  vi.spyOn(bridge, 'request').mockResolvedValue({ ...listing, tasks: [task] });
  useAppStore.setState({ bridge, snapshot });
  render(<CheckpointPanel onClose={() => {}} />);
  expect(await screen.findByText(notice)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Finish recording' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Abandon recording' })).toBeEnabled();
});
it('creates in the original directories by default and exposes repository scope', async () => {
  const bridge = new MockBridge(() => []);
  const requests = vi.spyOn(bridge, 'request').mockResolvedValue(listing);
  useAppStore.setState({ bridge, snapshot });
  render(<CheckpointPanel onClose={() => {}} />);
  await screen.findByText('No checkpoint tasks yet');
  fireEvent.click(screen.getByRole('button', { name: 'New checkpoint task' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Task name' }), { target: { value: 'Fix login' } });
  expect(screen.getByText('Original directories (default)')).toBeInTheDocument();
  expect(screen.getByTitle('/project/repo')).toHaveTextContent('repo');
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await waitFor(() => expect(requests).toHaveBeenCalledWith(expect.objectContaining({ type: 'checkpoint', payload: { workspace_id: 'ws', action: { type: 'create', name: 'Fix login', repo_ids: ['repo'], mode: 'manual', isolation: 'original', include_ignored: [] } } }), expect.anything()));
});
it('does not claim automatic protection before receiving actual hooks', async () => {
  const bridge = new MockBridge(() => []);
  const task: TaskWorkspace = { id: 't', workspaceId: 'ws', name: 'Automatic task', path: '/project', roots: ['/project'], repositories: [], mode: 'automatic', isolation: 'original', createdAt: '', seed: '', sourceSeed: '', lastApplied: null, checkpoints: [], hookEvents: [], lastHookAt: null, hookError: null, error: null };
  vi.spyOn(bridge, 'request').mockResolvedValue({ ...listing, tasks: [task] });
  useAppStore.setState({ bridge, snapshot }); render(<CheckpointPanel onClose={() => {}} />);
  expect(await screen.findByRole('button', { name: 'Unverified' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Preview bring back' })).not.toBeInTheDocument();
});
it('keeps global setup out of task settings and exposes path actions in the task view', async () => {
  const bridge = new MockBridge(() => []);
  const task: TaskWorkspace = { id: 't', workspaceId: 'ws', name: 'Daily task', path: '/project', roots: ['/project'], repositories: [], mode: 'manual', isolation: 'original', createdAt: '', seed: '', sourceSeed: '', lastApplied: null, checkpoints: [], hookEvents: [], lastHookAt: null, hookError: null, error: null };
  vi.spyOn(bridge, 'request').mockResolvedValue({ ...listing, tasks: [task] });
  useAppStore.setState({ bridge, snapshot }); render(<CheckpointPanel onClose={() => {}} />);
  await screen.findByRole('heading', { name: 'Daily task' });
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Install Codex checkpoint hooks' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy Codex project path' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Task settings' }));
  expect(screen.queryByRole('button', { name: 'Install Codex checkpoint hooks' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy Codex project path' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Recording mode')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to checkpoints' }));
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeInTheDocument();
});
it('opens a separate change review and returns to the history without losing the selected task', async () => {
  const bridge = new MockBridge(() => []);
  const task: TaskWorkspace = { id: 't', workspaceId: 'ws', name: 'Review task', path: '/project', roots: ['/project'], repositories: [], mode: 'manual', isolation: 'original', createdAt: '', seed: '', sourceSeed: '', lastApplied: null, checkpoints: [{ id: 'p', name: 'Fix validation', createdAt: '2026-10-18T00:00:00Z', status: 'completed', sessionId: null, turnId: null, before: 'before', after: 'after', error: null }], hookEvents: [], lastHookAt: null, hookError: null, error: null };
  vi.spyOn(bridge, 'request').mockImplementation(cmd => Promise.resolve(cmd.type === 'checkpoint' && cmd.payload.action.type === 'detail' ? [{ repository: '/project/repo', path: 'auth.ts', layer: 'working', status: 'modified', before: 'before', after: 'after' }] : { ...listing, tasks: [task] }) as never);
  useAppStore.setState({ bridge, snapshot }); render(<CheckpointPanel onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'View changes' }));
  expect((await screen.findAllByText('auth.ts')).length).toBeGreaterThan(0);
  expect(screen.queryByRole('heading', { name: 'Checkpoint history' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to checkpoints' }));
  expect(screen.getByRole('heading', { name: 'Review task' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
});

it('previews cleanup and requires confirmation before removing history while keeping the task', async () => {
  const bridge = new MockBridge(() => []);
  const task: TaskWorkspace = { id: 't', workspaceId: 'ws', name: 'Cleanup task', path: '/project', roots: ['/project'], repositories: [], mode: 'manual', isolation: 'original', createdAt: '', seed: 'seed', sourceSeed: 'seed', lastApplied: null, checkpoints: [], hookEvents: [], lastHookAt: null, hookError: null, error: null };
  const confirmation = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(false);
  const request = vi.spyOn(bridge, 'request').mockImplementation(cmd => {
    if (cmd.type !== 'checkpoint') return Promise.resolve(null) as never;
    if (cmd.payload.action.type === 'previewCleanup') return Promise.resolve({ taskId: 't', keepRecent: 10, removeCount: 5, protectedCount: 2, reclaimableBytes: 2 * 1048576, fingerprint: 'preview-fingerprint' }) as never;
    if (cmd.payload.action.type === 'cleanup') return Promise.resolve({ status: 'succeeded', removedCount: 5, freedBytes: 1048576, error: null }) as never;
    return Promise.resolve({ ...listing, tasks: [task], connections: { [task.id]: { status: 'verified', verifiedAt: '2026-10-20T00:00:00Z', error: null } } }) as never;
  });
  useAppStore.setState({ bridge, snapshot }); render(<CheckpointPanel onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Task settings' }));
  expect(screen.getByLabelText('History to keep')).toHaveTextContent('Keep latest 10 records');
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  expect(await screen.findByText('5 records to remove · 2 protected · Estimated space to free: 2.00 MiB')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clean history' }));
  await waitFor(() => expect(confirmation).toHaveBeenCalledOnce());
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'cleanup')).toBe(false);
  confirmation.mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Clean history' }));
  expect(await screen.findByText('Removed 5 records · Freed 1.00 MiB')).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'cleanup', task_id: 't', keep_recent: 10, fingerprint: 'preview-fingerprint' } } }), expect.anything());
  expect(screen.getByRole('button', { name: 'Cleanup task' })).toBeInTheDocument();
});

it('distinguishes automatic history by file summary and stable id, and supports custom names', async () => {
  const bridge = new MockBridge(() => []);
  const task: TaskWorkspace = { id: 't', workspaceId: 'ws', name: 'History task', path: '/project', roots: ['/project'], repositories: [], mode: 'manual', isolation: 'original', createdAt: '', seed: 'seed', sourceSeed: 'seed', lastApplied: null, checkpoints: [
    { id: 'abcd1234-first', name: 'Codex turn', createdAt: '', status: 'completed', sessionId: 'chat', turnId: '1', before: 'before', after: 'after', error: null, summary: { files: 2, paths: ['api/map.ts', 'web/map.vue'] } },
    { id: 'efgh5678-next', name: 'Fix permissions', createdAt: '', status: 'completed', sessionId: 'chat', turnId: '2', before: 'before', after: 'after', error: null },
  ], hookEvents: [], lastHookAt: null, hookError: null, error: null };
  const request = vi.spyOn(bridge, 'request').mockImplementation(cmd => {
    if (cmd.type === 'checkpoint' && cmd.payload.action.type === 'rename') { task.checkpoints[0].name = cmd.payload.action.name; return Promise.resolve(true) as never; }
    return Promise.resolve({ ...listing, tasks: [task], connections: { [task.id]: { status: 'verified', verifiedAt: '2026-10-20T00:00:00Z', error: null } } }) as never;
  });
  const prompt = vi.spyOn(dialogs, 'promptDialog').mockResolvedValue('修复地图定位');
  useAppStore.setState({ bridge, snapshot }); render(<CheckpointPanel onClose={() => {}} />);
  expect((await screen.findAllByText('map.ts · map.vue')).length).toBeGreaterThan(0);
  expect(screen.getByText('#abcd1234')).toBeInTheDocument();
  expect(screen.getByText('#efgh5678')).toBeInTheDocument();
  expect(screen.getByText('2 changed files')).toBeInTheDocument();
  expect(screen.getByText('map.ts · map.vue', { selector: '.checkpoint-entry-title' })).toHaveAttribute('title', 'api/map.ts\nweb/map.vue');
  expect(screen.getByText('Fix permissions')).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[1]);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename checkpoint' }));
  expect(await screen.findByText('修复地图定位')).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'rename', task_id: 't', checkpoint_id: 'abcd1234-first', name: '修复地图定位' } } }), expect.anything());
  expect(prompt).toHaveBeenCalledOnce();
});

it('uses the message title and fetches full text only when the record is expanded', async () => {
  const bridge = new MockBridge(() => []);
  const task: TaskWorkspace = { id: 't', workspaceId: 'ws', name: 'Messages', path: '/project', roots: ['/project'], repositories: [], mode: 'automatic', isolation: 'original', createdAt: '', seed: 'seed', sourceSeed: 'seed', lastApplied: null, checkpoints: [
    { id: 'message-record', name: '修复地图定位', promptHash: 'hash', createdAt: '', status: 'completed', sessionId: 'chat', turnId: '1', before: 'before', after: 'after', error: null, summary: { files: 1, paths: ['api/map.ts'] } },
    { id: 'old-record', name: 'Codex turn', createdAt: '', status: 'completed', sessionId: 'chat', turnId: '0', before: 'before', after: 'after', error: null },
  ], hookEvents: [], lastHookAt: null, hookError: null, error: null };
  const requests = vi.spyOn(bridge, 'request').mockImplementation(command => Promise.resolve(command.type === 'checkpoint' && command.payload.action.type === 'messages' ? [{ body: '修复地图定位\n完整消息内容', annotations: [], attachments: [], selections: [], raw: null }] : { ...listing, tasks: [task] }) as never);
  useAppStore.setState({ bridge, snapshot }); render(<CheckpointPanel onClose={() => {}} />);
  expect(await screen.findByText('修复地图定位')).toBeInTheDocument();
  expect(screen.getByText('map.ts')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'View message' })).toHaveLength(1);
  expect(requests.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'messages')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'View message' }));
  expect(await screen.findByText(/完整消息内容/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Hide message' }));
  expect(screen.queryByText(/完整消息内容/)).not.toBeInTheDocument();
});

function reviewTask(): TaskWorkspace {
  return { id: 'review-task', workspaceId: 'ws', name: 'Map improvements', path: '/project', roots: ['/project'], repositories: [], mode: 'automatic', isolation: 'original', createdAt: '', seed: 'seed', sourceSeed: 'seed', lastApplied: null, checkpoints: [
    { id: 'first-turn', name: 'Fix map validation', promptHash: 'prompt', createdAt: '2026-10-20T02:00:00Z', status: 'completed', sessionId: 'chat', turnId: '1', before: 'before', after: 'after', error: null },
    { id: 'later-turn', name: 'Add tests', createdAt: '2026-10-20T03:00:00Z', status: 'completed', sessionId: 'chat', turnId: '2', before: 'before2', after: 'after2', error: null },
  ], hookEvents: ['UserPromptSubmit', 'Stop'], lastHookAt: null, hookError: null, error: null };
}
const reviewFiles = [{ repository: '/project/repo', path: 'src/map/validate.ts', layer: 'working', status: 'modified', before: 'old', after: 'new' }];
function setupReview(task = reviewTask(), conflicts: string[] = [], previewFiles = reviewFiles) {
  const bridge = new MockBridge(() => []);
  const request = vi.spyOn(bridge, 'request').mockImplementation(command => {
    if (command.type !== 'checkpoint') return Promise.resolve(null) as never;
    const action = command.payload.action;
    if (action.type === 'detail') return Promise.resolve(reviewFiles) as never;
    if (action.type === 'diff') return Promise.resolve({ path: action.path, content: '@@ -1 +1 @@\n-old\n+new\n', language: 'typescript', binary: false, truncated: false, lineCount: 3 }) as never;
    if (action.type === 'messages') return Promise.resolve([{ body: 'Fix map validation\nPreserve existing input', annotations: [], attachments: [], selections: [], raw: null }]) as never;
    if (action.type === 'preview') return Promise.resolve({ id: 'undo-preview', taskId: task.id, bringBack: false, files: previewFiles, conflicts, fingerprint: 'fingerprint', checkpointCount: action.checkpoint_id === 'first-turn' ? 2 : 1 }) as never;
    if (action.type === 'execute') { task.checkpoints.forEach(point => { point.status = 'undone'; }); return Promise.resolve({ status: 'succeeded' }) as never; }
    return Promise.resolve({ ...listing, tasks: [task], connections: { [task.id]: { status: 'verified', verifiedAt: '2026-10-20T00:00:00Z', error: null } } }) as never;
  });
  useAppStore.setState({ bridge, snapshot });
  render(<CheckpointPanel onClose={() => {}} />);
  return request;
}
it('focuses review on code and identifies the message, time and checkpoint, with message expansion', async () => {
  setupReview();
  fireEvent.click((await screen.findAllByRole('button', { name: 'View changes' }))[1]);
  expect(await screen.findByText('validate.ts')).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: 'Checkpoint tasks' })).not.toBeInTheDocument();
  expect(screen.queryByText('A matching hook round was recorded successfully.')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Task settings' })).not.toBeInTheDocument();
  expect(screen.getByText('Fix map validation')).toBeInTheDocument();
  expect(screen.getByText('#first-tu')).toBeInTheDocument();
  expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-10-20T02:00:00Z');
  expect(screen.getByText('Undoing this checkpoint also undoes 1 later completed turns.')).toBeInTheDocument();
  const undo = screen.getByRole('button', { name: 'Undo to before this turn' });
  expect(undo.closest('footer')).toHaveClass('checkpoint-footer');
  expect(undo.closest('.checkpoint-review-header')).toBeNull();
  expect(undo.closest('footer')?.querySelectorAll('button')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'View message' }));
  expect(await screen.findByText(/Preserve existing input/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to checkpoints' }));
  expect(screen.getByRole('navigation', { name: 'Checkpoint tasks' })).toBeInTheDocument();
});
it('checks undo on the current page and applies only after direct confirmation', async () => {
  const request = setupReview();
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(false);
  fireEvent.click((await screen.findAllByRole('button', { name: 'View changes' }))[1]);
  await screen.findByText('validate.ts');
  const diff = document.querySelector('.checkpoint-changes');
  const calls = request.mock.calls.filter(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'diff').length;
  fireEvent.click(screen.getByRole('button', { name: 'Undo to before this turn' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Confirm undo', danger: true, message: 'Undo 2 turns affecting 1 files? Stop external writes before continuing. Later non-overlapping edits are kept, and your current state will be backed up.' }));
  expect(screen.getByRole('banner', { name: 'View changes' })).toBeInTheDocument();
  expect(document.querySelector('.checkpoint-changes')).toBe(diff);
  expect(request.mock.calls.filter(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'diff')).toHaveLength(calls);
  expect(screen.queryByRole('button', { name: 'Show undo preview' })).not.toBeInTheDocument();
  expect(document.querySelector('.checkpoint-undo-check')).not.toBeInTheDocument();
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && cmd.payload.action.type === 'execute')).toBe(false);
  confirm.mockResolvedValue(true);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Undo to before this turn' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Undo to before this turn' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'execute', preview_id: 'undo-preview' } } }), expect.anything()));
  expect(await screen.findByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
});
it('shows conflicts inline without replacing the historical diff or asking to execute', async () => {
  const request = setupReview(reviewTask(), ['Overlapping edit in map/validate.ts']);
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(true);
  fireEvent.click((await screen.findAllByRole('button', { name: 'View changes' }))[1]);
  await screen.findByText('validate.ts');
  const diff = document.querySelector('.checkpoint-changes');
  fireEvent.click(screen.getByRole('button', { name: 'Undo to before this turn' }));
  expect(await screen.findByText('Overlapping edit in map/validate.ts')).toBeInTheDocument();
  expect(document.querySelector('.checkpoint-changes')).toBe(diff);
  expect(confirm).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && cmd.payload.action.type === 'execute')).toBe(false);
  expect(screen.queryByRole('button', { name: 'Show undo preview' })).not.toBeInTheDocument();
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && cmd.payload.action.type === 'diff' && cmd.payload.action.source.type === 'preview')).toBe(false);
  expect(screen.getByRole('banner', { name: 'View changes' })).toBeInTheDocument();
});
it.each(['history', 'detail'] as const)('undoes bring-back through the same guarded confirmation from %s', async entry => {
  const task = reviewTask();
  task.checkpoints = [{ ...task.checkpoints[0], id: 'bring-back-transaction', status: 'applied' }];
  const request = setupReview(task);
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(false);
  if (entry === 'detail') {
    fireEvent.click(await screen.findByRole('button', { name: 'View changes' }));
    await screen.findByText('validate.ts');
  }
  fireEvent.click(await screen.findByRole('button', { name: 'Undo bring back' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'recover')).toBe(false);
  confirm.mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Undo bring back' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'recover', transaction_id: 'bring-back-transaction' } } }), expect.anything()));
});
it('keeps bring-back as a separately reviewed and confirmed restore', async () => {
  const task = reviewTask();
  const request = setupReview(task);
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(true);
  await screen.findByRole('heading', { name: 'Checkpoint history' });
  const { useCheckpointStore } = await import('../checkpoints/store');
  act(() => useCheckpointStore.setState({ preview: { id: 'bring-back-preview', taskId: task.id, bringBack: true, files: reviewFiles, conflicts: [], fingerprint: 'fp' } }));
  expect(screen.getByRole('banner', { name: 'Bring-back preview' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Apply restore preview' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Apply restore preview' })));
  await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'execute', preview_id: 'bring-back-preview' } } }), expect.anything()));
});
it.each(['undone', 'recording', 'recovery'] as const)('blocks review undo when %s', async state => {
  const task = reviewTask();
  if (state === 'undone') task.checkpoints[0].status = 'undone';
  if (state === 'recording') task.checkpoints[1].status = 'recording';
  setupReview(task);
  fireEvent.click((await screen.findAllByRole('button', { name: 'View changes' }))[1]);
  if (state === 'recovery') {
    const { useCheckpointStore } = await import('../checkpoints/store');
    const { act } = await import('@testing-library/react');
    act(() => useCheckpointStore.setState({ listing: { ...listing, tasks: [task], recovery: [{ id: 'recover', taskId: task.id, status: 'failed', completed: 1, total: 2, error: 'Write failed' }] } }));
  }
  expect(await screen.findByRole('button', { name: 'Undo to before this turn' })).toBeDisabled();
});
it('does not apply an old preview if the workspace changes during confirmation', async () => {
  const request = setupReview();
  let resolve!: (value: boolean) => void;
  vi.spyOn(dialogs, 'confirmDialog').mockImplementation(() => new Promise(done => { resolve = done; }));
  fireEvent.click((await screen.findAllByRole('button', { name: 'View changes' }))[1]);
  fireEvent.click(await screen.findByRole('button', { name: 'Undo to before this turn' }));
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  const { act } = await import('@testing-library/react');
  await act(async () => { useAppStore.setState({ snapshot: { ...snapshot, workspace: { ...snapshot.workspace, id: 'other' } } }); resolve(true); });
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && cmd.payload.action.type === 'execute')).toBe(false);
});

it.each(['cancel', 'fail'] as const)('keeps the diff visible while checking and handles %s without a confirmation', async outcome => {
  const request = setupReview();
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(true);
  fireEvent.click((await screen.findAllByRole('button', { name: 'View changes' }))[1]);
  await screen.findByText('validate.ts');
  const diff = document.querySelector('.checkpoint-changes');
  const previous = request.getMockImplementation()!;
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  request.mockImplementation((command, options) => command.type === 'checkpoint' && command.payload.action.type === 'preview' ? new Promise((done, fail) => { resolve = done; reject = fail; }) : previous(command, options));
  fireEvent.click(screen.getByRole('button', { name: 'Undo to before this turn' }));
  expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled();
  expect(document.querySelector('.checkpoint-changes')).toBe(diff);
  if (outcome === 'cancel') {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel operation' }));
    await act(async () => resolve({ id: 'late', taskId: 'review-task', files: reviewFiles, conflicts: [], bringBack: false, fingerprint: 'fp' }));
  } else {
    await act(async () => reject(new Error('Cannot capture stable state')));
    expect(await screen.findByText('Cannot capture stable state')).toBeInTheDocument();
  }
  expect(confirm).not.toHaveBeenCalled();
  expect(document.querySelector('.checkpoint-changes')).toBe(diff);
  expect(await screen.findByRole('button', { name: 'Undo to before this turn' })).toBeEnabled();
});

it.each(['history', 'latest'] as const)('confirms %s undo without opening or loading a change view', async entry => {
  const request = setupReview();
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(false);
  const button = entry === 'history' ? (await screen.findAllByRole('button', { name: 'Undo to before this turn' }))[1] : await screen.findByRole('button', { name: 'Undo latest turn' });
  fireEvent.click(button);
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(`Undo ${entry === 'history' ? 2 : 1} turns affecting 1 files?`) }));
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: 'Checkpoint tasks' })).toBeInTheDocument();
  expect(screen.queryByRole('banner', { name: 'View changes' })).not.toBeInTheDocument();
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && ['detail', 'diff', 'execute'].includes(cmd.payload.action.type))).toBe(false);
  await waitFor(() => expect(button).toBeEnabled());
  confirm.mockResolvedValue(true);
  fireEvent.click(button);
  await waitFor(() => expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && cmd.payload.action.type === 'execute')).toBe(true));
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && ['detail', 'diff'].includes(cmd.payload.action.type))).toBe(false);
});

it.each(['conflict', 'empty'] as const)('keeps %s undo results on the history page without confirmation', async outcome => {
  const notice = outcome === 'conflict' ? 'Overlapping edit in map/validate.ts' : 'No changes to apply';
  const request = setupReview(reviewTask(), outcome === 'conflict' ? [notice] : [], outcome === 'empty' ? [] : reviewFiles);
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Undo latest turn' }));
  expect(await screen.findByText(notice)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
  expect(screen.queryByRole('banner', { name: 'View changes' })).not.toBeInTheDocument();
  expect(confirm).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && ['detail', 'diff', 'execute'].includes(cmd.payload.action.type))).toBe(false);
});

it('does not execute an outer undo after switching tasks during confirmation', async () => {
  const task = reviewTask();
  const request = setupReview(task);
  let resolve!: (value: boolean) => void;
  vi.spyOn(dialogs, 'confirmDialog').mockImplementation(() => new Promise(done => { resolve = done; }));
  fireEvent.click(await screen.findByRole('button', { name: 'Undo latest turn' }));
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  const { useCheckpointStore, selectCheckpointTask } = await import('../checkpoints/store');
  await act(async () => {
    useCheckpointStore.setState({ listing: { ...listing, tasks: [task, { ...task, id: 'another-task', name: 'Another task', checkpoints: [] }] } });
    selectCheckpointTask('another-task');
    resolve(true);
  });
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && cmd.payload.action.type === 'execute')).toBe(false);
});

it('filters confirmed empty history without hiding active, interrupted, incomplete, failed or unknown records', async () => {
  const task = reviewTask();
  const base = task.checkpoints[0];
  task.checkpoints = [
    { ...base, id: 'empty', name: 'Empty completed turn', summary: { files: 0, paths: [] } },
    { ...base, id: 'unknown', name: 'Old summary unavailable', summary: undefined },
    { ...base, id: 'changed', name: 'Changed turn', summary: { files: 1, paths: ['api/map.ts'] } },
    ...(['recording', 'interrupted', 'incomplete'] as const).map(status => ({ ...base, id: status, name: status + ' turn', status, summary: { files: 0, paths: [] } })),
    { ...base, id: 'error', name: 'Failed capture', status: 'incomplete', error: 'Capture failed', summary: { files: 0, paths: [] } },
  ];
  setupReview(task);
  expect(await screen.findByText('Changed turn')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Only with changes' })).toBeChecked();
  expect(screen.queryByText('Empty completed turn')).not.toBeInTheDocument();
  for (const name of ['Old summary unavailable', 'recording turn', 'interrupted turn', 'incomplete turn', 'Failed capture']) expect(screen.getAllByText(name).length).toBeGreaterThan(0);
  expect(screen.getByText('6/7')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Only with changes' }));
  expect(screen.getByText('Empty completed turn')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Only with changes' }));
  expect(screen.queryByText('Empty completed turn')).not.toBeInTheDocument();
});
it('provides an explicit way to reveal all history when the filtered list is empty', async () => {
  const task = reviewTask();
  task.checkpoints = [{ ...task.checkpoints[0], promptHash: null, name: 'Empty interval', summary: { files: 0, paths: [] } }];
  setupReview(task);
  expect(await screen.findByText('No checkpoints with changes')).toBeInTheDocument();
  expect(screen.queryByText('Empty interval')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show all records' }));
  expect(screen.getByText('Empty interval')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Only with changes' })).not.toBeChecked();
});
it('groups records by local calendar date, shows time per row and keeps complete dates and paths available', async () => {
  const task = reviewTask();
  task.checkpoints = [
    { ...task.checkpoints[0], id: 'older', name: 'Older turn', createdAt: new Date(2026, 9, 19, 23, 59).toISOString(), summary: { files: 2, paths: ['admin/src/components/Map.vue', 'api/地图 配置.ts'] } },
    { ...task.checkpoints[1], name: 'Newer turn', createdAt: new Date(2026, 9, 20, 0, 1).toISOString() },
  ];
  setupReview(task);
  expect(await screen.findByRole('heading', { name: '2026/10/20' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '2026/10/19' })).toBeInTheDocument();
  expect(screen.getByText('23:59')).toHaveAttribute('title', '2026/10/19 23:59');
  expect(screen.getByText('00:01')).toHaveAttribute('title', '2026/10/20 00:01');
  expect(screen.getByText('Map.vue · 地图 配置.ts')).toHaveAttribute('title', 'admin/src/components/Map.vue\napi/地图 配置.ts');
});
it('keeps rename in a keyboard accessible menu and closes that menu without closing the panel', async () => {
  const request = setupReview();
  const rename = vi.spyOn(dialogs, 'promptDialog').mockResolvedValue(null);
  const trigger = (await screen.findAllByRole('button', { name: 'More actions' }))[0];
  act(() => trigger.focus());
  fireEvent.click(trigger);
  const item = screen.getByRole('menuitem', { name: 'Rename checkpoint' });
  expect(item).toHaveFocus();
  fireEvent.keyDown(item, { key: 'Escape' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename checkpoint' }));
  await waitFor(() => expect(rename).toHaveBeenCalledOnce());
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && cmd.payload.action.type === 'detail')).toBe(false);
});
it('closes the old record menu when switching task and does not revive it on return', async () => {
  const task = reviewTask();
  const another = { ...task, id: 'another-task', name: 'Another task', checkpoints: [] };
  setupReview(task);
  await screen.findByText('Fix map validation');
  const { useCheckpointStore } = await import('../checkpoints/store');
  act(() => useCheckpointStore.setState({ listing: { ...listing, tasks: [task, another] } }));
  fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0]);
  expect(screen.getByRole('menu')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Another task' }));
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Map improvements' }));
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});
it('opens changes by clicking the record title and keeps manual and automatic recording actions usable', async () => {
  const request = setupReview();
  const title = await screen.findByText('Fix map validation');
  const button = title.closest('button')!;
  act(() => button.focus());
  expect(button).toHaveFocus();
  fireEvent.click(title);
  await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'detail', task_id: 'review-task', checkpoint_id: 'first-turn' } } }), expect.anything()));
  fireEvent.click(await screen.findByRole('button', { name: 'Back to checkpoints' }));
  expect(screen.getByRole('button', { name: 'Undo latest turn' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Hooks verified' })).toHaveAttribute('title', 'A matching hook round was recorded successfully.');
});

it('describes each task mode in the sidebar and updates connection status for the selected task', async () => {
  const task = reviewTask();
  const isolated: TaskWorkspace = { ...task, id: 'isolated', name: 'Isolated task', isolation: 'worktree', mode: 'manual', hookEvents: [], hookError: null, checkpoints: [] };
  const failed: TaskWorkspace = { ...task, id: 'failed', name: 'Connection issue task', hookError: 'Hook handler failed', checkpoints: [] };
  const bridge = new MockBridge(() => []);
  vi.spyOn(bridge, 'request').mockResolvedValue({ ...listing, tasks: [task, isolated, failed], connections: { [task.id]: { status: 'verified', verifiedAt: '2026-10-20T00:00:00Z', error: null } } });
  useAppStore.setState({ bridge, snapshot });
  render(<CheckpointPanel onClose={() => {}} />);
  const originalTask = await screen.findByRole('button', { name: 'Map improvements' });
  expect(within(originalTask).getByText('Original · Automatic')).toBeInTheDocument();
  const isolatedTask = screen.getByRole('button', { name: 'Isolated task' });
  expect(within(isolatedTask).getByText('Isolated · Manual')).toBeInTheDocument();
  const connection = screen.getByRole('button', { name: 'Codex connection' });
  expect(within(connection).getByText('Hook state: verified')).toHaveAttribute('data-status', 'connected');
  expect(connection).toHaveAttribute('title', 'Map improvements · A matching hook round was recorded successfully.');
  fireEvent.click(isolatedTask);
  expect(within(connection).getByText('Hook state: manual')).toHaveAttribute('data-status', 'manual');
  fireEvent.click(screen.getByRole('button', { name: 'Connection issue task' }));
  expect(within(connection).getByText('Hook state: error')).toHaveAttribute('data-status', 'error');
  expect(connection).toHaveAttribute('title', 'Connection issue task · Hook handler failed');
  fireEvent.click(connection);
  expect(screen.getByRole('heading', { name: 'Connection details' })).toBeInTheDocument();
  expect(screen.getByText('Hook handler failed')).toBeInTheDocument();
});
it('keeps an unconfigured task connection separate from global Hook installation', async () => {
  const bridge = new MockBridge(() => []);
  vi.spyOn(bridge, 'request').mockResolvedValue({ ...listing });
  const globalSettings = vi.fn();
  useAppStore.setState({ bridge, snapshot });
  render(<CheckpointPanel onClose={() => {}} onOpenGlobalSettings={globalSettings} />);
  await screen.findByText('No checkpoint tasks yet');
  const connection = screen.getByRole('button', { name: 'Codex connection' });
  expect(within(connection).getByText('Not configured')).toBeInTheDocument();
  fireEvent.click(connection);
  expect(screen.queryByRole('button', { name: 'Update Codex hooks' })).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Checkpoint settings' }));
  expect(globalSettings).toHaveBeenCalledOnce();
});

it('keeps task configuration and connection diagnostics on separate pages', async () => {
  const task = reviewTask();
  task.lastHookAt = '2026-10-20T04:24:02Z';
  setupReview(task);
  fireEvent.click(await screen.findByRole('button', { name: 'Task settings' }));
  expect(screen.getByText('· Map improvements')).toHaveAttribute('title', 'Map improvements');
  expect([...document.querySelectorAll('.checkpoint-settings-section h4')].map(node => node.textContent)).toEqual(['Working directory', 'Checkpoint storage', 'Remove checkpoint task']);
  expect(screen.queryByText('Usage instructions')).not.toBeInTheDocument();
  expect(screen.getByText('Remove this task and its checkpoint history. Original project files are kept.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to checkpoints' }));
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
});
it.each(['original', 'worktree'] as const)('opens %s task roots from the directory menu in the task view', async isolation => {
  setupReview({ ...reviewTask(), isolation, path: '/task workspace', roots: ['/task workspace'] });
  const bridge = useAppStore.getState().bridge!;
  const newWindow = vi.spyOn(bridge, 'openInNewWindow').mockResolvedValue('window');
  const currentWindow = vi.fn().mockResolvedValue(undefined);
  useAppStore.setState({ openWorkspace: currentWindow });
  const more = await screen.findByRole('button', { name: 'Open task' });
  expect(more.querySelector('.codicon-link-external')).toBeInTheDocument();
  act(() => more.focus()); fireEvent.click(more);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new window' }));
  expect(newWindow).toHaveBeenCalledWith(['/task workspace']);
  expect(currentWindow).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.click(more);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open in current window' }));
  expect(currentWindow).toHaveBeenCalledWith(['/task workspace']);
});
it('disables opening the task in the current window when its roots are already open', async () => {
  setupReview();
  fireEvent.click(await screen.findByRole('button', { name: 'Open task' }));
  expect(screen.getByRole('menuitem', { name: 'Open in current window' })).toBeDisabled();
  expect(screen.getByRole('menuitem', { name: 'Open in new window' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Copy Codex project path' })).toBeInTheDocument();
});
it('launches Codex with the registered task id and displays failures in the panel', async () => {
  const request = setupReview();
  vi.spyOn(useAppStore.getState().bridge!, 'platform').mockReturnValue('macos');
  await screen.findByRole('button', { name: 'Open task' });
  const previous = request.getMockImplementation()!;
  request.mockImplementation((command, options) => command.type === 'checkpoint' && command.payload.action.type === 'openInCodex' ? Promise.reject(new Error('Codex desktop app is not installed')) : previous(command, options));
  fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
  expect(screen.getByRole('menuitem', { name: 'Open in Codex' }).querySelector('svg.codicon-codex')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Codex' }));
  expect(await screen.findByText('Codex desktop app is not installed')).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'openInCodex', task_id: 'review-task' } } }), expect.objectContaining({ showProgress: false }));
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
});
it.each(['windows', 'linux'] as const)('keeps Codex opening unavailable on %s', async platform => {
  setupReview();
  vi.spyOn(useAppStore.getState().bridge!, 'platform').mockReturnValue(platform);
  fireEvent.click(await screen.findByRole('button', { name: 'Open task' }));
  expect(screen.getByRole('menuitem', { name: 'Open in Codex' })).toBeDisabled();
});
it('shows a simple empty cleanup result but allows reclaiming unused bytes with zero history records', async () => {
  const task = reviewTask();
  setupReview(task);
  fireEvent.click(await screen.findByRole('button', { name: 'Task settings' }));
  const { useCheckpointStore } = await import('../checkpoints/store');
  const preview = { taskId: task.id, keepRecent: 10, removeCount: 0, protectedCount: 2, reclaimableBytes: 0, fingerprint: 'empty' };
  act(() => useCheckpointStore.setState({ cleanupPreview: preview }));
  expect(screen.getByText('No eligible history to clean')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Clean history' })).not.toBeInTheDocument();
  expect(screen.queryByText(/0 records to remove/)).not.toBeInTheDocument();
  act(() => useCheckpointStore.setState({ cleanupPreview: { ...preview, reclaimableBytes: 1048576, fingerprint: 'garbage' } }));
  expect(screen.queryByText('No eligible history to clean')).not.toBeInTheDocument();
  expect(screen.getByText('0 records to remove · 2 protected · Estimated space to free: 1.00 MiB')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Clean history' })).toBeEnabled();
});

it('marks the task name required, explains invalid input and uses a single creation footer', async () => {
  const bridge = new MockBridge(() => []);
  vi.spyOn(bridge, 'request').mockResolvedValue(listing);
  useAppStore.setState({ bridge, snapshot });
  render(<CheckpointPanel onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'New checkpoint task' }));
  const input = screen.getByRole('textbox', { name: 'Task name' });
  expect(input).toBeRequired();
  expect(screen.getByText('Enter a task name to enable creation.')).toBeInTheDocument();
  fireEvent.change(input, { target: { value: '   ' } });
  fireEvent.blur(input);
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('alert')).toHaveTextContent('Task name cannot be empty or whitespace');
  expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
  fireEvent.change(input, { target: { value: 'Fix POI' } });
  expect(input).not.toHaveAttribute('aria-invalid');
  const footer = document.querySelector('.checkpoint-footer')!;
  expect(within(footer as HTMLElement).getAllByRole('button').map(node => node.textContent)).toEqual(['Cancel', 'Create task']);
  expect(document.querySelector('.checkpoint-action-footer')).toBeNull();
  expect(screen.getByRole('button', { name: 'Create task' })).toBeEnabled();
});
it('bulk selection only includes supported repositories and retains complete path tooltips', async () => {
  const bridge = new MockBridge(() => []);
  vi.spyOn(bridge, 'request').mockResolvedValue(listing);
  const git = snapshot.repositories[0];
  const repos = [git, { ...git, meta: { ...git.meta, id: 'nested', name: '工具 仓库', rootPath: '/project/packages/工具 仓库' } }, { ...git, meta: { ...git.meta, id: 'svn', name: 'SVN', kind: 'svn' as const, rootPath: '/project/svn' } }, { ...git, meta: { ...git.meta, id: 'submodule', name: 'Submodule', isSubmodule: true, rootPath: '/project/submodule' } }];
  useAppStore.setState({ bridge, snapshot: { ...snapshot, repositories: repos } });
  render(<CheckpointPanel onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'New checkpoint task' }));
  expect(screen.getByText('Selected 2 / 2')).toBeInTheDocument();
  expect(screen.getByTitle('/project/packages/工具 仓库')).toHaveTextContent('packages/工具 仓库');
  const inputs = screen.getAllByRole('checkbox');
  expect(inputs[2]).toBeDisabled();
  expect(inputs[3]).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Deselect all repositories' }));
  expect(inputs.every(input => !(input as HTMLInputElement).checked)).toBe(true);
  expect(screen.getByText('Select at least one Git repository')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Select all repositories' }));
  expect(inputs[0]).toBeChecked();
  expect(inputs[1]).toBeChecked();
  expect(inputs[2]).not.toBeChecked();
  expect(inputs[3]).not.toBeChecked();
});
it('blocks duplicate original tasks in the same workspace even with disjoint repositories and offers isolation', async () => {
  const request = setupReview();
  fireEvent.click(await screen.findByRole('button', { name: 'New checkpoint task' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Task name' }), { target: { value: 'Parallel change' } });
  expect(screen.getByText('An original-directory task already protects these repositories; use that task or create an isolated task')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && cmd.payload.action.type === 'create')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to isolated mode' }));
  expect(screen.getByLabelText('Working directory mode')).toHaveTextContent('Isolated task worktrees');
  expect(screen.getByRole('button', { name: 'Create task' })).toBeEnabled();
  expect(screen.queryByText('An original-directory task already protects these repositories; use that task or create an isolated task')).not.toBeInTheDocument();
});
it('returns to the existing task directly from the overlap notice', async () => {
  setupReview();
  fireEvent.click(await screen.findByRole('button', { name: 'New checkpoint task' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use task: Map improvements' }));
  expect(screen.getByRole('heading', { name: 'Map improvements' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Task name' })).not.toBeInTheDocument();
});

it('renames the current task from its heading and refreshes both the sidebar and title', async () => {
  const task = reviewTask();
  const request = setupReview(task);
  request.mockImplementation(command => {
    if (command.type === 'checkpoint' && command.payload.action.type === 'renameTask') { task.name = command.payload.action.name.trim(); return Promise.resolve(true) as never; }
    return Promise.resolve({ ...listing, tasks: [task], connections: { [task.id]: { status: 'verified', verifiedAt: '2026-10-20T00:00:00Z', error: null } } }) as never;
  });
  const prompt = vi.spyOn(dialogs, 'promptDialog').mockResolvedValue('  地图与权限联调  ');
  fireEvent.click(await screen.findByRole('button', { name: 'Rename task' }));
  expect(await screen.findByRole('heading', { name: '地图与权限联调' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '地图与权限联调' })).toBeInTheDocument();
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rename task', inputLabel: 'Task name', initialValue: 'Map improvements' }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'renameTask', task_id: 'review-task', name: '  地图与权限联调  ' } } }), expect.anything());
});
it.each([null, ' Map improvements '])('does not rename for a cancelled or unchanged name: %s', async value => {
  const request = setupReview();
  vi.spyOn(dialogs, 'promptDialog').mockResolvedValue(value);
  fireEvent.click(await screen.findByRole('button', { name: 'Rename task' }));
  await act(async () => {});
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'renameTask')).toBe(false);
});
it('does not apply a task rename after selection changes during the prompt', async () => {
  const task = reviewTask();
  const other = { ...task, id: 'other-task', name: 'Other task' };
  const request = setupReview(task);
  request.mockResolvedValue({ ...listing, tasks: [task, other] });
  await screen.findByRole('button', { name: 'Task settings' });
  const { useCheckpointStore } = await import('../checkpoints/store');
  act(() => useCheckpointStore.setState({ listing: { ...listing, tasks: [task, other] } }));
  let resolve!: (value: string) => void;
  vi.spyOn(dialogs, 'promptDialog').mockImplementation(() => new Promise(done => { resolve = done; }));
  fireEvent.click(await screen.findByRole('button', { name: 'Rename task' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Other task' }));
  await act(async () => resolve('Wrong target'));
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'renameTask')).toBe(false);
  expect(screen.getByRole('heading', { name: 'Other task' })).toBeInTheDocument();
});

it('loads paged history, searches messages, filters repositories and retains the complete undo range', async () => {
  const task = reviewTask();
  task.repositories = [{ sourceId: 'repo', sourcePath: '/project/repo', taskPath: '/project/repo', branch: 'main' }];
  const bridge = new MockBridge(() => []);
  const pagePoint = { ...task.checkpoints[0], id: 'old-page-point', name: 'Older matching turn' };
  const request = vi.spyOn(bridge, 'request').mockImplementation(command => {
    if (command.type !== 'checkpoint') return Promise.resolve(null) as never;
    const action = command.payload.action;
    if (action.type === 'history') return Promise.resolve({ taskId: task.id, points: [pagePoint], total: 123, matching: action.query ? 1 : 123, offset: action.offset, revision: 'r1', followingTurns: { [pagePoint.id]: 72 } }) as never;
    if (action.type === 'detail') return Promise.resolve(reviewFiles) as never;
    return Promise.resolve({ ...listing, tasks: [task], historyCounts: { [task.id]: 123 }, historyRevisions: { [task.id]: 'r1' } }) as never;
  });
  useAppStore.setState({ bridge, snapshot });
  render(<CheckpointPanel onClose={() => {}} />);
  expect(await screen.findByText('Older matching turn')).toBeInTheDocument();
  expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Older matching turn'));
  expect(await screen.findByText('Undoing this checkpoint also undoes 72 later completed turns.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to checkpoints' }));
  fireEvent.click(screen.getByRole('button', { name: 'Search checkpoints' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Search checkpoints' }), { target: { value: '追加正文' } });
  await waitFor(() => expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'history' && command.payload.action.query === '追加正文' && command.payload.action.offset === 0)).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Filter checkpoint repository' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'repo' }));
  await waitFor(() => expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'history' && command.payload.action.repository === '/project/repo')).toBe(true));
});
function setupRedo(conflicts: string[] = [], files = reviewFiles) {
  const task = reviewTask();
  task.checkpoints.forEach(point => { point.status = 'undone'; });
  const bridge = new MockBridge(() => []);
  const request = vi.spyOn(bridge, 'request').mockImplementation(command => {
    if (command.type === 'checkpoint' && command.payload.action.type === 'detail') return Promise.resolve(reviewFiles) as never;
    if (command.type === 'checkpoint' && command.payload.action.type === 'diff') return Promise.resolve({ path: command.payload.action.path, content: '@@ -1 +1 @@\n-old\n+new\n', language: 'typescript', binary: false, truncated: false, lineCount: 3 }) as never;
    if (command.type === 'checkpoint' && command.payload.action.type === 'previewRedo') return Promise.resolve({ id: 'redo-preview', taskId: task.id, redoOf: 'undo-tx', bringBack: false, files, conflicts, fingerprint: 'fp' }) as never;
    if (command.type === 'checkpoint' && command.payload.action.type === 'execute') {
      task.checkpoints.forEach(point => { point.status = 'completed'; });
      return Promise.resolve({ status: 'succeeded' }) as never;
    }
    const available = task.checkpoints.every(point => point.status === 'undone');
    return Promise.resolve({ ...listing, tasks: [task], redoCheckpoints: available ? { [task.id]: task.checkpoints.map(point => point.id) } : {} }) as never;
  });
  useAppStore.setState({ bridge, snapshot });
  render(<CheckpointPanel onClose={() => {}} />);
  return request;
}
it('shows redo only in eligible details and keeps the historical diff when confirmation is cancelled', async () => {
  const request = setupRedo();
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(false);
  await screen.findByRole('heading', { name: 'Checkpoint history' });
  expect(screen.getAllByRole('button', { name: 'Redo last undo' })).toHaveLength(1);
  fireEvent.click((await screen.findAllByRole('button', { name: 'View changes' }))[1]);
  await screen.findByText('validate.ts');
  const diff = document.querySelector('.checkpoint-changes');
  const count = request.mock.calls.filter(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'diff').length;
  const button = screen.getByRole('button', { name: 'Redo last undo' });
  expect(button.closest('footer')).toHaveClass('checkpoint-footer');
  expect(screen.queryByRole('button', { name: 'Undo to before this turn' })).not.toBeInTheDocument();
  expect(screen.getByText('Reapplies all 2 turns from the last undo.')).toBeInTheDocument();
  fireEvent.click(button);
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(document.querySelector('.checkpoint-changes')).toBe(diff);
  expect(request.mock.calls.filter(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'diff')).toHaveLength(count);
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'execute')).toBe(false);
  await waitFor(() => expect(button).toBeEnabled());
  confirm.mockResolvedValue(true);
  fireEvent.click(button);
  await waitFor(() => expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'execute')).toBe(true));
});
it.each(['older', 'missing', 'invalidated'] as const)('hides detail redo for %s eligibility while retaining historical changes', async reason => {
  setupRedo();
  fireEvent.click((await screen.findAllByRole('button', { name: 'View changes' }))[1]);
  await screen.findByText('validate.ts');
  const { useCheckpointStore } = await import('../checkpoints/store');
  act(() => {
    const current = useCheckpointStore.getState().listing!;
    useCheckpointStore.setState({ listing: { ...current, redoCheckpoints: reason === 'missing' ? undefined : reason === 'invalidated' ? {} : { 'review-task': ['later-turn'] } } });
  });
  expect(screen.queryByRole('button', { name: 'Redo last undo' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Undo to before this turn' })).toBeDisabled();
  expect(screen.getByText('validate.ts')).toBeInTheDocument();
});
it('keeps redo conflicts inside the detail page', async () => {
  const request = setupRedo(['Overlapping redo edit']);
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(true);
  fireEvent.click((await screen.findAllByRole('button', { name: 'View changes' }))[0]);
  await screen.findByText('validate.ts');
  const diff = document.querySelector('.checkpoint-changes');
  fireEvent.click(screen.getByRole('button', { name: 'Redo last undo' }));
  expect(await screen.findByText('Overlapping redo edit')).toBeInTheDocument();
  expect(document.querySelector('.checkpoint-changes')).toBe(diff);
  expect(confirm).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'execute')).toBe(false);
});
it('confirms redo directly on the history page and only executes after confirmation', async () => {
  const request = setupRedo();
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(false);
  const button = await screen.findByRole('button', { name: 'Redo last undo' });
  fireEvent.click(button);
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Redo last undo', message: 'Reapply the changes from the last undo, affecting 1 files? Stop external writes before continuing. Later non-overlapping edits are kept, and your current state will be backed up.' }));
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
  expect(screen.queryByRole('banner', { name: 'Redo preview' })).not.toBeInTheDocument();
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && ['detail', 'diff', 'execute'].includes(command.payload.action.type))).toBe(false);
  await waitFor(() => expect(button).toBeEnabled());
  confirm.mockResolvedValue(true);
  fireEvent.click(button);
  await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'execute', preview_id: 'redo-preview' } } }), expect.anything()));
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
});
it.each(['conflict', 'empty'] as const)('keeps redo %s on the history page without asking to execute', async outcome => {
  const notice = outcome === 'conflict' ? 'Later overlapping edit' : 'No changes to apply';
  const request = setupRedo(outcome === 'conflict' ? [notice] : [], outcome === 'empty' ? [] : reviewFiles);
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Redo last undo' }));
  expect(await screen.findByText(notice)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
  expect(confirm).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && ['detail', 'diff', 'execute'].includes(command.payload.action.type))).toBe(false);
});
it.each(['cancel', 'fail'] as const)('keeps the history visible during redo preflight and handles %s', async outcome => {
  const request = setupRedo();
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(true);
  const button = await screen.findByRole('button', { name: 'Redo last undo' });
  const previous = request.getMockImplementation()!;
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  request.mockImplementation((command, options) => command.type === 'checkpoint' && command.payload.action.type === 'previewRedo' ? new Promise((done, fail) => { resolve = done; reject = fail; }) : previous(command, options));
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
  if (outcome === 'cancel') {
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel operation' }));
    await act(async () => resolve({ id: 'late-redo', taskId: 'review-task', redoOf: 'undo-tx', bringBack: false, files: reviewFiles, conflicts: [], fingerprint: 'fp' }));
  } else {
    await act(async () => reject(new Error('Redo preflight failed')));
    expect(await screen.findByText('Redo preflight failed')).toBeInTheDocument();
  }
  await waitFor(() => expect(button).toBeEnabled());
  expect(confirm).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'execute')).toBe(false);
});
it.each(['task', 'preview', 'close'] as const)('does not execute a stale redo confirmation after changing %s', async change => {
  const request = setupRedo();
  let resolve!: (value: boolean) => void;
  vi.spyOn(dialogs, 'confirmDialog').mockImplementation(() => new Promise(done => { resolve = done; }));
  fireEvent.click(await screen.findByRole('button', { name: 'Redo last undo' }));
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  const { useCheckpointStore, selectCheckpointTask } = await import('../checkpoints/store');
  await act(async () => {
    if (change === 'task') selectCheckpointTask('another-task');
    else if (change === 'preview') useCheckpointStore.setState({ preview: { ...useCheckpointStore.getState().preview!, id: 'replacement' } });
    else cleanup();
    resolve(true);
  });
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'execute')).toBe(false);
});
it('shows the open recording name, elapsed time and last event without closing it automatically', async () => {
  const task = reviewTask();
  task.lastHookAt = '2026-10-20T02:01:00Z';
  task.checkpoints = [{ ...task.checkpoints[0], name: 'Unfinished change', status: 'recording', after: null, createdAt: new Date(Date.now() - 20 * 60000).toISOString() }];
  const request = setupReview(task);
  expect(await screen.findByText('Unfinished for 20 minutes')).toBeInTheDocument();
  expect(screen.getByText('This interval is still open. Verify that all writes have stopped before finishing; elapsed time does not prove Codex has stopped.')).toBeInTheDocument();
  expect(screen.getByText(/Last event:/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Finish recording' })).toBeEnabled();
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && ['finish', 'abandon'].includes(command.payload.action.type))).toBe(false);
});

it('shows a checkmark and copied tooltip for two seconds without sending a notification', async () => {
  setupReview();
  const copy = await screen.findByRole('button', { name: 'Copy Codex project path' });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const notifications = useAppStore.getState().notifications;
  vi.useFakeTimers();
  fireEvent.click(copy);
  await act(async () => {});
  expect(writeText).toHaveBeenCalledWith('/project');
  const copied = screen.getByRole('button', { name: 'Copied' });
  expect(copied).toHaveAttribute('title', 'Copied');
  expect(copied.querySelector('.codicon-check')).toBeInTheDocument();
  expect(useAppStore.getState().notifications).toEqual(notifications);
  act(() => vi.advanceTimersByTime(1999));
  expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('button', { name: 'Copy Codex project path' }).querySelector('.codicon-copy')).toBeInTheDocument();
  vi.useRealTimers();
});
it('keeps failed copies in the panel and clears their error after a successful retry', async () => {
  setupReview();
  const copy = await screen.findByRole('button', { name: 'Copy Codex project path' });
  const writeText = vi.fn().mockRejectedValueOnce(new Error('Clipboard unavailable')).mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  fireEvent.click(copy);
  expect(await screen.findByText('Copy failed; select and copy the task path.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  fireEvent.click(copy);
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  expect(screen.queryByText('Copy failed; select and copy the task path.')).not.toBeInTheDocument();
});
it.each(['success', 'failure'] as const)('ignores a late clipboard %s after changing tasks', async outcome => {
  const task = reviewTask();
  setupReview(task);
  const copy = await screen.findByRole('button', { name: 'Copy Codex project path' });
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const writeText = vi.fn(() => new Promise<void>((done, fail) => { resolve = done; reject = fail; }));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  fireEvent.click(copy);
  expect(copy).toBeDisabled();
  const { useCheckpointStore } = await import('../checkpoints/store');
  act(() => useCheckpointStore.setState({ listing: { ...listing, tasks: [task, { ...task, id: 'other', name: 'Another task', path: '/other' }] }, selectedTaskId: 'other' }));
  expect(screen.getByRole('button', { name: 'Copy Codex project path' })).toBeEnabled();
  await act(async () => { if (outcome === 'success') resolve(); else reject(new Error('Old clipboard error')); });
  expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  expect(screen.queryByText('Copy failed; select and copy the task path.')).not.toBeInTheDocument();
});
