import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictsWorkspace } from './ConflictsWorkspace';
import { useAppStore } from '../store/appStore';
import * as dialogService from './dialogService';
import type { ConflictFile } from '../bindings/generated';

const mockConflict: ConflictFile = {
  repoId: 'repo-1',
  repoName: 'SERVICE-AUTH',
  repoColor: '#ff0000',
  path: 'src/authorization-policy.js',
  kind: 'git',
  binary: false,
};

afterEach(() => {
  cleanup();
  useAppStore.setState({ conflicts: [], selectedFile: undefined, mergeTarget: undefined, snapshot: undefined, loadErrors: {} });
});

describe('ConflictsWorkspace', () => {
  it('renders conflict list and allows opening merge editor', async () => {
    const openMerge = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      conflicts: [mockConflict],
      openMerge,
    });

    render(<ConflictsWorkspace />);

    expect(screen.getByText('SERVICE-AUTH')).toBeInTheDocument();
    expect(screen.getByText('authorization-policy.js')).toBeInTheDocument();

    const fileRow = screen.getByText('authorization-policy.js');
    fireEvent.click(fileRow);

    const mergeBtn = screen.getByRole('button', { name: 'Merge...' });
    expect(mergeBtn).toBeEnabled();

    fireEvent.click(mergeBtn);
    await waitFor(() => expect(openMerge).toHaveBeenCalledWith(mockConflict));
  });

  it('allows accepting current or incoming side', async () => {
    const resolveConflict = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      conflicts: [mockConflict],
      resolveConflict,
    });

    render(<ConflictsWorkspace />);

    const fileRow = screen.getByText('authorization-policy.js');
    fireEvent.click(fileRow);

    const acceptCurrentBtn = screen.getByRole('button', { name: 'Accept Current' });
    fireEvent.click(acceptCurrentBtn);

    await waitFor(() => expect(resolveConflict).toHaveBeenCalledWith(mockConflict, 'mine'));
  });

  it('allows navigating back to history via back button', () => {
    const backToHistory = vi.fn();
    useAppStore.setState({
      conflicts: [mockConflict],
      backToHistory,
    });

    render(<ConflictsWorkspace />);

    const backBtn = screen.getByRole('button', { name: 'Back to history' });
    fireEvent.click(backBtn);

    expect(backToHistory).toHaveBeenCalled();
  });

  it('renders side statuses and conflict type badges, and displays warning banner for non-text conflicts', async () => {
    const treeConflict: ConflictFile = {
      repoId: 'repo-2',
      repoName: 'SVN-REPO',
      repoColor: '#00ff00',
      path: 'folder/config.xml',
      kind: 'svn',
      binary: false,
      conflictType: 'tree',
      currentStatus: 'added',
      incomingStatus: 'deleted',
    };
    const openMerge = vi.fn().mockResolvedValue(undefined);
    const addNotification = vi.fn();
    useAppStore.setState({
      conflicts: [treeConflict],
      openMerge,
      addNotification,
    });

    render(<ConflictsWorkspace />);

    // 验证状态文本
    expect(screen.getByText('Conflict Added')).toBeInTheDocument();
    expect(screen.getByText('Conflict Deleted')).toBeInTheDocument();
    // 验证冲突类型徽章
    expect(screen.getByText('Tree conflict')).toBeInTheDocument();

    // 点击该行选中
    const row = screen.getByText('config.xml');
    fireEvent.click(row);

    // 验证警告横幅出现
    expect(screen.getByText('SVN tree or property conflict requires a side selection. Choose Accept Current or Accept Incoming.')).toBeInTheDocument();

    // 树冲突不可合并，Merge 按钮应被禁用
    const mergeBtn = screen.getByRole('button', { name: 'Merge...' });
    expect(mergeBtn).toBeDisabled();

    // 双击触发通知而非打开合并编辑器
    fireEvent.doubleClick(row);
    expect(openMerge).not.toHaveBeenCalled();
    expect(addNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'info',
      title: 'SVN-REPO',
    }));
  });

  it('allows merging when both text and property conflicts exist', async () => {
    const textAndPropConflict: ConflictFile = {
      repoId: 'repo-3',
      repoName: 'SVN-REPO',
      repoColor: '#00ff00',
      path: 'src/main.rs',
      kind: 'svn',
      binary: false,
      conflictType: 'text',
      conflictTypes: ['text', 'property'],
      currentStatus: 'modified',
      incomingStatus: 'modified',
    };
    const openMerge = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      conflicts: [textAndPropConflict],
      openMerge,
    });

    render(<ConflictsWorkspace />);

    // 验证冲突类型徽章显示“文本和属性冲突”
    expect(screen.getByText('Text and property conflict')).toBeInTheDocument();

    const row = screen.getByText('main.rs');
    fireEvent.click(row);

    // 存在文本冲突时，Merge 按钮应为启用状态，且不应展示要求强制选择一侧的警告横幅
    const mergeBtn = screen.getByRole('button', { name: 'Merge...' });
    expect(mergeBtn).toBeEnabled();
    expect(screen.queryByText('SVN tree or property conflict requires a side selection. Choose Accept Current or Accept Incoming.')).not.toBeInTheDocument();

    fireEvent.click(mergeBtn);
    await waitFor(() => expect(openMerge).toHaveBeenCalledWith(textAndPropConflict));
  });

  it('displays error banner and failed empty state when conflicts load fails', () => {
    useAppStore.setState({
      conflicts: [],
      loadErrors: { 'conflicts:all': 'Network error occurred while fetching conflicts' },
    });

    render(<ConflictsWorkspace />);

    // 验证错误横幅出现且内容正确
    expect(screen.getByText('Network error occurred while fetching conflicts')).toBeInTheDocument();
    // 验证主体内容显示“加载冲突列表失败”而不是“所有冲突均已解决”
    expect(screen.getByText('Failed to load conflicts')).toBeInTheDocument();
    expect(screen.queryByText('All conflicts resolved')).not.toBeInTheDocument();
  });

  it('disables merge editor button and shows submodule conflict badge for submodule conflicts', () => {
    const submoduleConflict: ConflictFile = {
      repoId: 'repo-sub',
      repoName: 'MAIN-REPO',
      repoColor: '#336699',
      path: 'modules/mysub',
      kind: 'git',
      binary: false,
      conflictType: 'submodule',
      conflictTypes: ['submodule'],
      currentStatus: 'modified',
      incomingStatus: 'modified',
    };
    const addNotification = vi.fn();
    useAppStore.setState({
      conflicts: [submoduleConflict],
      addNotification,
    });

    render(<ConflictsWorkspace />);

    expect(screen.getByText('Submodule conflict')).toBeInTheDocument();

    const row = screen.getByText('mysub');
    fireEvent.click(row);

    const mergeBtn = screen.getByRole('button', { name: 'Merge...' });
    expect(mergeBtn).toBeDisabled();

    // 验证显示专用的子模块警告横幅，绝不显示 SVN 横幅
    expect(screen.getByText('Submodule conflict requires a side selection. Choose Accept Current or Accept Incoming.')).toBeInTheDocument();
    expect(screen.queryByText(/SVN tree or property conflict/)).not.toBeInTheDocument();

    const acceptIncomingBtn = screen.getByRole('button', { name: 'Accept Incoming' });
    expect(acceptIncomingBtn).toBeEnabled();

    // 双击触发子模块专用通知
    fireEvent.doubleClick(row);
    expect(addNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'info',
      title: 'MAIN-REPO',
      message: { raw: 'Submodule conflicts cannot be opened in the text merge editor. Use a conflict action instead.' },
    }));
  });

  it('shows binary conflict warning banner and notification for git binary conflicts without SVN mentions', () => {
    const binaryConflict: ConflictFile = {
      repoId: 'repo-bin',
      repoName: 'GIT-REPO',
      repoColor: '#f05032',
      path: 'assets/logo.png',
      kind: 'git',
      binary: true,
      conflictType: 'binary',
      conflictTypes: ['binary'],
      currentStatus: 'modified',
      incomingStatus: 'modified',
    };
    const addNotification = vi.fn();
    useAppStore.setState({
      conflicts: [binaryConflict],
      addNotification,
    });

    render(<ConflictsWorkspace />);

    expect(screen.getByText('Binary conflict')).toBeInTheDocument();

    const row = screen.getByText('logo.png');
    fireEvent.click(row);

    const mergeBtn = screen.getByRole('button', { name: 'Merge...' });
    expect(mergeBtn).toBeDisabled();

    // 验证显示专用的二进制警告横幅，绝不显示 SVN
    expect(screen.getByText('Binary conflict requires a side selection. Choose Accept Current or Accept Incoming.')).toBeInTheDocument();
    expect(screen.queryByText(/SVN/)).not.toBeInTheDocument();

    // 双击触发二进制专用通知
    fireEvent.doubleClick(row);
    expect(addNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'info',
      title: 'GIT-REPO',
      message: { raw: 'Binary conflicts cannot be opened in the text merge editor. Use a conflict action instead.' },
    }));
  });

  it('stops batch accept when one conflict fails', async () => {
    const file1: ConflictFile = {
      repoId: 'repo-1',
      repoName: 'REPO',
      repoColor: '#ff0000',
      path: 'file1.txt',
      kind: 'git',
      binary: false,
    };
    const file2: ConflictFile = {
      repoId: 'repo-1',
      repoName: 'REPO',
      repoColor: '#ff0000',
      path: 'file2.txt',
      kind: 'git',
      binary: false,
    };
    const resolveConflict = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    useAppStore.setState({
      conflicts: [file1, file2],
      resolveConflict,
    });

    render(<ConflictsWorkspace />);

    const row1 = screen.getByText('file1.txt');
    const row2 = screen.getByText('file2.txt');
    fireEvent.click(row1);
    fireEvent.click(row2, { ctrlKey: true });

    const acceptBtn = screen.getByRole('button', { name: 'Accept Current' });
    fireEvent.click(acceptBtn);

    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    expect(resolveConflict).toHaveBeenCalledWith(file1, 'mine');
    expect(resolveConflict).not.toHaveBeenCalledWith(file2, 'mine');
  });

  it('renders data-key on file rows for speed search and scrolling', () => {
    useAppStore.setState({
      conflicts: [mockConflict],
    });

    render(<ConflictsWorkspace />);

    const row = document.querySelector('[data-key="repo-1:src/authorization-policy.js"]');
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute('data-selected', 'false');
  });

  it('renders continue and abort buttons when all conflicts are resolved and operation is active', async () => {
    const continueRepositoryOperation = vi.fn().mockResolvedValue(true);
    const backToHistory = vi.fn();
    useAppStore.setState({
      conflicts: [],
      snapshot: {
        workspace: { id: 'w1', name: 'Workspace', paths: ['/path'], lastOpenedAt: '', available: true },
        generation: 1,
        tools: { git: true, svn: true, svnadmin: true },
        repositories: [
          {
            meta: { id: 'repo-rebase', name: 'my-service', rootPath: '/path', color: '#ff0000', kind: 'git', depth: 0, isSubmodule: false, isWorktree: false, parentRepoId: null },
            branch: 'feature',
            revision: '123456',
            ahead: 0,
            behind: 0,
            files: [],
            conflicts: 0,
            operation: 'rebase',
          },
        ],
      },
      continueRepositoryOperation,
      backToHistory,
    });

    render(<ConflictsWorkspace />);

    expect(screen.getByText('All conflicts resolved')).toBeInTheDocument();
    expect(screen.getByText('All conflicts resolved. Continue rebase to apply next commits.')).toBeInTheDocument();

    const continueBtn = screen.getByRole('button', { name: 'Continue Rebase' });
    expect(continueBtn).toBeInTheDocument();

    const abortBtn = screen.getByRole('button', { name: 'Abort Rebase' });
    expect(abortBtn).toBeInTheDocument();

    fireEvent.click(continueBtn);
    await waitFor(() => {
      expect(continueRepositoryOperation).toHaveBeenCalledWith('repo-rebase', 'rebase');
      expect(backToHistory).toHaveBeenCalled();
    });
  });

  it('allows aborting operation from resolved state with confirmation', async () => {
    const abortRepositoryOperation = vi.fn().mockResolvedValue(true);
    const backToHistory = vi.fn();
    const confirmSpy = vi.spyOn(dialogService, 'confirmDialog').mockResolvedValue(true);

    useAppStore.setState({
      conflicts: [],
      snapshot: {
        workspace: { id: 'w1', name: 'Workspace', paths: ['/path'], lastOpenedAt: '', available: true },
        generation: 1,
        tools: { git: true, svn: true, svnadmin: true },
        repositories: [
          {
            meta: { id: 'repo-merge', name: 'my-service', rootPath: '/path', color: '#ff0000', kind: 'git', depth: 0, isSubmodule: false, isWorktree: false, parentRepoId: null },
            branch: 'feature',
            revision: '123456',
            ahead: 0,
            behind: 0,
            files: [],
            conflicts: 0,
            operation: 'merge',
          },
        ],
      },
      abortRepositoryOperation,
      backToHistory,
    });

    render(<ConflictsWorkspace />);

    const abortBtn = screen.getByRole('button', { name: 'Abort Merge' });
    expect(abortBtn).toBeInTheDocument();

    fireEvent.click(abortBtn);
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmLabel: 'Abort Merge',
          danger: true,
        }),
      );
      expect(abortRepositoryOperation).toHaveBeenCalledWith('repo-merge', 'merge');
      expect(backToHistory).toHaveBeenCalled();
    });

    confirmSpy.mockRestore();
  });

  it('does not exit conflicts view if abort operation fails', async () => {
    const abortRepositoryOperation = vi.fn().mockResolvedValue(false);
    const backToHistory = vi.fn();
    const confirmSpy = vi.spyOn(dialogService, 'confirmDialog').mockResolvedValue(true);

    useAppStore.setState({
      conflicts: [],
      snapshot: {
        workspace: { id: 'w1', name: 'Workspace', paths: ['/path'], lastOpenedAt: '', available: true },
        generation: 1,
        tools: { git: true, svn: true, svnadmin: true },
        repositories: [
          {
            meta: { id: 'repo-rebase-fail', name: 'my-service', rootPath: '/path', color: '#ff0000', kind: 'git', depth: 0, isSubmodule: false, isWorktree: false, parentRepoId: null },
            branch: 'feature',
            revision: '123456',
            ahead: 0,
            behind: 0,
            files: [],
            conflicts: 0,
            operation: 'rebase',
          },
        ],
      },
      abortRepositoryOperation,
      backToHistory,
    });

    render(<ConflictsWorkspace />);

    const abortBtn = screen.getByRole('button', { name: 'Abort Rebase' });
    expect(abortBtn).toBeInTheDocument();

    fireEvent.click(abortBtn);
    await waitFor(() => {
      expect(abortRepositoryOperation).toHaveBeenCalledWith('repo-rebase-fail', 'rebase');
    });
    expect(backToHistory).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('does not render abort button in header bar while viewing conflict files', () => {
    useAppStore.setState({
      conflicts: [mockConflict],
      snapshot: {
        workspace: { id: 'w1', name: 'Workspace', paths: ['/path'], lastOpenedAt: '', available: true },
        generation: 1,
        tools: { git: true, svn: true, svnadmin: true },
        repositories: [
          {
            meta: { id: 'repo-1', name: 'SERVICE-AUTH', rootPath: '/path', color: '#ff0000', kind: 'git', depth: 0, isSubmodule: false, isWorktree: false, parentRepoId: null },
            branch: 'feature',
            revision: '123456',
            ahead: 0,
            behind: 0,
            files: [],
            conflicts: 1,
            operation: 'merge',
          },
        ],
      },
    });

    render(<ConflictsWorkspace />);

    // 验证顶部导航栏没有中止操作按钮
    expect(document.querySelector('.conflicts-abort-header-btn')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Abort/ })).not.toBeInTheDocument();
  });
});
