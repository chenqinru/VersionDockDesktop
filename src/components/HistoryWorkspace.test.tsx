import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryWorkspace } from './HistoryWorkspace';
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
  useAppStore.setState({ bridge: undefined, bootstrap: undefined, snapshot: undefined, selectedRepoId: undefined, history: [], branches: [], tags: [], remotes: {}, comparison: undefined });
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
});
