import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
  useAppStore.setState({ worktrees: {}, busy: false, snapshot: undefined, bridge: undefined });
});

describe('WorktreePanel', () => {
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
});
