import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncPanel } from './SyncPanel';
import { useAppStore } from '../store/appStore';
import type { CommitDetail, CommitNode, IncomingCommit, RepositoryStatus, UnpushedCommit, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import * as dialogService from './dialogService';
import { commitKey } from '../history/commitDetails';

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

describe('SyncPanel footer parity with plugin', () => {
  const initial = useAppStore.getState();
  afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks(); });
  const setup = (ahead: number, behind: number, upstream: string | null = 'origin/main', multiple = false) => {
    const target = { ...gitRepo, ahead, behind };
    const repos = multiple ? [target, { ...target, meta: { ...target.meta, id: 'repo-2', name: 'Repo 2' } }] : [target];
    const fetch = vi.fn().mockResolvedValue(undefined);
    const sync = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      bridge, snapshot: { ...snapshot, repositories: repos }, operations: {}, loadErrors: {}, sync,
      bootstrap: { state: { settings: { updateProjectMethod: 'rebase' } } } as any,
      incomingCommits: Object.fromEntries(repos.map(repo => [repo.meta.id, behind ? sampleIncoming : []])),
      unpushedCommits: Object.fromEntries(repos.map(repo => [repo.meta.id, ahead ? sampleOutgoing : []])),
      branchesByRepo: Object.fromEntries(repos.map(repo => [repo.meta.id, [{ name: 'main', current: true, remote: false, remoteName: null, upstream, ahead, behind, detachedTag: null, detachedHash: null, lastCommitMessage: null, lastCommitDate: null }]])),
      loadIncomingCommits: vi.fn().mockResolvedValue(undefined), loadUnpushedCommits: vi.fn().mockResolvedValue(undefined),
      fetchRepositories: fetch,
    });
    const view = render(<BridgeContext.Provider value={bridge}><SyncPanel repos={repos} /></BridgeContext.Provider>);
    return { ...view, fetch, sync };
  };

  it('keeps the footer enabled throughout read-only commit detail loading', async () => {
    const { container } = setup(1, 0);
    const commit: CommitNode = { repoId: 'repo-1', hash: 'detail-commit', shortHash: 'detail', parents: [],
      author: 'Developer', email: 'developer@example.test', authorDate: '2026-10-06T00:00:00Z',
      committerDate: '2026-10-06T00:00:00Z', message: 'Read commit details', refs: [] };
    let finish!: (detail: CommitDetail) => void;
    const pending = new Promise<CommitDetail>(resolve => { finish = resolve; });
    useAppStore.setState({ bridge: new MockBridge(command => command.type === 'commitDetail' ? pending : []),
      selectedCommits: [], selectedPrimaryKey: undefined, selectedCommitDetails: {}, selectedCommitLoading: {} });
    const primary = container.querySelector('.sync-primary-action')!;
    const more = container.querySelector('.sync-primary-more')!;
    let request!: Promise<unknown>;
    act(() => { request = initial.selectCommit(commit); });
    try {
      expect(useAppStore.getState().selectedCommitLoading[commitKey(commit.repoId, commit.hash)]).toBe(true);
      expect(primary).toBeEnabled();
      expect(more).toBeEnabled();
      expect(useAppStore.getState().operations).toEqual({});
      await act(async () => { await Promise.resolve(); });
      expect(primary).toBeEnabled();
      expect(more).toBeEnabled();
    } finally {
      await act(async () => {
        finish({ commit, fullMessage: commit.message, branches: { local: [], remote: [], tags: [] }, files: [] });
        await request;
      });
    }
    expect(container.querySelector('.sync-primary-action')).toBe(primary);
    expect(primary).toHaveTextContent('Push');
    expect(primary).toBeEnabled();
    expect(useAppStore.getState().selectedCommit?.commit.hash).toBe(commit.hash);
  });

  it('still guards the footer while a repository history write is pending', async () => {
    const { container } = setup(1, 0);
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    useAppStore.setState({ bridge: new MockBridge(command => command.type === 'historyOperation' ? pending : []),
      refresh: vi.fn().mockResolvedValue(undefined), loadHistory: vi.fn().mockResolvedValue(undefined) });
    let request!: Promise<unknown>;
    act(() => { request = initial.historyOperation('repo-1', { type: 'revert', revisions: ['revision'] }); });
    try {
      expect(container.querySelector('.sync-primary-action')).toBeDisabled();
      expect(container.querySelector('.sync-primary-more')).toBeDisabled();
    } finally { await act(async () => { finish(); await request; }); }
    expect(container.querySelector('.sync-primary-action')).toBeEnabled();
    expect(container.querySelector('.sync-primary-more')).toBeEnabled();
  });

  it.each([{ ahead: 1, behind: 0 }, { ahead: 0, behind: 1 }, { ahead: 1, behind: 1 }, { ahead: 0, behind: 0 }])('keeps footer and repository actions enabled during automatic fetch ($ahead/$behind)', async ({ ahead, behind }) => {
    const { container } = setup(ahead, behind);
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const fetchBridge = new MockBridge(command => command.type === 'sync' ? pending : []);
    useAppStore.setState({ bridge: fetchBridge });
    let request!: Promise<unknown>;
    act(() => { request = initial.sync('repo-1', 'fetch', false); });
    try {
      expect(container.querySelector('.sync-primary-action')).toBeEnabled();
      const more = container.querySelector('.sync-primary-more');
      if (more) expect(more).toBeEnabled();
      fireEvent.contextMenu(container.querySelector('.sync-repo-heading')!);
      for (const name of ['Fetch', ...(ahead ? ['Push'] : []), ...(behind ? ['Update'] : []), ...(ahead && behind ? ['Sync'] : [])]) {
        expect(screen.getByRole('menuitem', { name })).toBeEnabled();
      }
    } finally {
      await act(async () => { finish({ output: '', update: null }); await request; });
    }
  });

  it.each([
    { ahead: 1, behind: 0, label: 'Push', items: ['Safe Force Push...'] },
    { ahead: 0, behind: 1, label: 'Update', items: ['Update Strategy: Rebase', 'Update Strategy: Merge', 'Update Strategy: Fast-Forward Only'] },
    { ahead: 1, behind: 1, label: 'Sync ↓1 ↑1', items: [] },
    { ahead: 0, behind: 0, label: 'Fetch', items: [] },
  ])('matches the single-repo $label button and menu', ({ ahead, behind, label, items }) => {
    const { container } = setup(ahead, behind);
    expect(container.querySelector('.sync-primary-action')).toHaveTextContent(label);
    const more = container.querySelector('.sync-primary-more');
    if (items.length) {
      expect(more).not.toBeNull();
      fireEvent.click(more!);
      expect(screen.getAllByRole('menuitem').map(item => item.textContent?.trim())).toEqual(items);
      expect(screen.queryByRole('menuitem', { name: 'Fetch All' })).not.toBeInTheDocument();
    } else expect(more).toBeNull();
  });

  it('publishes without push options or pulling when a single repository has no upstream', async () => {
    const { container, sync } = setup(1, 1, null);
    const primary = container.querySelector('.sync-primary-action')!;
    expect(primary).toHaveTextContent('Publish Branch');
    expect(primary).not.toHaveClass('push');
    expect(container.querySelector('.sync-primary-more')).toBeNull();
    fireEvent.click(primary);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    expect(sync).toHaveBeenCalledWith('repo-1', 'push', undefined, undefined, 'workspace-1');
  });

  it('uses direction-specific menus and disables Sync when both directions are off', () => {
    const { container } = setup(1, 1);
    const outgoing = container.querySelector('.sync-direction-pill.outgoing')!;
    const incoming = container.querySelector('.sync-direction-pill.incoming')!;
    fireEvent.click(outgoing);
    expect(container.querySelector('.sync-primary-action')).toHaveTextContent('Update');
    fireEvent.click(container.querySelector('.sync-primary-more')!);
    expect(screen.getAllByRole('menuitem').map(item => item.textContent?.trim())).toEqual(['Update Strategy: Rebase', 'Update Strategy: Merge', 'Update Strategy: Fast-Forward Only']);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(outgoing);
    fireEvent.click(incoming);
    expect(container.querySelector('.sync-primary-action')).toHaveTextContent('Push');
    fireEvent.click(outgoing);
    expect(container.querySelector('.sync-primary-action')).toHaveTextContent('Sync');
    expect(container.querySelector('.sync-primary-action')).toBeDisabled();
    expect(container.querySelector('.sync-primary-more')).toBeNull();
  });

  it('keeps Fetch All available with no repository selected and fetches every repository', async () => {
    const { container, fetch } = setup(1, 0, 'origin/main', true);
    const primary = container.querySelector('.sync-primary-action')!;
    expect(primary).toHaveTextContent('Fetch All');
    expect(primary).toBeEnabled();
    expect(container.querySelector('.sync-primary-more')).toBeNull();
    fireEvent.click(primary);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(['repo-1', 'repo-2'], true, 'workspace-1'));
  });

  it.each([
    { ahead: 1, behind: 0, label: 'Push (2)', items: ['Safe Force Push...'], upstream: 'origin/main' },
    { ahead: 0, behind: 1, label: 'Update (2)', items: ['Update Strategy: Rebase', 'Update Strategy: Merge', 'Update Strategy: Fast-Forward Only'], upstream: 'origin/main' },
    { ahead: 1, behind: 1, label: 'Sync ↓2 ↑2', items: [], upstream: 'origin/main' },
    { ahead: 1, behind: 0, label: 'Publish Branches (2)', items: [], upstream: null },
  ])('matches multi-repo $label and its menu', ({ ahead, behind, label, items, upstream }) => {
    const { container } = setup(ahead, behind, upstream, true);
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    expect(container.querySelector('.sync-primary-action')).toHaveTextContent(label);
    const more = container.querySelector('.sync-primary-more');
    if (items.length) {
      fireEvent.click(more!);
      expect(screen.getAllByRole('menuitem').map(item => item.textContent?.trim())).toEqual(items);
    } else expect(more).toBeNull();
  });
});
