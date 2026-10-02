import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommitPanel } from './CommitPanel';
import { SubtreePanel } from './SubtreePanel';
import { buildFileTree } from './fileTree';
import { useAppStore } from '../store/appStore';
import type { BootstrapData, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';

import * as dialogService from './dialogService';

const bootstrap = (stash: boolean, shelf = false, subtree = false, worktree = false): BootstrapData => ({
  applicationSessionId: 'test-session',
  state: { theme: 'system', language: 'system', uiFontSize: 'standard', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null },
  tools: { git: true, svn: true, svnadmin: true },
  capabilities: { ai: false, stash, shelf, changelist: false, worktree, subtree, submodule: true, compare: false, remoteManagement: false },
});
const bridge = new MockBridge(() => []);
const renderPanel = () => render(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
const gitRepo: RepositoryStatus = { meta: { id: 'repo', name: 'Repository', rootPath: '/tmp/repo', color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null };
const gitSnapshot: WorkspaceSnapshot = { workspace: { id: 'workspace', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true }, generation: 1, tools: { git: true, svn: true, svnadmin: true }, repositories: [gitRepo] };
const originalRefresh = useAppStore.getState().refresh;
const originalLoadStashes = useAppStore.getState().loadStashes;
const originalUnstage = useAppStore.getState().unstage;
const originalStage = useAppStore.getState().stage;

afterEach(() => { cleanup(); useAppStore.setState({ bootstrap: undefined, snapshot: undefined, stashes: {}, shelves: {}, subtrees: {}, unpushedCommits: {}, worktreeDiff: undefined, batchCommitReport: undefined, operations: {}, notifications: [], toastNotificationIds: [], mode: 'history', commitMessage: '', mergeMessageSuggestion: undefined, amendRepoIds: [], commitSelections: {}, refresh: originalRefresh, loadStashes: originalLoadStashes, unstage: originalUnstage, stage: originalStage }); });

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
    expect(container.querySelector('.panel-toolbar [title="Rollback"]')).not.toBeInTheDocument();
    expect(screen.getByTitle('More Actions...')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('More Actions...'));
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
    expect(screen.queryByText('Amend last commit')).not.toBeInTheDocument();
    expect(screen.getByTitle('Amend last commit for Repository')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /Repository/ }));
    expect(screen.getAllByText('No changes')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Empty Two/ }));
    expect(screen.getAllByText('No changes')).toHaveLength(2);
    fireEvent.click(screen.getByTitle('More Actions...'));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByText('No changes')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('More Actions...'));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByText('No changes')).toHaveLength(2);
  });

  it('keeps repository expansion unchanged when browsing its branch menu', async () => {
    const branches = ['main', 'topic'].map((name) => ({ name, current: name === 'main', remote: false, upstream: null, ahead: 0, behind: 0 }));
    const menuBridge = new MockBridge((command) => command.type === 'branches' ? branches : []);
    useAppStore.setState({ bootstrap: bootstrap(false), snapshot: gitSnapshot, selectedRepoId: 'repo', branchesByRepo: { repo: branches }, tagsByRepo: {} });
    render(<BridgeContext.Provider value={menuBridge}><CommitPanel /></BridgeContext.Provider>);
    const repositoryToggle = screen.getByRole('button', { name: 'Repository' });
    expect(repositoryToggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByTitle('Switch branch'));
    const branchMenu = screen.getByRole('dialog', { name: 'Repository — Branches' });
    await waitFor(() => expect(within(branchMenu).getByRole('option', { name: 'topic' })).toBeInTheDocument());
    fireEvent.click(within(branchMenu).getByRole('option', { name: 'topic' }));
    expect(screen.getByRole('dialog', { name: 'topic — Repository' })).toBeInTheDocument();
    expect(repositoryToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('No changes')).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('dialog', { name: 'topic — Repository' })).getByRole('button', { name: 'Back' }));
    expect(repositoryToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(within(branchMenu).getByText('LOCAL'));
    expect(repositoryToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.change(within(branchMenu).getByRole('combobox'), { target: { value: 'topic' } });
    fireEvent.click(within(branchMenu).getByRole('button', { name: 'Clear search' }));
    expect(repositoryToggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.pointerDown(document.body);
    fireEvent.click(repositoryToggle);
    expect(repositoryToggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByTitle('Switch branch'));
    const reopenedMenu = screen.getByRole('dialog', { name: 'Repository — Branches' });
    fireEvent.click(within(reopenedMenu).getByRole('option', { name: 'topic' }));
    expect(repositoryToggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows a mixed expansion state after a repository is toggled manually', () => {
    const changedRepo = { ...gitRepo, files: [{ path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true, conflicted: false }] };
    useAppStore.setState({ bootstrap: bootstrap(false), snapshot: { ...gitSnapshot, repositories: [changedRepo] }, selectedRepoId: 'repo' });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Repository/ }));
    fireEvent.click(screen.getByTitle('More Actions...'));

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
    expect(screen.queryByRole('tab', { name: 'Stash' })).not.toBeInTheDocument();
    useAppStore.setState({ bootstrap: bootstrap(true) });
    rerender(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    expect(screen.getByRole('tab', { name: 'Stash' })).toBeInTheDocument();
    expect(screen.queryByText('AI Commit Message')).not.toBeInTheDocument();
  });

  it('persists a stash view mode independently from the changes view', () => {
    const data = bootstrap(true);
    data.state.layout = { panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'stash', fileViewMode: 'tree', stashViewMode: 'tree', branchSidebarCollapsed: false, branchSidebarCollapsedSections: [] };
    useAppStore.setState({ bootstrap: data, snapshot: gitSnapshot, selectedRepoId: 'repo' });
    renderPanel();
    fireEvent.click(screen.getByTitle('More Actions...'));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'View options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Flat list' }));
    expect(useAppStore.getState().bootstrap?.state.layout?.stashViewMode).toBe('list');
    expect(useAppStore.getState().bootstrap?.state.layout?.fileViewMode).toBe('tree');
  });

  it('keeps keyboard search owned by the visible tab after visiting saved-change tabs', async () => {
    useAppStore.setState({ bridge, bootstrap: bootstrap(true, true), snapshot: gitSnapshot, stashes: { repo: [] }, shelves: { repo: [] } });
    const { container } = renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Shelf' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Stash' }));
    const activeTab = screen.getByRole('tab', { name: 'Stash' });
    activeTab.focus();
    fireEvent.keyDown(activeTab, { key: 'x' });
    await waitFor(() => expect(container.querySelector('.stash-tab-content .speed-search-indicator')).toHaveTextContent('x'));
    expect(container.querySelector('.shelf-tab-content .speed-search-indicator')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    await waitFor(() => expect(container.querySelector('.stash-tab-content .speed-search-indicator')).not.toBeInTheDocument());
  });

  it('refreshes panel status and stash data once without reloading the workspace log', async () => {
    const data = bootstrap(true);
    data.state.layout = { panelSizes: { commit: 360, branches: 220, detail: 380 }, activeTab: 'stash', fileViewMode: 'tree', stashViewMode: 'tree', branchSidebarCollapsed: false, branchSidebarCollapsedSections: [] };
    const refresh = vi.fn().mockResolvedValue(undefined);
    const loadStashes = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ bootstrap: data, snapshot: gitSnapshot, selectedRepoId: 'repo', stashes: { repo: [] }, refresh, loadStashes });
    renderPanel();
    loadStashes.mockClear();
    fireEvent.click(screen.getByTitle('VersionDock: Refresh Commit Panel'));
    await waitFor(() => expect(loadStashes).toHaveBeenCalledOnce());
    expect(refresh).toHaveBeenCalledExactlyOnceWith(false, { reloadRepository: false });
  });

  it('shows shelf only after its storage and backend capability is enabled', () => {
    useAppStore.setState({ bootstrap: bootstrap(false, true) });
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Shelf' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Stash' })).not.toBeInTheDocument();
  });

  it('hides Subtree until enabled, then opens its real panel', () => {
    useAppStore.setState({ bridge, bootstrap: bootstrap(false, false), snapshot: gitSnapshot, selectedRepoId: 'repo', subtrees: {} });
    const { rerender } = renderPanel();
    expect(screen.queryByRole('tab', { name: 'Subtrees' })).not.toBeInTheDocument();
    useAppStore.setState({ bootstrap: bootstrap(false, false, true), subtrees: {} });
    rerender(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Subtrees' }));
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
    expect(screen.getByText('Checking...')).toBeInTheDocument();
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
    const tabs = Array.from(container.querySelectorAll('.commit-tabs button')).map((button) => button.getAttribute('aria-label'));
    expect(tabs).toEqual(['Changes', 'Shelf', 'Stash', 'Submodules', 'Worktrees', 'Subtrees', 'Sync']);
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
    expect(screen.getByTitle('VersionDock: Update Project')).toBeInTheDocument();
    expect(screen.getByTitle('VersionDock: Refresh Commit Panel')).toBeInTheDocument();
    expect(screen.getByTitle('VersionDock: Settings')).toBeInTheDocument();
    expect(container.querySelector('.commit-tabs')).not.toBeInTheDocument();
    expect(screen.getByText('origin/feature vs Working Tree')).toBeInTheDocument();
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

  it('migrates the push tab to sync while AI stays hidden', async () => {
    const pushBridge = new MockBridge((command) => command.type === 'unpushedCommits' ? [{ hash: 'abc', shortHash: 'abc', message: 'local commit', author: 'Test', date: '2026-08-13T00:00:00Z', filesChanged: 1, additions: 2, deletions: 0 }] : []);
    useAppStore.setState({ bridge: pushBridge, bootstrap: { ...bootstrap(false), state: { ...bootstrap(false).state, activeTab: 'push' } }, snapshot: { ...gitSnapshot, repositories: [{ ...gitRepo, ahead: 1 }] }, selectedRepoId: 'repo', unpushedCommits: {} });
    render(<BridgeContext.Provider value={pushBridge}><CommitPanel /></BridgeContext.Provider>);
    expect(screen.getByRole('tab', { name: 'Sync' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('local commit')).toBeInTheDocument());
    expect(screen.queryByText('AI Commit Message')).not.toBeInTheDocument();
    expect(screen.queryByText('AI Code Review')).not.toBeInTheDocument();
  });

  it('matches the VersionDock file, folder, and repository context menus', async () => {
    const diffRequests: boolean[] = [];
    const shelfRequests: string[][] = [];
    const menuBridge = new MockBridge((command) => {
      if (command.type === 'shelfOperation' && command.payload.operation.type === 'create') shelfRequests.push(command.payload.operation.paths ?? []);
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
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('src/file.ts'));
    fireEvent.contextMenu(container.querySelector('.repo-heading')!);
    fireEvent.click(screen.getByText('Shelve Changes'));
    await waitFor(() => expect(shelfRequests).toEqual([['src/file.ts']]));
  });

  it('keeps the gitlink menu focused and exposes the dedicated Submodule tab', () => {
    const submoduleRepo = { ...gitRepo, files: [{ path: 'vendor/module', status: 'submodule', staged: false, unstaged: true, conflicted: false, submodule: true }] };
    useAppStore.setState({ bridge, bootstrap: bootstrap(true, true, true, true), snapshot: { ...gitSnapshot, repositories: [submoduleRepo] }, selectedRepoId: 'repo', submodules: { repo: [{ name: 'module', path: 'vendor/module', url: 'https://example.test/module.git', initialized: true, revision: 'abcdef1', branch: 'main', dirty: true, syncStatus: 'outOfSync', recordedCommit: '1234567', currentBranch: 'main', detached: false, unpushedCount: 0 }] } });
    const { container } = render(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    expect(Array.from(container.querySelectorAll('.commit-tabs button')).map((button) => button.getAttribute('aria-label'))).toContain('Submodules');
    fireEvent.contextMenu(screen.getByTitle('vendor/module').closest('.file-row')!);
    expect(screen.getByText('Stage')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.queryByText('Update Submodule')).not.toBeInTheDocument();
    expect(screen.queryByText('Show Diff')).not.toBeInTheDocument();
  });

  it('supports select all / invert selection and manage remote accounts from the panel toolbar', async () => {
    const changedRepo = {
      ...gitRepo,
      files: [
        { path: 'src/file1.ts', status: 'modified' as const, staged: false, unstaged: true, conflicted: false },
        { path: 'src/file2.ts', status: 'modified' as const, staged: false, unstaged: true, conflicted: false },
      ],
    };
    useAppStore.setState({
      bridge,
      bootstrap: bootstrap(false),
      snapshot: { ...gitSnapshot, repositories: [changedRepo] },
      selectedRepoId: 'repo',
      commitSelections: {},
    });
    const { container } = render(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);

    // 1. 验证顶栏中的全选按钮
    const selectAllBtn = container.querySelector('.panel-toolbar button[title="VersionDock: Select All"]');
    expect(selectAllBtn).toBeInTheDocument();
    expect(selectAllBtn?.querySelector('.custom-icon')).toBeInTheDocument();

    // 点击全选
    fireEvent.click(selectAllBtn!);
    expect(useAppStore.getState().commitSelections['repo']).toEqual(['src/file1.ts', 'src/file2.ts']);

    // 全选后变为反选
    const invertBtn = container.querySelector('.panel-toolbar button[title="VersionDock: Invert Selection"]');
    expect(invertBtn).toBeInTheDocument();
    expect(invertBtn?.querySelector('.custom-icon')).toBeInTheDocument();

    // 点击反选
    fireEvent.click(invertBtn!);
    expect(useAppStore.getState().commitSelections['repo'] ?? []).toEqual([]);

    // 2. 验证顶栏管理远端账号按钮
    const remoteAccountsBtn = container.querySelector('.panel-toolbar button[title="VersionDock: Manage Remote Accounts (GitHub / GitLab / Gitee)"]');
    expect(remoteAccountsBtn).toBeInTheDocument();
    expect(remoteAccountsBtn?.querySelector('.codicon-account')).toBeInTheDocument();

    // 点击打开远端平台面板
    fireEvent.click(remoteAccountsBtn!);
    expect(screen.getByRole('dialog', { name: 'Remote Providers' })).toBeInTheDocument();

    // 3. 验证更多菜单中不再包含全选和反选
    const moreBtn = container.querySelector('.panel-toolbar button[title="More Actions..."]');
    expect(moreBtn).toBeInTheDocument();
    fireEvent.click(moreBtn!);
    expect(screen.queryByText('VersionDock: Select All', { selector: '.view-options-menu *' })).not.toBeInTheDocument();
    expect(screen.queryByText('VersionDock: Invert Selection', { selector: '.view-options-menu *' })).not.toBeInTheDocument();
  });

  it('calculates commit targets for pure SVN workspace in VS Code mode', async () => {
    const svnRepo: RepositoryStatus = {
      meta: { id: 'svn-repo', name: 'SVN Repo', rootPath: '/tmp/svn', color: '#ce9178', kind: 'svn', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
      branch: 'trunk',
      revision: '10',
      ahead: 0,
      behind: 0,
      files: [
        { path: 'doc.txt', status: 'modified', staged: false, unstaged: true, conflicted: false },
      ],
      conflicts: 0,
      operation: null,
    };
    const otherRepo: RepositoryStatus = {
      ...svnRepo,
      meta: { ...svnRepo.meta, id: 'other-repo', name: 'Other Repo' },
      files: [
        { path: 'other.txt', status: 'modified', staged: false, unstaged: true, conflicted: false },
      ],
    };
    const baseBootstrap = bootstrap(false);
    useAppStore.setState({
      bridge,
      bootstrap: {
        ...baseBootstrap,
        state: {
          ...baseBootstrap.state,
          settings: {
            theme: 'system',
            language: 'system',
            uiFontSize: 'standard',
            changesDisplayMode: 'vscode',
            defaultCommitAction: 'commitAndPush',
            defaultSaveAction: 'stash',
            promptBeforeAddingUntracked: true,
            suppressDivergedWarning: false,
            autoRefreshInterval: 0,
            fetchOnStartup: false,
            resetViewLocationsOnStartup: false,
            notifyIncomingCommits: false,
            notifyUnpushedCommits: false,
            repositoryScanDepth: 4,
            ignoredFolders: [],
            maximumGraphCommits: 1000,
            projectColors: {},
            externalEditor: null,
          },
        },
      },
      snapshot: { ...gitSnapshot, repositories: [svnRepo, otherRepo] },
      selectedRepoId: 'svn-repo',
    });

    const { container } = renderPanel();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Commit & Push' })).not.toBeInTheDocument();
    expect(container.querySelectorAll('.commit-action > button')).toHaveLength(1);
    // 纯 SVN 模式下不应该渲染暂存区
    expect(screen.queryByText('Staged Changes')).not.toBeInTheDocument();
    // Changes 区分组应存在并列出文件
    expect(screen.getByText('Changes')).toBeInTheDocument();
    expect(screen.getByText('doc.txt')).toBeInTheDocument();
    // 提交目标 Pill 应显示 SVN Repo
    expect(container.querySelector('.commit-targets em')).toHaveTextContent('SVN Repo');
  });

  it('retains draft message and does not record history when batchCommit fails', async () => {
    const failingBridge = new MockBridge(async (request) => {
      if (request.type === 'batchCommit') {
        throw new Error('IPC failed');
      }
      return [];
    });
    const changedRepo = { ...gitRepo, files: [{ path: 'src/App.tsx', status: 'modified', staged: true, unstaged: false, conflicted: false }] };
    useAppStore.setState({
      bridge: failingBridge,
      bootstrap: bootstrap(false),
      snapshot: { ...gitSnapshot, repositories: [changedRepo] },
      selectedRepoId: 'repo',
      commitMessage: 'WIP draft commit message',
      commitSelections: { repo: ['src/App.tsx'] },
    });

    render(<BridgeContext.Provider value={failingBridge}><CommitPanel /></BridgeContext.Provider>);
    const commitBtn = screen.getByRole('button', { name: 'Commit' });
    fireEvent.click(commitBtn);

    await waitFor(() => {
      // 提交失败时，提交草稿必须被保留，不能被清空
      expect(useAppStore.getState().commitMessage).toBe('WIP draft commit message');
    });
  });

  it('removes SVN repository from commit targets when clicking close on its target tag in vscode mode', () => {
    const svnRepo: RepositoryStatus = {
      meta: {
        id: 'svn-repo',
        name: 'SVN Repo',
        rootPath: '/tmp/svn',
        color: '#3794ff',
        kind: 'svn',
        parentRepoId: null,
        depth: 0,
        isSubmodule: false,
        isWorktree: false,
      },
      branch: '',
      revision: 'r10',
      ahead: 0,
      behind: 0,
      files: [{ path: 'doc.txt', status: 'modified', staged: false, unstaged: true, conflicted: false }],
      conflicts: 0,
      operation: null,
    };

    const otherRepo: RepositoryStatus = {
      meta: {
        id: 'other-repo',
        name: 'Other Repo',
        rootPath: '/tmp/other',
        color: '#4ec9b0',
        kind: 'git',
        parentRepoId: null,
        depth: 0,
        isSubmodule: false,
        isWorktree: false,
      },
      branch: 'main',
      revision: 'def',
      ahead: 0,
      behind: 0,
      files: [{ path: 'other.txt', status: 'modified', staged: true, unstaged: false, conflicted: false }],
      conflicts: 0,
      operation: null,
    };

    useAppStore.setState({
      bootstrap: {
        ...bootstrap(false),
        state: {
          ...bootstrap(false).state,
          settings: {
            theme: 'system',
            language: 'system',
            uiFontSize: 'standard',
            changesDisplayMode: 'vscode',
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
            ignoredFolders: [],
            maximumGraphCommits: 1000,
            projectColors: {},
            externalEditor: null,
          },
        },
      },
      snapshot: { ...gitSnapshot, repositories: [svnRepo, otherRepo] },
      selectedRepoId: 'svn-repo',
    });

    renderPanel();
    const removeBtn = screen.getByTitle('Remove SVN Repo');
    expect(removeBtn).toBeInTheDocument();
    fireEvent.click(removeBtn);
    expect(screen.queryByTitle('Remove SVN Repo')).not.toBeInTheDocument();
    expect(screen.getByTitle('Remove Other Repo')).toBeInTheDocument();
  });

  it('removes Git repository from commit targets without calling unstage when clicking close in vscode mode', () => {
    const unstageMock = vi.fn();
    useAppStore.setState({ unstage: unstageMock });

    const gitRepo1: RepositoryStatus = {
      meta: {
        id: 'git-repo-1',
        name: 'Repo 1',
        rootPath: '/tmp/repo1',
        color: '#4ec9b0',
        kind: 'git',
        parentRepoId: null,
        depth: 0,
        isSubmodule: false,
        isWorktree: false,
      },
      branch: 'main',
      revision: '111',
      ahead: 0,
      behind: 0,
      files: [{ path: 'file1.ts', status: 'modified', staged: true, unstaged: false, conflicted: false }],
      conflicts: 0,
      operation: null,
    };

    const gitRepo2: RepositoryStatus = {
      meta: {
        id: 'git-repo-2',
        name: 'Repo 2',
        rootPath: '/tmp/repo2',
        color: '#3794ff',
        kind: 'git',
        parentRepoId: null,
        depth: 0,
        isSubmodule: false,
        isWorktree: false,
      },
      branch: 'main',
      revision: '222',
      ahead: 0,
      behind: 0,
      files: [{ path: 'file2.ts', status: 'modified', staged: true, unstaged: false, conflicted: false }],
      conflicts: 0,
      operation: null,
    };

    useAppStore.setState({
      bootstrap: {
        ...bootstrap(false),
        state: {
          ...bootstrap(false).state,
          settings: {
            theme: 'system',
            language: 'system',
            uiFontSize: 'standard',
            changesDisplayMode: 'vscode',
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
            ignoredFolders: [],
            maximumGraphCommits: 1000,
            projectColors: {},
            externalEditor: null,
          },
        },
      },
      snapshot: { ...gitSnapshot, repositories: [gitRepo1, gitRepo2] },
      selectedRepoId: 'git-repo-1',
    });

    renderPanel();
    const removeBtn = screen.getByTitle('Remove Repo 2');
    expect(removeBtn).toBeInTheDocument();
    fireEvent.click(removeBtn);

    // Repo 2 target is removed, Repo 1 remains
    expect(screen.queryByTitle('Remove Repo 2')).not.toBeInTheDocument();
    expect(screen.getByTitle('Remove Repo 1')).toBeInTheDocument();
    // unstage must NOT be called
    expect(unstageMock).not.toHaveBeenCalled();

    // Repo 2 checkbox in staged section should now be unchecked
    const checkboxes = screen.getAllByTitle('Include this repository in the commit') as HTMLInputElement[];
    const repo2Checkbox = checkboxes[1];
    expect(repo2Checkbox.checked).toBe(false);

    // Click checkbox to re-include Repo 2 into commit targets (operation closed-loop)
    fireEvent.click(repo2Checkbox);
    expect(screen.getByTitle('Remove Repo 2')).toBeInTheDocument();
  });

  it('prompts confirmDialog before staging single truncated SVN directory and only stages if confirmed', async () => {
    const stageMock = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ stage: stageMock });
    const confirmSpy = vi.spyOn(dialogService, 'confirmDialog');

    const svnRepoTruncated: RepositoryStatus = {
      meta: {
        id: 'svn-trunc-repo',
        name: 'SVN Trunc Repo',
        rootPath: '/tmp/svn-trunc',
        color: '#3794ff',
        kind: 'svn',
        parentRepoId: null,
        depth: 0,
        isSubmodule: false,
        isWorktree: false,
      },
      branch: '',
      revision: 'r99',
      ahead: 0,
      behind: 0,
      files: [{ path: 'deep-folder', status: 'untracked', staged: false, unstaged: true, conflicted: false, isTruncated: true }],
      conflicts: 0,
      operation: null,
    };

    useAppStore.setState({
      bootstrap: {
        ...bootstrap(false),
        state: {
          ...bootstrap(false).state,
          settings: {
            theme: 'system',
            language: 'system',
            uiFontSize: 'standard',
            changesDisplayMode: 'vscode',
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
            ignoredFolders: [],
            maximumGraphCommits: 1000,
            projectColors: {},
            externalEditor: null,
          },
        },
      },
      snapshot: { ...gitSnapshot, repositories: [svnRepoTruncated] },
      selectedRepoId: 'svn-trunc-repo',
    });

    renderPanel();

    // 1. User cancels confirmDialog
    confirmSpy.mockResolvedValueOnce(false);
    const fileRow = screen.getByText('deep-folder').closest('.file-item')!;
    fireEvent.mouseEnter(fileRow);
    const addBtn = screen.getByTitle('Add directory recursively to SVN');
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
    });
    expect(stageMock).not.toHaveBeenCalled();

    // 2. User accepts confirmDialog
    confirmSpy.mockClear();
    confirmSpy.mockResolvedValueOnce(true);
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
      expect(stageMock).toHaveBeenCalledWith('svn-trunc-repo', ['deep-folder'], true);
    });
  });

  it('resizes commit textarea with arrow keys on grip and persists height to localStorage', () => {
    localStorage.clear();
    useAppStore.setState({ bootstrap: bootstrap(false), snapshot: gitSnapshot, selectedRepoId: 'repo' });
    renderPanel();

    const grip = screen.getByLabelText('Resize commit message');
    expect(grip).toBeInTheDocument();

    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    const persisted = localStorage.getItem('versiondock:commit-message-textarea-height');
    expect(persisted).toBeTruthy();
    expect(Number(persisted)).toBeGreaterThanOrEqual(52);
  });

  it('orders commit targets deeper first so submodules are committed before parent repositories', async () => {
    const parentRepo: RepositoryStatus = {
      meta: {
        id: 'parent',
        name: 'Parent Repository',
        rootPath: '/tmp/parent',
        color: '#4ec9b0',
        kind: 'git',
        parentRepoId: null,
        depth: 0,
        isSubmodule: false,
        isWorktree: false,
      },
      branch: 'main',
      revision: 'abc',
      ahead: 0,
      behind: 0,
      files: [{ path: 'parent.txt', status: 'modified', staged: false, unstaged: true, conflicted: false }],
      conflicts: 0,
      operation: null,
    };
    const submoduleRepo: RepositoryStatus = {
      meta: {
        id: 'submodule',
        name: 'Submodule Repository',
        rootPath: '/tmp/parent/sub',
        color: '#569cd6',
        kind: 'git',
        parentRepoId: 'parent',
        depth: 1,
        isSubmodule: true,
        isWorktree: false,
      },
      branch: 'main',
      revision: 'def',
      ahead: 0,
      behind: 0,
      files: [{ path: 'sub.txt', status: 'modified', staged: false, unstaged: true, conflicted: false }],
      conflicts: 0,
      operation: null,
    };

    let receivedTargets: any[] = [];
    const mockCommitMany = vi.fn().mockImplementation(async (targets: any[]) => {
      receivedTargets = targets;
      return targets.map((t) => ({ repoId: t.repoId, committed: true, error: null }));
    });

    useAppStore.setState({
      bootstrap: bootstrap(false),
      snapshot: {
        ...gitSnapshot,
        // 扫描顺序中父仓库排在子模块前面
        repositories: [parentRepo, submoduleRepo],
      },
      selectedRepoId: 'parent',
      commitMessage: 'feat: multi-repo commit',
      commitMany: mockCommitMany,
      commitSelections: {
        parent: ['parent.txt'],
        submodule: ['sub.txt'],
      },
    });

    renderPanel();

    const commitBtn = screen.getByRole('button', { name: /^Commit$/ });
    fireEvent.click(commitBtn);

    await waitFor(() => {
      expect(mockCommitMany).toHaveBeenCalled();
    });

    // 验证子模块 (depth: 1) 排在父仓库 (depth: 0) 之前提交
    expect(receivedTargets.map((t) => t.repoId)).toEqual(['submodule', 'parent']);
  });

  it('renders conflict action popup with full title, description and detail aligned with plugin', () => {
    const conflictedRepo: RepositoryStatus = {
      ...gitRepo,
      operation: 'merge',
      conflicts: 1,
      files: [{ path: 'file.txt', status: 'modified', staged: false, unstaged: false, conflicted: true }],
    };
    useAppStore.setState({
      bootstrap: bootstrap(false),
      snapshot: { ...gitSnapshot, repositories: [conflictedRepo] },
      selectedRepoId: 'repo',
    });

    renderPanel();

    const triggerBtn = screen.getByRole('button', { name: 'VersionDock: Resolve Conflicts' });
    expect(triggerBtn).toBeInTheDocument();

    // 点击打开弹窗
    fireEvent.click(triggerBtn);

    // 验证弹窗标题与副标题
    expect(screen.getByText('VersionDock: There are still unresolved conflicts')).toBeInTheDocument();
    expect(screen.getByText('Select an action to resolve or handle conflicts')).toBeInTheDocument();

    // 验证第一项：解决冲突，以及其统计描述和详情
    expect(screen.getByRole('menuitem', { name: /Resolve Conflicts/ })).toBeInTheDocument();
    expect(screen.getByText('1 repository · 1 unresolved conflict file')).toBeInTheDocument();
    expect(screen.getByText('Open the conflicts panel to resolve files')).toBeInTheDocument();

    // 验证第二项：中止合并及其描述详情
    expect(screen.getByRole('menuitem', { name: /Abort Merge/ })).toBeInTheDocument();
    expect(document.querySelector('.conflict-action-item.danger .conflict-action-item__desc')).toHaveTextContent('Repository');
    expect(screen.getByText('Merge in progress — abort and restore previous state')).toBeInTheDocument();

    // 按 Escape 键可以关闭弹窗
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('VersionDock: There are still unresolved conflicts')).not.toBeInTheDocument();
  });

  it('renders correct abort label and confirm label for cherry-pick and revert operations', async () => {
    const cherryPickRepo: RepositoryStatus = {
      ...gitRepo,
      operation: 'cherry-pick',
      conflicts: 1,
      files: [{ path: 'file.txt', status: 'modified', staged: false, unstaged: false, conflicted: true }],
    };
    const confirmSpy = vi.spyOn(dialogService, 'confirmDialog').mockResolvedValue(true);
    const abortRepositoryOperation = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      bootstrap: bootstrap(false),
      snapshot: { ...gitSnapshot, repositories: [cherryPickRepo] },
      selectedRepoId: 'repo',
      abortRepositoryOperation,
    });

    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'VersionDock: Resolve Conflicts' }));
    const abortItem = screen.getByRole('menuitem', { name: /Abort Cherry-pick/ });
    expect(abortItem).toBeInTheDocument();

    fireEvent.click(abortItem);
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmLabel: 'Abort Cherry-pick',
        }),
      );
    });
    confirmSpy.mockRestore();
  });

  it('renders continue button and allows continuing rebase when all conflicts are resolved', async () => {
    const resolvedRebaseRepo: RepositoryStatus = {
      ...gitRepo,
      operation: 'rebase',
      conflicts: 0,
      files: [{ path: 'file.txt', status: 'modified', staged: true, unstaged: false, conflicted: false }],
    };
    const continueRepositoryOperation = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      bootstrap: bootstrap(false),
      snapshot: { ...gitSnapshot, repositories: [resolvedRebaseRepo] },
      selectedRepoId: 'repo',
      continueRepositoryOperation,
    });

    renderPanel();

    const triggerBtn = screen.getByRole('button', { name: 'Continue Rebase' });
    expect(triggerBtn).toBeInTheDocument();

    fireEvent.click(triggerBtn);

    expect(screen.getByText('VersionDock: All conflicts resolved')).toBeInTheDocument();
    expect(screen.getByText('Continue or abort the repository operation')).toBeInTheDocument();

    const continueItem = screen.getByRole('menuitem', { name: /Continue Rebase/ });
    expect(continueItem).toBeInTheDocument();
    expect(screen.getByText('All conflicts resolved. Continue rebase to apply next commits.')).toBeInTheDocument();

    const abortItem = screen.getByRole('menuitem', { name: /Abort Rebase/ });
    expect(abortItem).toBeInTheDocument();

    fireEvent.click(continueItem);
    await waitFor(() => {
      expect(continueRepositoryOperation).toHaveBeenCalledWith('repo', 'rebase');
    });
  });
});
