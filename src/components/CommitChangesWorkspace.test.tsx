import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommitChangesWorkspace } from './CommitChangesWorkspace';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';

const repository: RepositoryStatus = { meta: { id: 'repo', name: 'Repository', rootPath: '/tmp/repo', color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc', ahead: 0, behind: 0, conflicts: 0, operation: null, files: [{ path: 'both.txt', status: 'modified', staged: true, unstaged: true, conflicted: false }, { path: 'new.txt', status: 'untracked', staged: false, unstaged: true, conflicted: false }] };
const snapshot: WorkspaceSnapshot = { workspace: { id: 'workspace', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true }, generation: 1, tools: { git: true, svn: true, svnadmin: true }, repositories: [repository] };

afterEach(() => { cleanup(); useAppStore.setState({ bridge: undefined, snapshot: undefined, changes: undefined, changesDiff: undefined, mode: 'history' }); });

describe('working tree changes workspace', () => {
  it('groups staged, unstaged, and untracked entries and requests the correct diff side', async () => {
    const requests: boolean[] = [];
    const bridge = new MockBridge((command) => {
      if (command.type === 'fileDiff') { requests.push(command.payload.staged); return { path: command.payload.relative_path, content: 'diff', language: 'text', binary: false, truncated: false, lineCount: 1 }; }
      return true;
    });
    useAppStore.setState({ bridge, snapshot, allRepositories: [repository], selectedRepoId: 'repo' });
    useAppStore.getState().openWorkingChanges('repo');
    render(<CommitChangesWorkspace />);
    expect(screen.getByText('Staged Changes')).toBeInTheDocument();
    expect(screen.getByText('Unstaged Changes')).toBeInTheDocument();
    expect(screen.getByText('Untracked Files')).toBeInTheDocument();
    await waitFor(() => expect(requests[0]).toBe(true));
    fireEvent.click(screen.getAllByText('both.txt')[1]);
    await waitFor(() => expect(requests).toContain(false));
  });

  it('issues only one diff request when switching to another changed file', async () => {
    const diffRequests: Array<{ path: string; staged: boolean }> = [];
    const bridge = new MockBridge((command) => {
      if (command.type === 'fileDiff') {
        diffRequests.push({ path: command.payload.relative_path, staged: command.payload.staged });
        return {
          path: command.payload.relative_path,
          content: '@@ -1,1 +1,1 @@\n-line\n+line',
          language: 'text',
          binary: false,
          truncated: false,
          lineCount: 1,
        };
      }
      return true;
    });

    useAppStore.setState({ bridge, snapshot, allRepositories: [repository], selectedRepoId: 'repo' });
    useAppStore.getState().openWorkingChanges('repo');
    render(<CommitChangesWorkspace />);

    // 初始首项加载完毕，只发起 1 次请求
    await waitFor(() => {
      expect(diffRequests).toHaveLength(1);
      expect(diffRequests[0]).toEqual({ path: 'both.txt', staged: true });
    });

    // 切换到未跟踪文件 new.txt
    fireEvent.click(screen.getByRole('button', { name: 'new.txt' }));

    // 等待请求记录更新，确保只发起 1 次针对 new.txt 的请求，累计恰好 2 次请求（无重复加载）
    await waitFor(() => {
      expect(diffRequests).toHaveLength(2);
      expect(diffRequests[1]).toEqual({ path: 'new.txt', staged: false });
    });

    // 再次点击已经选中的 new.txt，不应发起重复的额外请求
    fireEvent.click(screen.getByRole('button', { name: 'new.txt' }));
    expect(diffRequests).toHaveLength(2);
  });

  it('clears previous diff immediately and shows loading placeholder when switching files', async () => {
    let resolveSecondDiff: ((value: any) => void) | undefined;
    const secondDiffPromise = new Promise((resolve) => {
      resolveSecondDiff = resolve;
    });

    const bridge = new MockBridge((command) => {
      if (command.type === 'fileDiff') {
        if (command.payload.relative_path === 'both.txt') {
          return {
            path: 'both.txt',
            content: '@@ -1,1 +1,1 @@\n-old line\n+new line',
            language: 'text',
            binary: false,
            truncated: false,
            lineCount: 2,
          };
        }
        if (command.payload.relative_path === 'new.txt') {
          return secondDiffPromise;
        }
      }
      return true;
    });

    useAppStore.setState({ bridge, snapshot, allRepositories: [repository], selectedRepoId: 'repo' });
    useAppStore.getState().openWorkingChanges('repo');
    render(<CommitChangesWorkspace />);

    // 第一个文件 both.txt 差异加载完成并渲染
    await waitFor(() => {
      expect(screen.getByText((_, el) => el?.tagName.toLowerCase() === 'code' && el.textContent === 'old line')).toBeInTheDocument();
    });

    // 切换到 new.txt
    fireEvent.click(screen.getByRole('button', { name: 'new.txt' }));

    // 立即显示 loading，旧文件的差异内容被立刻卸载
    expect(screen.getByText('Loading diff...')).toBeInTheDocument();
    expect(screen.queryByText((_, el) => el?.tagName.toLowerCase() === 'code' && el.textContent === 'old line')).not.toBeInTheDocument();

    // 延迟 resolve 第二个文件的差异
    resolveSecondDiff!({
      path: 'new.txt',
      content: '@@ -0,0 +1,1 @@\n+untracked file content',
      language: 'text',
      binary: false,
      truncated: false,
      lineCount: 1,
    });

    await waitFor(() => {
      expect(screen.getByText((_, el) => el?.tagName.toLowerCase() === 'code' && el.textContent === 'untracked file content')).toBeInTheDocument();
      expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
    });
  });

  it('shows error placeholder and retry button when diff loading fails, and retries successfully', async () => {
    let shouldFail = true;
    const bridge = new MockBridge((command) => {
      if (command.type === 'fileDiff') {
        if (shouldFail) {
          throw new Error('Network timeout');
        }
        return {
          path: command.payload.relative_path,
          content: '@@ -1,1 +1,1 @@\n-failed\n+recovered',
          language: 'text',
          binary: false,
          truncated: false,
          lineCount: 2,
        };
      }
      return true;
    });

    useAppStore.setState({ bridge, snapshot, allRepositories: [repository], selectedRepoId: 'repo' });
    useAppStore.getState().openWorkingChanges('repo');
    render(<CommitChangesWorkspace />);

    // 初始加载失败，展示错误占位符与重试按钮
    await waitFor(() => {
      expect(screen.getByText('Network timeout')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
    });

    // 修复网络并点击重试
    shouldFail = false;
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));

    // 成功恢复并展示差异内容
    await waitFor(() => {
      expect(screen.getByText((_, el) => el?.tagName.toLowerCase() === 'code' && el.textContent === 'recovered')).toBeInTheDocument();
      expect(screen.queryByText('Network timeout')).not.toBeInTheDocument();
    });
  });
});
