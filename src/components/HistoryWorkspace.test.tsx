import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryWorkspace } from './HistoryWorkspace';
import { buildDetailTree, collapseDetailTree, mergeBranches, splitVisibleBranches } from './HistoryWorkspace.helpers';
import { useAppStore } from '../store/appStore';
import type { BootstrapData, BridgeCommand, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';

const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'workspace', name: 'Test', paths: ['/tmp/test'], lastOpenedAt: '', available: true },
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
  repositories: [{ meta: { id: 'repo', name: 'Repo', rootPath: '/tmp/test', color: '#4EC9B0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc1234', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null }],
};

const bootstrap = (compare: boolean, remoteManagement: boolean): BootstrapData => ({
  state: { theme: 'system', language: 'system', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null },
  tools: snapshot.tools,
  capabilities: { ai: false, stash: true, shelf: true, changelist: true, worktree: true, subtree: false, compare, remoteManagement },
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ bridge: undefined, bootstrap: undefined, snapshot: undefined, selectedRepoId: undefined, history: [], historyByRepo: {}, historyHasMoreByRepo: {}, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, remotes: {}, comparison: undefined });
});

describe('HistoryWorkspace capabilities', () => {
  it('hides compare and remotes until both real capabilities are enabled', () => {
    useAppStore.setState({ bootstrap: bootstrap(false, false), snapshot, selectedRepoId: 'repo' });
    const { rerender } = render(<HistoryWorkspace />);
    expect(screen.queryByText('Compare')).not.toBeInTheDocument();
    expect(screen.queryByText('Remotes')).not.toBeInTheDocument();
    useAppStore.setState({ bootstrap: bootstrap(true, true) });
    rerender(<HistoryWorkspace />);
    expect(screen.getByText('Compare')).toBeInTheDocument();
    expect(screen.getByText('Remotes')).toBeInTheDocument();
  });

  it('loads remote metadata through the bridge without exposing a cwd', async () => {
    const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'remotes') return [{ name: 'origin', fetchUrl: 'https://example.test/repo.git', pushUrl: 'https://example.test/repo.git' }];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo' });
    render(<HistoryWorkspace />);
    fireEvent.click(screen.getByText('Remotes'));
    await waitFor(() => expect(screen.getByText('origin')).toBeInTheDocument());
    expect(commands).toContainEqual({ type: 'remotes', payload: { workspace_id: 'workspace', repo_id: 'repo' } });
    expect(JSON.stringify(commands)).not.toContain('cwd');
  });

  it('requests branch comparison with repository-scoped identifiers', async () => {
    const responder = vi.fn((command: BridgeCommand) => command.type === 'branchCompare' ? { base: 'main', target: 'feature', baseCommits: [], targetCommits: [], files: [] } : []);
    useAppStore.setState({ bridge: new MockBridge(responder), bootstrap: bootstrap(true, false), snapshot, selectedRepoId: 'repo', branches: [
      { name: 'main', current: true, remote: false, upstream: null, ahead: 0, behind: 0 },
      { name: 'feature', current: false, remote: false, upstream: null, ahead: 0, behind: 0 },
    ] });
    render(<HistoryWorkspace />);
    fireEvent.click(screen.getByText('Compare'));
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(responder).toHaveBeenCalledWith({ type: 'branchCompare', payload: { workspace_id: 'workspace', repo_id: 'repo', base: 'main', target: 'feature' } }));
  });

  it('opens functional author and repository filter menus', () => {
    useAppStore.setState({
      bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo',
      history: [{ repoId: 'repo', hash: 'abc', shortHash: 'abc', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'feat: filter', refs: ['HEAD -> main'] }],
    });
    render(<HistoryWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: /Author/ }));
    expect(screen.getByText('Ada')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Repository/ }));
    expect(screen.getAllByText('Repo').length).toBeGreaterThan(0);
  });
});

describe('HistoryWorkspace data helpers', () => {
  it('merges branch instances and only exposes shared, current, or mainline branches by default', () => {
    const secondRepo = { ...snapshot.repositories[0], meta: { ...snapshot.repositories[0].meta, id: 'repo-2', name: 'Repo 2', color: '#569CD6' } };
    const branches = {
      repo: [
        { name: 'main', current: true, remote: false, upstream: null, ahead: 1, behind: 0 },
        { name: 'feature/local', current: false, remote: false, upstream: null, ahead: 0, behind: 0 },
        { name: 'feature/shared', current: false, remote: false, upstream: null, ahead: 0, behind: 0 },
      ],
      'repo-2': [
        { name: 'develop', current: false, remote: false, upstream: null, ahead: 0, behind: 2 },
        { name: 'feature/shared', current: false, remote: false, upstream: null, ahead: 3, behind: 0 },
      ],
    };
    const merged = mergeBranches([snapshot.repositories[0], secondRepo], branches, false);
    expect(merged.find((entry) => entry.name === 'feature/shared')?.instances).toHaveLength(2);
    expect(splitVisibleBranches(merged, false).primary.map((entry) => entry.name)).toEqual(['main', 'develop', 'feature/shared']);
    expect(splitVisibleBranches(merged, false).other.map((entry) => entry.name)).toEqual(['feature/local']);
    expect(splitVisibleBranches(merged, true).other).toHaveLength(0);
  });

  it('keeps distinct remote namespaces from one repository out of cross-repository shared branches', () => {
    const branches = {
      repo: [
        { name: 'origin/main', current: false, remote: true, upstream: null, ahead: 0, behind: 0 },
        { name: 'upstream/main', current: false, remote: true, upstream: null, ahead: 0, behind: 0 },
      ],
    };
    const merged = mergeBranches(snapshot.repositories, branches, true);
    expect(merged.map((entry) => entry.name)).toEqual(['origin/main', 'upstream/main']);
    expect(merged.every((entry) => entry.instances.length === 1)).toBe(true);
    expect(splitVisibleBranches(merged, false).primary).toHaveLength(0);
  });

  it('deduplicates identical full branch references from the same repository', () => {
    const main = { name: 'main', current: true, remote: false, upstream: null, ahead: 2, behind: 1 };
    const merged = mergeBranches(snapshot.repositories, { repo: [main, { ...main }] }, false);
    expect(merged).toHaveLength(1);
    expect(merged[0].instances).toHaveLength(1);
    expect(merged[0].instances[0].branch).toEqual(main);
  });

  it('counts files recursively and collapses single-child directories for the detail tree', () => {
    const files = [
      { path: 'src/deep/components/App.tsx', status: 'M', added: 2, removed: 1 },
      { path: 'src/deep/components/Button.tsx', status: 'A', added: 3, removed: 0 },
      { path: 'README.md', status: 'M', added: 1, removed: 1 },
    ];
    const tree = buildDetailTree(files);
    const src = collapseDetailTree(tree.find((node) => node.name === 'src')!);
    expect(src.name).toBe('src/deep/components');
    expect(src.fileCount).toBe(2);
    expect(tree.find((node) => node.name === 'README.md')?.fileCount).toBe(1);
  });
});
