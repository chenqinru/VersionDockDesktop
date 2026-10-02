import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffLineHistoryTarget, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { DiffWorkspace } from './DiffWorkspace';
import { UnifiedDiffView } from './UnifiedDiffView';

const original = useAppStore.getState();
const snapshot: WorkspaceSnapshot = { workspace: { id: 'ws', name: 'Test', paths: ['/tmp/test'], lastOpenedAt: '', available: true }, repositories: [], tools: { git: true, svn: true, svnadmin: true }, generation: 1 };
afterEach(() => { cleanup(); useAppStore.setState(original, true); });
describe('mutable diff selection history', () => {
  it('maps index coordinates into the original committed path and lines', async () => {
    const history = vi.fn(); const requests: unknown[] = [];
    useAppStore.setState({ snapshot, openHistoryForLineRange: history, selectedFile: { repoId: 'repo', path: 'renamed.txt', staged: false }, diff: { path: 'renamed.txt', content: '--- a/renamed.txt\n+++ b/renamed.txt\n@@ -20 +20 @@\n-index text\n+working text', language: 'text', lineCount: 20, truncated: false, binary: false } });
    const bridge = new MockBridge((command) => { requests.push(command); return { path: 'original.txt', revision: 'commit-before-staging', lineRange: { start: 18, end: 18 } }; });
    const { container } = render(<BridgeContext.Provider value={bridge}><DiffWorkspace /></BridgeContext.Provider>);
    fireEvent.contextMenu(container.querySelector('.diff-code-cell.old code')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show Selection History' }));
    await waitFor(() => expect(history).toHaveBeenCalledWith('repo', 'original.txt', { start: 18, end: 18, side: 'old' }, 'commit-before-staging'));
    expect(requests).toContainEqual({ type: 'diffLineHistoryTarget', payload: { workspace_id: 'ws', repo_id: 'repo', relative_path: 'renamed.txt', source_revision: 'INDEX', line_range: { start: 20, end: 20 } } });
  });
  it('reports an uncommitted-only range without querying incorrect HEAD lines', async () => {
    const history = vi.fn(); useAppStore.setState({ snapshot, openHistoryForLineRange: history });
    const bridge = new MockBridge(() => null);
    const { container } = render(<BridgeContext.Provider value={bridge}><UnifiedDiffView path="file.txt" repoId="repo" oldRevision="INDEX" newRevision="WORKTREE" content={'@@ -1 +1 @@\n index-only line'} /></BridgeContext.Provider>);
    fireEvent.contextMenu(container.querySelector('.diff-code-cell.old code')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show Selection History' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Uncommitted additions have no history');
    expect(history).not.toHaveBeenCalled();
  });
  it('discards a history mapping result after the displayed file changes', async () => {
    let resolve: (value: DiffLineHistoryTarget) => void = () => undefined;
    const history = vi.fn(); useAppStore.setState({ snapshot, openHistoryForLineRange: history });
    const bridge = new MockBridge(() => new Promise((done) => { resolve = done; }));
    const props = { repoId: 'repo', oldRevision: 'INDEX', newRevision: 'WORKTREE' };
    const { container, rerender } = render(<BridgeContext.Provider value={bridge}><UnifiedDiffView {...props} path="one.txt" content={'@@ -1 +1 @@\n context'} /></BridgeContext.Provider>);
    fireEvent.contextMenu(container.querySelector('.diff-code-cell.old code')!); fireEvent.click(screen.getByRole('menuitem', { name: 'Show Selection History' }));
    rerender(<BridgeContext.Provider value={bridge}><UnifiedDiffView {...props} path="two.txt" content={'@@ -1 +1 @@\n other'} /></BridgeContext.Provider>);
    await act(async () => { resolve({ path: 'one.txt', revision: 'HEAD', lineRange: { start: 1, end: 1 } }); });
    expect(history).not.toHaveBeenCalled();
  });
});
