import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryWorkspace } from './HistoryWorkspace';
import { formatRefLabel } from '../history/refs';
import { commitKey } from '../history/commitDetails';
import { buildDetailTree, buildHistoryRefOptions, buildSidebarModel, collapseDetailTree, mergeBranches, splitVisibleBranches } from './HistoryWorkspace.helpers';
import { BranchSidebar } from './BranchSidebar';
import { useAppStore } from '../store/appStore';
import type { BootstrapData, WorkspaceSnapshot } from '../bindings/generated';

const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'workspace', name: 'Test', paths: ['/tmp/test'], lastOpenedAt: '', available: true },
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
  repositories: [{ meta: { id: 'repo', name: 'Repo', rootPath: '/tmp/test', color: '#4EC9B0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc1234', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null }],
};

const bootstrap = (compare: boolean, remoteManagement: boolean): BootstrapData => ({
  applicationSessionId: 'test-session',
  state: { theme: 'system', language: 'system', uiFontSize: 'standard', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null },
  tools: snapshot.tools,
  capabilities: { ai: false, stash: true, shelf: true, changelist: true, worktree: true, subtree: false, compare, remoteManagement },
});
const originalHistoryOperation = useAppStore.getState().historyOperation;

afterEach(() => {
  cleanup();
  useAppStore.setState({ bridge: undefined, bootstrap: undefined, snapshot: undefined, selectedRepoId: undefined, history: [], historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, remotes: {}, comparisonTarget: undefined, comparison: undefined, historyOperation: originalHistoryOperation });
});

describe('HistoryWorkspace capabilities', () => {
  it('keeps history operation buttons out of the top filter bar', () => {
    useAppStore.setState({ bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo' });
    render(<HistoryWorkspace />);
    expect(screen.queryByText('Compare')).not.toBeInTheDocument();
    expect(screen.queryByText('Remotes')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Fetch')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Pull')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Push')).not.toBeInTheDocument();
  });

  it('opens functional author and repository filter menus', () => {
    useAppStore.setState({
      bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo',
      history: [{ repoId: 'repo', hash: 'abc', shortHash: 'abc', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'feat: filter', refs: ['HEAD -> main'] }],
    });
    render(<HistoryWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: /Author/ }));
    expect(screen.getAllByText('Ada').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Repository/ }));
    expect(screen.getAllByText('Repo').length).toBeGreaterThan(0);
  });

  it('provides commit, branch, tag, and repository context menus', () => {
    useAppStore.setState({
      bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo',
      history: [{ repoId: 'repo', hash: 'abcdef1234567', shortHash: 'abcdef1', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'feat: context menu', refs: ['HEAD -> main'], unpushed: true }],
      branchesByRepo: { repo: [{ name: 'main', current: true, remote: false, remoteName: null, upstream: null, ahead: 1, behind: 0 }] },
      tagsByRepo: { repo: [{ name: 'v1', hash: 'abcdef1234567', date: '' }] },
    });
    render(<HistoryWorkspace />);
    fireEvent.contextMenu(screen.getByText('feat: context menu').closest('.commit-row')!);
    expect(screen.getByText('Copy Revision Number')).toBeInTheDocument();
    expect(screen.getByText('New Branch...')).toBeInTheDocument();
    expect(screen.getByText('Cherry-Pick')).toBeInTheDocument();
    fireEvent.click(document.body);
  });

  it('runs cherry-pick directly without an App-only confirmation dialog', async () => {
    const historyOperation = vi.fn().mockResolvedValue(undefined);
    const commit = { repoId: 'repo', hash: 'abcdef1234567', shortHash: 'abcdef1', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'feat: cherry-pick directly', refs: [] };
    useAppStore.setState({ bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo', history: [commit], historyOperation });
    render(<HistoryWorkspace />);
    fireEvent.contextMenu(screen.getByText('feat: cherry-pick directly').closest('.commit-row')!);
    fireEvent.click(screen.getByText('Cherry-Pick'));
    await waitFor(() => expect(historyOperation).toHaveBeenCalledWith('repo', { type: 'cherryPick', revision: commit.hash }));
  });

  it('uses the row action to open commit details rather than previewing the first file', async () => {
    const commit = { repoId: 'repo', hash: 'abcdef1234567', shortHash: 'abcdef1', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'feat: inspect detail', refs: ['HEAD -> main'] };
    const detail = { commit, fullMessage: `${commit.message}\n\nFull commit body`, branches: { local: ['main'], remote: [], tags: [] }, files: [{ path: 'src/detail.ts', status: 'M', added: 2, removed: 1 }] };
    useAppStore.setState({
      bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo', history: [commit],
      selectedCommit: detail,
      selectedCommits: [commit],
      selectedCommitDetails: { [commitKey('repo', 'abcdef1234567')]: detail },
      mode: 'history',
    });
    render(<HistoryWorkspace />);
    const row = screen.getAllByText('feat: inspect detail').find((element) => element.classList.contains('commit-subject-text'))!.closest('.commit-row')!;
    fireEvent.mouseEnter(row);
    const action = row.querySelector<HTMLButtonElement>('button[title="Open Commit Detail"]');
    expect(action).not.toBeNull();
    expect(row.querySelector('button[title="Open preview"]')).toBeNull();
    fireEvent.click(action!);
    await waitFor(() => expect(useAppStore.getState().mode).toBe('commit-detail'));
    expect(useAppStore.getState().diff).toBeUndefined();
  });

  it('opens branch comparison in the main content area instead of nesting a full workspace in the sidebar', async () => {
    const selectCommit = vi.fn().mockResolvedValue(undefined);
    const targetCommit = { repoId: 'repo', hash: 'target1234567', shortHash: 'target1', parents: ['base'], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-02T00:00:00Z', committerDate: '2026-01-02T00:00:00Z', message: 'feat: target-only change', refs: ['feature/ui'] };
    const baseCommit = { ...targetCommit, hash: 'base123456789', shortHash: 'base123', message: 'fix: base-only change', refs: ['main'] };
    const compareBranches = vi.fn().mockImplementation(async () => {
      useAppStore.setState({ comparison: { base: 'main', target: 'feature/ui', baseCommits: [baseCommit], targetCommits: [targetCommit], files: [] } });
    });
    useAppStore.setState({
      bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo',
      branchesByRepo: { repo: [
        { name: 'main', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        { name: 'feature/ui', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
      ] },
      tagsByRepo: { repo: [] },
      compareBranches,
      selectCommit,
    });

    render(<HistoryWorkspace />);
    fireEvent.contextMenu(screen.getByText('feature/ui').closest('.branch-ref-row')!);
    fireEvent.click(screen.getByText('Compare with Current'));

    expect(document.querySelector('.branch-sidebar .compare-workspace')).not.toBeInTheDocument();
    expect(document.querySelector('.log-pane > .compare-workspace')).toBeInTheDocument();
    expect(document.querySelector('.history-columns > .detail-slot')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll('.compare-pane')).toHaveLength(2));
    expect(document.querySelectorAll('.compare-pane-filters.history-filters')).toHaveLength(2);
    expect(document.querySelectorAll('.compare-pane-filters .commit-search')).toHaveLength(2);
    expect(document.querySelectorAll('.compare-pane-filters .filter-button')).toHaveLength(4);
    expect(document.querySelector('.compare-pane-filters select')).not.toBeInTheDocument();
    expect(document.querySelector('.compare-pane-filters input[type="date"]')).not.toBeInTheDocument();
    const firstFilterBar = document.querySelector('.compare-pane-filters')!;
    const filterButtons = firstFilterBar.querySelectorAll<HTMLButtonElement>('.filter-button');
    fireEvent.click(filterButtons[0]);
    expect(firstFilterBar.querySelector('.popover-search')).toBeInTheDocument();
    fireEvent.click(filterButtons[0]);
    fireEvent.click(filterButtons[1]);
    expect(firstFilterBar.querySelector('.calendar-panes')).toBeInTheDocument();
    expect(screen.getByText('feat: target-only change')).toBeInTheDocument();
    expect(screen.getByText('fix: base-only change')).toBeInTheDocument();
    expect(screen.queryByText('Changed files')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('feat: target-only change'));
    expect(selectCommit).toHaveBeenCalledWith(expect.objectContaining({ hash: targetCommit.hash }), 'single', [expect.objectContaining({ hash: targetCommit.hash })]);
    expect(compareBranches).toHaveBeenCalledWith('repo', 'main', 'feature/ui');
  });

  it('shows non-blocking loading feedback and formats merged local/remote refs', () => {
    useAppStore.setState({
      bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo', historyLoading: true,
      history: [{ repoId: 'repo', hash: 'abc', shortHash: 'abc', parents: [], author: 'Ada', email: '', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'feat: refs', refs: ['main', 'origin/main'] }],
      remotes: { repo: [{ name: 'origin', fetchUrl: 'https://example.test/repo.git', pushUrl: 'https://example.test/repo.git' }] },
    });
    render(<HistoryWorkspace />);
    expect(screen.getByText('Loading branches…')).toBeInTheDocument();
    expect(screen.getByText('Loading commits…')).toBeInTheDocument();
  });

  it('formats a merged local and remote ref without translation placeholders', () => {
    expect(formatRefLabel({ key: 'main', label: 'main', remoteName: 'origin', isHead: false, isLocal: true, isRemote: true, isTag: false, isDetached: false, isRemoteHead: false, isSvnRevision: false }, 'Remote')).toBe('origin & main');
  });
});

describe('HistoryWorkspace data helpers', () => {
  it('maps local, remote, and tag filters to unambiguous full Git refs', () => {
    const options = buildHistoryRefOptions(snapshot.repositories, {
      repo: [
        { name: 'feature/ui', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        { name: 'origin/main', current: false, remote: true, remoteName: 'origin', upstream: null, ahead: 0, behind: 0 },
      ],
    }, { repo: [{ name: 'v1.0.0' }] });
    expect(options.find((option) => option.id === 'feature/ui')?.revisionsByRepo.repo).toBe('refs/heads/feature/ui');
    expect(options.find((option) => option.id === 'origin/main')?.revisionsByRepo.repo).toBe('refs/remotes/origin/main');
    expect(options.find((option) => option.id === 'v1.0.0')?.revisionsByRepo.repo).toBe('refs/tags/v1.0.0');
  });

  it('groups remote namespaces and preserves mixed repository identity', () => {
    const svnRepo = { ...snapshot.repositories[0], meta: { ...snapshot.repositories[0].meta, id: 'svn', name: 'SVN', kind: 'svn' as const } };
    const model = buildSidebarModel([snapshot.repositories[0], svnRepo], {
      repo: [
        { name: 'main', current: true, remote: false, remoteName: null, upstream: 'origin/main', ahead: 1, behind: 0 },
        { name: 'company/remote/feature/ui', current: false, remote: true, remoteName: 'company/remote', upstream: null, ahead: 0, behind: 0 },
      ],
      svn: [{ name: 'trunk', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 2 }],
    }, {
      repo: [{ name: 'v1.0.0', hash: 'a', date: '' }],
      svn: [{ name: 'v1.0.0', hash: 'r2', date: '' }],
    });
    expect(model.local.map((branch) => branch.name)).toEqual(['main', 'trunk']);
    expect(model.remotes).toHaveLength(1);
    expect(model.remotes[0].name).toBe('company/remote');
    expect(model.remotes[0].branches[0].name).toBe('feature/ui');
    expect(model.tags).toHaveLength(2);
  });

  it('filters branches, remote names, and tags with one search value', () => {
    const model = buildSidebarModel(snapshot.repositories, {
      repo: [{ name: 'feature/api', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }],
    }, { repo: [{ name: 'v1.0.0', hash: 'a', date: '' }] }, 'api');
    expect(model.local.map((branch) => branch.name)).toEqual(['feature/api']);
    expect(model.tags).toHaveLength(0);
    expect(buildSidebarModel(snapshot.repositories, {}, { repo: [{ name: 'v1.0.0-api', hash: 'a', date: '' }] }, 'api').tags).toHaveLength(1);
  });

  it('sorts sidebar branches like the VersionDock plugin', () => {
    const model = buildSidebarModel(snapshot.repositories, {
      repo: [
        { name: 'zeta', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        { name: 'release/candidate', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        { name: 'release', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        { name: 'prod/task', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        { name: 'main', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        { name: 'trunk', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        { name: 'development', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        { name: 'feature/current', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
      ],
    }, {});
    expect(model.local.map((branch) => branch.name)).toEqual([
      'feature/current', 'main', 'release', 'trunk', 'development', 'prod/task', 'release/candidate', 'zeta',
    ]);
  });

  it('uses single click for highlighting and double click for history filtering', () => {
    const onRefFilter = vi.fn();
    useAppStore.setState({ bootstrap: bootstrap(false, false), snapshot, selectedRepoId: 'repo', branchesByRepo: {
      repo: [{ name: 'feature/ui', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }],
    }, tagsByRepo: { repo: [] } });
    render(<BranchSidebar repoFilter={new Set()} refFilter={new Set()} onRepoFilter={vi.fn()} onRefFilter={onRefFilter} onCompare={vi.fn()} onCollapse={vi.fn()} />);
    const row = screen.getByText('feature/ui');
    fireEvent.click(row);
    expect(onRefFilter).not.toHaveBeenCalled();
    fireEvent.doubleClick(row);
    expect(onRefFilter).toHaveBeenCalledWith('refs/heads/feature/ui');
  });

  it('opens a remote branch working-tree comparison with its unambiguous full ref', () => {
    const loadBranchWorkingDiff = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      bootstrap: bootstrap(false, false),
      snapshot,
      selectedRepoId: 'repo',
      branchesByRepo: {
        repo: [
          { name: 'main', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
          { name: 'origin/feature/ui', current: false, remote: true, remoteName: 'origin', upstream: null, ahead: 0, behind: 0 },
        ],
      },
      tagsByRepo: { repo: [] },
      loadBranchWorkingDiff,
    });
    render(<BranchSidebar repoFilter={new Set()} refFilter={new Set()} onRepoFilter={vi.fn()} onRefFilter={vi.fn()} onCompare={vi.fn()} onCollapse={vi.fn()} />);

    fireEvent.contextMenu(screen.getByText('feature/ui').closest('.branch-ref-row')!);
    fireEvent.click(screen.getByText('Show Diff with Working Tree'));

    expect(loadBranchWorkingDiff).toHaveBeenCalledWith('repo', 'refs/remotes/origin/feature/ui');
  });

  it('keeps repository and branch filters single-select and closes after selection', () => {
    const secondRepo = { ...snapshot.repositories[0], meta: { ...snapshot.repositories[0].meta, id: 'repo-2', name: 'Repo 2', color: '#569CD6' } };
    useAppStore.setState({
      bootstrap: bootstrap(false, false),
      snapshot: { ...snapshot, repositories: [snapshot.repositories[0], secondRepo] },
      selectedRepoId: 'repo',
      branchesByRepo: {
        repo: [{ name: 'main', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }],
        'repo-2': [{ name: 'feature/ui', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }],
      },
      tagsByRepo: { repo: [], 'repo-2': [] },
    });
    render(<HistoryWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: 'Repository' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Repo 2GIT' }));
    expect(screen.queryByRole('radio', { name: 'Repo 2GIT' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Repo 2' })[0]).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Repo 2' })[0]);
    expect(screen.getByRole('radio', { name: 'Repo 2GIT' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'RepoGIT' }));
    expect(screen.queryByRole('radio', { name: 'RepoGIT' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Repo' })[0]);
    expect(screen.getByRole('radio', { name: 'RepoGIT' })).toBeChecked();
    expect(screen.getAllByRole('button', { name: 'Repo' })[0]).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Branch / Tags' }));
    fireEvent.click(screen.getByRole('radio', { name: 'feature/ui' }));
    expect(screen.queryByRole('radio', { name: 'feature/ui' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'feature/ui' }));
    expect(screen.getByRole('radio', { name: 'feature/ui' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'main' }));
    expect(screen.queryByRole('radio', { name: 'main' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'main' }));
    expect(screen.getByRole('radio', { name: 'main' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'feature/ui' })).not.toBeChecked();
  }, 15000);

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
