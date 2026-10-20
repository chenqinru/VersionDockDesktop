import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CheckpointPanel } from './CheckpointPanel';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { checkpointWorkspaceChanged } from '../checkpoints/store';
import type { CheckpointListing, TaskWorkspace, WorkspaceSnapshot } from '../bindings/generated';
import * as dialogs from './dialogService';
const original = useAppStore.getState();
const snapshot: WorkspaceSnapshot = { workspace: { id: 'ws', name: 'project', paths: ['/project'], available: true, lastOpenedAt: '' }, repositories: [{ meta: { id: 'repo', name: 'repo', kind: 'git', rootPath: '/project/repo', color: '#888', depth: 0, parentRepoId: null, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null }], tools: { git: true, svn: false, svnadmin: false }, generation: 1 };
const listing: CheckpointListing = { tasks: [], recovery: [], storageBytes: 1024, hooksInstalled: false };
afterEach(() => { cleanup(); checkpointWorkspaceChanged(null); useAppStore.setState(original, true); vi.restoreAllMocks(); });
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
  vi.spyOn(bridge, 'request').mockResolvedValue({ ...listing, tasks: [task], hooksInstalled: true });
  useAppStore.setState({ bridge, snapshot }); render(<CheckpointPanel onClose={() => {}} />);
  expect(await screen.findByRole('button', { name: 'Unverified' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Preview bring back' })).not.toBeInTheDocument();
});
it('keeps setup controls out of the daily recording view and makes them available in task settings', async () => {
  const bridge = new MockBridge(() => []);
  const task: TaskWorkspace = { id: 't', workspaceId: 'ws', name: 'Daily task', path: '/project', roots: ['/project'], repositories: [], mode: 'manual', isolation: 'original', createdAt: '', seed: '', sourceSeed: '', lastApplied: null, checkpoints: [], hookEvents: [], lastHookAt: null, hookError: null, error: null };
  vi.spyOn(bridge, 'request').mockResolvedValue({ ...listing, tasks: [task] });
  useAppStore.setState({ bridge, snapshot }); render(<CheckpointPanel onClose={() => {}} />);
  await screen.findByRole('heading', { name: 'Daily task' });
  expect(screen.getByRole('button', { name: 'Start recording' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Install Codex checkpoint hooks' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy Codex project path' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Task settings' }));
  expect(screen.getByRole('button', { name: 'Install Codex checkpoint hooks' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy Codex project path' })).toBeInTheDocument();
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
function setupReview(task = reviewTask(), conflicts: string[] = []) {
  const bridge = new MockBridge(() => []);
  const request = vi.spyOn(bridge, 'request').mockImplementation(command => {
    if (command.type !== 'checkpoint') return Promise.resolve(null) as never;
    const action = command.payload.action;
    if (action.type === 'detail') return Promise.resolve(reviewFiles) as never;
    if (action.type === 'messages') return Promise.resolve([{ body: 'Fix map validation\nPreserve existing input', annotations: [], attachments: [], selections: [], raw: null }]) as never;
    if (action.type === 'preview') return Promise.resolve({ id: 'undo-preview', taskId: task.id, bringBack: false, files: reviewFiles, conflicts, fingerprint: 'fingerprint' }) as never;
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
it('previews undo for the displayed checkpoint and applies only after confirmation', async () => {
  const request = setupReview();
  const confirm = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(false);
  fireEvent.click((await screen.findAllByRole('button', { name: 'View changes' }))[1]);
  fireEvent.click(await screen.findByRole('button', { name: 'Undo to before this turn' }));
  expect(await screen.findByText('Undo preview')).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'preview', task_id: 'review-task', checkpoint_id: 'first-turn', bring_back: false } } }), expect.anything());
  expect(screen.getByText('Fix map validation')).toBeInTheDocument();
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && cmd.payload.action.type === 'execute')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm undo' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(request.mock.calls.some(([cmd]) => cmd.type === 'checkpoint' && cmd.payload.action.type === 'execute')).toBe(false);
  confirm.mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm undo' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'execute', preview_id: 'undo-preview' } } }), expect.anything()));
  expect(await screen.findByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
});
it('blocks applying a conflicted review preview', async () => {
  setupReview(reviewTask(), ['Overlapping edit in map/validate.ts']);
  fireEvent.click((await screen.findAllByRole('button', { name: 'View changes' }))[1]);
  fireEvent.click(await screen.findByRole('button', { name: 'Undo to before this turn' }));
  expect(await screen.findByText('Overlapping edit in map/validate.ts')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm undo' })).toBeDisabled();
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
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm undo' }));
  const { act } = await import('@testing-library/react');
  await act(async () => { useAppStore.setState({ snapshot: { ...snapshot, workspace: { ...snapshot.workspace, id: 'other' } } }); resolve(true); });
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
  expect(screen.getByRole('button', { name: 'Preview undo latest turn' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Hooks verified' })).toHaveAttribute('title', 'A matching hook round was recorded successfully.');
});

it('describes each task mode in the sidebar and updates connection status for the selected task', async () => {
  const task = reviewTask();
  const isolated: TaskWorkspace = { ...task, id: 'isolated', name: 'Isolated task', isolation: 'worktree', mode: 'manual', hookEvents: [], hookError: null, checkpoints: [] };
  const failed: TaskWorkspace = { ...task, id: 'failed', name: 'Connection issue task', hookError: 'Hook handler failed', checkpoints: [] };
  const bridge = new MockBridge(() => []);
  vi.spyOn(bridge, 'request').mockResolvedValue({ ...listing, hooksInstalled: true, tasks: [task, isolated, failed], connections: { [task.id]: { status: 'verified', verifiedAt: '2026-10-20T00:00:00Z', error: null } } });
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
  expect(screen.getByRole('heading', { name: 'Task settings' })).toBeInTheDocument();
  expect(screen.getByText('Hook handler failed')).toBeInTheDocument();
});
it('does not claim a connection just because hooks are installed and has a usable entry without tasks', async () => {
  const bridge = new MockBridge(() => []);
  vi.spyOn(bridge, 'request').mockResolvedValue({ ...listing, hooksInstalled: true });
  useAppStore.setState({ bridge, snapshot });
  render(<CheckpointPanel onClose={() => {}} />);
  await screen.findByText('No checkpoint tasks yet');
  const connection = screen.getByRole('button', { name: 'Codex connection' });
  expect(within(connection).getByText('Not configured')).toBeInTheDocument();
  fireEvent.click(connection);
  expect(screen.getByRole('button', { name: 'Update Codex hooks' })).toBeInTheDocument();
});

it('identifies the settings task, places connection before cleanup, and folds usage instructions', async () => {
  const task = reviewTask();
  task.lastHookAt = '2026-10-20T04:24:02Z';
  setupReview(task);
  fireEvent.click(await screen.findByRole('button', { name: 'Task settings' }));
  expect(screen.getByText('· Map improvements')).toHaveAttribute('title', 'Map improvements');
  expect([...document.querySelectorAll('.checkpoint-settings-section h4')].map(node => node.textContent)).toEqual(['Working directory', 'Codex connection', 'Checkpoint storage', 'Remove checkpoint task']);
  const instructions = screen.getByText('Usage instructions').closest('details')!;
  expect(instructions).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('Usage instructions'));
  expect(instructions).toHaveAttribute('open');
  expect(screen.getByText(/Last event:/)).toBeInTheDocument();
  expect(screen.getByText('Remove this task and its checkpoint history. Original project files are kept.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to checkpoints' }));
  expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeInTheDocument();
});
it('keeps original-directory open actions in More and routes them to the selected task roots', async () => {
  setupReview();
  const bridge = useAppStore.getState().bridge!;
  const newWindow = vi.spyOn(bridge, 'openInNewWindow').mockResolvedValue('window');
  const currentWindow = vi.fn().mockResolvedValue(undefined);
  useAppStore.setState({ openWorkspace: currentWindow });
  fireEvent.click(await screen.findByRole('button', { name: 'Task settings' }));
  expect(screen.queryByRole('button', { name: 'Open in VersionDock' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open task in this window' })).not.toBeInTheDocument();
  const more = screen.getByRole('button', { name: 'More actions' });
  act(() => more.focus());
  fireEvent.click(more);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open in VersionDock' }));
  expect(newWindow).toHaveBeenCalledWith(['/project']);
  expect(currentWindow).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.click(more);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open task in this window' }));
  expect(currentWindow).toHaveBeenCalledWith(['/project']);
});
it('keeps isolated workspace open actions visible', async () => {
  const task = { ...reviewTask(), isolation: 'worktree' as const };
  setupReview(task);
  fireEvent.click(await screen.findByRole('button', { name: 'Task settings' }));
  expect(screen.getByRole('button', { name: 'Open in VersionDock' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Open task in this window' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
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

it('renames the current task from settings and refreshes both the sidebar and title', async () => {
  const task = reviewTask();
  const request = setupReview(task);
  request.mockImplementation(command => {
    if (command.type === 'checkpoint' && command.payload.action.type === 'renameTask') { task.name = command.payload.action.name.trim(); return Promise.resolve(true) as never; }
    return Promise.resolve({ ...listing, tasks: [task], connections: { [task.id]: { status: 'verified', verifiedAt: '2026-10-20T00:00:00Z', error: null } } }) as never;
  });
  const prompt = vi.spyOn(dialogs, 'promptDialog').mockResolvedValue('  地图与权限联调  ');
  fireEvent.click(await screen.findByRole('button', { name: 'Task settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Rename task' }));
  expect(await screen.findByText('· 地图与权限联调')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '地图与权限联调' })).toBeInTheDocument();
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rename task', inputLabel: 'Task name', initialValue: 'Map improvements' }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'ws', action: { type: 'renameTask', task_id: 'review-task', name: '  地图与权限联调  ' } } }), expect.anything());
});
it.each([null, ' Map improvements '])('does not rename for a cancelled or unchanged name: %s', async value => {
  const request = setupReview();
  vi.spyOn(dialogs, 'promptDialog').mockResolvedValue(value);
  fireEvent.click(await screen.findByRole('button', { name: 'Task settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Rename task' }));
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
  fireEvent.click(await screen.findByRole('button', { name: 'Task settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Rename task' }));
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
  fireEvent.change(screen.getByRole('textbox', { name: 'Search checkpoints' }), { target: { value: '追加正文' } });
  await waitFor(() => expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'history' && command.payload.action.query === '追加正文' && command.payload.action.offset === 0)).toBe(true));
  fireEvent.click(screen.getByRole('combobox', { name: 'Filter checkpoint repository' }));
  fireEvent.click(screen.getByRole('option', { name: 'repo' }));
  await waitFor(() => expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'history' && command.payload.action.repository === '/project/repo')).toBe(true));
});
it('previews redo as a protected restore instead of executing it immediately', async () => {
  const task = reviewTask();
  task.checkpoints.forEach(point => { point.status = 'undone'; });
  const bridge = new MockBridge(() => []);
  const request = vi.spyOn(bridge, 'request').mockImplementation(command => {
    if (command.type === 'checkpoint' && command.payload.action.type === 'previewRedo') return Promise.resolve({ id: 'redo-preview', taskId: task.id, redoOf: 'undo-tx', bringBack: false, files: reviewFiles, conflicts: [], fingerprint: 'fp' }) as never;
    return Promise.resolve({ ...listing, tasks: [task], redoTasks: [task.id] }) as never;
  });
  useAppStore.setState({ bridge, snapshot });
  render(<CheckpointPanel onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Redo last undo' }));
  expect(await screen.findByRole('banner', { name: 'Redo preview' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Apply restore preview' })).toBeEnabled();
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
