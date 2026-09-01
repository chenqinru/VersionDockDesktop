import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommitPanel } from './CommitPanel';
import { SubtreePanel } from './SubtreePanel';
import { buildFileTree } from './fileTree';
import { useAppStore } from '../store/appStore';
import type { BootstrapData, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';

const bootstrap = (stash: boolean, shelf = false, subtree = false, worktree = false): BootstrapData => ({
  applicationSessionId: 'test-session',
  state: { theme: 'system', language: 'system', uiFontSize: 'standard', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null },
  tools: { git: true, svn: true, svnadmin: true },
  capabilities: { ai: false, stash, shelf, changelist: false, worktree, subtree, compare: false, remoteManagement: false },
});
const bridge = new MockBridge(() => []);
const renderPanel = () => render(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
const gitRepo: RepositoryStatus = { meta: { id: 'repo', name: 'Repository', rootPath: '/tmp/repo', color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null };
const gitSnapshot: WorkspaceSnapshot = { workspace: { id: 'workspace', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true }, generation: 1, tools: { git: true, svn: true, svnadmin: true }, repositories: [gitRepo] };
const originalRefresh = useAppStore.getState().refresh;
const originalLoadStashes = useAppStore.getState().loadStashes;

afterEach(() => { cleanup(); useAppStore.setState({ bootstrap: undefined, snapshot: undefined, stashes: {}, shelves: {}, subtrees: {}, unpushedCommits: {}, worktreeDiff: undefined, batchCommitReport: undefined, operations: {}, notifications: [], toastNotificationIds: [], mode: 'history', commitMessage: '', mergeMessageSuggestion: undefined, amendRepoIds: [], commitSelections: {}, refresh: originalRefresh, loadStashes: originalLoadStashes }); });

describe('CommitPanel capabilities and file view', () => {
  it('compacts single-child directory chains while preserving file paths', () => {
    const tree = buildFileTree([
      { path: 'src/components/App.tsx', status: 'modified', staged: false, unstaged: true, conflicted: false },
      { path: 'README.md', status: 'untracked', staged: false, unstaged: true, conflicted: false },
    ]);
    expect(tree.map((node) => node.name)).toEqual(['src/components', 'README.md']);
    expect(tree[0].children[0].path).toBe('src/components/App.tsx');
  });

  it('renders repository tint and file-type icons without the active blue rail', () => {
    const changedRepo = { ...gitRepo, files: [{ path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true, conflicted: false }] };
    useAppStore.setState({ bootstrap: bootstrap(false), snapshot: { ...gitSnapshot, repositories: [changedRepo] }, selectedRepoId: 'repo' });
    const { container } = renderPanel();
    expect(container.querySelector('.repo-heading')).toHaveAttribute('style', expect.stringContaining('#4ec9b0'));
    expect(container.querySelector('.file-type-icon')).toBeInTheDocument();
    expect(container.querySelector('.repo-change-group.active')).not.toBeInTheDocument();
  });

  it('selects repositories and compact directories with indeterminate states', () => {
    const changedRepo = { ...gitRepo, files: [
      { path: 'src/main/java/App.java', status: 'modified', staged: false, unstaged: true, conflicted: false },
      { path: 'src/main/resources/app.yml', status: 'modified', staged: false, unstaged: true, conflicted: false },
    ] };
    useAppStore.setState({ bootstrap: bootstrap(false), snapshot: { ...gitSnapshot, repositories: [changedRepo] }, selectedRepoId: 'repo' });
    renderPanel();
    const repoCheckbox = screen.getByLabelText('Repository') as HTMLInputElement;
    fireEvent.click(screen.getByLabelText('src/main/java'));
    expect(repoCheckbox.indeterminate).toBe(true);
    expect(repoCheckbox.parentElement?.querySelector('.codicon-remove')).toBeInTheDocument();
    expect(screen.getByLabelText('src/main/java/App.java').parentElement?.querySelector('.codicon-check')).toBeInTheDocument();
    fireEvent.click(repoCheckbox);
    expect(repoCheckbox.checked).toBe(true);
    expect(repoCheckbox.parentElement?.querySelector('.codicon-check')).toBeInTheDocument();
    expect(screen.getByText('src/main', { selector: '.directory-row span' })).toBeInTheDocument();
  });

  it('matches the VersionDock title actions and keeps commit metadata left aligned', async () => {
    const changedRepo = { ...gitRepo, ahead: 1, files: [{ path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true, conflicted: false }] };
    const emptyRepo = { ...gitRepo, meta: { ...gitRepo.meta, id: 'empty', name: 'Empty' } };
    useAppStore.setState({ bootstrap: bootstrap(false), snapshot: { ...gitSnapshot, repositories: [changedRepo, emptyRepo] }, selectedRepoId: 'repo' });
    const { container } = renderPanel();
    expect(screen.queryByTitle('Rollback')).not.toBeInTheDocument();
    expect(screen.getByTitle('More')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('More'));
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unstage' })).not.toBeInTheDocument();
    const parentRow = container.querySelector('.directory-row')!;
    const childRow = container.querySelector('.file-row')!;
    expect(parentRow).toHaveStyle({ paddingLeft: '20px' });
    expect(childRow).toHaveStyle({ paddingLeft: '40px' });
    fireEvent.click(screen.getByLabelText('src/App.tsx'));
    expect(container.querySelector('.commit-targets em')).toHaveTextContent('Repository');
    expect(screen.getByText('Amend last commit')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit message history' })).toBeEnabled());
    expect(screen.queryByTitle('Use Last Commit Message')).not.toBeInTheDocument();
  });

  it('collapses empty repositories by default while keeping them expandable', () => {
    const secondRepo = { ...gitRepo, meta: { ...gitRepo.meta, id: 'empty-two', name: 'Empty Two', color: '#cc6a9a' } };
    useAppStore.setState({ bootstrap: bootstrap(false), snapshot: { ...gitSnapshot, repositories: [gitRepo, secondRepo] }, selectedRepoId: 'repo' });
    renderPanel();
    expect(screen.queryByText('No changes')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.repo-heading > b')).toHaveLength(0);
    expect(screen.getByLabelText('Repository')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Repositorymain' }));
    expect(screen.getAllByText('No changes')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Empty Twomain' }));
    expect(screen.getAllByText('No changes')).toHaveLength(2);
    fireEvent.click(screen.getByTitle('More'));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByText('No changes')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('More'));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByText('No changes')).toHaveLength(2);
  });

  it('shows a mixed expansion state after a repository is toggled manually', () => {
    const changedRepo = { ...gitRepo, files: [{ path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true, conflicted: false }] };
    useAppStore.setState({ bootstrap: bootstrap(false), snapshot: { ...gitSnapshot, repositories: [changedRepo] }, selectedRepoId: 'repo' });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Repositorymain' }));
    fireEvent.click(screen.getByTitle('More'));

    expect(screen.getByRole('button', { name: 'Expand all' })).not.toHaveClass('selected');
    expect(screen.getByRole('button', { name: 'Collapse all' })).not.toHaveClass('selected');
  });

  it('auto-expands a repository when changes appear after an empty initial state', async () => {
    const { rerender } = renderPanel();
    useAppStore.setState({ bootstrap: bootstrap(false), snapshot: gitSnapshot, selectedRepoId: 'repo' });
    rerender(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    expect(screen.queryByText('No changes')).not.toBeInTheDocument();

    const changedRepo = { ...gitRepo, files: [{ path: 'src/App.tsx', status: 'modified' as const, staged: false, unstaged: true, conflicted: false }] };
    useAppStore.setState({ snapshot: { ...gitSnapshot, repositories: [changedRepo] } });
    rerender(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    await waitFor(() => expect(screen.getByLabelText('src/App.tsx')).toBeInTheDocument());
  });

  it('omits the changelist toolbar button and exposes a draggable commit-message separator', () => {
    const changedRepo = { ...gitRepo, files: [{ path: 'App.tsx', status: 'modified', staged: false, unstaged: true, conflicted: false }] };
    useAppStore.setState({ bootstrap: { ...bootstrap(false), capabilities: { ...bootstrap(false).capabilities, changelist: true } }, snapshot: { ...gitSnapshot, repositories: [changedRepo] }, selectedRepoId: 'repo' });
    renderPanel();
    expect(screen.queryByTitle('Changelists')).not.toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize commit message' })).toBeInTheDocument();
  });

  it('commits selected files across repositories and unstages excluded indexed files', async () => {
    const commands: string[] = [];
    const multiBridge = new MockBridge((command) => {
      commands.push(command.type);
      if (command.type === 'batchCommit') {
        for (const target of command.payload.targets) {
          if (target.unstagePaths?.length) commands.push(`unstage:${target.repoId}:${target.unstagePaths.join(',')}`);
          commands.push(`commit:${target.repoId}:${target.paths.join(',')}`);
        }
        return command.payload.targets.map((target) => ({ repoId: target.repoId, committed: true, revision: 'abc', pushed: false, error: null }));
      }
      if (command.type === 'workspaceRefresh') return { ...gitSnapshot, repositories: [] };
      return [];
    });
    const repoOne = { ...gitRepo, meta: { ...gitRepo.meta, id: 'one', name: 'ONE' }, files: [
      { path: 'selected.ts', status: 'modified', staged: false, unstaged: true, conflicted: false },
      { path: 'excluded.ts', status: 'modified', staged: true, unstaged: false, conflicted: false },
    ] };
    const repoTwo = { ...gitRepo, meta: { ...gitRepo.meta, id: 'two', name: 'TWO', color: '#cc6a9a' }, files: [
      { path: 'selected.rs', status: 'modified', staged: false, unstaged: true, conflicted: false },
    ] };
    useAppStore.setState({ bridge: multiBridge, bootstrap: bootstrap(false), snapshot: { ...gitSnapshot, repositories: [repoOne, repoTwo] }, selectedRepoId: 'one' });
    render(<BridgeContext.Provider value={multiBridge}><CommitPanel /></BridgeContext.Provider>);
    fireEvent.click(screen.getByLabelText('selected.ts'));
    fireEvent.click(screen.getByLabelText('selected.rs'));
    fireEvent.change(screen.getByPlaceholderText(/Commit message/), { target: { value: 'selected changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(commands).toContain('commit:two:selected.rs'));
    expect(commands).toContain('unstage:one:excluded.ts');
    expect(commands).toContain('commit:one:selected.ts');
  });

  it('commits selected untracked files without an extra confirmation dialog', async () => {
    const commands: string[] = [];
    const commitBridge = new MockBridge((command) => {
      commands.push(command.type);
      if (command.type === 'batchCommit') return command.payload.targets.map((target) => ({ repoId: target.repoId, committed: true, revision: 'abc', pushed: false, error: null }));
      return [];
    });
    const untrackedRepo = { ...gitRepo, files: [{ path: 'new-file.ts', status: 'untracked' as const, staged: false, unstaged: true, conflicted: false }] };
    useAppStore.setState({ bridge: commitBridge, bootstrap: bootstrap(false), snapshot: { ...gitSnapshot, repositories: [untrackedRepo] }, selectedRepoId: 'repo' });
    render(<BridgeContext.Provider value={commitBridge}><CommitPanel /></BridgeContext.Provider>);
    fireEvent.click(screen.getByLabelText('new-file.ts'));
    fireEvent.change(screen.getByPlaceholderText(/Commit message/), { target: { value: 'add new file' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(commands).toContain('batchCommit'));
  });

  it('keeps commit actions available when only an unrelated repository is busy', () => {
    const repoOne = { ...gitRepo, meta: { ...gitRepo.meta, id: 'one', name: 'ONE' }, files: [{ path: 'one.ts', status: 'modified', staged: false, unstaged: true, conflicted: false }] };
    const repoTwo = { ...gitRepo, meta: { ...gitRepo.meta, id: 'two', name: 'TWO' }, files: [{ path: 'two.ts', status: 'modified', staged: false, unstaged: true, conflicted: false }] };
    useAppStore.setState({
      bootstrap: bootstrap(false),
      snapshot: { ...gitSnapshot, repositories: [repoOne, repoTwo] },
      selectedRepoId: 'two',
      operations: {
        commitOne: {
          operationId: 'commitOne',
          context: { generation: 1, domain: 'commit', visibility: 'foreground', workspaceId: 'workspace', repositoryId: 'one', target: null },
          status: 'running', phase: 'commit', message: '', startedAt: '', cancellable: true, completed: null, total: null, error: null,
        },
      },
    });
    renderPanel();
    fireEvent.click(screen.getByLabelText('two.ts'));
    fireEvent.change(screen.getByPlaceholderText(/Commit message/), { target: { value: 'repo two only' } });
    expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled();
    fireEvent.click(screen.getByLabelText('one.ts'));
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });

  it('keeps failed repository selections and reports the precise batch failure stage non-modally', async () => {
    const partialBridge = new MockBridge((command) => command.type === 'batchCommit' ? [
      { repoId: 'one', commitAttempted: true, committed: true, revision: 'success123456', pushAttempted: false, pushed: false, failedStage: null, recoveryHint: null, error: null },
      { repoId: 'two', commitAttempted: true, committed: false, revision: null, pushAttempted: false, pushed: false, failedStage: 'identity', recoveryHint: 'Configure an identity', error: { code: 'IDENTITY_REQUIRED', message: 'Identity is missing', command: null, exitCode: null, stderr: null, recoverable: true } },
    ] : []);
    const repoOne = { ...gitRepo, meta: { ...gitRepo.meta, id: 'one', name: 'ONE' }, files: [{ path: 'one.ts', status: 'modified', staged: false, unstaged: true, conflicted: false }] };
    const repoTwo = { ...gitRepo, meta: { ...gitRepo.meta, id: 'two', name: 'TWO' }, files: [{ path: 'two.ts', status: 'modified', staged: false, unstaged: true, conflicted: false }] };
    useAppStore.setState({ bridge: partialBridge, bootstrap: bootstrap(false), snapshot: { ...gitSnapshot, repositories: [repoOne, repoTwo] }, selectedRepoId: 'one' });
    render(<BridgeContext.Provider value={partialBridge}><CommitPanel /></BridgeContext.Provider>);
    fireEvent.click(screen.getByLabelText('one.ts'));
    fireEvent.click(screen.getByLabelText('two.ts'));
    fireEvent.change(screen.getByPlaceholderText(/Commit message/), { target: { value: 'partial result' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    await waitFor(() => expect(useAppStore.getState().notifications.some((item) => item.actions.some((action) => action.type === 'retryBatchResult'))).toBe(true));
    const failure = useAppStore.getState().notifications.find((item) => item.actions.some((action) => action.type === 'retryBatchResult'));
    expect(failure?.details).toContain('Failed stage: Identity check');
    expect(screen.queryByText('Batch commit results')).not.toBeInTheDocument();
    expect(screen.getByLabelText('one.ts')).not.toBeChecked();
    expect(screen.getByLabelText('two.ts')).toBeChecked();
    expect(screen.getByPlaceholderText(/Commit message/)).toHaveValue('partial result');
  });

  it('retries only push after a successful batch commit', async () => {
    const commands: string[] = [];
    const retryBridge = new MockBridge((command) => { commands.push(command.type); return []; });
    useAppStore.setState({
      bridge: retryBridge,
      bootstrap: bootstrap(false),
      snapshot: gitSnapshot,
      batchCommitReport: {
        message: 'already committed', push: true,
        targets: [{ repoId: 'repo', paths: ['a.ts'], unstagePaths: [], amend: false }],
        results: [{ repoId: 'repo', commitAttempted: true, committed: true, revision: 'abc123', pushAttempted: true, pushed: false, failedStage: 'push', recoveryHint: 'Retry push', error: { code: 'PUSH_FAILED', message: 'Remote rejected', command: null, exitCode: 1, stderr: null, recoverable: true } }],
      },
    });
    await useAppStore.getState().retryBatchResult('repo');
    await waitFor(() => expect(commands).toContain('sync'));
    expect(commands).not.toContain('batchCommit');
    expect(useAppStore.getState().batchCommitReport).toBeUndefined();
  });

  it('hides the stash surface until its real capability is enabled', () => {
    useAppStore.setState({ bootstrap: bootstrap(false) });
    const { rerender } = renderPanel();
    expect(screen.queryByTitle('Stash')).not.toBeInTheDocument();
    useAppStore.setState({ bootstrap: bootstrap(true) });
    rerender(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    expect(screen.getByTitle('Stash')).toBeInTheDocument();
    expect(screen.queryByText('AI Commit Message')).not.toBeInTheDocument();
  });

  it('persists a stash view mode independently from the changes view', () => {
    const data = bootstrap(true);
    data.state.layout = { panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'stash', fileViewMode: 'tree', stashViewMode: 'tree', branchSidebarCollapsed: false, branchSidebarCollapsedSections: [] };
    useAppStore.setState({ bootstrap: data, snapshot: gitSnapshot, selectedRepoId: 'repo' });
    renderPanel();
    fireEvent.click(screen.getByTitle('More'));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'View options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Flat list' }));
    expect(useAppStore.getState().bootstrap?.state.layout?.stashViewMode).toBe('list');
    expect(useAppStore.getState().bootstrap?.state.layout?.fileViewMode).toBe('tree');
  });

  it('refreshes the active stash data together with the workspace snapshot', async () => {
    const data = bootstrap(true);
    data.state.layout = { panelSizes: { commit: 360, branches: 220, detail: 380 }, activeTab: 'stash', fileViewMode: 'tree', stashViewMode: 'tree', branchSidebarCollapsed: false, branchSidebarCollapsedSections: [] };
    const refresh = vi.fn().mockResolvedValue(undefined);
    const loadStashes = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ bootstrap: data, snapshot: gitSnapshot, selectedRepoId: 'repo', refresh, loadStashes });
    renderPanel();
    loadStashes.mockClear();
    fireEvent.click(screen.getAllByTitle('Refresh')[0]);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(loadStashes).toHaveBeenCalledOnce();
  });

  it('shows shelf only after its storage and backend capability is enabled', () => {
    useAppStore.setState({ bootstrap: bootstrap(false, true) });
    renderPanel();
    expect(screen.getByTitle('Shelf')).toBeInTheDocument();
    expect(screen.queryByTitle('Stash')).not.toBeInTheDocument();
  });

  it('hides Subtree until enabled, then opens its real panel', () => {
    useAppStore.setState({ bridge, bootstrap: bootstrap(false, false), snapshot: gitSnapshot, selectedRepoId: 'repo', subtrees: {} });
    const { rerender } = renderPanel();
    expect(screen.queryByTitle('Subtree')).not.toBeInTheDocument();
    useAppStore.setState({ bootstrap: bootstrap(false, false, true), subtrees: {} });
    rerender(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    fireEvent.click(screen.getByTitle('Subtree'));
    expect(screen.getByText('No subtrees registered')).toBeInTheDocument();
  });

  it('renders registered Subtree details and controls', () => {
    const entry = [{ id: 'entry-1', prefix: 'vendor/api', remote: 'origin', branch: 'main', squash: true, state: 'active' as const }];
    const entryBridge = new MockBridge((command) => command.type === 'subtrees' ? entry : []);
    useAppStore.setState({ bridge: entryBridge, bootstrap: bootstrap(false, false, true), snapshot: gitSnapshot, subtrees: { repo: entry } });
    render(<BridgeContext.Provider value={entryBridge}><SubtreePanel repos={[gitRepo]} /></BridgeContext.Provider>);
    expect(screen.getByText('api')).toBeInTheDocument();
    expect(screen.getByText('vendor/api')).toBeInTheDocument();
    expect(screen.getByText('origin')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('squash')).toBeInTheDocument();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
    expect(screen.getByTitle('Pull Subtree')).toBeInTheDocument();
    expect(screen.getByTitle('More')).toBeInTheDocument();
  });

  it('loads Subtree entries once when their store update rerenders the panel', async () => {
    let subtreeRequests = 0;
    const subtreeBridge = new MockBridge((command) => {
      if (command.type === 'subtrees') subtreeRequests += 1;
      return [];
    });
    useAppStore.setState({ bridge: subtreeBridge, bootstrap: { ...bootstrap(false, false, true), state: { ...bootstrap(false, false, true).state, activeTab: 'subtree' } }, snapshot: gitSnapshot, selectedRepoId: 'repo', subtrees: {} });
    const { rerender } = render(<BridgeContext.Provider value={subtreeBridge}><CommitPanel /></BridgeContext.Provider>);
    await waitFor(() => expect(subtreeRequests).toBe(1));
    rerender(<BridgeContext.Provider value={subtreeBridge}><CommitPanel /></BridgeContext.Provider>);
    await waitFor(() => expect(subtreeRequests).toBe(1));
  });

  it('keeps all enabled capability tabs in the settled order', () => {
    useAppStore.setState({ bootstrap: bootstrap(true, true, true, true), snapshot: gitSnapshot });
    const { container } = renderPanel();
    const tabs = Array.from(container.querySelectorAll('.commit-tabs button')).map((button) => button.getAttribute('title'));
    expect(tabs).toEqual(['Changes', 'Shelf', 'Stash', 'Worktrees', 'Subtree', 'Push']);
  });

  it('shows a branch-to-working-tree diff across the whole commit panel instead of the Worktrees tab', async () => {
    const requests: string[] = [];
    const diffBridge = new MockBridge((command) => {
      requests.push(command.type);
      if (command.type === 'branchWorkingFileDiff') return { path: command.payload.relative_path, content: 'diff --git a/file b/file', language: 'diff', binary: false, truncated: false, lineCount: 1 };
      if (command.type === 'updateLayout') return command.payload.layout;
      return true;
    });
    const data = bootstrap(false, false, false, true);
    data.state.activeTab = 'worktree';
    useAppStore.setState({
      bridge: diffBridge,
      bootstrap: data,
      snapshot: gitSnapshot,
      selectedRepoId: 'repo',
      worktreeDiff: {
        repoId: 'repo',
        source: 'repository',
        path: '/tmp/repo',
        baseRef: 'refs/remotes/origin/feature',
        currentRef: 'main',
        files: [
          { path: 'src/alpha.ts', status: 'M', added: 2, removed: 1 },
          { path: 'src/nested/beta.ts', status: 'A', added: 4, removed: 0 },
        ],
      },
    });

    const { container } = render(<BridgeContext.Provider value={diffBridge}><CommitPanel /></BridgeContext.Provider>);
    expect(container.querySelector('.branch-working-diff-panel')).toBeInTheDocument();
    expect(screen.getByTitle('VersionDock Commit')).toBeInTheDocument();
    expect(screen.getByTitle('Fetch')).toBeInTheDocument();
    expect(screen.getByTitle('Refresh')).toBeInTheDocument();
    expect(screen.getByTitle('Settings')).toBeInTheDocument();
    expect(container.querySelector('.commit-tabs')).not.toBeInTheDocument();
    expect(screen.getByText('refs/remotes/origin/feature vs Working Tree')).toBeInTheDocument();
    expect(screen.getByTitle('src')).toHaveTextContent('2');

    fireEvent.click(screen.getByText('alpha.ts'));
    await waitFor(() => expect(requests).toContain('branchWorkingFileDiff'));

    fireEvent.contextMenu(screen.getByText('beta.ts').closest('.branch-working-file-row')!);
    expect(screen.getByText('Show Diff')).toBeInTheDocument();
    expect(screen.getByText('Open file')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(screen.getByTitle('Back to Changes'));
    expect(useAppStore.getState().worktreeDiff).toBeUndefined();
    expect(useAppStore.getState().bootstrap?.state.layout?.activeTab).toBe('changes');
  });

  it('keeps the real push tab visible while AI stays hidden', async () => {
    const pushBridge = new MockBridge((command) => command.type === 'unpushedCommits' ? [{ hash: 'abc', shortHash: 'abc', message: 'local commit', author: 'Test', date: '2026-08-13T00:00:00Z', filesChanged: 1, additions: 2, deletions: 0 }] : []);
    useAppStore.setState({ bridge: pushBridge, bootstrap: { ...bootstrap(false), state: { ...bootstrap(false).state, activeTab: 'push' } }, snapshot: { ...gitSnapshot, repositories: [{ ...gitRepo, ahead: 1 }] }, selectedRepoId: 'repo', unpushedCommits: {} });
    render(<BridgeContext.Provider value={pushBridge}><CommitPanel /></BridgeContext.Provider>);
    expect(screen.getByTitle('Push')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('local commit')).toBeInTheDocument());
    expect(screen.queryByText('AI Commit Message')).not.toBeInTheDocument();
    expect(screen.queryByText('AI Code Review')).not.toBeInTheDocument();
  });

  it('matches the VersionDock file, folder, and repository context menus', async () => {
    const diffRequests: boolean[] = [];
    const menuBridge = new MockBridge((command) => {
      if (command.type === 'fileDiff') {
        diffRequests.push(command.payload.staged);
        return { path: command.payload.relative_path, content: 'diff --git a/file b/file', language: 'diff', binary: false, truncated: false, lineCount: 1 };
      }
      if (command.type === 'workspaceRefresh') return { ...gitSnapshot, repositories: [changedRepo] };
      return true;
    });
    const changedRepo = { ...gitRepo, files: [
      { path: 'src/file.ts', status: 'modified', staged: true, unstaged: true, conflicted: false },
      { path: 'src/new.ts', status: 'untracked', staged: false, unstaged: true, conflicted: false },
    ] };
    useAppStore.setState({ bridge: menuBridge, bootstrap: bootstrap(false, true), snapshot: { ...gitSnapshot, repositories: [changedRepo] }, selectedRepoId: 'repo' });
    const { container } = render(<BridgeContext.Provider value={menuBridge}><CommitPanel /></BridgeContext.Provider>);

    fireEvent.contextMenu(screen.getByTitle('src/file.ts').closest('.file-row')!);
    expect(screen.getByText('Show Diff')).toBeInTheDocument();
    expect(screen.getByText('Rollback')).toBeInTheDocument();
    expect(screen.getByText('Shelve')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Show Diff'));
    await waitFor(() => expect(diffRequests).toEqual([false]));

    fireEvent.contextMenu(screen.getByTitle('src').closest('.directory-row')!);
    expect(screen.getByText('Rollback')).toBeInTheDocument();
    expect(screen.getByText('Shelve Changes')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.contextMenu(container.querySelector('.repo-heading')!);
    expect(screen.getByText('Manage Repository')).toBeInTheDocument();
    expect(screen.getByText('View Git Log')).toBeInTheDocument();
  });

  it('matches VersionDock by keeping a gitlink menu minimal and adding no Submodule tab', () => {
    const submoduleRepo = { ...gitRepo, files: [{ path: 'vendor/module', status: 'submodule', staged: false, unstaged: true, conflicted: false, submodule: true }] };
    useAppStore.setState({ bridge, bootstrap: bootstrap(true, true, true, true), snapshot: { ...gitSnapshot, repositories: [submoduleRepo] }, selectedRepoId: 'repo', submodules: { repo: [{ path: 'vendor/module', url: 'https://example.test/module.git', initialized: true, revision: 'abcdef1', branch: 'main', dirty: true }] } });
    const { container } = render(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    expect(Array.from(container.querySelectorAll('.commit-tabs button')).map((button) => button.getAttribute('title'))).not.toContain('Submodules');
    fireEvent.contextMenu(screen.getByTitle('vendor/module').closest('.file-row')!);
    expect(screen.getByText('Stage')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.queryByText('Update Submodule')).not.toBeInTheDocument();
    expect(screen.queryByText('Show Diff')).not.toBeInTheDocument();
  });
});
