import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorktreePanel } from './WorktreePanel';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus, WorktreeEntry } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { currentDialog, publishDialog } from './dialogService';

const gitRepo: RepositoryStatus = {
  meta: {
    id: 'repo-1',
    name: 'VersionDock',
    rootPath: '/tmp/VersionDock',
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
  files: [],
  conflicts: 0,
  operation: null,
};

const sampleWorktrees: WorktreeEntry[] = [
  {
    path: '/tmp/VersionDock',
    head: '06457b02',
    branch: 'main',
    bare: false,
    detached: false,
    locked: false,
    lockReason: null,
    prunable: false,
    main: true,
  },
];

const snapshot = {
  workspace: { id: 'workspace-1', name: 'Workspace', paths: ['/tmp/VersionDock'], lastOpenedAt: '', available: true },
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
  repositories: [gitRepo],
};
const originalWorktreeOperation = useAppStore.getState().worktreeOperation;

afterEach(() => {
  cleanup();
  publishDialog(undefined);
  useAppStore.setState({ worktrees: {}, worktreeDiff: undefined, snapshot: undefined, bridge: undefined, branchesByRepo: {}, worktreeOperation: originalWorktreeOperation, worktreeBusy: {} });
});

describe('WorktreePanel', () => {
  it('validates a managed worktree before opening a VersionDock window and keeps reveal in the backend', async () => {
    const commands: string[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(`${command.type}:${command.type === 'openWorktree' ? command.payload.reveal : ''}`);
      return command.type === 'openWorktree' ? '/tmp/VersionDock-linked' : true;
    });
    bridge.focusWorkspaceAcrossWindows = vi.fn(async () => false);
    bridge.openInNewWindow = vi.fn(async () => 'window-new');
    useAppStore.setState({ bridge, snapshot, allRepositories: [gitRepo] });
    await useAppStore.getState().openWorktree('repo-1', '/tmp/VersionDock-linked', false);
    await useAppStore.getState().openWorktree('repo-1', '/tmp/VersionDock-linked', true);
    expect(commands).toContain('openWorktree:false');
    expect(commands).toContain('openWorktree:true');
    expect(bridge.openInNewWindow).toHaveBeenCalledTimes(1);
  });
  it('renders repository and worktree item with main badge and branch badge', () => {
    const bridge = new MockBridge(() => sampleWorktrees);
    useAppStore.setState({
      bridge,
      snapshot,
      worktrees: { 'repo-1': sampleWorktrees },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <WorktreePanel repos={[gitRepo]} />
      </BridgeContext.Provider>
    );

    expect(screen.getAllByText('VersionDock')).toHaveLength(2);
    expect(screen.getAllByText('main')).toHaveLength(2);
  });

  it('renders multi-repo header with uppercase repo name when multiple repos exist', () => {
    const gitRepo2: RepositoryStatus = {
      ...gitRepo,
      meta: { ...gitRepo.meta, id: 'repo-2', name: 'OtherRepo' },
    };
    const bridge = new MockBridge(() => sampleWorktrees);
    useAppStore.setState({
      bridge,
      snapshot: { ...snapshot, repositories: [gitRepo, gitRepo2] },
      worktrees: { 'repo-1': sampleWorktrees, 'repo-2': [] },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <WorktreePanel repos={[gitRepo, gitRepo2]} />
      </BridgeContext.Provider>
    );

    expect(screen.getByText('OtherRepo')).toBeInTheDocument();
  });

  it.each([true, false])('keeps the busy indicator in its repository header with multiRepo=%s', (multiRepo) => {
    const gitRepo2: RepositoryStatus = { ...gitRepo, meta: { ...gitRepo.meta, id: 'repo-2', name: 'OtherRepo' } };
    useAppStore.setState({
      snapshot: { ...snapshot, repositories: [gitRepo, gitRepo2] },
      worktrees: { 'repo-1': sampleWorktrees, 'repo-2': [] },
      worktreeBusy: { 'workspace-1:repo-1': true },
    });
    render(<WorktreePanel repos={[gitRepo, gitRepo2]} multiRepo={multiRepo} />);

    const header = screen.getByRole('button', { name: 'VersionDock' }).parentElement!;
    const status = within(header).getByRole('status', { name: 'Worktree operation in progress…' });
    expect(status.querySelector('.codicon-loading.codicon-modifier-spin')).toBeInTheDocument();
    expect(status).toHaveAttribute('title', 'Worktree operation in progress…');
    expect(screen.queryByText('Worktree operation in progress…')).not.toBeInTheDocument();
    const otherHeader = screen.getByRole('button', { name: 'OtherRepo' }).parentElement!;
    expect(within(otherHeader).queryByRole('status')).not.toBeInTheDocument();
    const actionName = multiRepo ? 'Add worktree' : 'New Worktree';
    expect(screen.getAllByRole('button', { name: actionName })[0]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: actionName })[1]).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'VersionDock' }));
    expect(status).toBeVisible();
    act(() => useAppStore.setState({ worktreeBusy: {} }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'VersionDock' }));
    expect(screen.getAllByRole('button', { name: actionName })[0]).not.toBeDisabled();
  });

  it.each([
    [['/a/project', '/b/a/project'], ['/a', 'b/a']],
    [['/one/shared/project', '/two/shared/project/'], ['one/shared', 'two/shared']],
    [['C:\\a\\project', 'D:\\a\\project\\'], ['C:/a', 'D:/a']],
    [['/project', '/a/project'], ['/', 'a']],
  ])('disambiguates same-name worktrees by parent suffix: %j', (paths, labels) => {
    useAppStore.setState({ worktreeDiff: undefined });
    render(<WorktreePanel customRepos={[{
      repoId: 'repo-1', repoName: 'VersionDock', repoColor: '#4ec9b0', isLinkedWorktree: false,
      worktrees: [
        { path: '/main/project', head: 'abc', branch: 'main', branchShort: 'main', isMain: true, isDetached: false, isBare: false, isLocked: false, isPrunable: false, isInWorkspace: true },
        ...paths.map(path => ({ path, head: 'abc', branch: 'topic', branchShort: 'topic', isMain: false, isDetached: false, isBare: false, isLocked: false, isPrunable: false, isInWorkspace: false })),
      ],
    }]} />);
    expect(screen.getAllByText('project')).toHaveLength(3);
    labels.forEach((label, index) => expect(screen.getByText(label)).toHaveAttribute('title', paths[index]));
    expect(screen.queryByText('/main')).not.toBeInTheDocument();
  });

  it('renders empty state when no worktrees are loaded', () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({
      bridge,
      snapshot,
      worktrees: { 'repo-1': [] },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <WorktreePanel repos={[gitRepo]} />
      </BridgeContext.Provider>
    );

    expect(screen.getByText('No worktrees')).toBeInTheDocument();
  });

  it('matches the original worktree context menu without adding a diff entry', () => {
    const linked = { ...sampleWorktrees[0], path: '/tmp/managed-linked', branch: 'feature/worktree', main: false };
    const bridge = new MockBridge((command) => {
      if (command.type === 'worktreeDiff') return { path: command.payload.path, baseRef: command.payload.base_ref, currentRef: 'feature/worktree', files: [{ path: 'src/file.ts', status: 'M', added: 2, removed: 1 }] };
      if (command.type === 'worktrees') return [sampleWorktrees[0], linked];
      return true;
    });
    useAppStore.setState({ bridge, snapshot, worktrees: { 'repo-1': [sampleWorktrees[0], linked] } });
    render(<BridgeContext.Provider value={bridge}><WorktreePanel repos={[gitRepo]} /></BridgeContext.Provider>);
    fireEvent.contextMenu(screen.getAllByTitle('/tmp/managed-linked')[0]);
    expect(screen.getByText('Open in New Window')).toBeInTheDocument();
    expect(screen.getByText('Open in File Manager')).toBeInTheDocument();
    expect(screen.getByText('Lock')).toBeInTheDocument();
    expect(screen.getByText('Remove Worktree')).toBeInTheDocument();
    expect(screen.getByText('Force Remove')).toBeInTheDocument();
    expect(screen.queryByText('Open Worktree')).not.toBeInTheDocument();
    expect(screen.queryByText('Show Worktree Diff')).not.toBeInTheDocument();
  });

  it('requires confirmation before removing a worktree and blocks removal if cancelled', async () => {
    const linked = { ...sampleWorktrees[0], path: '/tmp/managed-linked', branch: 'feature/worktree', main: false };
    const worktreeOperation = vi.fn().mockResolvedValue(undefined);
    const bridge = new MockBridge((command) => command.type === 'worktreeRemovalInfo' ? {entry:linked, changedCount:0, ignoredCount:0, shelfCount:0} : command.type === 'worktrees' ? [sampleWorktrees[0], linked] : true);
    useAppStore.setState({ bridge, snapshot, worktrees: { 'repo-1': [sampleWorktrees[0], linked] }, worktreeOperation });
    render(<BridgeContext.Provider value={bridge}><WorktreePanel repos={[gitRepo]} /></BridgeContext.Provider>);
    fireEvent.contextMenu(screen.getAllByTitle('/tmp/managed-linked')[0]);
    fireEvent.click(screen.getByText('Remove Worktree'));

    await vi.waitFor(() => expect(currentDialog()?.kind).toBe('choice'));
    expect(currentDialog()?.danger).toBe(true);

    // 1. 用户取消
    currentDialog()?.resolve(null);
    await vi.waitFor(() => expect(screen.getByTitle('Add worktree')).not.toBeDisabled());
    expect(worktreeOperation).not.toHaveBeenCalled();

    publishDialog(undefined);
    // 2. 再次触发并确认
    fireEvent.contextMenu(screen.getAllByTitle('/tmp/managed-linked')[0]);
    fireEvent.click(screen.getByText('Remove Worktree'));
    await vi.waitFor(() => expect(currentDialog()?.kind).toBe('choice'));
    currentDialog()?.resolve('remove');

    await vi.waitFor(() => expect(worktreeOperation).toHaveBeenCalledWith('repo-1', { type: 'remove', path: '/tmp/managed-linked', force: false }));
  });

  it('requires explicit danger confirmation before force removing a worktree', async () => {
    const linked = { ...sampleWorktrees[0], path: '/tmp/managed-linked', branch: 'feature/worktree', main: false };
    const worktreeOperation = vi.fn().mockResolvedValue(undefined);
    const bridge = new MockBridge((command) => command.type === 'worktreeRemovalInfo' ? {entry:linked, changedCount:0, ignoredCount:0, shelfCount:0} : command.type === 'worktrees' ? [sampleWorktrees[0], linked] : true);
    useAppStore.setState({ bridge, snapshot, worktrees: { 'repo-1': [sampleWorktrees[0], linked] }, worktreeOperation });
    render(<BridgeContext.Provider value={bridge}><WorktreePanel repos={[gitRepo]} /></BridgeContext.Provider>);
    fireEvent.contextMenu(screen.getAllByTitle('/tmp/managed-linked')[0]);
    fireEvent.click(screen.getByText('Force Remove'));

    await vi.waitFor(() => expect(currentDialog()?.kind).toBe('choice'));
    expect(currentDialog()?.danger).toBe(true);
    expect(currentDialog()?.choices?.[0].label).toBe('Force Remove');

    // 用户确认
    currentDialog()?.resolve('remove');
    await vi.waitFor(() => expect(worktreeOperation).toHaveBeenCalledWith('repo-1', { type: 'remove', path: '/tmp/managed-linked', force: true }));
  });

  it('selects an existing branch for a new worktree like VersionDock', async () => {
    const worktreeOperation = vi.fn().mockResolvedValue(undefined);
    const bridge = new MockBridge((command) => command.type === 'branches' ? [{ name:'main', current:true, remote:false, upstream:null, ahead:0, behind:0 }, {name:'feature/ui', current:false, remote:false, upstream:null, ahead:0, behind:0}] : command.type === 'worktrees' ? sampleWorktrees : true);
    useAppStore.setState({
      bridge,
      snapshot,
      worktrees: { 'repo-1': sampleWorktrees },
      branchesByRepo: { 'repo-1': [
        { name: 'main', current: true, remote: false, upstream: null, ahead: 0, behind: 0 },
        { name: 'feature/ui', current: false, remote: false, upstream: null, ahead: 0, behind: 0 },
      ] },
      worktreeOperation,
    });
    render(<BridgeContext.Provider value={bridge}><WorktreePanel repos={[gitRepo]} /></BridgeContext.Provider>);
    fireEvent.click(screen.getByTitle('Add worktree'));
    await vi.waitFor(() => expect(currentDialog()?.kind).toBe('choice'));
    expect(currentDialog()?.compactChoices).toBe(true);
    expect(screen.getByRole('status', { name: 'Worktree operation in progress…' }).closest('.repository-group-header')).toBeInTheDocument();
    currentDialog()?.resolve('branch:1');
    await vi.waitFor(() => expect(currentDialog()?.kind).toBe('prompt'));
    expect(currentDialog()?.initialValue).toContain('--feature-ui');
    currentDialog()?.resolve('/tmp/custom-worktree');
    await vi.waitFor(() => expect(worktreeOperation).toHaveBeenCalledWith('repo-1', { type: 'create', path: '/tmp/custom-worktree', branch: 'feature/ui', new_branch: false, commitish: null, no_track: false }));
    await vi.waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});

describe('worktree safety and workflow ownership', () => {
  it('offers opening an occupied branch without creating another worktree', async () => {
    const write = vi.fn();
    const bridge = new MockBridge(command => command.type === 'branches' ? [{name:'main', remote:false}] : sampleWorktrees);
    useAppStore.setState({bridge, snapshot, worktrees:{'repo-1':sampleWorktrees}, worktreeOperation:write});
    render(<WorktreePanel repos={[gitRepo]} />);
    fireEvent.click(screen.getByTitle('Add worktree'));
    await vi.waitFor(() => expect(currentDialog()?.kind).toBe('choice'));
    currentDialog()?.resolve('branch:0');
    await vi.waitFor(() => expect(currentDialog()?.message).toContain('already used'));
    currentDialog()?.resolve(null);
    expect(write).not.toHaveBeenCalled();
  });
  it('counts ignored files before offering force removal', async () => {
    const linked = {...sampleWorktrees[0], path:'/tmp/managed-linked', main:false};
    const write = vi.fn();
    const bridge = new MockBridge(command => command.type === 'worktreeRemovalInfo' ? {entry:linked, changedCount:0, ignoredCount:2, shelfCount:0} : [sampleWorktrees[0], linked]);
    useAppStore.setState({bridge, snapshot, worktrees:{'repo-1':[sampleWorktrees[0], linked]}, worktreeOperation:write});
    render(<WorktreePanel repos={[gitRepo]} />);
    fireEvent.contextMenu(screen.getAllByTitle(linked.path)[0]); fireEvent.click(screen.getByText('Remove Worktree'));
    await vi.waitFor(() => expect(currentDialog()?.message).toContain('2 ignored entries'));
    currentDialog()?.resolve('remove');
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('repo-1', {type:'remove', path:linked.path, force:true}));
  });
  it('blocks removal when shelves exist', async () => {
    const linked = {...sampleWorktrees[0], path:'/tmp/managed-linked', main:false};
    const write = vi.fn();
    const bridge = new MockBridge(command => command.type === 'worktreeRemovalInfo' ? {entry:linked, changedCount:0, ignoredCount:0, shelfCount:1} : [sampleWorktrees[0], linked]);
    useAppStore.setState({bridge, snapshot, worktrees:{'repo-1':[sampleWorktrees[0], linked]}, worktreeOperation:write, notifications:[]});
    render(<WorktreePanel repos={[gitRepo]} />);
    fireEvent.contextMenu(screen.getAllByTitle(linked.path)[0]); fireEvent.click(screen.getByText('Force Remove'));
    await vi.waitFor(() => expect(useAppStore.getState().notifications.at(-1)?.message).toEqual({raw:expect.stringContaining('1 shelves')}));
    expect(write).not.toHaveBeenCalled();
  });
  it('fixes the starting commit before asking for a new name', async () => {
    const write = vi.fn();
    const requests: string[] = [];
    const bridge = new MockBridge(command => {
      requests.push(command.type);
      if (command.type === 'branches') return [];
      if (command.type === 'worktrees') return sampleWorktrees;
      if (command.type === 'tagResolveCommit') return 'a'.repeat(40);
      return true;
    });
    useAppStore.setState({bridge, snapshot, worktrees:{'repo-1':sampleWorktrees}, worktreeOperation:write});
    render(<WorktreePanel repos={[gitRepo]} />);
    fireEvent.click(screen.getByTitle('Add worktree'));
    await vi.waitFor(() => expect(currentDialog()?.kind).toBe('choice')); currentDialog()?.resolve('new');
    await vi.waitFor(() => expect(currentDialog()?.title).toContain('Starting Point')); currentDialog()?.resolve('HEAD');
    await vi.waitFor(() => expect(currentDialog()?.title).toContain('New Branch Name')); expect(requests).toContain('tagResolveCommit'); currentDialog()?.resolve('fix/test');
    await vi.waitFor(() => expect(currentDialog()?.title).toContain('Directory Path')); currentDialog()?.resolve('/tmp/new-worktree');
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('repo-1', expect.objectContaining({commitish:'a'.repeat(40), new_branch:true})));
  });
});
