import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStateSnapshot, BootstrapData, BridgeCommand, WorkspaceSnapshot } from '../../bindings/generated';
import { I18nContext, createTranslator } from '../../i18n';
import { MockBridge } from '../../platform/bridge';
import type { RequestOptions } from '../../platform/bridge';
import { BridgeContext } from '../../platform/context';
import { useAppStore } from '../../store/appStore';
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
      expect(screen.getByText('Manage Git identities…')).toBeInTheDocument();
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
      actionLabel: 'Push',
      actionKey: 'pushAll',
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

    // 点击清空
    const clearBtn = screen.getByTitle('Clear all');
    fireEvent.click(clearBtn);

    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });

  it('shows active operation progress in the status bar and supports cancellation', async () => {
    const { bridge, container } = renderStatusBar();
    const cancelOperation = vi.fn(async () => true);
    bridge.cancelOperation = cancelOperation;
    useAppStore.setState({
      operations: {
        fetch: {
          operationId: 'fetch',
          context: { generation: 1, domain: 'sync', visibility: 'foreground', workspaceId: 'ws1', repositoryId: 'repo1', target: null },
          status: 'running', phase: 'sync', message: '', startedAt: '', cancellable: true,
          completed: 2, total: 4, result: null, error: null,
        },
      },
    });

    expect(await screen.findByText('Synchronizing repository')).toBeInTheDocument();
    expect(container.querySelector('.statusbar-operation-progress')).toHaveAttribute('value', '2');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelOperation).toHaveBeenCalledWith('fetch');
    expect(document.querySelector('.operation-strip')).toBeNull();
  });

  it('does not flash the operation item for requests that finish within the display delay', async () => {
    vi.useFakeTimers();
    try {
      renderStatusBar();
      act(() => {
        useAppStore.setState({
          operations: {
            quick: {
              operationId: 'quick',
              context: { generation: 1, domain: 'sync', visibility: 'foreground', workspaceId: 'ws1', repositoryId: 'repo1', target: null },
              status: 'running', phase: 'sync', message: '', startedAt: '', cancellable: true,
              completed: null, total: null, result: null, error: null,
            },
          },
        });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      act(() => useAppStore.setState({ operations: {} }));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });

      expect(document.querySelector('.statusbar-operation')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
