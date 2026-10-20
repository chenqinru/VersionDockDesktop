import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CheckpointDiffSource, DiffDocument, RestoreFile, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { CheckpointChangesView } from './CheckpointChangesView';

const original = useAppStore.getState();
const source: CheckpointDiffSource = { type: 'checkpoint', task_id: 'task', checkpoint_id: 'point' };
const file = (repository: string, layer = 'working'): RestoreFile => ({ repository, layer, path: 'same.ts', status: 'modified', before: 'old', after: 'new' });
const document: DiffDocument = { path: 'same.ts', content: '--- a/same.ts\n+++ b/same.ts\n@@ -1 +1 @@\n-old\n+new\n', language: 'typescript', binary: false, truncated: false, lineCount: 1 };
function setup() {
  const bridge = new MockBridge(() => []);
  useAppStore.setState({ bridge, snapshot: { workspace: { id: 'ws' } } as WorkspaceSnapshot });
  return bridge;
}
afterEach(() => { cleanup(); useAppStore.setState(original, true); vi.restoreAllMocks(); });

it('opens the first file automatically, groups duplicate paths and loads other layers only on selection', async () => {
  const bridge = setup();
  const request = vi.spyOn(bridge, 'request').mockResolvedValue(document);
  const { container } = render(<CheckpointChangesView files={[file('/project/api'), file('/project/web'), file('/project/web', 'index')]} source={source} />);
  expect(screen.getByText('api')).toBeInTheDocument();
  expect(screen.getByText('web')).toBeInTheDocument();
  await waitFor(() => expect(request).toHaveBeenCalledWith({ type: 'checkpoint', payload: { workspace_id: 'ws', action: { type: 'diff', source, repository: '/project/api', path: 'same.ts', layer: 'working' } } }, expect.anything()));
  expect(request).toHaveBeenCalledTimes(1);
  const rows = screen.getAllByRole('button', { name: /same.ts/ });
  expect(rows[0]).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(rows[2]);
  await waitFor(() => expect(request).toHaveBeenCalledWith({ type: 'checkpoint', payload: { workspace_id: 'ws', action: { type: 'diff', source, repository: '/project/web', path: 'same.ts', layer: 'index' } } }, expect.anything()));
  await waitFor(() => expect(container.querySelector('.unified-diff')).toBeInTheDocument());
  expect(rows[2]).toHaveAttribute('aria-pressed', 'true');
  expect(rows[1]).toHaveAttribute('aria-pressed', 'false');
});

it('cancels stale requests and keeps a later file selected when the old response arrives', async () => {
  const bridge = setup();
  let resolve!: (document: DiffDocument) => void;
  let firstSignal: AbortSignal | undefined;
  vi.spyOn(bridge, 'request').mockImplementation((_cmd, options) => {
    if (!firstSignal) { firstSignal = options?.signal; return new Promise(r => { resolve = r; }); }
    return Promise.resolve({ ...document, binary: true });
  });
  const view = render(<CheckpointChangesView files={[file('/project/api'), file('/project/web')]} source={source} />);
  const rows = screen.getAllByRole('button', { name: /same.ts/ });
  fireEvent.click(rows[0]);
  fireEvent.click(rows[1]);
  expect(firstSignal?.aborted).toBe(true);
  expect(await screen.findByText('Binary diff cannot be displayed')).toBeInTheDocument();
  await act(async () => resolve(document));
  expect(screen.getByText('Binary diff cannot be displayed')).toBeInTheDocument();
  view.unmount();
});

it('uses the preview source, retries failures and shows large-file placeholders', async () => {
  const bridge = setup();
  const request = vi.spyOn(bridge, 'request').mockRejectedValueOnce(new Error('Diff failed')).mockResolvedValue({ ...document, truncated: true });
  render(<CheckpointChangesView files={[file('/project/api')]} source={{ type: 'preview', preview_id: 'preview' }} />);
  fireEvent.click(screen.getByRole('button', { name: /same.ts/ }));
  expect(await screen.findByText('Diff failed')).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Diff is too large to display')).toBeInTheDocument();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ action: expect.objectContaining({ source: { type: 'preview', preview_id: 'preview' } }) }) }), expect.anything());
});

it('prioritizes file names, retains directory and layer details and supports keyboard resizing', () => {
  setup();
  const path = 'src/components/地图 配置/MapValidation.ts';
  render(<CheckpointChangesView files={[{ ...file('/project/api'), path }, { ...file('/project/web', 'index'), path: 'src\\map\\MapValidation.ts' }]} source={source} />);
  const rows = screen.getAllByRole('button', { name: /MapValidation.ts/ });
  expect(within(rows[0]).getByText('MapValidation.ts')).toBeInTheDocument();
  expect(within(rows[0]).getByText('src/components/地图 配置 · Working tree')).toHaveAttribute('title', path);
  expect(within(rows[1]).getByText('src/map · Staged changes')).toBeInTheDocument();
  const splitter = screen.getByRole('separator', { name: 'Resize changed files' });
  expect(splitter).toHaveAttribute('aria-valuenow', '250');
  fireEvent.keyDown(splitter, { key: 'ArrowRight' });
  expect(splitter).toHaveAttribute('aria-valuenow', '260');
  fireEvent.keyDown(splitter, { key: 'Home' });
  expect(splitter).toHaveAttribute('aria-valuenow', '150');
  fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
  expect(splitter).toHaveAttribute('aria-valuenow', '150');
  fireEvent.keyDown(splitter, { key: 'End' });
  expect(splitter).toHaveAttribute('aria-valuenow', '480');
});

it('selects the first file when an initially empty list loads and falls back when the selected file disappears', async () => {
  const bridge = setup();
  const request = vi.spyOn(bridge, 'request').mockResolvedValue(document);
  const view = render(<CheckpointChangesView files={[]} source={source} />);
  expect(request).not.toHaveBeenCalled();
  const files = [file('/project/api'), file('/project/web')];
  view.rerender(<CheckpointChangesView files={files} source={source} />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  let rows = screen.getAllByRole('button', { name: /same.ts/ });
  expect(rows[0]).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(rows[1]);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  view.rerender(<CheckpointChangesView files={[...files]} source={source} />);
  expect(screen.getAllByRole('button', { name: /same.ts/ })[1]).toHaveAttribute('aria-pressed', 'true');
  expect(request).toHaveBeenCalledTimes(2);
  view.rerender(<CheckpointChangesView files={[files[0]]} source={source} />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  rows = screen.getAllByRole('button', { name: /same.ts/ });
  expect(rows[0]).toHaveAttribute('aria-pressed', 'true');
});
it('resets to the first file on a different checkpoint and ignores its predecessor response', async () => {
  const bridge = setup();
  let resolve!: (value: DiffDocument) => void;
  let signal: AbortSignal | undefined;
  const request = vi.spyOn(bridge, 'request').mockResolvedValue(document);
  const files = [file('/project/api'), file('/project/web')];
  const view = render(<CheckpointChangesView files={files} source={source} />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  request.mockImplementationOnce((_command, options) => { signal = options?.signal; return new Promise(done => { resolve = done; }); });
  fireEvent.click(screen.getAllByRole('button', { name: /same.ts/ })[1]);
  view.rerender(<CheckpointChangesView files={files} source={{ type: 'checkpoint', task_id: 'task', checkpoint_id: 'new-point' }} />);
  expect(signal?.aborted).toBe(true);
  expect(screen.getAllByRole('button', { name: /same.ts/ })[0]).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  await act(async () => resolve({ ...document, binary: true }));
  expect(screen.queryByText('Binary diff cannot be displayed')).not.toBeInTheDocument();
});
