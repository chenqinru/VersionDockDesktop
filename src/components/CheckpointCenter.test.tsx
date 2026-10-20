import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskWorkspace, WorkspaceDescriptor, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { checkpointWorkspaceChanged, useCheckpointStore } from '../checkpoints/store';
import { closeCheckpointCenter } from '../checkpoints/center';
import { I18nContext, createTranslator } from '../i18n';
import { TitleBarActions } from './TitleBarActions';
import { CheckpointStatusBarItem } from './StatusBar/CheckpointStatusBarItem';
import { getProjectColor, getProjectInitials } from './projectIconUtils';

const original = useAppStore.getState();
const project = (id: string): WorkspaceDescriptor => ({ id, name: `Project ${id}`, paths: [`/${id}`], available: true, lastOpenedAt: '' });
const task = (id: string, workspaceId: string, status: string): TaskWorkspace => ({ id, workspaceId, name: `Fix ${id}`, path: `/${workspaceId}`, roots: [`/${workspaceId}`], mode: 'manual', isolation: 'original', repositories: [], createdAt: '', seed: 'seed', sourceSeed: 'seed', lastApplied: null, hookEvents: [], lastHookAt: null, hookError: null, error: null, checkpoints: [{ id: `point-${id}`, name: `Change ${id}`, status, createdAt: '2026-10-20T01:00:00Z', before: 'before', after: status === 'recording' ? null : 'after', error: null, sessionId: null, turnId: null }] });
afterEach(() => { cleanup(); closeCheckpointCenter(); checkpointWorkspaceChanged(null); useAppStore.setState(original, true); vi.restoreAllMocks(); });

function setup(withProject = true, extraTasks: TaskWorkspace[] = []) {
  const projects = [project('A'), project('B')];
  const tasks = [task('A', 'A', 'recording'), task('B', 'B', 'completed'), ...extraTasks];
  const bridge = new MockBridge(command => {
    if (command.type === 'checkpointCatalog') return { projects, tasks };
    if (command.type !== 'checkpoint') return [];
    const action = command.payload.action;
    if (action.type === 'repositories') return [];
    if (action.type === 'detail') return [{ repository: '/B/repo', path: 'file.ts', layer: 'working', status: 'modified', before: null, after: null }];
    if (action.type === 'diff') return { path: 'file.ts', language: 'typescript', content: '@@ -1 +1 @@\n-old\n+new\n', binary: false, truncated: false, lineCount: 3 };
    return { tasks: tasks.filter(task => task.workspaceId === command.payload.workspace_id), recovery: [], storageBytes: 0, hooksInstalled: false };
  });
  const originalRequest = bridge.request.bind(bridge);
  const request = vi.spyOn(bridge, 'request');
  useAppStore.setState({ bridge, snapshot: withProject ? { workspace: projects[0], repositories: [], tools: { git: true, svn: false, svnadmin: false }, generation: 1 } as WorkspaceSnapshot : undefined, operations: {} });
  render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><TitleBarActions workspaceId={withProject ? 'A' : undefined} />{withProject && <CheckpointStatusBarItem />}</I18nContext.Provider>);
  if (withProject) fireEvent.click(screen.getByRole('button', { name: 'Tasks and checkpoints' }));
  return { request, originalRequest, projects, tasks };
}

it('groups tasks across projects, searches and collapses them, without switching the main workspace or its status', async () => {
  const { request } = setup();
  await screen.findByRole('navigation', { name: 'Checkpoint projects' });
  const groupB = await within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).findByRole('button', { name: /^Project B/ });
  expect(within(groupB).getByTestId('project-icon')).toHaveAttribute('data-initials', getProjectInitials('Project B'));
  expect(within(groupB).getByTestId('project-icon')).toHaveStyle({ backgroundColor: getProjectColor('/B') });
  expect(groupB).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(groupB);
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).getByRole('button', { name: /Fix B/ }));
  expect(await screen.findByRole('heading', { name: 'Fix B' })).toBeInTheDocument();
  expect(useAppStore.getState().snapshot?.workspace.id).toBe('A');
  expect(useCheckpointStore.getState()).toMatchObject({ workspaceId: 'B', selectedTaskId: 'B' });
  expect(screen.getByText('Checkpoints · Recording')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Search projects and tasks' }));
  const search = screen.getByRole('textbox', { name: 'Search projects and tasks' });
  fireEvent.change(search, { target: { value: 'Fix A' } });
  expect(within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).getByRole('button', { name: /Fix A/ })).toBeInTheDocument();
  expect(within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).queryByRole('button', { name: /^Project B/ })).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: 'missing' } });
  expect(within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).getByText('No results')).toBeInTheDocument();
  fireEvent.change(search, { target: { value: '' } });
  fireEvent.click(await screen.findByRole('button', { name: 'View changes' }));
  expect((await screen.findAllByText('file.ts')).length).toBeGreaterThan(0);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspace_id: 'B', action: { type: 'detail', task_id: 'B', checkpoint_id: 'point-B' } } }), expect.anything());
  expect(request.mock.calls.filter(([command]) => command.type === 'checkpointCatalog').every(([, options]) => options?.showProgress === false)).toBe(true);
});

it('keeps the welcome screen free of the checkpoint entry and catalog requests', () => {
  const { request } = setup(false);
  expect(screen.queryByRole('button', { name: 'Tasks and checkpoints' })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: 'Tasks and checkpoints' })).not.toBeInTheDocument();
  expect(useAppStore.getState().snapshot).toBeUndefined();
  expect(request.mock.calls.some(([command]) => command.type === 'checkpointCatalog')).toBe(false);
});

it('keeps project search compact and handles clearing and closing without dismissing the center', async () => {
  setup();
  await screen.findByRole('heading', { name: 'Fix A' });
  const button = screen.getByRole('button', { name: 'Search projects and tasks' });
  expect(screen.queryByRole('textbox', { name: 'Search projects and tasks' })).not.toBeInTheDocument();
  fireEvent.click(button);
  const input = screen.getByRole('textbox', { name: 'Search projects and tasks' });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: 'Fix A' } });
  fireEvent.click(button);
  expect(input).toHaveValue('Fix A');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(input).toHaveValue('');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('textbox', { name: 'Search projects and tasks' })).not.toBeInTheDocument();
  expect(button).toHaveFocus();
  expect(screen.getByRole('dialog', { name: 'Tasks and checkpoints' })).toBeInTheDocument();
});

it('ignores an old project response when selection changes', async () => {
  const { request, originalRequest } = setup();
  await screen.findByRole('heading', { name: 'Fix A' });
  let release!: (value: unknown) => void;
  request.mockImplementation((command, options) => command.type === 'checkpoint' && command.payload.workspace_id === 'B' && command.payload.action.type === 'overview' ? new Promise(resolve => { release = resolve; }) : originalRequest(command, options));
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).getByRole('button', { name: /^Project B/ }));
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).getByRole('button', { name: /Fix B/ }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  const groupA = within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).getByRole('button', { name: /^Project A/ });
  if (groupA.getAttribute('aria-expanded') === 'false') fireEvent.click(groupA);
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).getByRole('button', { name: /Fix A/ }));
  expect(useCheckpointStore.getState().workspaceId).toBe('A');
  await act(async () => release({ tasks: [task('stale', 'B', 'completed')], recovery: [] }));
  expect(await screen.findByRole('heading', { name: 'Fix A' })).toBeInTheDocument();
  expect(useCheckpointStore.getState().workspaceId).toBe('A');
});

it('keeps the dialog, sidebar position and task focus while another project loads', async () => {
  const { request, originalRequest, tasks } = setup();
  await screen.findByRole('heading', { name: 'Fix A' });
  const dialog = screen.getByRole('dialog', { name: 'Tasks and checkpoints' });
  const navigation = screen.getByRole('navigation', { name: 'Checkpoint projects' });
  navigation.scrollTop = 80;
  let release!: (value: unknown) => void;
  request.mockImplementation((command, options) => command.type === 'checkpoint' && command.payload.workspace_id === 'B' && command.payload.action.type === 'overview' ? new Promise(resolve => { release = resolve; }) : originalRequest(command, options));
  fireEvent.click(within(navigation).getByRole('button', { name: /^Project B/ }));
  const target = within(navigation).getByRole('button', { name: /Fix B/ });
  target.focus();
  fireEvent.click(target);
  await waitFor(() => expect(release).toBeTypeOf('function'));
  expect(screen.getByRole('dialog', { name: 'Tasks and checkpoints' })).toBe(dialog);
  expect(screen.getByRole('navigation', { name: 'Checkpoint projects' })).toBe(navigation);
  expect(navigation.scrollTop).toBe(80);
  expect(target).toHaveFocus();
  expect(screen.queryByRole('heading', { name: 'Fix A' })).not.toBeInTheDocument();
  await act(async () => release({ tasks: [tasks[1]], recovery: [], storageBytes: 0, hooksInstalled: false }));
  expect(await screen.findByRole('heading', { name: 'Fix B' })).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Tasks and checkpoints' })).toBe(dialog);
  expect(target).toHaveFocus();
  expect(navigation.scrollTop).toBe(80);
});

it('switches tasks within a project without reloading the dialog and leaves creation or settings explicitly', async () => {
  const { request } = setup(true, [task('A2', 'A', 'completed')]);
  await screen.findByRole('heading', { name: 'Fix A' });
  const dialog = screen.getByRole('dialog', { name: 'Tasks and checkpoints' });
  const navigation = screen.getByRole('navigation', { name: 'Checkpoint projects' });
  const overviews = () => request.mock.calls.filter(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'overview').length;
  const count = overviews();
  fireEvent.click(within(navigation).getByRole('button', { name: /Fix A2/ }));
  expect(await screen.findByRole('heading', { name: 'Fix A2' })).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Tasks and checkpoints' })).toBe(dialog);
  expect(overviews()).toBe(count);
  fireEvent.click(screen.getByRole('button', { name: 'Task settings' }));
  expect(screen.getByRole('button', { name: 'Back to checkpoints' })).toBeInTheDocument();
  fireEvent.click(within(navigation).getByRole('button', { name: /Fix A2/ }));
  expect(screen.queryByRole('button', { name: 'Back to checkpoints' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'New checkpoint task' }));
  expect(screen.getByRole('heading', { name: 'New checkpoint task' })).toBeInTheDocument();
  fireEvent.click(within(navigation).getByRole('button', { name: /^Fix A\D/ }));
  expect(await screen.findByRole('heading', { name: 'Fix A' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'New checkpoint task' })).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Tasks and checkpoints' })).toBe(dialog);
});
