import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommitPanel } from './CommitPanel';
import { buildFileTree } from './fileTree';
import { useAppStore } from '../store/appStore';
import type { BootstrapData } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';

const bootstrap = (stash: boolean, shelf = false): BootstrapData => ({
  state: { theme: 'system', language: 'system', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null },
  tools: { git: true, svn: true, svnadmin: true },
  capabilities: { ai: false, stash, shelf, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false },
});
const bridge = new MockBridge(() => []);
const renderPanel = () => render(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);

afterEach(() => { cleanup(); useAppStore.setState({ bootstrap: undefined, snapshot: undefined, stashes: {}, shelves: {} }); });

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
});
