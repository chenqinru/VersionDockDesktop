import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StashPanel, type StashItem } from './StashPanel';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';

const gitRepo1: RepositoryStatus = {
  meta: {
    id: 'repo-1',
    name: 'ADMIN-WEB',
    rootPath: '/tmp/admin-web',
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
  files: [{ path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true, conflicted: false }],
  conflicts: 0,
  operation: null,
};

const gitRepo2: RepositoryStatus = {
  meta: {
    id: 'repo-2',
    name: 'BACKEND-SERVICE',
    rootPath: '/tmp/backend-service',
    color: '#569cd6',
    kind: 'git',
    parentRepoId: null,
    depth: 0,
    isSubmodule: false,
    isWorktree: false,
  },
  branch: 'feature/login',
  revision: 'def',
  ahead: 0,
  behind: 0,
  files: [],
  conflicts: 0,
  operation: null,
};

const sampleStashes: StashItem[] = [
  {
    reference: 'stash@{0}',
    hash: 'hash001',
    branch: 'main',
    message: 'fix login navigation layout',
    fullMessage: 'fix login navigation layout\n\n- Fix button padding\n- Align icons',
    date: '2026-08-20T08:00:00Z',
    files: [
      { path: 'src/components/LoginModal.tsx', status: 'modified' },
      { path: 'src/components/Avatar.tsx', status: 'added' },
    ],
  },
];

const snapshot = {
  workspace: { id: 'workspace-1', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true },
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
  repositories: [gitRepo1, gitRepo2],
};

afterEach(() => {
  cleanup();
  useAppStore.setState({ stashes: {}, snapshot: undefined, bridge: undefined });
});

describe('StashPanel', () => {
  it('renders repository headers and empty stash state for multi repo', () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({ bridge, snapshot });
    render(
      <BridgeContext.Provider value={bridge}>
        <StashPanel repos={[gitRepo1, gitRepo2]} selectedPaths={new Map()} />
      </BridgeContext.Provider>,
    );

    expect(screen.getByText('ADMIN-WEB')).toBeInTheDocument();
    expect(screen.getByText('BACKEND-SERVICE')).toBeInTheDocument();
    expect(screen.getAllByText('No stashes').length).toBe(2);
  });

  it('renders stash item with branch badge and files in tree view', () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({ bridge, snapshot, stashes: { 'repo-1': sampleStashes } });

    render(
      <BridgeContext.Provider value={bridge}>
        <StashPanel
          repos={[gitRepo1, gitRepo2]}
          selectedPaths={new Map()}
          viewMode="tree"
          expansion={{ sequence: 1, expanded: true }}
        />
      </BridgeContext.Provider>,
    );

    expect(screen.getByText('fix login navigation layout')).toBeInTheDocument();
    expect(screen.getAllByText('main').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('2 files')).toBeInTheDocument();

    // Tree structure directory & file nodes
    expect(screen.getByText('src/components')).toBeInTheDocument();
    expect(screen.getByText('LoginModal.tsx')).toBeInTheDocument();
    expect(screen.getByText('Avatar.tsx')).toBeInTheDocument();
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders stash item in list view', () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({ bridge, snapshot, stashes: { 'repo-1': sampleStashes } });

    render(
      <BridgeContext.Provider value={bridge}>
        <StashPanel
          repos={[gitRepo1, gitRepo2]}
          selectedPaths={new Map()}
          viewMode="list"
          expansion={{ sequence: 1, expanded: true }}
        />
      </BridgeContext.Provider>,
    );

    expect(screen.getByText('LoginModal.tsx')).toBeInTheDocument();
    expect(screen.getByText('Avatar.tsx')).toBeInTheDocument();
    expect(screen.getAllByText('src/components').length).toBe(2);
  });

  it('invokes pop on double click', async () => {
    let requestedOperation: unknown = null;
    const bridge = new MockBridge((command) => {
      if (command.type === 'stashOperation') {
        requestedOperation = command.payload.operation;
      }
      return [];
    });
    useAppStore.setState({ bridge, snapshot, stashes: { 'repo-1': sampleStashes } });

    render(
      <BridgeContext.Provider value={bridge}>
        <StashPanel repos={[gitRepo1, gitRepo2]} selectedPaths={new Map()} />
      </BridgeContext.Provider>,
    );

    const titleEl = screen.getByText('fix login navigation layout');
    fireEvent.doubleClick(titleEl.closest('div[title*="double-click"]')!);

    expect(requestedOperation).toEqual({
      type: 'pop',
      reference: 'stash@{0}',
    });
  });

  it('triggers onOpenFileDiff when clicking file item', () => {
    const onOpenFileDiff = vi.fn();
    const bridge = new MockBridge(() => []);
    useAppStore.setState({ bridge, snapshot, stashes: { 'repo-1': sampleStashes } });

    render(
      <BridgeContext.Provider value={bridge}>
        <StashPanel
          repos={[gitRepo1]}
          selectedPaths={new Map()}
          viewMode="list"
          expansion={{ sequence: 1, expanded: true }}
          onOpenFileDiff={onOpenFileDiff}
        />
      </BridgeContext.Provider>,
    );

    const fileEl = screen.getByText('LoginModal.tsx');
    fireEvent.click(fileEl.closest('div')!);

    expect(onOpenFileDiff).toHaveBeenCalledWith(
      'repo-1',
      'stash@{0}',
      'src/components/LoginModal.tsx',
    );
  });

  it('opens a stash file diff from a file click without inventing a file context menu', () => {
    const onOpenFileDiff = vi.fn();
    const bridge = new MockBridge(() => []);
    useAppStore.setState({ bridge, snapshot, stashes: { 'repo-1': sampleStashes } });
    render(<BridgeContext.Provider value={bridge}><StashPanel repos={[gitRepo1]} viewMode="list" expansion={{ sequence: 1, expanded: true }} onOpenFileDiff={onOpenFileDiff} /></BridgeContext.Provider>);
    const row = screen.getByText('LoginModal.tsx').closest('div[title*="click to open diff"]')!;
    fireEvent.click(row);
    expect(onOpenFileDiff).toHaveBeenCalledWith('repo-1', 'stash@{0}', 'src/components/LoginModal.tsx');
    fireEvent.contextMenu(row);
    expect(screen.queryByText('Show Diff')).not.toBeInTheDocument();
  });
});
