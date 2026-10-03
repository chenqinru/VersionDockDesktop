import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryWorkspace } from './HistoryWorkspace';
import { formatRefLabel } from '../history/refs';
import { commitKey } from '../history/commitDetails';
import { buildDetailTree, buildHistoryRefOptions, buildSidebarModel, collapseDetailTree, sumBranchAheadBehind } from './HistoryWorkspace.helpers';
import * as dialogService from './dialogService';
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
const originalLoadHistory = useAppStore.getState().loadHistory;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAppStore.setState({ loadHistory: originalLoadHistory, historyHasMore: false });
  useAppStore.setState({ bridge: undefined, bootstrap: undefined, snapshot: undefined, selectedRepoId: undefined, history: [], historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, remotes: {}, comparisonTarget: undefined, comparison: undefined, historyOperation: originalHistoryOperation });
});

describe('HistoryWorkspace capabilities', () => {
  it('switches edge padding while keeping graph rows contiguous and preserving selection', () => {
    const data = bootstrap(true, true);
    data.state.settings = { layoutDensity: 'comfortable' } as any;
    const commits = Array.from({ length: 3 }, (_, index) => ({ repoId: 'repo', hash: `c${index}`, shortHash: `c${index}`, parents: index < 2 ? [`c${index + 1}`] : [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: `density ${index}`, refs: [] }));
    useAppStore.setState({ bootstrap: data, snapshot, selectedRepoId: 'repo', history: commits, selectedCommits: [commits[1]] });
    const { container } = render(<HistoryWorkspace />);
    const positions = () => Array.from(container.querySelectorAll<HTMLElement>('.commit-row')).map(row => row.style.transform);
    expect(positions()).toEqual(['translateY(4px)', 'translateY(32px)', 'translateY(60px)']);
    act(() => useAppStore.setState({ bootstrap: { ...data, state: { ...data.state, settings: { ...data.state.settings!, layoutDensity: 'compact' } } } }));
    expect(positions()).toEqual(['translateY(0px)', 'translateY(28px)', 'translateY(56px)']);
    expect(useAppStore.getState().selectedCommits).toEqual([commits[1]]);
  });

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
    expect(screen.queryByRole('button', { name: /^Repository/ })).not.toBeInTheDocument();
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

  it('copies revision number to clipboard and dispatches notification', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const commit = { repoId: 'repo', hash: 'abcdef1234567890', shortHash: 'abcdef1', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'feat: copy hash', refs: [] };
    useAppStore.setState({ bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo', history: [commit] });
    render(<HistoryWorkspace />);
    fireEvent.contextMenu(screen.getByText('feat: copy hash').closest('.commit-row')!);
    fireEvent.click(screen.getByText('Copy Revision Number'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(commit.hash));
    expect(useAppStore.getState().notifications.some((n) => n.title === 'Revision copied')).toBe(true);
  });

  it('checks out revision directly when no local branch points to it', async () => {
    const historyOperation = vi.fn().mockResolvedValue(true);
    const commit = { repoId: 'repo', hash: 'abcdef1234567', shortHash: 'abcdef1', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'feat: checkout directly', refs: [] };
    useAppStore.setState({ bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo', history: [commit], historyOperation });
    render(<HistoryWorkspace />);
    fireEvent.contextMenu(screen.getByText('feat: checkout directly').closest('.commit-row')!);
    fireEvent.click(screen.getByText('Checkout Revision'));
    await waitFor(() => expect(historyOperation).toHaveBeenCalledWith('repo', { type: 'checkout', revision: commit.hash }));
  });

  it('requests undo with expectedHash matching the selected HEAD commit', async () => {
    const confirmSpy = vi.spyOn(dialogService, 'confirmDialog').mockResolvedValue(true);
    const unpushedOperation = vi.fn().mockResolvedValue(true);
    const commit = {
      repoId: 'repo',
      hash: 'abcdef1234567890abcdef1234567890abcdef12',
      shortHash: 'abcdef1',
      parents: [],
      author: 'Ada',
      email: 'ada@example.test',
      authorDate: '2026-01-01T00:00:00Z',
      committerDate: '2026-01-01T00:00:00Z',
      message: 'feat: undo me',
      refs: ['HEAD -> main'],
      unpushed: true,
    };
    useAppStore.setState({ bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo', history: [commit], unpushedOperation });
    render(<HistoryWorkspace />);
    fireEvent.contextMenu(screen.getByText('feat: undo me').closest('.commit-row')!);
    fireEvent.click(screen.getByText('Undo Commit'));
    await waitFor(() => expect(unpushedOperation).toHaveBeenCalledWith('repo', { type: 'undoHead', expectedHash: commit.hash }));
    confirmSpy.mockRestore();
  });

  it('requests reset with expectedBranch and expectedHead matching the confirmed branch state', async () => {
    const choiceSpy = vi.spyOn(dialogService, 'choiceDialog').mockResolvedValue('hard');
    const confirmSpy = vi.spyOn(dialogService, 'confirmDialog').mockResolvedValue(true);
    const historyOperation = vi.fn().mockResolvedValue(true);
    const commit = {
      repoId: 'repo',
      hash: 'target1234567890abcdef',
      shortHash: 'target1',
      parents: [],
      author: 'Ada',
      email: 'ada@example.test',
      authorDate: '2026-01-01T00:00:00Z',
      committerDate: '2026-01-01T00:00:00Z',
      message: 'feat: reset target',
      refs: [],
    };
    useAppStore.setState({
      bootstrap: bootstrap(true, true),
      snapshot,
      selectedRepoId: 'repo',
      history: [commit],
      branchesByRepo: { repo: [{ name: 'main', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }] },
      historyOperation,
    });
    render(<HistoryWorkspace />);
    fireEvent.contextMenu(screen.getByText('feat: reset target').closest('.commit-row')!);
    fireEvent.click(screen.getByText('Reset Current Branch to Here...'));
    await waitFor(() => expect(historyOperation).toHaveBeenCalledWith('repo', {
      type: 'reset',
      revision: commit.hash,
      mode: 'hard',
      expectedBranch: 'main',
      expectedHead: 'abc1234',
    }));
    choiceSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it('saves patch to selected file path via savePatch', async () => {
    const savePatch = vi.fn().mockResolvedValue('/path/to/my.patch');
    const saveFileDialog = vi.fn().mockResolvedValue('/path/to/my.patch');
    const mockBridge = {
      saveFileDialog,
      platform: () => 'macos',
      request: vi.fn(),
    } as unknown as import('../platform/bridge').VersionDockBridge;
    const commit = { repoId: 'repo', hash: 'abcdef1234567', shortHash: 'abcdef1', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'feat: save patch', refs: [] };
    useAppStore.setState({ bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo', history: [commit], bridge: mockBridge, savePatch });
    render(<HistoryWorkspace />);
    fireEvent.contextMenu(screen.getByText('feat: save patch').closest('.commit-row')!);
    fireEvent.click(screen.getByText('Create Patch...'));
    await waitFor(() => expect(savePatch).toHaveBeenCalledWith('repo', [commit.hash], '/path/to/my.patch'));
    expect(useAppStore.getState().notifications.some((n) => n.title === 'Patch created')).toBe(true);
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
      useAppStore.setState({ comparison: { base: 'refs/heads/main', target: 'refs/heads/feature/ui', baseCommits: [baseCommit], targetCommits: [targetCommit], files: [] } });
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
    expect(compareBranches).toHaveBeenCalledWith('repo', 'refs/heads/main', 'refs/heads/feature/ui');
  });

  it('shows non-blocking loading feedback and formats merged local/remote refs', () => {
    useAppStore.setState({
      bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo', historyLoading: true, branchesLoading: true,
      history: [{ repoId: 'repo', hash: 'abc', shortHash: 'abc', parents: [], author: 'Ada', email: '', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'feat: refs', refs: ['main', 'origin/main'] }],
      remotes: { repo: [{ name: 'origin', fetchUrl: 'https://example.test/repo.git', pushUrl: 'https://example.test/repo.git' }] },
    });
    render(<HistoryWorkspace />);
    expect(screen.getByText('Loading branches…')).toBeInTheDocument();
    expect(screen.getByText('Loading commits…')).toBeInTheDocument();
    expect(document.querySelector('.ref-overflow')).toHaveTextContent('1');
    expect(document.querySelector('.ref-overflow')).not.toHaveTextContent('+1');
  });

  it('keeps paging feedback outside the scroller and prevents more requests while loading', () => {
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      bootstrap: bootstrap(true, true), snapshot, selectedRepoId: 'repo',
      historyLoading: true, historyHasMore: true, loadHistory,
      history: [{ repoId: 'repo', hash: 'abc', shortHash: 'abc', parents: [], author: 'Ada', email: '', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'Existing commit', refs: [] }],
    });
    render(<HistoryWorkspace />);
    const scroller = document.querySelector('.commit-list')!;
    const feedback = screen.getByRole('status', { name: 'Loading commits…' });
    expect(screen.getByText('Existing commit')).toBeInTheDocument();
    expect(scroller.parentElement).toContainElement(feedback);
    expect(scroller).not.toContainElement(feedback);
    fireEvent.scroll(scroller);
    expect(loadHistory).not.toHaveBeenCalled();

    act(() => useAppStore.setState({ historyLoading: false }));
    expect(screen.queryByRole('status', { name: 'Loading commits…' })).not.toBeInTheDocument();
    expect(screen.getByText('Existing commit')).toBeInTheDocument();
    fireEvent.scroll(scroller);
    expect(loadHistory).toHaveBeenCalledWith(false);
  });

  it('clamps legacy persisted sidebar widths as soon as the history view mounts', () => {
    const data = bootstrap(true, true);
    data.state.layout = { panelSizes: { commit: 360, branches: 40, detail: 900 }, activeTab: 'changes', fileViewMode: 'tree', stashViewMode: 'tree', branchSidebarCollapsed: false, branchSidebarCollapsedSections: [] };
    useAppStore.setState({ bootstrap: data, snapshot, selectedRepoId: 'repo' });
    render(<HistoryWorkspace />);
    expect(screen.getByRole('separator', { name: 'Resize branch sidebar' })).toHaveAttribute('aria-valuenow', '120');
    expect(screen.getByRole('separator', { name: 'Resize detail sidebar' })).toHaveAttribute('aria-valuenow', '680');
    expect(document.querySelector('.branch-slot')).toHaveStyle({ width: '120px' });
    expect(document.querySelector('.detail-slot')).toHaveStyle({ width: '680px' });
  });

  it('formats a merged local and remote ref without translation placeholders', () => {
    expect(formatRefLabel({ key: 'main', label: 'main', remoteName: 'origin', isHead: false, isLocal: true, isRemote: true, isTag: false, isDetached: false, isRemoteHead: false, isSvnRevision: false }, 'Remote')).toBe('origin & main');
  });
});

describe('HistoryWorkspace data helpers', () => {
  it('maps local, remote, and tag filters to unambiguous full Git refs, excluding remote branches from dropdown', () => {
    const options = buildHistoryRefOptions(snapshot.repositories, {
      repo: [
        { name: 'feature/ui', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        { name: 'origin/main', current: false, remote: true, remoteName: 'origin', upstream: null, ahead: 0, behind: 0 },
      ],
    }, { repo: [{ name: 'v1.0.0' }] });
    expect(options.find((option) => option.id === 'refs/heads/feature/ui')?.revisionsByRepo.repo).toBe('refs/heads/feature/ui');
    expect(options.find((option) => option.id === 'refs/remotes/origin/main')).toBeUndefined();
    expect(options.find((option) => option.id === 'refs/tags/v1.0.0')?.revisionsByRepo.repo).toBe('refs/tags/v1.0.0');
    expect(options.find((option) => option.id === 'refs/heads/feature/ui')?.label).toBe('feature/ui');
  });

  it('keeps both branch and tag when they share the same name without overwriting', () => {
    const options = buildHistoryRefOptions(snapshot.repositories, {
      repo: [{ name: 'v1.0.0', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }],
    }, { repo: [{ name: 'v1.0.0' }] });
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.id)).toEqual(['refs/heads/v1.0.0', 'refs/tags/v1.0.0']);
  });

  it('excludes detached HEAD pseudo-branch from history ref options and sidebar branches', () => {
    const branchesWithHead = {
      repo: [
        { name: 'HEAD', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0, detachedTag: 'v1.0.0' },
        { name: 'main', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        { name: 'origin/HEAD', current: false, remote: true, remoteName: 'origin', upstream: null, ahead: 0, behind: 0 },
      ],
    };
    const options = buildHistoryRefOptions(snapshot.repositories, branchesWithHead, { repo: [{ name: 'v1.0.0' }] });
    expect(options.some((opt) => opt.label === 'HEAD')).toBe(false);
    expect(options.some((opt) => opt.id === 'refs/heads/HEAD')).toBe(false);

    const model = buildSidebarModel(snapshot.repositories, branchesWithHead, { repo: [{ name: 'v1.0.0', hash: 'a', date: '' }] });
    expect(model.local.map((b) => b.name)).toEqual(['main']);
    expect(model.remotes).toHaveLength(0);
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

  it('adds ahead and behind counts across merged repository branches', () => {
    const nested = { ...snapshot.repositories[0], meta: { ...snapshot.repositories[0].meta, id: 'nested', name: 'Nested', rootPath: '/tmp/test/nested' } };
    const model = buildSidebarModel([...snapshot.repositories, nested], {
      repo: [{ name: 'main', current: true, remote: false, remoteName: null, upstream: 'origin/main', ahead: 2, behind: 1 }],
      nested: [{ name: 'main', current: true, remote: false, remoteName: null, upstream: 'origin/main', ahead: 3, behind: 4 }],
    }, {});
    expect(sumBranchAheadBehind(model.local[0])).toEqual({ ahead: 5, behind: 5 });
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
    expect(onRefFilter).toHaveBeenCalledWith('refs/heads/feature/ui', ['repo']);
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

    fireEvent.click(screen.getByRole('button', { name: /^Repository/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^REPO 2/ }));
    expect(screen.queryByRole('radio', { name: /^REPO 2/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^REPO 2/ })[0]).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Branch \/ Tag/ }));
    expect(screen.queryByRole('radio', { name: 'main' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'feature/ui' }));
    expect(screen.queryByRole('radio', { name: 'feature/ui' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'feature/ui' }));
    expect(screen.getByRole('radio', { name: 'feature/ui' })).toBeChecked();
    fireEvent.click(screen.getAllByRole('button', { name: /^REPO 2/ })[0]);
    fireEvent.click(screen.getByRole('radio', { name: /^REPO$/i }));
    expect(screen.queryByRole('radio', { name: /^REPO$/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^REPO$/i })[0]).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Branch \/ Tag/ }));
    expect(screen.getByRole('radio', { name: 'main' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'feature/ui' })).not.toBeInTheDocument();
  }, 15000);

  it('resets mismatched repo filter when double clicking branch from another repo in sidebar', async () => {
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

    const repoRow = screen.getByText('Repo').closest('.branch-repo-row')!;
    fireEvent.doubleClick(repoRow);
    expect(useAppStore.getState().historyScope.repoIds).toEqual(['repo']);

    const branchRow = screen.getByText('feature/ui').closest('.branch-ref-row')!;
    fireEvent.doubleClick(branchRow);

    await waitFor(() => {
      expect(useAppStore.getState().historyScope.repoIds).toEqual(['repo-2']);
      expect(useAppStore.getState().historyScope.revisionsByRepo).toEqual({ 'repo-2': 'refs/heads/feature/ui' });
    });
  });

  it('shows the tag icon and closes an already-selected All filter', () => {
    useAppStore.setState({ bootstrap: bootstrap(false, false), snapshot, selectedRepoId: 'repo', tagsByRepo: { repo: [{ name: 'v1', hash: 'abc', date: '' }] } });
    render(<HistoryWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: /^Branch \/ Tag/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'v1' }));
    expect(screen.getAllByRole('button', { name: 'v1' })[0].querySelector('.codicon-tag')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'v1' })[0]);
    fireEvent.click(screen.getByRole('radio', { name: 'All branches & tags' }));
    expect(screen.queryByRole('dialog', { name: 'All branches & tags' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Branch \/ Tag/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'All branches & tags' }));
    expect(screen.queryByRole('dialog', { name: 'All branches & tags' })).not.toBeInTheDocument();
  });

  it('clears every condition and cancels an unsubmitted search while file history is active', () => {
    vi.useFakeTimers();
    useAppStore.setState({ bootstrap: bootstrap(false, false), snapshot, selectedRepoId: 'repo', historyQuery: { text: null, author: 'Ada', fromDate: '2026-01-01', toDate: null, path: 'src/file.ts', revision: null, lineRange: { start: 2, end: 5 } }, historyFilter: '', historyScope: { repoIds: ['repo'], revisionsByRepo: {} } });
    render(<HistoryWorkspace />);
    expect(screen.getByText('file.ts:lines 2-5')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search commits…' }), { target: { value: 'pending' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByRole('textbox', { name: 'Search commits…' })).toHaveValue('');
    expect(useAppStore.getState().historyQuery).toEqual({ text: null, author: null, fromDate: null, toDate: null, path: null, revision: null, lineRange: null });
    expect(useAppStore.getState().historyScope).toEqual({ repoIds: null, revisionsByRepo: {} });
    vi.useRealTimers();
  });

  it('selects all instances of a shared sidebar branch, clearing the previous repository filter', async () => {
    const secondRepo = { ...snapshot.repositories[0], meta: { ...snapshot.repositories[0].meta, id: 'repo-2', name: 'Repo 2', color: '#569CD6' } };
    useAppStore.setState({
      bootstrap: bootstrap(false, false),
      snapshot: { ...snapshot, repositories: [snapshot.repositories[0], secondRepo] },
      selectedRepoId: 'repo',
      branchesByRepo: {
        repo: [{ name: 'main', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }],
        'repo-2': [{ name: 'main', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }],
      },
      tagsByRepo: { repo: [], 'repo-2': [] },
    });
    render(<HistoryWorkspace />);

    const repoRow = screen.getByText('Repo').closest('.branch-repo-row')!;
    fireEvent.doubleClick(repoRow);
    expect(useAppStore.getState().historyScope.repoIds).toEqual(['repo']);

    const mainBranchRow = screen.getByText('main').closest('.branch-ref-row')!;
    fireEvent.doubleClick(mainBranchRow);

    await waitFor(() => {
      expect(useAppStore.getState().historyScope.repoIds).toEqual(['repo', 'repo-2']);
      expect(useAppStore.getState().historyScope.revisionsByRepo).toEqual({ repo: 'refs/heads/main', 'repo-2': 'refs/heads/main' });
      expect(mainBranchRow.classList.contains('filtered')).toBe(true);
    });
  });

  it('keeps distinct remote namespaces from one repository out of cross-repository shared branches', () => {
    const branches = {
      repo: [
        { name: 'origin/main', current: false, remote: true, upstream: null, ahead: 0, behind: 0 },
        { name: 'upstream/main', current: false, remote: true, upstream: null, ahead: 0, behind: 0 },
      ],
    };
    const merged = buildSidebarModel(snapshot.repositories, branches, {}).remotes;
    expect(merged.map((entry) => entry.name)).toEqual(['origin', 'upstream']);
    expect(merged.every((entry) => entry.branches[0].instances.length === 1)).toBe(true);
  });

  it('deduplicates identical full branch references from the same repository', () => {
    const main = { name: 'main', current: true, remote: false, upstream: null, ahead: 2, behind: 1 };
    const merged = buildSidebarModel(snapshot.repositories, { repo: [main, { ...main }] }, {}).local;
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

  it('connects branch double-click in HistoryWorkspace to filter history by canonical revision ref and highlight sidebar row', async () => {
    useAppStore.setState({
      bootstrap: bootstrap(true, true),
      snapshot,
      selectedRepoId: 'repo',
      branchesByRepo: {
        repo: [
          { name: 'main', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
          { name: 'feature/ui', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
        ],
      },
      tagsByRepo: { repo: [] },
    });

    render(<HistoryWorkspace />);
    const branchRow = screen.getByText('feature/ui').closest('.branch-ref-row')!;
    expect(branchRow).not.toHaveClass('filtered');

    fireEvent.doubleClick(branchRow);

    await waitFor(() => {
      expect(useAppStore.getState().historyScope.revisionsByRepo).toEqual({ repo: 'refs/heads/feature/ui' });
    });
    expect(branchRow).toHaveClass('filtered');
  });

  it('scopes a remote sidebar filter to repositories containing the exact remote ref', async () => {
    const second = { ...snapshot.repositories[0], meta: { ...snapshot.repositories[0].meta, id: 'repo-2', name: 'Repo 2' } };
    useAppStore.setState({ bootstrap: bootstrap(true, true), snapshot: { ...snapshot, repositories: [snapshot.repositories[0], second] }, selectedRepoId: 'repo', branchesByRepo: {
      repo: [{ name: 'origin/topic', current: false, remote: true, remoteName: 'origin', upstream: null, ahead: 0, behind: 0 }],
      'repo-2': [{ name: 'upstream/topic', current: false, remote: true, remoteName: 'upstream', upstream: null, ahead: 0, behind: 0 }],
    }, tagsByRepo: {} });
    render(<HistoryWorkspace />);
    const remoteRow = [...document.querySelectorAll('.branch-ref-row')].find((row) => row.textContent === 'topic')!;
    fireEvent.doubleClick(remoteRow);
    await waitFor(() => expect(useAppStore.getState().historyScope).toEqual({ repoIds: ['repo'], revisionsByRepo: { repo: 'refs/remotes/origin/topic' } }));
    expect(remoteRow).toHaveClass('filtered');
    fireEvent.doubleClick(remoteRow);
    expect(useAppStore.getState().historyScope.revisionsByRepo).toEqual({ repo: 'refs/remotes/origin/topic' });
  });

  it('keeps all repositories and their branches in sidebar when repository filter is active', () => {
    const secondRepo = {
      ...snapshot.repositories[0],
      meta: { ...snapshot.repositories[0].meta, id: 'repo-2', name: 'Repo 2', color: '#569CD6' },
    };
    useAppStore.setState({
      bootstrap: bootstrap(true, true),
      snapshot: { ...snapshot, repositories: [snapshot.repositories[0], secondRepo] },
      selectedRepoId: 'repo',
      branchesByRepo: {
        repo: [{ name: 'main', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }],
        'repo-2': [{ name: 'feature/second', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }],
      },
      tagsByRepo: { repo: [], 'repo-2': [] },
    });

    render(<HistoryWorkspace />);

    // Both repos are rendered in repo list
    expect(screen.getByText('Repo')).toBeInTheDocument();
    expect(screen.getByText('Repo 2')).toBeInTheDocument();

    // Double-click Repo 1 to filter by Repo 1
    fireEvent.doubleClick(screen.getByText('Repo'));

    // Even though Repo 1 is filtered, Repo 2's branch remains in the sidebar!
    expect(screen.getByText('feature/second')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('renders SUB badge on submodule repositories with informative title', () => {
    const submoduleRepo = {
      ...snapshot.repositories[0],
      meta: { ...snapshot.repositories[0].meta, id: 'sub-repo', name: 'SubRepo', isSubmodule: true },
    };
    useAppStore.setState({
      bootstrap: bootstrap(true, true),
      snapshot: { ...snapshot, repositories: [snapshot.repositories[0], submoduleRepo] },
      selectedRepoId: 'repo',
      branchesByRepo: { repo: [], 'sub-repo': [] },
      tagsByRepo: { repo: [], 'sub-repo': [] },
    });

    render(<HistoryWorkspace />);
    const subBadge = screen.getByText('SUB');
    expect(subBadge).toBeInTheDocument();
    expect(subBadge).toHaveClass('branch-submodule-badge');
    expect(subBadge).toHaveAttribute('title', 'Submodule');
  });

  it('merges multi-repo tags across all associated repository instances', async () => {
    const tagOperation = vi.fn().mockResolvedValue(undefined);
    const secondRepo = {
      ...snapshot.repositories[0],
      meta: { ...snapshot.repositories[0].meta, id: 'repo-2', name: 'Repo 2' },
    };
    useAppStore.setState({
      bootstrap: bootstrap(true, true),
      snapshot: { ...snapshot, repositories: [snapshot.repositories[0], secondRepo] },
      selectedRepoId: 'repo',
      branchesByRepo: { repo: [], 'repo-2': [] },
      tagsByRepo: {
        repo: [{ name: 'v2.0', hash: 'abc', date: '' }],
        'repo-2': [{ name: 'v2.0', hash: 'def', date: '' }],
      },
      tagOperation,
    });

    render(<BranchSidebar repoFilter={new Set()} refFilter={new Set()} onRepoFilter={vi.fn()} onRefFilter={vi.fn()} onCompare={vi.fn()} onCollapse={vi.fn()} />);

    const tagRow = screen.getByText('v2.0').closest('.branch-ref-row')!;
    fireEvent.contextMenu(tagRow);
    fireEvent.click(screen.getByText('Merge into current'));

    await waitFor(() => {
      expect(tagOperation).toHaveBeenCalledWith({ type: 'merge', name: 'v2.0' }, 'repo');
      expect(tagOperation).toHaveBeenCalledWith({ type: 'merge', name: 'v2.0' }, 'repo-2');
    });
  });
});
