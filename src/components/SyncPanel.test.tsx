import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncPanel } from './SyncPanel';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';

const bridge = new MockBridge(() => []);
const gitRepo: RepositoryStatus = {
  meta: {
    id: 'repo-1',
    name: 'Repo 1',
    rootPath: '/tmp/repo-1',
    color: '#4ec9b0',
    kind: 'git',
    parentRepoId: null,
    depth: 0,
    isSubmodule: false,
    isWorktree: false,
  },
  branch: 'main',
  revision: 'abc',
  ahead: 1,
  behind: 0,
  files: [],
  conflicts: 0,
  operation: null,
};

const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'workspace-1', name: 'Workspace 1', paths: ['/tmp/repo-1'], lastOpenedAt: '', available: true },
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
  repositories: [gitRepo],
};

afterEach(() => {
  cleanup();
  useAppStore.setState({
    snapshot: undefined,
    unpushedCommits: {},
    incomingCommits: {},
    loadErrors: {},
    operations: {},
  });
});

describe('SyncPanel error handling', () => {
  it('renders load errors banner with retry button and updates empty state', () => {
    const mockLoadOutgoing = vi.fn();
    useAppStore.setState({
      bridge,
      snapshot,
      unpushedCommits: {},
      incomingCommits: {},
      loadErrors: {
        'unpushed:repo-1': 'Failed to connect to remote',
      },
      loadUnpushedCommits: mockLoadOutgoing,
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <SyncPanel repos={[gitRepo]} />
      </BridgeContext.Provider>,
    );

    // 错误信息横幅
    expect(screen.getByText('Failed to connect to remote')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    expect(retryBtn).toBeInTheDocument();

    fireEvent.click(retryBtn);
    expect(mockLoadOutgoing).toHaveBeenCalledWith('repo-1');

    // 空状态提示应显示读取失败，而非误导性的 Fetch to load
    expect(screen.getByText('Failed to load commits')).toBeInTheDocument();
    expect(screen.queryByText('Fetch to load incoming commit details.')).not.toBeInTheDocument();
  });
});
