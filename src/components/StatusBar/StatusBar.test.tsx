import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStateSnapshot, BootstrapData, BridgeCommand, WorkspaceSnapshot } from '../../bindings/generated';
import { I18nContext, createTranslator } from '../../i18n';
import { MockBridge } from '../../platform/bridge';
import type { RequestOptions } from '../../platform/bridge';
import { BridgeContext } from '../../platform/context';
import { useAppStore } from '../../store/appStore';
import { configureTaskProgress, resetTaskProgress, useTaskProgressStore } from '../../progress/taskProgressStore';
import { createOperationRequestEvent } from '../../platform/bridge';
import { StatusBar } from './StatusBar';

const state = (): AppStateSnapshot => ({
  schemaVersion: 3,
  settings: {
    theme: 'system',
    language: 'system',
    uiFontSize: 'standard',
    changesDisplayMode: 'simplified',
    defaultCommitAction: 'commit',
    defaultSaveAction: 'stash',
    promptBeforeAddingUntracked: true,
    suppressDivergedWarning: false,
    autoRefreshInterval: 0,
    fetchOnStartup: false,
    resetViewLocationsOnStartup: false,
    notifyIncomingCommits: false,
    notifyUnpushedCommits: false,
    repositoryScanDepth: 4,
    ignoredFolders: ['node_modules'],
    maximumGraphCommits: 1000,
    projectColors: {},
    externalEditor: null,
  },
  layout: {
    panelSizes: { commit: 360, branches: 220, detail: 360 },
    activeTab: 'changes',
    fileViewMode: 'tree',
    stashViewMode: 'tree',
    branchSidebarCollapsed: false,
    branchSidebarCollapsedSections: [],
  },
  lastWorkspaceId: null,
  recentWorkspaces: [],
});

const bootstrap = (): BootstrapData => ({
  applicationSessionId: 'test-session',
  state: state(),
  tools: { git: true, svn: true, svnadmin: true },
  capabilities: {
    ai: false,
    stash: true,
    shelf: true,
    changelist: true,
    worktree: true,
    subtree: true,
    compare: true,
    remoteManagement: true,
  },
});

const snapshot = (): WorkspaceSnapshot => ({
  generation: 1,
  workspace: { id: 'ws1', name: 'Workspace', paths: ['/test'], available: true, lastOpenedAt: '2026-08-27T00:00:00Z' },
  repositories: [
    {
      meta: {
        id: 'repo1',
        name: 'Repo1',
        rootPath: '/test/repo1',
        color: '#4ec9b0',
        kind: 'git',
        parentRepoId: null,
        isWorktree: false,
        isSubmodule: false,
        depth: 0,
      },
      branch: 'main',
      revision: 'abc1234',
      ahead: 3,
      behind: 1,
      conflicts: 0,
      files: [],
      operation: null,
    },
  ],
  tools: { git: true, svn: true, svnadmin: true },
});

const renderStatusBar = () => {
  const commands: BridgeCommand[] = [];
  const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
  const bridge = new MockBridge((command, options) => {
    commands.push(command);
    requests.push({ command, options });
    if (command.type === 'gitIdentity') {
      return {
        effective: {
          userName: 'Developer',
          email: 'dev@example.com',
          source: 'local',
          valid: true,
        },
        local: { userName: 'Developer', email: 'dev@example.com' },
        global: { userName: 'GlobalDev', email: 'global@example.com' },
        profiles: [
          {
            id: 'p1',
            label: 'Work',
            userName: 'WorkDev',
            email: 'work@example.com',
          },
        ],
        selectedProfileId: null,
      };
    }
    if (command.type === 'branches' || command.type === 'tags') return [];
    return true;
  });

  useAppStore.setState({
    bridge,
    bootstrap: bootstrap(),
    snapshot: snapshot(),
    ready: true,
    selectedRepoId: 'repo1',
    notifications: [],
    operations: {},
    branchesByRepo: {},
    tagsByRepo: {},
  });

  const result = render(
    <BridgeContext.Provider value={bridge}>
      <I18nContext.Provider value={{ language: 'en', preference: 'system', t: createTranslator('en') }}>
        <StatusBar />
      </I18nContext.Provider>
    </BridgeContext.Provider>
  );

  return { bridge, commands, requests, container: result.container };
};

afterEach(() => {
  cleanup();
  resetTaskProgress();
  useAppStore.setState({ bridge: undefined, bootstrap: undefined, ready: false, snapshot: undefined, operations: {} });
  vi.restoreAllMocks();
});

describe('StatusBar', () => {
  it('renders branch status and accounts item', async () => {
    const { requests } = renderStatusBar();

    // 验证分支与数字
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();

    // 等待身份加载完成
    await waitFor(() => {
      expect(screen.getByText('Git: Developer')).toBeInTheDocument();
    });
    expect(requests.find(({ command }) => command.type === 'gitIdentity')?.options?.showProgress).toBe(false);
  });

  it('shows foreground VCS activity across the current workspace', () => {
    renderStatusBar();
    const current = snapshot();
    current.repositories.push({
      ...current.repositories[0],
      meta: { ...current.repositories[0].meta, id: 'repo2', name: 'Repo2', rootPath: '/test/repo2' },
    });
    const operation = {
      operationId: 'branchRepo1',
      context: { generation: 1, domain: 'branch' as const, visibility: 'foreground' as const, workspaceId: 'ws1', repositoryId: 'repo1', target: null },
      status: 'running' as const,
      phase: 'checkout', message: '', startedAt: '', cancellable: true, completed: null, total: null, error: null,
    };
    act(() => useAppStore.setState({ snapshot: current, selectedRepoId: 'repo2', operations: { branchRepo1: operation } }));
    const branchButton = screen.getByText('main').closest('button')!;
    expect(branchButton.querySelector('.codicon-modifier-spin')).toBeInTheDocument();
    act(() => useAppStore.setState({ operations: { branchRepo1: { ...operation, context: { ...operation.context, workspaceId: 'other' } } } }));
    expect(branchButton.querySelector('.codicon-modifier-spin')).not.toBeInTheDocument();
    act(() => useAppStore.setState({ selectedRepoId: 'repo1', operations: { branchRepo1: operation } }));
    expect(branchButton.querySelector('.codicon-modifier-spin')).toBeInTheDocument();
  });

  it('does not reload identity when only repository snapshot data changes', async () => {
    const { requests } = renderStatusBar();
    await waitFor(() => expect(screen.getByText('Git: Developer')).toBeInTheDocument());
    const updatedSnapshot = snapshot();
    updatedSnapshot.generation = 2;
    updatedSnapshot.repositories[0] = { ...updatedSnapshot.repositories[0], ahead: 4 };
    useAppStore.setState({ snapshot: updatedSnapshot });
    await waitFor(() => expect(screen.getByText('4')).toBeInTheDocument());
    expect(requests.filter(({ command }) => command.type === 'gitIdentity')).toHaveLength(1);
  });

  it('opens branch menu popover on clicking branch item', async () => {
    renderStatusBar();

    const branchBtn = screen.getByText('main').closest('button')!;
    fireEvent.click(branchBtn);

    // 浮层展开
    expect(screen.getByText('Update Project…')).toBeInTheDocument();
    expect(screen.getByText('Push…')).toBeInTheDocument();
    expect(screen.getByText('Commit')).toBeInTheDocument();
    expect(screen.getByText('New Branch…')).toBeInTheDocument();
    expect(screen.getByText('Log')).toBeInTheDocument();
    expect(screen.getByText('Repo1')).toBeInTheDocument();

    // 点击 Repo1 打开二级菜单
    const repoBtn = screen.getByText('Repo1').closest('button')!;
    fireEvent.click(repoBtn);
    expect(screen.getByText('Manage Remotes…')).toBeInTheDocument();
  });

  it('opens profile menu popover on clicking profile item', async () => {
    renderStatusBar();

    await waitFor(() => {
      expect(screen.getByText('Git: Developer')).toBeInTheDocument();
    });

    const profileBtn = screen.getByText('Git: Developer').closest('button')!;
    fireEvent.click(profileBtn);

    await waitFor(() => {
      expect(screen.getByText('Work')).toBeInTheDocument();
      expect(screen.getByText('Local')).toBeInTheDocument();
      expect(screen.getByText('Global')).toBeInTheDocument();
      expect(screen.getByText('New Profile…')).toBeInTheDocument();
      expect(screen.getByText('GitHub')).toBeInTheDocument();
    });
  });

  it('updates notification badge and opens notification center', async () => {
    const { container } = renderStatusBar();

    // 初始没有通知徽标
    expect(container.querySelector('.notification-status-badge')).toBeNull();

    // 添加一条通知
    useAppStore.getState().addNotification({
      type: 'warning',
      title: 'Unpushed Commits',
      message: 'Repo1: 3 unpushed commits',
      actions: [{ type: 'openPush', label: 'Push' }, { type: 'disableIncoming', label: "Don't show again" }],
    });

    // 验证角标出现
    await waitFor(() => {
      const badge = container.querySelector('.notification-status-badge');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe('1');
    });

    // 点击铃铛打开通知中心
    const bellBtn = screen.getByRole('button', { name: /Notifications/i });
    fireEvent.click(bellBtn);

    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Unpushed Commits')).toBeInTheDocument();
    expect(screen.getByText('Repo1: 3 unpushed commits')).toBeInTheDocument();
    expect(screen.getByText('Push')).toBeInTheDocument();
    expect(screen.getByText("Don't show again")).toBeInTheDocument();
    expect(screen.getByText('Push').closest('button')?.querySelector('.codicon-arrow-right')).toBeNull();
    const center = screen.getByRole('dialog', { name: 'Notifications' });
    expect(center.parentElement).toBe(document.body);
    expect(center.closest('.app-statusbar')).toBeNull();
    expect(center.querySelector('.notification-severity-icon.warning')).not.toBeNull();

    // 再次点击铃铛应关闭通知中心，pointerdown 不应被误判为外部点击后重新打开。
    fireEvent.pointerDown(bellBtn);
    fireEvent.click(bellBtn);
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(bellBtn).toHaveAttribute('aria-expanded', 'false');

    // 重新打开后继续验证通知操作。
    fireEvent.click(bellBtn);

    // 点击清空
    const clearBtn = screen.getByTitle('Clear all');
    fireEvent.click(clearBtn);

    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });

  it('isolates notification badge and provides scope switching in multi-project mode', async () => {
    const { container } = renderStatusBar();

    useAppStore.setState({
      tabs: [
        { id: 'ws1', name: 'Project One', paths: ['/ws1'], available: true, lastOpenedAt: '' },
        { id: 'ws2', name: 'Project Two', paths: ['/ws2'], available: true, lastOpenedAt: '' },
      ],
      activeTabId: 'ws1',
      notifications: [],
    });

    // 添加一条属于 Project Two 的通知
    act(() => {
      useAppStore.getState().addNotification({
        type: 'info',
        title: 'Project 2 Notice',
        message: 'Something in ws2',
        workspaceId: 'ws2',
      });
    });

    const bellBtn = screen.getByRole('button', { name: /Notifications/i });

    // 因为当前激活的是 ws1，状态栏角标不应显示
    expect(container.querySelector('.notification-status-badge')).toBeNull();
    expect(bellBtn).toHaveAttribute('title', 'Notifications · 1 in other projects');

    // 添加一条属于当前项目 ws1 的通知
    act(() => {
      useAppStore.getState().addNotification({
        type: 'warning',
        title: 'Project 1 Alert',
        message: 'Something in ws1',
        workspaceId: 'ws1',
      });
    });

    // 当前项目角标为 1，且 tooltip 提示其他项目也有未读
    await waitFor(() => {
      const badge = container.querySelector('.notification-status-badge');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe('1');
      expect(bellBtn).toHaveAttribute('title', 'Notifications (1) · 1 in other projects');
    });

    // 打开通知中心
    fireEvent.click(bellBtn);

    // 应该渲染作用域导航选项卡
    expect(screen.getByRole('tab', { name: /Current Project/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /All Projects/i })).toBeInTheDocument();

    // 默认在 Current Project 下，只展示 ws1 的通知
    expect(screen.getByText('Project 1 Alert')).toBeInTheDocument();
    expect(screen.queryByText('Project 2 Notice')).not.toBeInTheDocument();

    // 切换到 All Projects
    const allTab = screen.getByRole('tab', { name: /All Projects/i });
    fireEvent.click(allTab);

    // 两个通知均可见，且展示归属项目标签
    expect(screen.getByText('Project 1 Alert')).toBeInTheDocument();
    expect(screen.getByText('Project 2 Notice')).toBeInTheDocument();
    expect(screen.getByText('Project Two')).toBeInTheDocument();
  });

  it('shows task progress, opens details and supports cancellation', async () => {
    const { bridge } = renderStatusBar();
    const cancelOperation = vi.fn(async () => true);
    bridge.cancelOperation = cancelOperation;
    configureTaskProgress(cancelOperation);
    const event = createOperationRequestEvent({ type: 'sync', payload: { workspace_id: 'ws1', repo_id: 'repo1', action: 'push', remote: null, branch: null } }, {}, 'push');
    act(() => {
      useTaskProgressStore.getState().requested(event, { workspaceName: 'Workspace', repoName: 'Repo1' });
      useTaskProgressStore.getState().operation({ operationId: 'push', context: event.context, status: 'running', phase: 'pushing', message: 'Pushing repository changes', startedAt: '', cancellable: true, completed: 2, total: 4, error: null });
    });
    expect(await screen.findByText('Push')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    fireEvent.click(screen.getByRole('button', { name: 'Task progress' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    expect(cancelOperation).toHaveBeenCalledWith('push');
    expect(document.querySelector('.operation-strip')).toBeNull();
  });

  it('does not flash the operation item for requests that finish within the display delay', async () => {
    vi.useFakeTimers();
    try {
      renderStatusBar();
      const event = createOperationRequestEvent({ type: 'sync', payload: { workspace_id: 'ws1', repo_id: 'repo1', action: 'push', remote: null, branch: null } }, {}, 'quick');
      act(() => useTaskProgressStore.getState().requested(event, { workspaceName: 'Workspace' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      act(() => useTaskProgressStore.getState().settled({ type: 'operation-settled', progressEvent: true, requestId: 'quick' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(document.querySelector('.statusbar-operation')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

});
