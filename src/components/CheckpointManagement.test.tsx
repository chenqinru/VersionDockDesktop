import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CheckpointSettings, ProjectStorageUsage, TaskWorkspace, WorkspaceDescriptor, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { checkpointWorkspaceChanged } from '../checkpoints/store';
import { closeCheckpointCenter, openCheckpointCenter } from '../checkpoints/center';
import { I18nContext, createTranslator } from '../i18n';
import { CheckpointCenterHost } from './CheckpointCenter';
import * as dialogs from './dialogService';

const original = useAppStore.getState();
const project = (id: string): WorkspaceDescriptor => ({ id, name: `Project ${id}`, paths: [`/${id}`], available: true, lastOpenedAt: '' });
const task = (id: string): TaskWorkspace => ({ id, workspaceId: id, name: `Task ${id}`, path: `/${id}`, roots: [`/${id}`], mode: 'automatic', isolation: 'original', repositories: [], createdAt: '', seed: '', sourceSeed: '', lastApplied: null, checkpoints: [], hookEvents: ['UserPromptSubmit', 'Stop'], lastHookAt: null, hookError: null, error: null });
const settings: CheckpointSettings = { hooksInstalled: true, storage: { path: '/config/checkpoints', totalBytes: 2 * 1048576, taskBytes: 0, reclaimableBytes: null, warning: false } };
const usage = (id: string): ProjectStorageUsage => ({ projectId: id, totalBytes: 2 * 1048576, referencedBytes: 1048576, reclaimableBytes: 524288, tasks: [{ taskId: id, name: `Task ${id}`, checkpoints: 12, referencedBytes: 1048576, blockedReason: null }] });
afterEach(() => { cleanup(); closeCheckpointCenter(); checkpointWorkspaceChanged(null); useAppStore.setState(original, true); vi.restoreAllMocks(); });

function setup(empty = false) {
  const projects = empty ? [] : [project('A'), project('B')];
  const tasks = empty ? [] : [task('A'), task('B')];
  const bridge = new MockBridge(command => {
    if (command.type === 'checkpointCatalog') return { projects, tasks };
    if (command.type === 'checkpointSettings') return settings;
    if (command.type !== 'checkpoint') return [];
    const action = command.payload.action;
    const id = command.payload.workspace_id;
    if (action.type === 'projectStorageUsage') return usage(id);
    if (action.type === 'previewProjectCleanup') return { projectId: id, keepRecent: action.keep_recent, removeCount: 2, protectedCount: 1, reclaimableBytes: 262144, fingerprint: `fp-${id}` };
    if (action.type === 'projectCleanup') return { status: 'succeeded', removedCount: 2, freedBytes: 262144, error: null };
    return { tasks: tasks.filter(task => task.workspaceId === id), recovery: [], connections: { A: { status: 'verified', verifiedAt: '', error: null } } };
  });
  const originalRequest = bridge.request.bind(bridge);
  const request = vi.spyOn(bridge, 'request');
  useAppStore.setState({ bridge, snapshot: empty ? undefined : { workspace: projects[0], repositories: [], generation: 1 } as unknown as WorkspaceSnapshot, operations: {} });
  openCheckpointCenter();
  render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><CheckpointCenterHost /></I18nContext.Provider>);
  return { request, originalRequest };
}

async function openStorage(id: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Project actions: Project ${id}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Project storage' }));
}

it('opens global settings without any project and installs Hooks globally after confirmation', async () => {
  const { request } = setup(true);
  const confirmation = vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(false);
  const settingsEntry = screen.getByRole('button', { name: 'Checkpoint settings' });
  expect(settingsEntry.closest('.checkpoint-center-sidebar-footer')).toBeInTheDocument();
  expect(settingsEntry.closest('.checkpoint-header')).toBeNull();
  expect(settingsEntry).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(settingsEntry);
  expect(settingsEntry).toHaveAttribute('aria-pressed', 'true');
  expect(await screen.findByText('Hooks installed')).toBeInTheDocument();
  expect(screen.getByText('Hooks are installed globally. Connection verification is shown separately for each task.')).toBeInTheDocument();
  expect(screen.getByText('All projects: 2.0 MiB')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Update Codex hooks' }));
  await waitFor(() => expect(confirmation).toHaveBeenCalledOnce());
  expect(request.mock.calls.some(([command]) => command.type === 'checkpointSettings' && command.payload.action.type === 'installHooks')).toBe(false);
  confirmation.mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Update Codex hooks' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ type: 'checkpointSettings', payload: { action: { type: 'installHooks' } } }, expect.objectContaining({ showProgress: false })));
  expect(useAppStore.getState().snapshot).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Open snapshot folder' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ type: 'checkpointSettings', payload: { action: { type: 'openStorage' } } }, expect.objectContaining({ showProgress: false })));
});

it('shows task-specific verification in connection details and keeps global setup out of task settings', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Hooks verified' }));
  expect(screen.getByRole('heading', { name: 'Connection details' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Update Codex hooks' })).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).getByRole('button', { name: /^Project B/ }));
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).getByRole('button', { name: /Task B/ }));
  expect(await screen.findByRole('button', { name: 'Unverified' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Task settings' }));
  expect(screen.queryByRole('heading', { name: 'Codex connection' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Update Codex hooks' })).not.toBeInTheDocument();
});

it('previews and confirms cleanup under the selected project without opening the main workspace', async () => {
  const { request } = setup();
  vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(true);
  const dialog = screen.getByRole('dialog');
  await openStorage('B');
  expect(await screen.findByText('Project referenced space')).toBeInTheDocument();
  expect(screen.getByText('Reclaimable space')).toBeInTheDocument();
  expect(screen.getByText('12 checkpoint records')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  expect(await screen.findByText('2 records to remove · 1 protected · Estimated space to free: 0.25 MiB')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clean history' }));
  expect(await screen.findByText('Removed 2 records · Freed 0.25 MiB')).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith({ type: 'checkpoint', payload: { workspace_id: 'B', action: { type: 'projectCleanup', keep_recent: 10, fingerprint: 'fp-B' } } }, expect.objectContaining({ showProgress: false }));
  expect(useAppStore.getState().snapshot?.workspace.id).toBe('A');
  expect(screen.getByRole('dialog')).toBe(dialog);
});

it('ignores delayed storage results and confirmations after moving to another project', async () => {
  const { request, originalRequest } = setup();
  let release!: (value: ProjectStorageUsage) => void;
  request.mockImplementation((command, options) => command.type === 'checkpoint' && command.payload.workspace_id === 'A' && command.payload.action.type === 'projectStorageUsage' ? new Promise(resolve => { release = resolve; }) : originalRequest(command, options));
  await openStorage('A');
  await waitFor(() => expect(release).toBeTypeOf('function'));
  await openStorage('B');
  expect(await screen.findByText('12 checkpoint records')).toBeInTheDocument();
  await act(async () => release({ ...usage('A'), tasks: [{ ...usage('A').tasks[0], name: 'Stale task' }] }));
  expect(screen.queryByText('Stale task')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await screen.findByRole('button', { name: 'Clean history' });
  let confirm!: (value: boolean) => void;
  vi.spyOn(dialogs, 'confirmDialog').mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Clean history' }));
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Checkpoint projects' })).getByRole('button', { name: /Task A/ }));
  await act(async () => confirm(true));
  expect(request.mock.calls.some(([command]) => command.type === 'checkpoint' && command.payload.action.type === 'projectCleanup')).toBe(false);
});

it('blocks navigation during a cleanup write and reports failures inside the project page', async () => {
  const { request, originalRequest } = setup();
  vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(true);
  let reject!: (error: Error) => void;
  request.mockImplementation((command, options) => command.type === 'checkpoint' && command.payload.action.type === 'projectCleanup' ? new Promise((_, fail) => { reject = fail; }) : originalRequest(command, options));
  await openStorage('A');
  await screen.findByText('12 checkpoint records');
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Clean history' }));
  await waitFor(() => expect(reject).toBeTypeOf('function'));
  expect(screen.getByRole('button', { name: 'Project actions: Project B' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Checkpoint settings' })).toBeDisabled();
  expect(screen.getAllByRole('button', { name: 'Close' }).every(button => button.hasAttribute('disabled'))).toBe(true);
  await act(async () => reject(new Error('Disk is full')));
  expect(await screen.findByText('Disk is full')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Clean history' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Project actions: Project B' })).toBeEnabled();
});
