import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommitDetailPanel } from './CommitDetailPanel';
import { DialogHost } from './DialogHost';
import { publishDialog } from './dialogService';
import { useAppStore } from '../store/appStore';
import { commitKey } from '../history/commitDetails';
import { createTranslator, I18nContext } from '../i18n';
import type { CommitDetail, CommitNode, WorkspaceSnapshot } from '../bindings/generated';

const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'workspace', name: 'Test', paths: ['/tmp/test'], lastOpenedAt: '', available: true },
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
  repositories: [{
    meta: { id: 'repo-1', name: 'Repo 1', rootPath: '/tmp/test', color: '#4EC9B0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
    branch: 'main', revision: 'merge1234', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
  }],
};

const mergeCommit: CommitNode = {
  repoId: 'repo-1',
  hash: 'merge1234567890',
  shortHash: 'merge12',
  parents: ['parent11111111', 'parent22222222'],
  author: 'Alice',
  email: 'alice@example.test',
  authorDate: '2026-08-16T10:00:00Z',
  committerDate: '2026-08-16T10:00:00Z',
  message: 'Merge branch feature into main',
  refs: ['HEAD -> main'],
};

const mergeDetail: CommitDetail = {
  commit: mergeCommit,
  fullMessage: 'Merge branch feature into main\n\nDetailed merge description',
  files: [],
  branches: { local: ['main'], remote: ['origin/main'], tags: [] },
  mergeParentChanges: [
    {
      hash: 'parent11111111',
      shortHash: 'parent1',
      message: 'fix: something on main',
      authorName: 'Bob',
      authorDate: '2026-08-15T12:00:00Z',
      parentIndex: 0,
      fileCount: 2,
    },
    {
      hash: 'parent22222222',
      shortHash: 'parent2',
      message: 'feat: add new feature',
      authorName: 'Charlie',
      authorDate: '2026-08-15T14:00:00Z',
      parentIndex: 1,
      fileCount: 1,
    },
  ],
};

const directoryCommit: CommitNode = {
  ...mergeCommit,
  hash: 'directory1234567890',
  shortHash: 'director',
  parents: ['directory-parent'],
  message: 'feat: directory actions',
};

const directoryDetail: CommitDetail = {
  commit: directoryCommit,
  fullMessage: directoryCommit.message,
  branches: { local: ['main'], remote: [], tags: [] },
  files: [
    { path: 'src/alpha.ts', status: 'M', added: 2, removed: 1 },
    { path: 'src/nested/beta.ts', status: 'A', added: 4, removed: 0 },
    { path: 'README.md', status: 'M', added: 1, removed: 1 },
  ],
};

const originalHistoryOperation = useAppStore.getState().historyOperation;

afterEach(() => {
  cleanup();
  for (const key of Object.keys(localStorage)) if (key.startsWith('versiondock:detailView:')) localStorage.removeItem(key);
  publishDialog(undefined);
  localStorage.removeItem('versiondock:commitMessagesExpandedByDefault');
  useAppStore.setState({
    snapshot: undefined,
    selectedCommit: undefined,
    selectedCommits: [],
    selectedCommitDetails: {},
    selectedCommitLoading: {},
    selectedCommitError: {},
    mergeParentFiles: {},
    mergeParentFilesLoading: {},
    mergeParentFilesError: {},
    historyOperation: originalHistoryOperation,
    historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null },
    mode: 'history',
  });
});

describe('CommitDetailPanel merge commits', () => {
  it.each([
    ['zh-CN', '折叠提交详情'],
    ['en', 'Collapse commit detail'],
  ] as const)('localizes the collapse button in %s and preserves its action', (language, label) => {
    useAppStore.setState({ snapshot, selectedCommit: mergeDetail, selectedCommits: [mergeCommit] });
    const onCollapse = vi.fn();
    render(<I18nContext.Provider value={{ language, preference: language === 'zh-CN' ? 'zhCn' : 'en', t: createTranslator(language) }}>
      <CommitDetailPanel onCollapse={onCollapse} />
    </I18nContext.Provider>);
    const button = screen.getByRole('button', { name: label });
    expect(button).toHaveAttribute('title', label);
    fireEvent.click(button);
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it('shows HEAD explicitly and excludes symbolic remote HEAD references', () => {
    const detail: CommitDetail = {
      ...mergeDetail,
      branches: { local: ['main', 'feature/ui', 'zeta'], remote: ['origin/main', 'origin/HEAD'], tags: ['v1.0.0'], isHead: true },
    };
    useAppStore.setState({
      snapshot,
      selectedCommit: detail,
      selectedCommits: [mergeCommit],
      selectedCommitDetails: { [commitKey(mergeCommit.repoId, mergeCommit.hash)]: detail },
    });
    const { container } = render(<CommitDetailPanel onCollapse={vi.fn()} />);
    const labels = [...container.querySelectorAll('.detail-refs em')].map((element) => element.textContent);
    expect(labels[0]).toBe('HEAD');
    expect(labels).toContain('main');
    expect(labels).toContain('origin/main');
    expect(labels).not.toContain('origin/HEAD');
    fireEvent.click(screen.getByRole('button', { name: '+1 more' }));
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('shows loading instead of a failure before detail data arrives and renders genuine failures with retry', () => {
    const key = commitKey(directoryCommit.repoId, directoryCommit.hash);
    useAppStore.setState({ snapshot, selectedCommit: undefined, selectedCommits: [directoryCommit], selectedCommitDetails: {}, selectedCommitLoading: {}, selectedCommitError: {} });
    render(<CommitDetailPanel onCollapse={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading...');
    expect(screen.queryByText('Failed to load commit details')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    act(() => useAppStore.setState({ selectedCommitLoading: { [key]: true } }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading...');
    act(() => useAppStore.setState({ selectedCommit: directoryDetail, selectedCommitDetails: { [key]: directoryDetail }, selectedCommitLoading: {} }));
    expect(screen.getByText('alpha.ts')).toBeInTheDocument();
    act(() => useAppStore.setState({ selectedCommit: undefined, selectedCommitDetails: {}, selectedCommitError: { [key]: 'Cannot read this commit' } }));
    expect(screen.getByText('Cannot read this commit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveClass('detail-retry-button');
  });

  it('keeps the selected detail visible while an unrelated hover preview loads', () => {
    useAppStore.setState({
      snapshot,
      selectedCommit: directoryDetail,
      selectedCommits: [directoryCommit],
      selectedCommitDetails: { [commitKey(directoryCommit.repoId, directoryCommit.hash)]: directoryDetail },
      selectedCommitLoading: {},
    });
    render(<CommitDetailPanel onCollapse={vi.fn()} />);
    expect(screen.getByText('alpha.ts')).toBeInTheDocument();

    useAppStore.setState({ selectedCommitLoading: { 'repo-1:hover-preview': true } });

    expect(screen.getByText('alpha.ts')).toBeInTheDocument();
    expect(screen.queryByText('Loading files...')).not.toBeInTheDocument();
  });

  it('shows only restore and cherry-pick actions on directories and applies every descendant file', async () => {
    const historyOperation = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      snapshot: { ...snapshot, repositories: [...snapshot.repositories, { ...snapshot.repositories[0], meta: { ...snapshot.repositories[0].meta, id: 'repo-2', name: 'Repo 2' } }] },
      selectedCommit: directoryDetail,
      selectedCommits: [directoryCommit],
      selectedCommitDetails: { [commitKey(directoryCommit.repoId, directoryCommit.hash)]: directoryDetail },
      historyOperation,
    });

    render(<><CommitDetailPanel onCollapse={vi.fn()} /><DialogHost /></>);

    fireEvent.contextMenu(screen.getByTitle('src'));
    expect(screen.getByText('Revert Selected Changes')).toBeInTheDocument();
    expect(screen.getByText('Cherry-Pick Selected Changes')).toBeInTheDocument();
    expect(screen.queryByText('Show Diff')).not.toBeInTheDocument();
    expect(screen.queryByText('Open file')).not.toBeInTheDocument();
    expect(screen.queryByText('File history')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Revert Selected Changes'));
    expect(screen.getByRole('dialog')).toHaveTextContent('2 files');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(historyOperation).toHaveBeenCalledWith('repo-1', {
      type: 'revertPaths',
      entries: [
        { revision: directoryCommit.hash, path: 'src/alpha.ts', status: 'M' },
        { revision: directoryCommit.hash, path: 'src/nested/beta.ts', status: 'A' },
      ],
    }));

    fireEvent.contextMenu(screen.getByTitle('Repo 1'));
    expect(screen.queryByText('Show Diff')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Cherry-Pick Selected Changes'));
    expect(screen.getByRole('dialog')).toHaveTextContent('3 files');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(historyOperation).toHaveBeenLastCalledWith('repo-1', {
      type: 'applyPaths',
      entries: [
        { revision: directoryCommit.hash, path: 'src/alpha.ts', status: 'M' },
        { revision: directoryCommit.hash, path: 'src/nested/beta.ts', status: 'A' },
        { revision: directoryCommit.hash, path: 'README.md', status: 'M' },
      ],
    }));
  });

  it('opens the commit-detail workspace instead of previewing the first changed file', () => {
    useAppStore.setState({
      snapshot,
      selectedCommit: mergeDetail,
      selectedCommits: [mergeCommit],
      selectedCommitDetails: { 'repo-1:merge1234567890': mergeDetail },
      mode: 'history',
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    expect(screen.queryByTitle('Open preview')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Open Commit Detail'));
    expect(useAppStore.getState().mode).toBe('commit-detail');
  });

  it('renders "No merge conflicts" and merge parent change groups for merge commits with empty combined diff', () => {
    useAppStore.setState({
      snapshot,
      selectedCommit: mergeDetail,
      selectedCommits: [mergeCommit],
      selectedCommitDetails: { 'repo-1:merge1234567890': mergeDetail },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    expect(screen.getByText('No merge conflicts')).toBeInTheDocument();
    expect(screen.getByText('Changes from parent1')).toBeInTheDocument();
    expect(screen.getByText('fix: something on main')).toBeInTheDocument();
    expect(screen.getByText('2 files')).toBeInTheDocument();

    expect(screen.getByText('Changes from parent2')).toBeInTheDocument();
    expect(screen.getByText('feat: add new feature')).toBeInTheDocument();
    expect(screen.getByText('1 file')).toBeInTheDocument();
  });

  it('loads and renders parent files when expanding a merge parent change group, and opens diff with range', async () => {
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const loadMergeParentFiles = vi.fn().mockImplementation(async (_repoId, _rev, parentHash) => {
      const cacheKey = `repo-1\0merge1234567890\0${parentHash}`;
      const files = parentHash === 'parent22222222'
        ? [{ path: 'src/feature.ts', status: 'A', added: 10, removed: 0 }]
        : [{ path: 'src/main-fix.ts', status: 'M', added: 1, removed: 1 }];
      useAppStore.setState((state) => ({
        mergeParentFiles: { ...state.mergeParentFiles, [cacheKey]: files },
      }));
      return files;
    });

    useAppStore.setState({
      snapshot,
      selectedCommit: mergeDetail,
      selectedCommits: [mergeCommit],
      selectedCommitDetails: { 'repo-1:merge1234567890': mergeDetail },
      openDiff,
      loadMergeParentFiles,
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const parent2Row = screen.getByRole('button', { name: /Changes from parent2/ });
    fireEvent.click(parent2Row);

    expect(loadMergeParentFiles).toHaveBeenCalledWith('repo-1', 'merge1234567890', 'parent22222222');

    await waitFor(() => {
      expect(screen.getByText('feature.ts')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('feature.ts'));
    expect(openDiff).toHaveBeenCalledWith(
      'repo-1',
      'src/feature.ts',
      false,
      undefined,
      { fromRevision: 'parent22222222', toRevision: 'merge1234567890' },
    );
  });

  it('shows expand button and allows toggling for long subjects (>25 chars) even without body', () => {
    const longSubject = 'chore(quick-applications): 注释掉大模型 API 续期配置以简化代码结构';
    const longDetail: CommitDetail = {
      ...mergeDetail,
      commit: { ...mergeCommit, message: longSubject },
      fullMessage: longSubject,
    };
    useAppStore.setState({
      snapshot,
      selectedCommit: longDetail,
      selectedCommits: [longDetail.commit],
      selectedCommitDetails: { 'repo-1:merge1234567890': longDetail },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const expandBtn = screen.getByRole('button', { name: /Click to expand/ });
    expect(expandBtn).toBeInTheDocument();

    const titleEl = screen.getByText(longSubject);
    expect(titleEl).not.toHaveClass('expanded');

    fireEvent.click(expandBtn);
    expect(titleEl).toHaveClass('expanded');
    expect(screen.getByRole('button', { name: /Click to collapse/ })).toBeInTheDocument();
  });

  it('allows expanding a directory immediately on first click after collapse all', () => {
    useAppStore.setState({
      snapshot: { ...snapshot, repositories: [...snapshot.repositories, { ...snapshot.repositories[0], meta: { ...snapshot.repositories[0].meta, id: 'repo-2', name: 'Repo 2' } }] },
      selectedCommit: directoryDetail,
      selectedCommits: [directoryDetail.commit],
      selectedCommitDetails: { [commitKey('repo-1', directoryDetail.commit.hash)]: directoryDetail },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const collapseAllBtn = screen.getByTitle('Collapse all');
    fireEvent.click(collapseAllBtn);

    // 全部折叠后，仓库节点折叠；单击仓库行，仓库应立即展开
    const repoBtn = screen.getByTitle('Repo 1');
    fireEvent.click(repoBtn);

    // 此时子目录 src 仍处于折叠状态，子文件 alpha.ts 不可见
    expect(screen.queryByText('alpha.ts')).not.toBeInTheDocument();

    // 单击 src 目录，首次点击应立即展开并显示 alpha.ts
    const srcDirBtn = screen.getByTitle('src');
    fireEvent.click(srcDirBtn);

    expect(screen.getByText('alpha.ts')).toBeInTheDocument();
  });

  it('keeps revert and cherry-pick actions for single-occurrence files under multi-commit selection', () => {
    const commitA: CommitNode = { ...mergeCommit, hash: 'commit-a', shortHash: 'commita', parents: ['parent-a'] };
    const commitB: CommitNode = { ...mergeCommit, hash: 'commit-b', shortHash: 'commitb', parents: ['commit-a'] };
    const detailA: CommitDetail = {
      commit: commitA,
      fullMessage: 'commit a',
      branches: { local: [], remote: [], tags: [] },
      files: [{ path: 'only-in-a.ts', status: 'M', added: 1, removed: 0 }],
    };
    const detailB: CommitDetail = {
      commit: commitB,
      fullMessage: 'commit b',
      branches: { local: [], remote: [], tags: [] },
      files: [{ path: 'only-in-b.ts', status: 'M', added: 2, removed: 1 }],
    };
    useAppStore.setState({
      snapshot,
      selectedCommit: detailB,
      selectedCommits: [commitB, commitA],
      selectedCommitDetails: {
        [commitKey('repo-1', 'commit-b')]: detailB,
        [commitKey('repo-1', 'commit-a')]: detailA,
      },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const fileRow = screen.getByText('only-in-a.ts').closest('button');
    expect(fileRow).not.toBeNull();
    fireEvent.contextMenu(fileRow!);

    expect(screen.getByText('Revert Selected Changes')).toBeInTheDocument();
    expect(screen.getByText('Cherry-Pick Selected Changes')).toBeInTheDocument();
  });

  it('renders SVN HEAD and BASE revision badges with specific titles and versions icons', () => {
    const svnSnapshot: WorkspaceSnapshot = {
      ...snapshot,
      repositories: [{
        ...snapshot.repositories[0],
        meta: { ...snapshot.repositories[0].meta, id: 'svn-repo', kind: 'svn' },
      }],
    };
    const svnCommit: CommitNode = {
      repoId: 'svn-repo',
      hash: '123',
      shortHash: 'r123',
      parents: [],
      author: 'dev',
      email: '',
      authorDate: '2026-08-16T10:00:00Z',
      committerDate: '2026-08-16T10:00:00Z',
      message: 'svn commit',
      refs: ['HEAD', 'BASE'],
    };
    const svnDetail: CommitDetail = {
      commit: svnCommit,
      fullMessage: 'svn commit',
      branches: { local: ['HEAD', 'BASE'], remote: [], tags: [] },
      files: [{ path: 'file.txt', status: 'M', added: 1, removed: 1 }],
    };
    useAppStore.setState({
      snapshot: svnSnapshot,
      selectedCommit: svnDetail,
      selectedCommits: [svnCommit],
      selectedCommitDetails: { [commitKey('svn-repo', '123')]: svnDetail },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const headBadge = screen.getByTitle('SVN repository HEAD revision');
    const baseBadge = screen.getByTitle('SVN working copy BASE revision');
    expect(headBadge).toBeInTheDocument();
    expect(baseBadge).toBeInTheDocument();
    expect(headBadge).toHaveAttribute('data-ref-badge', 'revision');
    expect(baseBadge).toHaveAttribute('data-ref-badge', 'revision');
  });

  it('shows directory context menu on virtualized repo and directory rows (>40 items)', () => {
    const virtualFiles = Array.from({ length: 45 }, (_, i) => ({
      path: `src/file_${i}.ts`,
      status: 'M' as const,
      added: 1,
      removed: 1,
    }));
    const virtualCommit: CommitNode = {
      ...mergeCommit,
      hash: 'virtual1234567890',
      shortHash: 'virtual1',
    };
    const virtualDetail: CommitDetail = {
      commit: virtualCommit,
      fullMessage: 'feat: virtual list',
      branches: { local: ['main'], remote: [], tags: [] },
      files: virtualFiles,
    };
    useAppStore.setState({
      snapshot: { ...snapshot, repositories: [...snapshot.repositories, { ...snapshot.repositories[0], meta: { ...snapshot.repositories[0].meta, id: 'repo-2', name: 'Repo 2' } }] },
      selectedCommit: virtualDetail,
      selectedCommits: [virtualCommit],
      selectedCommitDetails: { [commitKey('repo-1', virtualCommit.hash)]: virtualDetail },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    // 虚拟模式下右键目录行
    const dirBtn = screen.getByTitle('src');
    fireEvent.contextMenu(dirBtn);
    expect(screen.getByText('Revert Selected Changes')).toBeInTheDocument();
    expect(screen.getByText('Cherry-Pick Selected Changes')).toBeInTheDocument();

    // 虚拟模式下右键仓库行
    const repoBtn = screen.getByTitle('Repo 1');
    fireEvent.contextMenu(repoBtn);
    expect(screen.getByText('Revert Selected Changes')).toBeInTheDocument();
    expect(screen.getByText('Cherry-Pick Selected Changes')).toBeInTheDocument();
  });

  it('isolates folder collapse state between repositories sharing the same folder name', () => {
    const multiRepoSnapshot: WorkspaceSnapshot = {
      ...snapshot,
      repositories: [
        snapshot.repositories[0],
        {
          ...snapshot.repositories[0],
          meta: { ...snapshot.repositories[0].meta, id: 'repo-2', name: 'Repo 2' },
        },
      ],
    };
    const commit1: CommitNode = {
      ...mergeCommit,
      repoId: 'repo-1',
      hash: 'hash-repo-1',
      shortHash: 'repo1',
    };
    const commit2: CommitNode = {
      ...mergeCommit,
      repoId: 'repo-2',
      hash: 'hash-repo-2',
      shortHash: 'repo2',
    };
    const detail1: CommitDetail = {
      commit: commit1,
      fullMessage: 'commit repo 1',
      branches: { local: ['main'], remote: [], tags: [] },
      files: [{ path: 'src/file-in-repo1.ts', status: 'M', added: 1, removed: 0 }],
    };
    const detail2: CommitDetail = {
      commit: commit2,
      fullMessage: 'commit repo 2',
      branches: { local: ['main'], remote: [], tags: [] },
      files: [{ path: 'src/file-in-repo2.ts', status: 'M', added: 1, removed: 0 }],
    };

    useAppStore.setState({
      snapshot: multiRepoSnapshot,
      selectedCommit: detail1,
      selectedCommits: [commit1, commit2],
      selectedCommitDetails: {
        [commitKey('repo-1', 'hash-repo-1')]: detail1,
        [commitKey('repo-2', 'hash-repo-2')]: detail2,
      },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    // 两处均有 src 目录
    const repo1Group = screen.getByTitle('Repo 1').closest<HTMLElement>('.detail-repo-group')!;
    const repo2Group = screen.getByTitle('Repo 2').closest<HTMLElement>('.detail-repo-group')!;

    expect(within(repo1Group).getByText('file-in-repo1.ts')).toBeInTheDocument();
    expect(within(repo2Group).getByText('file-in-repo2.ts')).toBeInTheDocument();

    // 点击折叠第一个仓库的 src 目录
    const repo1Src = within(repo1Group).getByTitle('src');
    fireEvent.click(repo1Src);

    // 第一个仓库下的文件被折叠隐藏
    expect(within(repo1Group).queryByText('file-in-repo1.ts')).not.toBeInTheDocument();
    // 第二个仓库下的同名 src 目录仍保持展开，其文件依然可见
    expect(within(repo2Group).getByText('file-in-repo2.ts')).toBeInTheDocument();
  });

  it('automatically expands collapsed repository and ancestor directories when searching', () => {
    useAppStore.setState({
      snapshot,
      selectedCommit: directoryDetail,
      selectedCommits: [directoryDetail.commit],
      selectedCommitDetails: { [commitKey('repo-1', directoryDetail.commit.hash)]: directoryDetail },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    // 点击全部折叠
    const collapseAllBtn = screen.getByTitle('Collapse all');
    fireEvent.click(collapseAllBtn);

    // 全部折叠后，alpha.ts 不可见
    expect(screen.queryByTitle(/src\/alpha\.ts/)).not.toBeInTheDocument();

    // 激活焦点以允许 SpeedSearch 监听按键
    collapseAllBtn.focus();

    // 触发 SpeedSearch 输入 'alpha'
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search files...' }), { target: { value: 'alpha' } });

    // 自动展开仓库行和 src 目录，alpha.ts 重新可见
    expect(screen.getByTitle(/src\/alpha\.ts/)).toBeInTheDocument();
  });

  it('renders badges correctly according to ref kinds without displaying remote branches or tags as local branches', () => {
    const gitCommit: CommitNode = {
      ...mergeCommit,
      hash: 'git123',
      shortHash: 'git123',
      refs: ['HEAD -> feature/ui', 'origin/main', 'tag: v1.0.0'],
    };
    const gitDetail: CommitDetail = {
      commit: gitCommit,
      fullMessage: 'git commit with refs',
      branches: { local: ['feature/ui'], remote: ['origin/main'], tags: ['v1.0.0'], isHead: true },
      files: [{ path: 'file.txt', status: 'M', added: 1, removed: 0 }],
    };
    useAppStore.setState({
      snapshot,
      selectedCommit: gitDetail,
      selectedCommits: [gitCommit],
      selectedCommitDetails: { [commitKey('repo-1', 'git123')]: gitDetail },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const headBadge = screen.getByText('HEAD');
    expect(headBadge.closest('[data-ref-badge="head"]')).toBeInTheDocument();

    const branchBadge = screen.getByText('feature/ui');
    expect(branchBadge.closest('[data-ref-badge="branch"]')).toBeInTheDocument();

    const remoteBadge = screen.getByText('origin/main');
    expect(remoteBadge.closest('[data-ref-badge="remote"]')).toBeInTheDocument();

    const tagBadge = screen.getByText('v1.0.0');
    expect(tagBadge.closest('[data-ref-badge="tag"]')).toBeInTheDocument();
  });

  it('renders SVN HEAD and BASE revision badges properly in multi-commit extended summary', () => {
    const svnSnapshot: WorkspaceSnapshot = {
      ...snapshot,
      repositories: [{
        ...snapshot.repositories[0],
        meta: { ...snapshot.repositories[0].meta, id: 'svn-repo', kind: 'svn' },
      }],
    };
    const svnCommit1: CommitNode = {
      repoId: 'svn-repo',
      hash: '102',
      shortHash: 'r102',
      parents: ['101'],
      author: 'dev',
      email: '',
      authorDate: '2026-08-16T12:00:00Z',
      committerDate: '2026-08-16T12:00:00Z',
      message: 'svn commit 102',
      refs: ['HEAD'],
    };
    const svnCommit2: CommitNode = {
      repoId: 'svn-repo',
      hash: '101',
      shortHash: 'r101',
      parents: [],
      author: 'dev',
      email: '',
      authorDate: '2026-08-16T11:00:00Z',
      committerDate: '2026-08-16T11:00:00Z',
      message: 'svn commit 101',
      refs: ['BASE'],
    };
    const svnDetail1: CommitDetail = {
      commit: svnCommit1,
      fullMessage: 'svn commit 102',
      branches: { local: ['HEAD'], remote: [], tags: [] },
      files: [{ path: 'file1.txt', status: 'M', added: 1, removed: 0 }],
    };
    const svnDetail2: CommitDetail = {
      commit: svnCommit2,
      fullMessage: 'svn commit 101',
      branches: { local: ['BASE'], remote: [], tags: [] },
      files: [{ path: 'file2.txt', status: 'M', added: 2, removed: 0 }],
    };

    useAppStore.setState({
      snapshot: svnSnapshot,
      selectedCommit: svnDetail1,
      selectedCommits: [svnCommit1, svnCommit2],
      selectedCommitDetails: {
        [commitKey('svn-repo', '102')]: svnDetail1,
        [commitKey('svn-repo', '101')]: svnDetail2,
      },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const headBadge = screen.getByTitle('SVN repository HEAD revision');
    const baseBadge = screen.getByTitle('SVN working copy BASE revision');
    expect(headBadge).toBeInTheDocument();
    expect(baseBadge).toBeInTheDocument();
    expect(headBadge).toHaveAttribute('data-ref-badge', 'revision');
    expect(baseBadge).toHaveAttribute('data-ref-badge', 'revision');
  });

  it('filters file list according to historyQuery.path in detail panel', () => {
    useAppStore.setState({
      snapshot,
      selectedCommit: directoryDetail,
      selectedCommits: [directoryCommit],
      selectedCommitDetails: { [commitKey(directoryCommit.repoId, directoryCommit.hash)]: directoryDetail },
      historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: 'src/alpha.ts', revision: null },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    expect(screen.getByText('alpha.ts')).toBeInTheDocument();
    expect(screen.queryByText('beta.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('README.md')).not.toBeInTheDocument();
  });

  it('displays speed search match counts and supports navigating between matches', () => {
    useAppStore.setState({
      snapshot,
      selectedCommit: directoryDetail,
      selectedCommits: [directoryCommit],
      selectedCommitDetails: { [commitKey(directoryCommit.repoId, directoryCommit.hash)]: directoryDetail },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const collapseAllBtn = screen.getByTitle('Collapse all');
    collapseAllBtn.focus();

    fireEvent.keyDown(window, { key: 't' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search files...' }), { target: { value: 'ts' } });

    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search files...' })).toHaveValue('ts');
    expect(screen.getByRole('search')).toHaveTextContent(/1\s*\/\s*2/);

    const nextBtn = screen.getByTitle('Next match');
    expect(nextBtn).toBeInTheDocument();

    fireEvent.click(nextBtn);
    expect(screen.getByText(/2\s*\/\s*2/)).toBeInTheDocument();

    const prevBtn = screen.getByTitle('Previous match');
    fireEvent.click(prevBtn);
    expect(screen.getByText(/1\s*\/\s*2/)).toBeInTheDocument();
  });

  it('isolates active match highlight between repositories with identical file paths', () => {
    const multiRepoSnapshot: WorkspaceSnapshot = {
      ...snapshot,
      repositories: [
        snapshot.repositories[0],
        {
          ...snapshot.repositories[0],
          meta: { ...snapshot.repositories[0].meta, id: 'repo-2', name: 'Repo 2' },
        },
      ],
    };
    const commit1: CommitNode = {
      ...mergeCommit,
      repoId: 'repo-1',
      hash: 'hash-repo-1',
      shortHash: 'repo1',
    };
    const commit2: CommitNode = {
      ...mergeCommit,
      repoId: 'repo-2',
      hash: 'hash-repo-2',
      shortHash: 'repo2',
    };
    const detail1: CommitDetail = {
      commit: commit1,
      fullMessage: 'commit in repo 1',
      branches: { local: ['main'], remote: [], tags: [] },
      files: [{ path: 'src/config.ts', status: 'M', added: 1, removed: 0 }],
    };
    const detail2: CommitDetail = {
      commit: commit2,
      fullMessage: 'commit in repo 2',
      branches: { local: ['main'], remote: [], tags: [] },
      files: [{ path: 'src/config.ts', status: 'M', added: 2, removed: 0 }],
    };

    useAppStore.setState({
      snapshot: multiRepoSnapshot,
      selectedCommit: detail1,
      selectedCommits: [commit1, commit2],
      selectedCommitDetails: {
        [commitKey('repo-1', 'hash-repo-1')]: detail1,
        [commitKey('repo-2', 'hash-repo-2')]: detail2,
      },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const collapseAllBtn = screen.getByTitle('Collapse all');
    collapseAllBtn.focus();
    fireEvent.keyDown(window, { key: 'c' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search files...' }), { target: { value: 'con' } });

    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('search')).toHaveTextContent(/1\s*\/\s*2/);

    const repo1Row = document.querySelector('[data-detail-repo-id="repo-1"][data-detail-path="src/config.ts"]');
    const repo2Row = document.querySelector('[data-detail-repo-id="repo-2"][data-detail-path="src/config.ts"]');
    expect(repo1Row).toBeInTheDocument();
    expect(repo2Row).toBeInTheDocument();

    const isRepo1First = repo1Row?.classList.contains('is-active-match');
    const isRepo2First = repo2Row?.classList.contains('is-active-match');
    expect(isRepo1First !== isRepo2First).toBe(true);

    fireEvent.click(screen.getByTitle('Next match'));
    expect(screen.getByRole('search')).toHaveTextContent(/2\s*\/\s*2/);

    expect(repo1Row?.classList.contains('is-active-match')).toBe(!isRepo1First);
    expect(repo2Row?.classList.contains('is-active-match')).toBe(!isRepo2First);
  });

  it('scrolls and activates matches outside visible range in virtualized list', () => {
    const virtualFiles = Array.from({ length: 60 }, (_, i) => ({
      path: `src/item_${i.toString().padStart(2, '0')}.ts`,
      status: 'M' as const,
      added: 1,
      removed: 1,
    }));
    const virtualCommit: CommitNode = {
      ...mergeCommit,
      hash: 'virtual-search-hash',
      shortHash: 'virt1',
    };
    const virtualDetail: CommitDetail = {
      commit: virtualCommit,
      fullMessage: 'feat: virtual list search test',
      branches: { local: ['main'], remote: [], tags: [] },
      files: virtualFiles,
    };

    useAppStore.setState({
      snapshot,
      selectedCommit: virtualDetail,
      selectedCommits: [virtualCommit],
      selectedCommitDetails: { [commitKey('repo-1', virtualCommit.hash)]: virtualDetail },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const collapseAllBtn = screen.getByTitle('Collapse all');
    collapseAllBtn.focus();
    fireEvent.keyDown(window, { key: 'i' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search files...' }), { target: { value: 'item_5' } });

    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('search')).toHaveTextContent(/1\s*\/\s*10/);

    const nextBtn = screen.getByTitle('Next match');
    fireEvent.click(nextBtn);
    expect(screen.getByRole('search')).toHaveTextContent(/2\s*\/\s*10/);

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(screen.getByRole('search')).toHaveTextContent(/3\s*\/\s*10/);
  });

  it('incorporates expanded merge parent change files into speed search and matches navigation', async () => {
    const parentCommitHash = 'parent-hash-abc';
    const mergeCommitWithParents: CommitNode = {
      ...mergeCommit,
      hash: 'merge-head-123',
      shortHash: 'merge123',
      parents: [parentCommitHash, 'parent-hash-def'],
    };
    const mergeDetail: CommitDetail = {
      commit: mergeCommitWithParents,
      fullMessage: 'merge branch feat into main',
      branches: { local: ['main'], remote: [], tags: [] },
      files: [{ path: 'main-file.ts', status: 'M', added: 1, removed: 0 }],
      mergeParentChanges: [
        {
          hash: parentCommitHash,
          shortHash: 'abc1234',
          authorName: 'Alice',
          authorDate: '2026-08-16T12:00:00Z',
          parentIndex: 0,
          message: 'feat: add parent unique file',
          fileCount: 1,
        },
      ],
    };

    const parentFiles = [
      { path: 'src/parent-unique.ts', status: 'A' as const, added: 10, removed: 0 },
    ];
    const parentCacheKey = `repo-1\0${mergeCommitWithParents.hash}\0${parentCommitHash}`;

    useAppStore.setState({
      snapshot,
      selectedCommit: mergeDetail,
      selectedCommits: [mergeCommitWithParents],
      selectedCommitDetails: { [commitKey('repo-1', mergeCommitWithParents.hash)]: mergeDetail },
      mergeParentFiles: { [parentCacheKey]: parentFiles },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const treeViewBtn = screen.getByTitle('Tree view');
    treeViewBtn.focus();

    // 展开父提交组
    const parentGroupBtn = screen.getByText(/Changes from abc1234/).closest('button');
    expect(parentGroupBtn).toBeInTheDocument();
    fireEvent.click(parentGroupBtn!);

    fireEvent.keyDown(window, { key: 'u' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search files...' }), { target: { value: 'uniq' } });

    // 搜索 parent-unique，匹配变为 1/1
    expect(screen.getByRole('search')).toHaveTextContent(/1\s*\/\s*1/);
    expect(screen.getByTitle(/parent-unique\.ts/)).toBeInTheDocument();

    const matchedRow = document.querySelector(`[data-detail-path="src/parent-unique.ts"][data-detail-from-revision="${parentCommitHash}"]`);
    expect(matchedRow).toBeInTheDocument();
    expect(matchedRow).toHaveClass('is-active-match');
  });

  it('searches cached merge parent files even when collapsed and auto-expands/restores matching group', () => {
    const parentCommitHash = 'parent-hash-xyz';
    const mergeCommitWithParents: CommitNode = {
      ...mergeCommit,
      hash: 'merge-head-456',
      shortHash: 'merge456',
      parents: [parentCommitHash, 'parent-hash-other'],
    };
    const mergeDetail: CommitDetail = {
      commit: mergeCommitWithParents,
      fullMessage: 'merge branch feat into main',
      branches: { local: ['main'], remote: [], tags: [] },
      files: [{ path: 'main-entry.ts', status: 'M', added: 1, removed: 0 }],
      mergeParentChanges: [
        {
          hash: parentCommitHash,
          shortHash: 'xyz7890',
          authorName: 'Bob',
          authorDate: '2026-08-16T12:00:00Z',
          parentIndex: 0,
          message: 'feat: add cached feature file',
          fileCount: 1,
        },
      ],
    };

    const parentFiles = [
      { path: 'src/cached-feature.ts', status: 'A' as const, added: 5, removed: 0 },
    ];
    const parentCacheKey = `repo-1\0${mergeCommitWithParents.hash}\0${parentCommitHash}`;

    useAppStore.setState({
      snapshot,
      selectedCommit: mergeDetail,
      selectedCommits: [mergeCommitWithParents],
      selectedCommitDetails: { [commitKey('repo-1', mergeCommitWithParents.hash)]: mergeDetail },
      mergeParentFiles: { [parentCacheKey]: parentFiles },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    // 初始状态下分组处于折叠状态，cached-feature.ts 不可见
    expect(screen.queryByTitle(/cached-feature\.ts/)).not.toBeInTheDocument();

    const treeViewBtn = screen.getByTitle('Tree view');
    treeViewBtn.focus();

    // 搜索折叠分组中的缓存文件
    fireEvent.keyDown(window, { key: 'c' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search files...' }), { target: { value: 'cach' } });

    // 搜索成功匹配，且自动展开了该父提交分组
    expect(screen.getByRole('search')).toHaveTextContent(/1\s*\/\s*1/);
    expect(screen.getByTitle(/cached-feature\.ts/)).toBeInTheDocument();

    const matchedRow = document.querySelector(`[data-detail-path="src/cached-feature.ts"][data-detail-from-revision="${parentCommitHash}"]`);
    expect(matchedRow).toBeInTheDocument();
    expect(matchedRow).toHaveClass('is-active-match');

    // 清除搜索后，分组自动收起
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTitle(/cached-feature\.ts/)).not.toBeInTheDocument();
  });

  it('shows retry button on merge parent file loading failure and avoids infinite automatic retries', async () => {
    const parentCommitHash = 'parent-hash-fail';
    const mergeCommitWithParents: CommitNode = {
      ...mergeCommit,
      hash: 'merge-head-fail',
      shortHash: 'mergefail',
      parents: [parentCommitHash, 'parent-hash-other'],
    };
    const mergeDetail: CommitDetail = {
      commit: mergeCommitWithParents,
      fullMessage: 'merge branch feat into main',
      branches: { local: ['main'], remote: [], tags: [] },
      files: [{ path: 'main-file.ts', status: 'M', added: 1, removed: 0 }],
      mergeParentChanges: [
        {
          hash: parentCommitHash,
          shortHash: 'fail1234',
          authorName: 'Charlie',
          authorDate: '2026-08-16T12:00:00Z',
          parentIndex: 0,
          message: 'feat: add file that fails initially',
          fileCount: 1,
        },
      ],
    };

    let requestCount = 0;
    let shouldFail = true;
    const loadMergeParentFiles = vi.fn().mockImplementation(async (repoId: string, revision: string, parentHash: string) => {
      requestCount += 1;
      const key = `${repoId}\0${revision}\0${parentHash}`;
      if (shouldFail) {
        useAppStore.setState((state) => ({
          mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: false },
          mergeParentFilesError: { ...state.mergeParentFilesError, [key]: 'Network timeout' },
        }));
        throw new Error('Network timeout');
      }
      const files = [{ path: 'src/recovered.ts', status: 'A' as const, added: 3, removed: 0 }];
      useAppStore.setState((state) => ({
        mergeParentFiles: { ...state.mergeParentFiles, [key]: files },
        mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: false },
        mergeParentFilesError: { ...state.mergeParentFilesError, [key]: '' },
      }));
      return files;
    });

    useAppStore.setState({
      snapshot,
      selectedCommit: mergeDetail,
      selectedCommits: [mergeCommitWithParents],
      selectedCommitDetails: { [commitKey('repo-1', mergeCommitWithParents.hash)]: mergeDetail },
      mergeParentFiles: {},
      mergeParentFilesLoading: {},
      mergeParentFilesError: {},
      loadMergeParentFiles,
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    // 点击展开父提交分组，触发初次加载
    const parentGroupBtn = screen.getByText(/Changes from fail1234/).closest('button');
    expect(parentGroupBtn).toBeInTheDocument();
    fireEvent.click(parentGroupBtn!);

    // 等待异步请求完成并触发错误提示
    await waitFor(() => {
      expect(screen.getByText('Failed to load files')).toBeInTheDocument();
    });

    const retryBtn = screen.getByText('Retry');
    expect(retryBtn).toBeInTheDocument();

    // 验证请求只发起了一次，没有无限自动重试
    expect(requestCount).toBe(1);

    // 允许成功并点击重试
    shouldFail = false;
    fireEvent.click(retryBtn);

    // 重试后发起第二次请求并成功渲染文件列表
    await waitFor(() => {
      expect(screen.getByTitle(/recovered\.ts/)).toBeInTheDocument();
    });
    expect(requestCount).toBe(2);
  });

  it('prefetches uncached merge parent files when opening search and auto-expands on match', async () => {
    const parentCommitHash = 'parent-hash-prefetch';
    const mergeCommitWithParents: CommitNode = {
      ...mergeCommit,
      hash: 'merge-head-prefetch',
      shortHash: 'mergeprefetch',
      parents: [parentCommitHash, 'parent-hash-other'],
    };
    const mergeDetail: CommitDetail = {
      commit: mergeCommitWithParents,
      fullMessage: 'merge feature branch into main',
      branches: { local: ['main'], remote: [], tags: [] },
      files: [{ path: 'entry.ts', status: 'M', added: 1, removed: 0 }],
      mergeParentChanges: [
        {
          hash: parentCommitHash,
          shortHash: 'pref1234',
          authorName: 'David',
          authorDate: '2026-08-16T12:00:00Z',
          parentIndex: 0,
          message: 'feat: add uncached file to parent',
          fileCount: 1,
        },
      ],
    };

    const parentFiles = [
      { path: 'src/prefetched-feature.ts', status: 'A' as const, added: 4, removed: 0 },
    ];

    let prefetchCallCount = 0;
    const loadMergeParentFiles = vi.fn().mockImplementation(async (repoId: string, revision: string, parentHash: string) => {
      prefetchCallCount += 1;
      const key = `${repoId}\0${revision}\0${parentHash}`;
      useAppStore.setState((state) => ({
        mergeParentFiles: { ...state.mergeParentFiles, [key]: parentFiles },
        mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: false },
        mergeParentFilesError: { ...state.mergeParentFilesError, [key]: '' },
      }));
      return parentFiles;
    });

    useAppStore.setState({
      snapshot,
      selectedCommit: mergeDetail,
      selectedCommits: [mergeCommitWithParents],
      selectedCommitDetails: { [commitKey('repo-1', mergeCommitWithParents.hash)]: mergeDetail },
      mergeParentFiles: {},
      mergeParentFilesLoading: {},
      mergeParentFilesError: {},
      loadMergeParentFiles,
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    // 初始状态下未展开也未缓存
    expect(screen.queryByTitle(/prefetched-feature\.ts/)).not.toBeInTheDocument();
    expect(prefetchCallCount).toBe(0);

    const treeViewBtn = screen.getByTitle('Tree view');
    treeViewBtn.focus();

    // 键入开启搜索，触发预取
    fireEvent.keyDown(window, { key: 'p' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search files...' }), { target: { value: 'pref' } });

    // 验证触发了对尚未缓存父提交文件的预取
    expect(loadMergeParentFiles).toHaveBeenCalledWith('repo-1', mergeCommitWithParents.hash, parentCommitHash);
    expect(prefetchCallCount).toBe(1);

    // 异步加载完成后，匹配项自动展开并高亮
    await waitFor(() => {
      expect(screen.getByRole('search')).toHaveTextContent(/1\s*\/\s*1/);
      expect(screen.getByTitle(/prefetched-feature\.ts/)).toBeInTheDocument();
      const matchedRow = document.querySelector(`[data-detail-path="src/prefetched-feature.ts"][data-detail-from-revision="${parentCommitHash}"]`);
      expect(matchedRow).toBeInTheDocument();
      expect(matchedRow).toHaveClass('is-active-match');
    });

    // 退出搜索后，分组自动收起
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTitle(/prefetched-feature\.ts/)).not.toBeInTheDocument();
  });

  it('does not infinitely retry prefetching parent files when prefetch fails during search', async () => {
    const parentCommitHash = 'parent-hash-search-fail';
    const mergeCommitWithParents: CommitNode = {
      ...mergeCommit,
      hash: 'merge-head-search-fail',
      shortHash: 'mergesearchfail',
      parents: [parentCommitHash, 'parent-hash-other'],
    };
    const mergeDetail: CommitDetail = {
      commit: mergeCommitWithParents,
      fullMessage: 'merge feature branch into main',
      branches: { local: ['main'], remote: [], tags: [] },
      files: [{ path: 'entry.ts', status: 'M', added: 1, removed: 0 }],
      mergeParentChanges: [
        {
          hash: parentCommitHash,
          shortHash: 'failsearch',
          authorName: 'Eve',
          authorDate: '2026-08-16T12:00:00Z',
          parentIndex: 0,
          message: 'feat: will fail to load',
          fileCount: 1,
        },
      ],
    };

    let callCount = 0;
    const loadMergeParentFiles = vi.fn().mockImplementation(async (repoId: string, revision: string, parentHash: string) => {
      callCount += 1;
      const key = `${repoId}\0${revision}\0${parentHash}`;
      useAppStore.setState((state) => ({
        mergeParentFilesLoading: { ...state.mergeParentFilesLoading, [key]: false },
        mergeParentFilesError: { ...state.mergeParentFilesError, [key]: 'Prefetch failed' },
      }));
      throw new Error('Prefetch failed');
    });

    useAppStore.setState({
      snapshot,
      selectedCommit: mergeDetail,
      selectedCommits: [mergeCommitWithParents],
      selectedCommitDetails: { [commitKey('repo-1', mergeCommitWithParents.hash)]: mergeDetail },
      mergeParentFiles: {},
      mergeParentFilesLoading: {},
      mergeParentFilesError: {},
      loadMergeParentFiles,
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const treeViewBtn = screen.getByTitle('Tree view');
    treeViewBtn.focus();

    // 第一次键入搜索，触发预取并失败
    fireEvent.keyDown(window, { key: 'a' });
    expect(callCount).toBe(1);

    // 继续键入其他字符，不应重复重试失败的预取
    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search files...' }), { target: { value: 'bc' } });
    expect(callCount).toBe(1);
  });

  it('renders error state and retry button when commit detail fails to load instead of empty "Select a commit"', () => {
    const reloadSelectedCommits = vi.fn().mockResolvedValue(undefined);
    const key = commitKey(directoryCommit.repoId, directoryCommit.hash);

    useAppStore.setState({
      snapshot,
      selectedCommit: undefined,
      selectedCommits: [directoryCommit],
      selectedPrimaryKey: key,
      selectedCommitDetails: {},
      selectedCommitLoading: {},
      selectedCommitError: { [key]: 'Custom backend error: revision not found' },
      reloadSelectedCommits,
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    // 确认绝不显示 "Select a commit"
    expect(screen.queryByText('Select a commit')).not.toBeInTheDocument();

    // 确认显示真实错误信息以及重试按钮
    expect(screen.getByText('Custom backend error: revision not found')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /Retry/ });
    expect(retryBtn).toBeInTheDocument();

    // 点击重试，触发 reloadSelectedCommits
    fireEvent.click(retryBtn);
    expect(reloadSelectedCommits).toHaveBeenCalledTimes(1);
  });

  it('renders aggregated error state when all commits fail in multi-selection', () => {
    const reloadSelectedCommits = vi.fn().mockResolvedValue(undefined);

    useAppStore.setState({
      snapshot,
      selectedCommit: undefined,
      selectedCommits: [mergeCommit, directoryCommit],
      selectedCommitDetails: {},
      selectedCommitLoading: {},
      selectedCommitError: {
        [commitKey(mergeCommit.repoId, mergeCommit.hash)]: 'Cannot read merge commit',
        [commitKey(directoryCommit.repoId, directoryCommit.hash)]: 'Cannot read directory commit',
      },
      reloadSelectedCommits,
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    expect(screen.queryByText('Select a commit')).not.toBeInTheDocument();
    expect(screen.getByText('Failed to load commit details')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /Retry/ });
    expect(retryBtn).toBeInTheDocument();

    fireEvent.click(retryBtn);
    expect(reloadSelectedCommits).toHaveBeenCalledTimes(1);
  });

  it('renders partial error state in aggregated list when some commits fail in multi-selection', () => {
    const reloadSelectedCommits = vi.fn().mockResolvedValue(undefined);
    const successKey = commitKey(directoryCommit.repoId, directoryCommit.hash);
    const failedKey = commitKey(mergeCommit.repoId, mergeCommit.hash);

    useAppStore.setState({
      snapshot,
      selectedCommit: directoryDetail,
      selectedCommits: [mergeCommit, directoryCommit],
      selectedCommitDetails: { [successKey]: directoryDetail },
      selectedCommitLoading: {},
      selectedCommitError: { [failedKey]: 'Connection reset by peer' },
      reloadSelectedCommits,
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    // 面板整体能进入聚合展示
    expect(screen.getByText('2 commits selected')).toBeInTheDocument();
    // 成功项的 message 正常显示
    expect(screen.getByText(directoryCommit.message)).toBeInTheDocument();
    // 失败项显示错误与重试
    expect(screen.getByText('Connection reset by peer')).toBeInTheDocument();
    const retryBtns = screen.getAllByRole('button', { name: /Retry/ });
    expect(retryBtns.length).toBeGreaterThan(0);

    fireEvent.click(retryBtns[0]);
    expect(reloadSelectedCommits).toHaveBeenCalledTimes(1);
  });
  it('keeps an editable file search open, handles keyboard navigation, and restores collapsed folders', () => {
    useAppStore.setState({ snapshot, selectedCommit: directoryDetail, selectedCommits: [directoryCommit], selectedCommitDetails: { [commitKey(directoryCommit.repoId, directoryCommit.hash)]: directoryDetail } });
    render(<CommitDetailPanel onCollapse={vi.fn()} />);
    const collapse = screen.getByTitle('Collapse all');
    fireEvent.click(collapse);
    collapse.focus();
    fireEvent.keyDown(collapse, { key: 'f', metaKey: true });
    const input = screen.getByRole('textbox', { name: 'Search files...' });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: '.ts' } });
    expect(screen.getByRole('search')).toHaveTextContent(/1\s*\/\s*2/);
    expect(screen.getByRole('button', { name: /alpha\.ts/ })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('search')).toHaveTextContent(/2\s*\/\s*2/);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByRole('search')).toHaveTextContent(/1\s*\/\s*2/);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /alpha\.ts/ })).not.toBeInTheDocument();
    expect(collapse).toHaveFocus();
  });

  it.each(['sidebar', 'workspace'] as const)('preserves a match while refining the query and leaves toolbar Enter alone in %s', (variant) => {
    useAppStore.setState({ snapshot, selectedCommit: directoryDetail, selectedCommits: [directoryCommit], selectedCommitDetails: { [commitKey(directoryCommit.repoId, directoryCommit.hash)]: directoryDetail } });
    render(<CommitDetailPanel variant={variant} onCollapse={vi.fn()} />);
    const trigger = screen.getByTitle('Collapse all'); trigger.focus();
    fireEvent.keyDown(trigger, { key: 'f', metaKey: true });
    const input = screen.getByRole('textbox', { name: 'Search files...' });
    fireEvent.change(input, { target: { value: '.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('search')).toHaveTextContent(/2\s*\/\s*2/);
    fireEvent.change(input, { target: { value: 'ts' } });
    expect(screen.getByRole('search')).toHaveTextContent(/2\s*\/\s*2/);
    trigger.focus();
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    trigger.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(screen.getByRole('search')).toHaveTextContent(/2\s*\/\s*2/);
    fireEvent.keyDown(trigger, { key: 'f', ctrlKey: true });
    expect(input).toHaveValue(variant === 'workspace' ? 'ts' : '');
    expect(input).toHaveFocus();
  });

  it('searches merge parent files in standalone details only after their group has been expanded', () => {
    const parent = mergeDetail.mergeParentChanges![0];
    const cacheKey = `repo-1\0${mergeCommit.hash}\0${parent.hash}`;
    useAppStore.setState({ snapshot, selectedCommit: mergeDetail, selectedCommits: [mergeCommit], selectedCommitDetails: { [commitKey('repo-1', mergeCommit.hash)]: mergeDetail }, mergeParentFiles: { [cacheKey]: [{ path: 'src/unique-parent.ts', status: 'M', added: 1, removed: 0 }] } });
    const { container } = render(<CommitDetailPanel variant="workspace" onCollapse={vi.fn()} />);
    const trigger = screen.getByTitle('Collapse all'); trigger.focus();
    fireEvent.keyDown(trigger, { key: 'f', metaKey: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search files...' }), { target: { value: 'unique-parent' } });
    expect(screen.getByRole('search')).toHaveTextContent('0/0');
    expect(screen.getByTitle('Next match')).toBeDisabled();
    fireEvent.click(container.querySelector('.merge-parent-row')!);
    expect(screen.getByRole('search')).toHaveTextContent('1/1');
    expect(screen.getByTitle(/unique-parent\.ts/)).toBeVisible();
  });

  it('uses the message expansion preference on subsequently selected commits', () => {
    const first = { ...directoryDetail, fullMessage: directoryCommit.message + '\n\nFirst body' };
    useAppStore.setState({ snapshot, selectedCommit: first, selectedCommits: [directoryCommit], selectedCommitDetails: { [commitKey(directoryCommit.repoId, directoryCommit.hash)]: first } });
    const view = render(<CommitDetailPanel onCollapse={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Expand commit messages by default'));
    expect(screen.getByText('First body')).toBeInTheDocument();
    const nextCommit = { ...directoryCommit, hash: 'next', message: 'Second subject' };
    const second = { ...directoryDetail, commit: nextCommit, fullMessage: 'Second subject\n\nSecond body' };
    useAppStore.setState({ selectedCommit: second, selectedCommits: [nextCommit], selectedCommitDetails: { [commitKey(nextCommit.repoId, nextCommit.hash)]: second } });
    view.rerender(<CommitDetailPanel onCollapse={vi.fn()} />);
    expect(screen.getByText('Second body')).toBeInTheDocument();
    expect(screen.getByTitle('Collapse commit messages by default')).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not restore files into a workspace switched while the confirmation was open', async () => {
    const historyOperation = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ snapshot, selectedCommit: directoryDetail, selectedCommits: [directoryCommit], selectedCommitDetails: { [commitKey(directoryCommit.repoId, directoryCommit.hash)]: directoryDetail }, historyOperation });
    render(<><CommitDetailPanel onCollapse={vi.fn()} /><DialogHost /></>);
    fireEvent.contextMenu(screen.getByText('alpha.ts').closest('button')!);
    fireEvent.click(screen.getByText('Revert Selected Changes'));
    useAppStore.setState({ snapshot: { ...snapshot, workspace: { ...snapshot.workspace, id: 'another-workspace' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(historyOperation).not.toHaveBeenCalled();
  });

  it('allows resizing the summary beyond its initial percentage while retaining space for files', () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains('commit-detail') ? 600 : this.classList.contains('detail-summary') ? 220 : 0;
      return height ? { x: 0, y: 0, top: 0, left: 0, right: 400, bottom: height, width: 400, height, toJSON: () => ({}) } : original.call(this);
    });
    try {
      useAppStore.setState({ snapshot, selectedCommit: directoryDetail, selectedCommits: [directoryCommit], selectedCommitDetails: { [commitKey(directoryCommit.repoId, directoryCommit.hash)]: directoryDetail } });
      render(<CommitDetailPanel onCollapse={vi.fn()} />);
      const separator = screen.getByRole('separator', { name: 'Resize commit detail' });
      for (let index = 0; index < 40; index++) fireEvent.keyDown(separator, { key: 'ArrowUp' });
      const expandedHeight = Number(separator.getAttribute('aria-valuenow'));
      expect(expandedHeight).toBeGreaterThan(600 * .48);
      expect(expandedHeight).toBeLessThan(600 - 96);
      expect(document.querySelector('.detail-summary')).toHaveStyle({ maxHeight: 'none', flex: `0 0 ${expandedHeight}px` });
      for (let index = 0; index < 60; index++) fireEvent.keyDown(separator, { key: 'ArrowDown' });
      expect(Number(separator.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(96);
    } finally {
      bounds.mockRestore();
    }
  });

});
