import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubtreePanel } from './SubtreePanel';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus, SubtreeEntry } from '../bindings/generated';
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

const sampleSubtrees: SubtreeEntry[] = [
  {
    id: 'subtree-1',
    prefix: 'admin',
    remote: 'ssh://git@git.gsdzone.net:32022/tongji/admin.git',
    branch: 'chenqinru',
    squash: true,
    state: 'active',
  },
  {
    id: 'subtree-2',
    prefix: 'api',
    remote: 'ssh://git@git.gsdzone.net:32022/tongji/api.git',
    branch: 'chenqinru',
    squash: true,
    state: 'active',
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
  useAppStore.setState({ subtrees: {}, snapshot: undefined, bridge: undefined });
});

describe('SubtreePanel', () => {
  it('renders subtree items with name, squash badge, prefix, repo link, ref, and status badge', () => {
    const bridge = new MockBridge(() => sampleSubtrees);
    useAppStore.setState({
      bridge,
      snapshot,
      subtrees: { 'repo-1': sampleSubtrees },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <SubtreePanel repos={[gitRepo]} />
      </BridgeContext.Provider>
    );

    expect(screen.getAllByText('admin')).toHaveLength(2); // name & prefix
    expect(screen.getAllByText('api')).toHaveLength(2); // name & prefix
    expect(screen.getAllByText('squash')).toHaveLength(2);
    expect(screen.getAllByText('Checking...')).toHaveLength(2);
    expect(screen.getByText('ssh://git@git.gsdzone.net:32022/tongji/admin.git')).toBeInTheDocument();
    expect(screen.getByText('ssh://git@git.gsdzone.net:32022/tongji/api.git')).toBeInTheDocument();
    expect(screen.getAllByText('chenqinru')).toHaveLength(2);
  });

  it('renders repo header with uppercase name and action buttons for single repo by default', () => {
    const bridge = new MockBridge(() => sampleSubtrees);
    const onAdd = vi.fn();
    const onRegister = vi.fn();
    useAppStore.setState({
      bridge,
      snapshot,
      subtrees: { 'repo-1': sampleSubtrees },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <SubtreePanel repos={[gitRepo]} onAdd={onAdd} onRegister={onRegister} />
      </BridgeContext.Provider>
    );

    expect(screen.getByText('VersionDock')).toBeInTheDocument();
    const addBtn = screen.getByTitle('Add Subtree from Repository');
    const regBtn = screen.getByTitle('Register Existing Directory');
    expect(addBtn).toBeInTheDocument();
    expect(regBtn).toBeInTheDocument();

    fireEvent.click(addBtn);
    expect(onAdd).toHaveBeenCalledWith('repo-1');

    fireEvent.click(regBtn);
    expect(onRegister).toHaveBeenCalledWith('repo-1');
  });

  it('renders bottom action buttons when multiRepo is explicitly false', () => {
    const bridge = new MockBridge(() => sampleSubtrees);
    const onAdd = vi.fn();
    const onRegister = vi.fn();
    useAppStore.setState({
      bridge,
      snapshot,
      subtrees: { 'repo-1': sampleSubtrees },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <SubtreePanel repos={[gitRepo]} multiRepo={false} onAdd={onAdd} onRegister={onRegister} />
      </BridgeContext.Provider>
    );

    const addBtn = screen.getByRole('button', { name: /Add Subtree/i });
    const regBtn = screen.getByRole('button', { name: /Register Existing/i });
    expect(addBtn).toBeInTheDocument();
    expect(regBtn).toBeInTheDocument();

    fireEvent.click(addBtn);
    expect(onAdd).toHaveBeenCalledWith('repo-1');

    fireEvent.click(regBtn);
    expect(onRegister).toHaveBeenCalledWith('repo-1');
  });

  it('renders multi-repo headers with uppercase names and action buttons when multiple repos exist', () => {
    const gitRepo2: RepositoryStatus = {
      ...gitRepo,
      meta: { ...gitRepo.meta, id: 'repo-2', name: 'SocialPratice2' },
    };
    const bridge = new MockBridge(() => sampleSubtrees);
    useAppStore.setState({
      bridge,
      snapshot: { ...snapshot, repositories: [gitRepo, gitRepo2] },
      subtrees: { 'repo-1': sampleSubtrees, 'repo-2': [] },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <SubtreePanel repos={[gitRepo, gitRepo2]} />
      </BridgeContext.Provider>
    );

    expect(screen.getByText('VersionDock')).toBeInTheDocument();
    expect(screen.getByText('SocialPratice2')).toBeInTheDocument();
  });

  it('renders context menu on more button click or right click', () => {
    const bridge = new MockBridge(() => sampleSubtrees);
    const onPull = vi.fn();
    useAppStore.setState({
      bridge,
      snapshot,
      subtrees: { 'repo-1': [sampleSubtrees[0]] },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <SubtreePanel repos={[gitRepo]} onPull={onPull} />
      </BridgeContext.Provider>
    );

    const moreBtn = screen.getByTitle('More');
    fireEvent.click(moreBtn);

    expect(screen.getByText('Pull Subtree')).toBeInTheDocument();
    expect(screen.getByText('Push Subtree')).toBeInTheDocument();
    expect(screen.getByText('Split Subtree')).toBeInTheDocument();
    expect(screen.getByText('Merge Subtree')).toBeInTheDocument();
    expect(screen.getByText('Reveal Prefix')).toBeInTheDocument();
    expect(screen.getByText('Edit Registry')).toBeInTheDocument();
    expect(screen.getByText('Delete Registry')).toBeInTheDocument();
    expect(screen.getByText('Remove Subtree Files')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Pull Subtree'));
    expect(onPull).toHaveBeenCalledWith('subtree-1');
  });

  it('renders empty state when no subtrees are registered', () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({
      bridge,
      snapshot,
      subtrees: { 'repo-1': [] },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <SubtreePanel repos={[gitRepo]} />
      </BridgeContext.Provider>
    );

    expect(screen.getByText('No subtrees registered')).toBeInTheDocument();
  });
});
