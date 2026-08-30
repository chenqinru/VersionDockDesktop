import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorktreePanel } from './WorktreePanel';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus, WorktreeEntry } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';

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

afterEach(() => {
  cleanup();
  useAppStore.setState({ worktrees: {}, worktreeDiff: undefined, snapshot: undefined, bridge: undefined });
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
    fireEvent.contextMenu(screen.getByTitle('/tmp/managed-linked'));
    expect(screen.getByText('Open in New Window')).toBeInTheDocument();
    expect(screen.getByText('Open in File Manager')).toBeInTheDocument();
    expect(screen.getByText('Lock')).toBeInTheDocument();
    expect(screen.getByText('Remove Worktree')).toBeInTheDocument();
    expect(screen.getByText('Force Remove')).toBeInTheDocument();
    expect(screen.queryByText('Open Worktree')).not.toBeInTheDocument();
    expect(screen.queryByText('Show Worktree Diff')).not.toBeInTheDocument();
  });
});
