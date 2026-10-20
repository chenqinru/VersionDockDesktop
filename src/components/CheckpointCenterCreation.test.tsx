import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CheckpointProject, RepositoryMeta, TaskWorkspace, WorkspaceDescriptor, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { checkpointWorkspaceChanged } from '../checkpoints/store';
import { closeCheckpointCenter, openCheckpointCenter } from '../checkpoints/center';
import { I18nContext, createTranslator } from '../i18n';
import { CheckpointCenterHost } from './CheckpointCenter';

const original = useAppStore.getState();
const project = (id: string): WorkspaceDescriptor => ({ id, name: `Project ${id}`, paths: [`/${id}`], available: true, lastOpenedAt: '' });
const repository = (id: string): RepositoryMeta => ({ id: `repo-${id}`, name: `Repository ${id}`, rootPath: `/${id}/repo`, kind: 'git', color: '#888', depth: 0, parentRepoId: null, isSubmodule: false, isWorktree: false });
const prepared = (id: string): CheckpointProject => ({ workspace: project(id), repositories: [repository(id)], tasks: [] });
afterEach(() => { cleanup(); closeCheckpointCenter(); checkpointWorkspaceChanged(null); useAppStore.setState(original, true); vi.restoreAllMocks(); });

function setup(withProject = true) {
  const tasks: TaskWorkspace[] = [];
  const projects = [project('A'), project('B')];
  const bridge = new MockBridge(command => {
    if (command.type === 'checkpointCatalog') return { projects: projects.filter(p => tasks.some(task => task.workspaceId === p.id)), tasks };
    if (command.type === 'checkpointProject') return prepared(command.payload.workspace_id ?? 'C');
    if (command.type !== 'checkpoint') return [];
    const action = command.payload.action;
    if (action.type === 'create') {
      const task: TaskWorkspace = { id: 'created', workspaceId: command.payload.workspace_id, name: action.name, path: `/${command.payload.workspace_id}`, roots: [`/${command.payload.workspace_id}`], repositories: [], mode: action.mode, isolation: action.isolation, createdAt: '', seed: '', sourceSeed: '', lastApplied: null, hookEvents: [], lastHookAt: null, hookError: null, error: null, checkpoints: [] };
      tasks.push(task);
      if (!projects.some(project => project.id === task.workspaceId)) projects.push(project(task.workspaceId));
      return task;
    }
    if (action.type === 'repositories') return [];
    return { tasks: tasks.filter(task => task.workspaceId === command.payload.workspace_id), recovery: [], storageBytes: 0, hooksInstalled: false };
  });
  const originalRequest = bridge.request.bind(bridge);
  const request = vi.spyOn(bridge, 'request');
  useAppStore.setState({ bridge, bootstrap: { ...original.bootstrap, state: { ...original.bootstrap?.state, recentWorkspaces: withProject ? projects : [] } } as typeof original.bootstrap, snapshot: withProject ? { workspace: projects[0], repositories: [], generation: 1 } as unknown as WorkspaceSnapshot : undefined, operations: {} });
  openCheckpointCenter();
  render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><CheckpointCenterHost /></I18nContext.Provider>);
  fireEvent.click(screen.getAllByRole('button', { name: 'New checkpoint task' })[0]);
  return { bridge, request, originalRequest };
}

async function choose(id: string) {
  fireEvent.click(screen.getByRole('combobox', { name: 'Task project' }));
  fireEvent.click(screen.getByRole('option', { name: `Project ${id}` }));
  await screen.findByText(`Repository ${id}`);
}

it('preserves task inputs across projects and creates under the chosen project without opening it', async () => {
  const { request } = setup();
  await screen.findByText('Repository A');
  expect(screen.getByRole('combobox', { name: 'Task project' })).toHaveTextContent('Project A');
  fireEvent.change(screen.getByRole('textbox', { name: 'Task name' }), { target: { value: 'Keep my draft' } });
  fireEvent.click(screen.getByRole('combobox', { name: 'Recording mode' }));
  fireEvent.click(screen.getByRole('option', { name: 'Automatic recording' }));
  await choose('B');
  expect(screen.getByRole('textbox', { name: 'Task name' })).toHaveValue('Keep my draft');
  expect(screen.getByRole('combobox', { name: 'Recording mode' })).toHaveTextContent('Automatic recording');
  expect(screen.queryByText('Repository A')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  expect(await screen.findByRole('heading', { name: 'Keep my draft' })).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'checkpoint', payload: { workspace_id: 'B', action: { type: 'create', name: 'Keep my draft', repo_ids: ['repo-B'], mode: 'automatic', isolation: 'original', include_ignored: [] } } }), expect.anything());
  expect(await within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).findByRole('button', { name: /^Project B/ })).toBeInTheDocument();
  expect(useAppStore.getState().snapshot?.workspace.id).toBe('A');
  expect(request.mock.calls.filter(([command]) => command.type === 'checkpointProject').every(([, options]) => options?.showProgress === false)).toBe(true);
});

it('ignores a late repository scan after choosing another project', async () => {
  const { request, originalRequest } = setup();
  await screen.findByText('Repository A');
  let release!: (value: CheckpointProject) => void;
  request.mockImplementation((command, options) => command.type === 'checkpointProject' && command.payload.workspace_id === 'B' ? new Promise(resolve => { release = resolve; }) : originalRequest(command, options));
  fireEvent.click(screen.getByRole('combobox', { name: 'Task project' }));
  fireEvent.click(screen.getByRole('option', { name: 'Project B' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  await choose('A');
  await act(async () => release(prepared('B')));
  expect(screen.getByText('Repository A')).toBeInTheDocument();
  expect(screen.queryByText('Repository B')).not.toBeInTheDocument();
});

it('allows a local folder from the welcome screen without opening the main workspace', async () => {
  const { bridge, request } = setup(false);
  vi.spyOn(bridge, 'selectDirectory').mockResolvedValue('/C');
  expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  await screen.findByText('Repository C');
  expect(screen.getByRole('combobox', { name: 'Task project' })).toHaveTextContent('Project C');
  expect(request).toHaveBeenCalledWith({ type: 'checkpointProject', payload: { workspace_id: null, paths: ['/C'] } }, expect.objectContaining({ showProgress: false }));
  expect(useAppStore.getState().snapshot).toBeUndefined();
});

it('keeps the current selection on folder cancel or failure and ignores selection after cancelling creation', async () => {
  const { bridge } = setup();
  await screen.findByText('Repository A');
  const pick = vi.spyOn(bridge, 'selectDirectory').mockResolvedValue(null);
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Choose folder' })).toBeEnabled());
  expect(screen.getByRole('combobox', { name: 'Task project' })).toHaveTextContent('Project A');
  pick.mockRejectedValueOnce(new Error('Directory unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  expect(await screen.findByText('Directory unavailable')).toBeInTheDocument();
  let release!: (value: string | null) => void;
  pick.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => release('/C'));
  expect(screen.queryByRole('combobox', { name: 'Task project' })).not.toBeInTheDocument();
  expect(useAppStore.getState().snapshot?.workspace.id).toBe('A');
});
