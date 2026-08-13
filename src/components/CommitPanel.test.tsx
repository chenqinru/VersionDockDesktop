import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommitPanel } from './CommitPanel';
import { SubtreePanel } from './SubtreePanel';
import { buildFileTree } from './fileTree';
import { useAppStore } from '../store/appStore';
import type { BootstrapData, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';

const bootstrap = (stash: boolean, shelf = false, subtree = false, worktree = false): BootstrapData => ({
  state: { theme: 'system', language: 'system', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null },
  tools: { git: true, svn: true, svnadmin: true },
  capabilities: { ai: false, stash, shelf, changelist: false, worktree, subtree, compare: false, remoteManagement: false },
});
const bridge = new MockBridge(() => []);
const renderPanel = () => render(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
const gitRepo: RepositoryStatus = { meta: { id: 'repo', name: 'Repository', rootPath: '/tmp/repo', color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null };
const gitSnapshot: WorkspaceSnapshot = { workspace: { id: 'workspace', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true }, generation: 1, tools: { git: true, svn: true, svnadmin: true }, repositories: [gitRepo] };

afterEach(() => { cleanup(); useAppStore.setState({ bootstrap: undefined, snapshot: undefined, stashes: {}, shelves: {}, subtrees: {} }); });

describe('CommitPanel capabilities and file view', () => {
  it('builds nested directories without flattening file paths', () => {
    const tree = buildFileTree([
      { path: 'src/components/App.tsx', status: 'modified', staged: false, unstaged: true, conflicted: false },
      { path: 'README.md', status: 'untracked', staged: false, unstaged: true, conflicted: false },
    ]);
    expect(tree.map((node) => node.name)).toEqual(['src', 'README.md']);
    expect(tree[0].children[0].children[0].path).toBe('src/components/App.tsx');
  });

  it('hides the stash surface until its real capability is enabled', () => {
    useAppStore.setState({ bootstrap: bootstrap(false) });
    const { rerender } = renderPanel();
    expect(screen.queryByText('Stash')).not.toBeInTheDocument();
    useAppStore.setState({ bootstrap: bootstrap(true) });
    rerender(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    expect(screen.getByText('Stash')).toBeInTheDocument();
    expect(screen.queryByText('AI Commit Message')).not.toBeInTheDocument();
  });

  it('shows shelf only after its storage and backend capability is enabled', () => {
    useAppStore.setState({ bootstrap: bootstrap(false, true) });
    renderPanel();
    expect(screen.getByText('Shelf')).toBeInTheDocument();
    expect(screen.queryByText('Stash')).not.toBeInTheDocument();
  });

  it('hides Subtree until enabled, then opens its real panel', () => {
    useAppStore.setState({ bridge, bootstrap: bootstrap(false, false), snapshot: gitSnapshot, selectedRepoId: 'repo', subtrees: {} });
    const { rerender } = renderPanel();
    expect(screen.queryByText('Subtree')).not.toBeInTheDocument();
    useAppStore.setState({ bootstrap: bootstrap(false, false, true), subtrees: {} });
    rerender(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    fireEvent.click(screen.getByText('Subtree'));
    expect(screen.getByText('No registered subtrees')).toBeInTheDocument();
  });

  it('renders registered Subtree details and gates pending entries to unregister only', () => {
    const pending = [{ id: 'pending', prefix: 'vendor/api', remote: 'origin', branch: 'main', squash: true, state: 'pending' as const }];
    const entryBridge = new MockBridge((command) => command.type === 'subtrees' ? pending : []);
    useAppStore.setState({ bridge: entryBridge, bootstrap: bootstrap(false, false, true), snapshot: gitSnapshot, subtrees: { repo: pending } });
    render(<BridgeContext.Provider value={entryBridge}><SubtreePanel repos={[gitRepo]} /></BridgeContext.Provider>);
    expect(screen.getByText('vendor/api')).toBeInTheDocument();
    expect(screen.getByText('origin · main · Squash')).toBeInTheDocument();
    expect(screen.getByText('Unregister')).toBeInTheDocument();
    expect(screen.queryByText('Pull')).not.toBeInTheDocument();
    expect(screen.queryByText('Push')).not.toBeInTheDocument();
  });

  it('loads Subtree entries once when their store update rerenders the panel', async () => {
    let subtreeRequests = 0;
    const subtreeBridge = new MockBridge((command) => {
      if (command.type === 'subtrees') subtreeRequests += 1;
      return [];
    });
    useAppStore.setState({ bridge: subtreeBridge, bootstrap: { ...bootstrap(false, false, true), state: { ...bootstrap(false, false, true).state, activeTab: 'subtree' } }, snapshot: gitSnapshot, selectedRepoId: 'repo', subtrees: {} });
    const { rerender } = render(<BridgeContext.Provider value={subtreeBridge}><CommitPanel /></BridgeContext.Provider>);
    await waitFor(() => expect(subtreeRequests).toBe(1));
    rerender(<BridgeContext.Provider value={subtreeBridge}><CommitPanel /></BridgeContext.Provider>);
    await waitFor(() => expect(subtreeRequests).toBe(1));
  });

  it('keeps all enabled capability tabs in the settled order', () => {
    useAppStore.setState({ bootstrap: bootstrap(true, true, true, true) });
    const { container } = renderPanel();
    const tabs = Array.from(container.querySelectorAll('.commit-tabs button')).map((button) => button.textContent?.replace(/\d+/g, '').trim());
    expect(tabs).toEqual(['Changes', 'Stash', 'Shelf', 'Worktrees', 'Subtree']);
  });
});
