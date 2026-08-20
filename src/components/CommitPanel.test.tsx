import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommitPanel } from './CommitPanel';
import { SubtreePanel } from './SubtreePanel';
import { buildFileTree } from './fileTree';
import { useAppStore } from '../store/appStore';
import type { BootstrapData, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';

const bootstrap = (stash: boolean, shelf = false, subtree = false, worktree = false): BootstrapData => ({
  state: { theme: 'system', language: 'system', uiFontSize: 'standard', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null },
  tools: { git: true, svn: true, svnadmin: true },
  capabilities: { ai: false, stash, shelf, changelist: false, worktree, subtree, compare: false, remoteManagement: false },
});
const bridge = new MockBridge(() => []);
const renderPanel = () => render(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
const gitRepo: RepositoryStatus = { meta: { id: 'repo', name: 'Repository', rootPath: '/tmp/repo', color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null };
const gitSnapshot: WorkspaceSnapshot = { workspace: { id: 'workspace', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true }, generation: 1, tools: { git: true, svn: true, svnadmin: true }, repositories: [gitRepo] };

afterEach(() => { cleanup(); useAppStore.setState({ bootstrap: undefined, snapshot: undefined, stashes: {}, shelves: {}, subtrees: {}, unpushedCommits: {} }); });

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
    expect(container.querySelector('.file-type-icon.tone-typescript')).toBeInTheDocument();
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

  it('matches the VersionDock toolbar and keeps commit metadata left aligned', () => {
    const changedRepo = { ...gitRepo, ahead: 1, files: [{ path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true, conflicted: false }] };
    const emptyRepo = { ...gitRepo, meta: { ...gitRepo.meta, id: 'empty', name: 'Empty' } };
    useAppStore.setState({ bootstrap: bootstrap(false), snapshot: { ...gitSnapshot, repositories: [changedRepo, emptyRepo] }, selectedRepoId: 'repo' });
    const { container } = renderPanel();
    expect(screen.getByTitle('Rollback')).toBeInTheDocument();
    expect(screen.getByTitle('Expand all')).toBeInTheDocument();
    expect(screen.getByTitle('Collapse all')).toBeInTheDocument();
    expect(screen.getByTitle('View options')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unstage' })).not.toBeInTheDocument();
    const parentRow = container.querySelector('.directory-row')!;
    const childRow = container.querySelector('.file-row')!;
    expect(parentRow).toHaveStyle({ paddingLeft: '20px' });
    expect(childRow).toHaveStyle({ paddingLeft: '40px' });
    fireEvent.click(screen.getByLabelText('src/App.tsx'));
    expect(container.querySelector('.commit-targets em')).toHaveTextContent('Repository');
    expect(screen.getByText('Amend')).toBeInTheDocument();
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
    fireEvent.click(screen.getByTitle('Collapse all'));
    expect(screen.queryByText('No changes')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Expand all'));
    expect(screen.getAllByText('No changes')).toHaveLength(2);
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
      commands.push(command.type === 'unstage' ? `unstage:${command.payload.repo_id}:${command.payload.paths.join(',')}` : command.type === 'commit' ? `commit:${command.payload.repo_id}:${command.payload.paths.join(',')}` : command.type);
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

  it('hides the stash surface until its real capability is enabled', () => {
    useAppStore.setState({ bootstrap: bootstrap(false) });
    const { rerender } = renderPanel();
    expect(screen.queryByTitle('Stash')).not.toBeInTheDocument();
    useAppStore.setState({ bootstrap: bootstrap(true) });
    rerender(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    expect(screen.getByTitle('Stash')).toBeInTheDocument();
    expect(screen.queryByText('AI Commit Message')).not.toBeInTheDocument();
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

  it('keeps the real push tab visible while AI stays hidden', async () => {
    const pushBridge = new MockBridge((command) => command.type === 'unpushedCommits' ? [{ hash: 'abc', shortHash: 'abc', message: 'local commit', author: 'Test', date: '2026-08-13T00:00:00Z', filesChanged: 1, additions: 2, deletions: 0 }] : []);
    useAppStore.setState({ bridge: pushBridge, bootstrap: { ...bootstrap(false), state: { ...bootstrap(false).state, activeTab: 'push' } }, snapshot: { ...gitSnapshot, repositories: [{ ...gitRepo, ahead: 1 }] }, selectedRepoId: 'repo', unpushedCommits: {} });
    render(<BridgeContext.Provider value={pushBridge}><CommitPanel /></BridgeContext.Provider>);
    expect(screen.getByTitle('Push')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('local commit')).toBeInTheDocument());
    expect(screen.queryByText('AI Commit Message')).not.toBeInTheDocument();
    expect(screen.queryByText('AI Code Review')).not.toBeInTheDocument();
  });
});
