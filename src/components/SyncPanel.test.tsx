import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncPanel } from './SyncPanel';
import { useAppStore } from '../store/appStore';
import type { IncomingCommit, RepositoryStatus, UnpushedCommit, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import * as dialogService from './dialogService';

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

const sampleIncoming: IncomingCommit[] = [
  {
    hash: 'inc-1',
    shortHash: 'inc1',
    message: 'incoming commit',
    author: 'someone',
    authorEmail: 'someone@example.com',
    date: '2026-09-26T10:00:00Z',
    filesChanged: 1,
    additions: 10,
    deletions: 0,
    parents: [],
    potentialConflictPaths: [],
  },
];

const sampleOutgoing: UnpushedCommit[] = [
  {
    hash: 'out-1',
    shortHash: 'out1',
    message: 'outgoing commit',
    author: 'me',
    authorEmail: 'me@example.com',
    date: '2026-09-26T11:00:00Z',
    filesChanged: 1,
    additions: 5,
    deletions: 0,
  },
];

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

  it('locks target workspace id for multi-step syncSelected when active tab switches during execution', async () => {
    const syncCalls: Array<{ repoId: string; action: string; targetWid?: string }> = [];
    const mockSync = vi.fn().mockImplementation(async (repoId: string, action: string, _interactive?: boolean, _opts?: unknown, targetWid?: string) => {
      syncCalls.push({ repoId, action, targetWid });
      if (action === 'pullRebase' || action === 'pull') {
        // 模拟在 pull 异步等待期间切换前台工作区至 workspace-2
        useAppStore.setState({
          snapshot: {
            ...snapshot,
            workspace: { ...snapshot.workspace, id: 'workspace-2' },
          },
        });
      }
      return true;
    });

    const mockLoadIncoming = vi.fn().mockResolvedValue(undefined);
    const mockLoadOutgoing = vi.fn().mockResolvedValue(undefined);

    const gitRepoWithChanges: RepositoryStatus = {
      ...gitRepo,
      ahead: 1,
      behind: 1,
    };

    useAppStore.setState({
      bridge,
      snapshot,
      tabs: [{ id: 'workspace-1', title: 'Workspace 1' } as any, { id: 'workspace-2', title: 'Workspace 2' } as any],
      sessions: { 'workspace-1': {} as any },
      sync: mockSync,
      loadIncomingCommits: mockLoadIncoming,
      loadUnpushedCommits: mockLoadOutgoing,
      incomingCommits: { 'repo-1': sampleIncoming },
      unpushedCommits: { 'repo-1': sampleOutgoing },
      bootstrap: {
        state: {
          settings: {
            updateProjectMethod: 'rebase',
          },
        },
      } as any,
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <SyncPanel repos={[gitRepoWithChanges]} />
      </BridgeContext.Provider>,
    );

    // 找到主同步按钮并点击触发 syncSelected
    const syncBtn = screen.getByRole('button', { name: /Sync.*↓1.*↑1/ });
    fireEvent.click(syncBtn);

    await vi.waitFor(() => {
      expect(syncCalls.length).toBe(2);
    });

    // 验证第一步 pullRebase 与第二步 push 都锁定了 workspace-1
    expect(syncCalls).toEqual([
      { repoId: 'repo-1', action: 'pullRebase', targetWid: 'workspace-1' },
      { repoId: 'repo-1', action: 'push', targetWid: 'workspace-1' },
    ]);

    // 验证完成后的刷新调用也固定为 workspace-1
    expect(mockLoadIncoming).toHaveBeenCalledWith(undefined, 'workspace-1');
    expect(mockLoadOutgoing).toHaveBeenCalledWith(undefined, 'workspace-1');
  });

  it('locks target workspace id for single-repo syncRepo when active tab switches during pull', async () => {
    const syncCalls: Array<{ repoId: string; action: string; targetWid?: string }> = [];
    const mockSync = vi.fn().mockImplementation(async (repoId: string, action: string, _interactive?: boolean, _opts?: unknown, targetWid?: string) => {
      syncCalls.push({ repoId, action, targetWid });
      if (action === 'pullRebase' || action === 'pull') {
        // 模拟在 pull 异步等待期间切换前台工作区至 workspace-2，原工作区仍在后台打开
        useAppStore.setState({
          snapshot: {
            ...snapshot,
            workspace: { ...snapshot.workspace, id: 'workspace-2' },
          },
        });
      }
      return true;
    });

    const gitRepoWithChanges: RepositoryStatus = {
      ...gitRepo,
      ahead: 1,
      behind: 1,
    };

    useAppStore.setState({
      bridge,
      snapshot,
      tabs: [{ id: 'workspace-1', title: 'Workspace 1' } as any, { id: 'workspace-2', title: 'Workspace 2' } as any],
      sessions: { 'workspace-1': {} as any },
      sync: mockSync,
      incomingCommits: { 'repo-1': sampleIncoming },
      unpushedCommits: { 'repo-1': sampleOutgoing },
      bootstrap: {
        state: {
          settings: {
            updateProjectMethod: 'rebase',
          },
        },
      } as any,
    });

    const { container } = render(
      <BridgeContext.Provider value={bridge}>
        <SyncPanel repos={[gitRepoWithChanges]} />
      </BridgeContext.Provider>,
    );

    // 右键打开仓库操作菜单
    const repoHeader = container.querySelector('.sync-repo-heading');
    expect(repoHeader).not.toBeNull();
    fireEvent.contextMenu(repoHeader!);

    // 点击上下文菜单中的 Sync 动作
    const syncMenuItem = screen.getByText('Sync');
    fireEvent.click(syncMenuItem);

    await vi.waitFor(() => {
      expect(syncCalls.length).toBe(2);
    });

    expect(syncCalls).toEqual([
      { repoId: 'repo-1', action: 'pullRebase', targetWid: 'workspace-1' },
      { repoId: 'repo-1', action: 'push', targetWid: 'workspace-1' },
    ]);
  });

  it('bails out safely and never sends repo requests to another workspace if active workspace was closed during strategy dialog', async () => {
    const choiceSpy = vi.spyOn(dialogService, 'choiceDialog').mockImplementation(async () => {
      // 模拟在策略弹窗等待期间，用户按 Cmd+W 关闭了当前工作区 workspace-1 并切到 workspace-2（tabs 和 sessions 均被清空）
      useAppStore.setState({
        tabs: [{ id: 'workspace-2', title: 'Workspace 2' } as any],
        sessions: { 'workspace-2': {} as any },
        snapshot: {
          ...snapshot,
          workspace: { id: 'workspace-2', name: 'Workspace 2', paths: ['/tmp/repo-2'], lastOpenedAt: '', available: true },
        },
      });
      return 'rebase';
    });

    const mockSync = vi.fn().mockResolvedValue(true);
    const gitRepoWithChanges: RepositoryStatus = {
      ...gitRepo,
      ahead: 1,
      behind: 1,
    };

    useAppStore.setState({
      bridge,
      snapshot,
      tabs: [{ id: 'workspace-1', title: 'Workspace 1' } as any],
      sessions: { 'workspace-1': {} as any },
      sync: mockSync,
      incomingCommits: { 'repo-1': sampleIncoming },
      unpushedCommits: { 'repo-1': sampleOutgoing },
      bootstrap: {
        state: {
          settings: {
            updateProjectMethod: 'prompt',
          },
        },
      } as any,
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <SyncPanel repos={[gitRepoWithChanges]} />
      </BridgeContext.Provider>,
    );

    const syncBtn = screen.getByRole('button', { name: /Sync.*↓1.*↑1/ });
    fireEvent.click(syncBtn);

    await vi.waitFor(() => {
      expect(choiceSpy).toHaveBeenCalled();
    });

    // 验证 sync 绝对没有被调用（没有把 workspace-1 的 repo-1 错发给 workspace-2，也没有发往已关闭的工作区）
    expect(mockSync).not.toHaveBeenCalled();
    choiceSpy.mockRestore();
  });

  it('locks target workspace id for syncSelected even if tab switched during strategy dialog', async () => {
    const syncCalls: Array<{ repoId: string; action: string; targetWid?: string }> = [];
    const mockSync = vi.fn().mockImplementation(async (repoId: string, action: string, _interactive?: boolean, _opts?: unknown, targetWid?: string) => {
      syncCalls.push({ repoId, action, targetWid });
      return true;
    });

    const choiceSpy = vi.spyOn(dialogService, 'choiceDialog').mockImplementation(async () => {
      // 模拟在策略弹窗期间切换前台工作区到 workspace-2，但 workspace-1 仍然保持打开状态（未关闭）
      useAppStore.setState({
        tabs: [
          { id: 'workspace-1', title: 'Workspace 1' } as any,
          { id: 'workspace-2', title: 'Workspace 2' } as any,
        ],
        snapshot: {
          ...snapshot,
          workspace: { id: 'workspace-2', name: 'Workspace 2', paths: ['/tmp/repo-2'], lastOpenedAt: '', available: true },
        },
      });
      return 'rebase';
    });

    const gitRepoWithChanges: RepositoryStatus = {
      ...gitRepo,
      ahead: 1,
      behind: 1,
    };

    useAppStore.setState({
      bridge,
      snapshot,
      tabs: [
        { id: 'workspace-1', title: 'Workspace 1' } as any,
        { id: 'workspace-2', title: 'Workspace 2' } as any,
      ],
      sync: mockSync,
      incomingCommits: { 'repo-1': sampleIncoming },
      unpushedCommits: { 'repo-1': sampleOutgoing },
      bootstrap: {
        state: {
          settings: {
            updateProjectMethod: 'prompt',
          },
        },
      } as any,
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <SyncPanel repos={[gitRepoWithChanges]} />
      </BridgeContext.Provider>,
    );

    const syncBtn = screen.getByRole('button', { name: /Sync.*↓1.*↑1/ });
    fireEvent.click(syncBtn);

    await vi.waitFor(() => {
      expect(syncCalls.length).toBe(2);
    });

    // 验证两步操作均锁定在发起工作区 workspace-1，未错发往当前前台 workspace-2
    expect(syncCalls).toEqual([
      { repoId: 'repo-1', action: 'pullRebase', targetWid: 'workspace-1' },
      { repoId: 'repo-1', action: 'push', targetWid: 'workspace-1' },
    ]);
    choiceSpy.mockRestore();
  });
});
