import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShelfPanel } from './ShelfPanel';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus, ShelfEntry } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';

const gitRepo: RepositoryStatus = {
  meta: {
    id: 'repo',
    name: 'VersionDock',
    rootPath: '/tmp/repo',
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

const sampleShelves: ShelfEntry[] = [
  {
    id: 'shelf-1',
    name: 'feat: add modern shelf panel',
    createdAt: '2026-08-20T08:00:00Z',
    branch: 'dev',
    files: [
      { path: 'src/components/ShelfPanel.tsx', status: 'modified' },
      { path: 'src/components/FileIcon.tsx', status: 'added' },
    ],
  },
];

const snapshot = {
  workspace: { id: 'workspace-1', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true },
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
  repositories: [gitRepo],
};

afterEach(() => {
  cleanup();
  useAppStore.setState({ shelves: {}, snapshot: undefined, bridge: undefined });
});

describe('ShelfPanel', () => {
  it('renders repository header and empty shelf state', () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({ bridge, snapshot });
    render(
      <BridgeContext.Provider value={bridge}>
        <ShelfPanel repos={[gitRepo]} selectedPaths={new Map()} />
      </BridgeContext.Provider>,
    );
    expect(screen.getByText('VersionDock')).toBeInTheDocument();
    expect(screen.getByText('No shelved changes')).toBeInTheDocument();
  });

  it('renders shelf item with branch chip and files in tree view', () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({ bridge, snapshot, shelves: { repo: sampleShelves } });

    render(
      <BridgeContext.Provider value={bridge}>
        <ShelfPanel repos={[gitRepo]} selectedPaths={new Map()} viewMode="tree" expansion={{ sequence: 1, expanded: true }} />
      </BridgeContext.Provider>,
    );

    expect(screen.getByText('feat: add modern shelf panel')).toBeInTheDocument();
    expect(screen.getByText('dev')).toBeInTheDocument();
    expect(screen.getByText('2 files')).toBeInTheDocument();

    // Tree structure should show compacted directory 'src/components'
    expect(screen.getByText('src/components')).toBeInTheDocument();
    expect(screen.getByText('ShelfPanel.tsx')).toBeInTheDocument();
    expect(screen.getByText('FileIcon.tsx')).toBeInTheDocument();
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders shelf item in list view', () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({ bridge, snapshot, shelves: { repo: sampleShelves } });

    render(
      <BridgeContext.Provider value={bridge}>
        <ShelfPanel repos={[gitRepo]} selectedPaths={new Map()} viewMode="list" expansion={{ sequence: 1, expanded: true }} />
      </BridgeContext.Provider>,
    );

    expect(screen.getByText('ShelfPanel.tsx')).toBeInTheDocument();
    expect(screen.getByText('FileIcon.tsx')).toBeInTheDocument();
    expect(screen.getAllByText('src/components').length).toBe(2);
  });

  it('invokes apply on double click', async () => {
    let requestedOperation: unknown = null;
    const bridge = new MockBridge((command) => {
      if (command.type === 'shelfOperation') {
        requestedOperation = command.payload.operation;
      }
      return [];
    });
    useAppStore.setState({ bridge, snapshot, shelves: { repo: sampleShelves } });

    render(
      <BridgeContext.Provider value={bridge}>
        <ShelfPanel repos={[gitRepo]} selectedPaths={new Map()} />
      </BridgeContext.Provider>,
    );

    const titleEl = screen.getByText('feat: add modern shelf panel');
    fireEvent.doubleClick(titleEl.closest('div[title*="double-click"]')!);

    expect(requestedOperation).toEqual({
      type: 'apply',
      shelf_id: 'shelf-1',
    });
  });

  it('opens a real shelf file diff from a file click without inventing a file context menu', () => {
    const onOpenFileDiff = vi.fn();
    const bridge = new MockBridge(() => []);
    useAppStore.setState({ bridge, snapshot, shelves: { repo: sampleShelves } });
    render(<BridgeContext.Provider value={bridge}><ShelfPanel repos={[gitRepo]} viewMode="list" expansion={{ sequence: 1, expanded: true }} onOpenFileDiff={onOpenFileDiff} /></BridgeContext.Provider>);
    const row = screen.getByText('ShelfPanel.tsx').closest('div[title="src/components/ShelfPanel.tsx"]')!;
    fireEvent.click(row);
    expect(onOpenFileDiff).toHaveBeenCalledWith('repo', 'shelf-1', 'src/components/ShelfPanel.tsx');
    fireEvent.contextMenu(row);
    expect(screen.queryByText('Show Diff')).not.toBeInTheDocument();
  });
});
