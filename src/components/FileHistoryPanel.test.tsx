import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileHistoryEntry, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { FileHistoryPanel } from './FileHistoryPanel';

const original = useAppStore.getState();
const entry: FileHistoryEntry = { revision: 'cccccccccc', previousRevision: 'bbbbbbbbbb', path: 'old-name.txt', previousPath: null, author: 'QA', date: '2026-10-02T12:00:00+08:00', message: 'edit old path', status: 'M' };
const snapshot: WorkspaceSnapshot = { workspace: { id: 'qa', name: 'QA', paths: ['/tmp/qa'], lastOpenedAt: '', available: true }, repositories: [], generation: 1, tools: { git: true, svn: true, svnadmin: true } };
function mount({ empty = false, failDiff = false, root = false } = {}) {
  const requests: string[] = []; let failing = failDiff;
  const history = vi.fn();
  const bridge = new MockBridge((command) => {
    requests.push(command.type);
    if (command.type === 'fileHistory') return { entries: empty ? [] : [root ? { ...entry, previousRevision: null } : entry, { ...entry, revision: 'dddddddddd', message: 'another revision' }], nextCursor: null };
    if (command.type === 'fileRevisionContent') return { revision: command.payload.revision, path: command.payload.relative_path, content: 'old content\nnew content\n', binary: false, truncated: false };
    if (command.type === 'fileDiff') { if (failing) throw new Error('QA comparison failed'); return { path: entry.path, content: '@@ -1,2 +1,2 @@\n old content\n-before\n+new content', language: 'text', binary: false, truncated: false, lineCount: 2 }; }
    return null;
  });
  useAppStore.setState({ snapshot, fileHistoryTarget: { repoId: 'qa-repo', path: 'new-name.txt' }, openHistoryForLineRange: history });
  return { ...render(<BridgeContext.Provider value={bridge}><FileHistoryPanel /></BridgeContext.Provider>), requests, history, recover: () => { failing = false; } };
}
afterEach(() => { cleanup(); useAppStore.setState(original, true); });
describe('file history dialog', () => {
  it('keeps the current preview when the selected revision is clicked again', async () => {
    const { container, requests } = mount(); await waitFor(() => expect(container.querySelector('.unified-diff')).not.toBeNull());
    const count = requests.length; fireEvent.click(screen.getByText('edit old path'));
    expect(requests).toHaveLength(count); expect(container.querySelector('.unified-diff')).not.toBeNull(); expect(screen.queryByText('Loading files...')).toBeNull();
  });
  it('opens full source from the menu and switches back to differences', async () => {
    const { container } = mount(); await waitFor(() => expect(container.querySelector('.unified-diff')).not.toBeNull());
    fireEvent.contextMenu(screen.getByText('another revision')); fireEvent.click(screen.getByRole('menuitem', { name: 'Open Revision' }));
    await waitFor(() => expect(container.querySelector('.source-code-view')).not.toBeNull()); expect(container.querySelector('.unified-diff')).toBeNull();
    fireEvent.click(screen.getByText('another revision')); expect(container.querySelector('.source-code-view')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show Diff' })); await waitFor(() => expect(container.querySelector('.unified-diff')).not.toBeNull());
  });
  it('uses the historical filename for selection history', async () => {
    const { container, history } = mount(); await waitFor(() => expect(container.querySelector('.diff-code-cell.new.context code')).not.toBeNull());
    fireEvent.contextMenu(container.querySelector('.diff-code-cell.new.context code')!); fireEvent.click(screen.getByRole('menuitem', { name: 'Show Selection History' }));
    expect(history).toHaveBeenCalledWith('qa-repo', 'old-name.txt', expect.objectContaining({ side: 'new' }), entry.revision);
  });
  it('shows an empty state when a file has no committed history', async () => {
    mount({ empty: true }); expect(await screen.findByText('No history')).toBeInTheDocument(); expect(screen.queryByText('Loading files...')).toBeNull();
  });
  it('reports a comparison failure and retries instead of silently switching to source', async () => {
    const { container, recover } = mount({ failDiff: true }); expect(await screen.findByRole('alert')).toHaveTextContent('QA comparison failed');
    expect(container.querySelector('.source-code-view')).toBeNull(); recover(); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(container.querySelector('.unified-diff')).not.toBeNull()); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('searches the first revision and closes search before closing the dialog', async () => {
    const { container } = mount({ root: true }); await waitFor(() => expect(container.querySelector('.source-code-view')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Find in file' })); fireEvent.change(screen.getByRole('textbox', { name: 'Find in file' }), { target: { value: 'content' } });
    expect(screen.getByText('1/2')).toBeInTheDocument(); fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull(); expect(screen.getByRole('dialog')).toBeInTheDocument(); fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('traps Tab and closes a context menu before the dialog', async () => {
    mount(); await screen.findByText('edit old path');
    const buttons = screen.getByRole('dialog').querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    const first = buttons[0], last = buttons[buttons.length - 1];
    last.focus(); fireEvent.keyDown(window, { key: 'Tab' }); expect(first).toHaveFocus();
    first.focus(); fireEvent.keyDown(window, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
    fireEvent.contextMenu(screen.getByText('edit old path')); fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('menu')).toBeNull(); expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('formats timestamps while retaining the original date in a tooltip', async () => {
    mount(); await screen.findByText('edit old path'); screen.getAllByTitle(`QA · ${entry.date}`).forEach((element) => expect(element).not.toHaveTextContent('T12:00:00'));
  });
  it('discards a pending preview after the file context changes', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const bridge = new MockBridge((command) => {
      if (command.type === 'fileHistory') return { entries: [{ ...entry, path: command.payload.relative_path, previousRevision: null }], nextCursor: null };
      if (command.type === 'fileRevisionContent' && command.payload.relative_path === 'first.txt') return new Promise((done) => { resolve = done; });
      return { revision: entry.revision, path: 'second.txt', content: 'second source', binary: false, truncated: false };
    });
    useAppStore.setState({ snapshot, fileHistoryTarget: { repoId: 'qa-repo', path: 'first.txt' } }); const { container } = render(<BridgeContext.Provider value={bridge}><FileHistoryPanel /></BridgeContext.Provider>);
    await screen.findByText('edit old path'); act(() => useAppStore.setState({ fileHistoryTarget: { repoId: 'qa-repo', path: 'second.txt' } }));
    await waitFor(() => expect(container.querySelector('.source-code-view')).toHaveTextContent('second source'));
    await act(async () => resolve({ revision: entry.revision, path: 'first.txt', content: 'stale source', binary: false, truncated: false })); expect(container).not.toHaveTextContent('stale source');
  });
});
