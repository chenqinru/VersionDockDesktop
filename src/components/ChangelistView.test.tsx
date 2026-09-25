import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangelistView } from './ChangelistView';
import { ChangelistGroup } from './ChangelistGroup';
import type { RepositoryStatus, ChangelistEntry } from '../bindings/generated';

const repo1: RepositoryStatus = {
  meta: { id: 'repo-1', name: 'Frontend', rootPath: '/tmp/frontend', color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch: 'main',
  revision: 'abc',
  ahead: 0,
  behind: 0,
  files: [
    { path: 'src/App.tsx', status: 'modified', staged: false, unstaged: true, conflicted: false },
    { path: 'src/custom.ts', status: 'modified', staged: false, unstaged: true, conflicted: false },
    { path: 'new-untracked.txt', status: 'untracked', staged: false, unstaged: true, conflicted: false },
  ],
  conflicts: 0,
  operation: null,
};

const repo2: RepositoryStatus = {
  meta: { id: 'repo-2', name: 'Backend', rootPath: '/tmp/backend', color: '#ce9178', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch: 'dev',
  revision: 'def',
  ahead: 1,
  behind: 0,
  files: [
    { path: 'server.go', status: 'modified', staged: false, unstaged: true, conflicted: false },
    { path: 'backend-custom.go', status: 'modified', staged: false, unstaged: true, conflicted: false },
    { path: 'temp.log', status: 'untracked', staged: false, unstaged: true, conflicted: false },
  ],
  conflicts: 0,
  operation: null,
};

const customEntries1: ChangelistEntry[] = [
  { id: 'cl-feature', name: 'Feature X', files: ['src/custom.ts'], isDefault: false, isActive: true },
];

const customEntries2: ChangelistEntry[] = [
  { id: 'cl-feature', name: 'Feature X', files: ['backend-custom.go'], isDefault: false, isActive: true },
];

afterEach(() => {
  cleanup();
});

describe('ChangelistView and ChangelistGroup hierarchy and interactions', () => {
  it('correctly aggregates Default Changelist, custom Changelists, and Unversioned Files', () => {
    const selected = new Set<string>();
    const setFiles = vi.fn();
    const onFile = vi.fn();
    const onContext = vi.fn();
    const onFolderContext = vi.fn();
    const onRepoContext = vi.fn();
    const onHeaderContextMenu = vi.fn();
    const onEmptyContextMenu = vi.fn();

    render(
      <ChangelistView
        repos={[repo1, repo2]}
        changelists={{
          'repo-1': customEntries1,
          'repo-2': customEntries2,
        }}
        selected={selected}
        setFiles={setFiles}
        onFile={onFile}
        onContext={onContext}
        onFolderContext={onFolderContext}
        onRepoContext={onRepoContext}
        onHeaderContextMenu={onHeaderContextMenu}
        onEmptyContextMenu={onEmptyContextMenu}
        viewMode="list"
        expansion={{ sequence: 0, expanded: true }}
        openWorkingChanges={vi.fn()}
      />,
    );

    // Verify 3 top-level Changelist groups
    expect(screen.getByText('Default Changelist')).toBeInTheDocument();
    expect(screen.getByText('Feature X')).toBeInTheDocument();
    expect(screen.getByText('Unversioned Files')).toBeInTheDocument();

    // Verify files distributed properly across groups
    expect(screen.getByTitle('src/App.tsx')).toBeInTheDocument();
    expect(screen.getByTitle('server.go')).toBeInTheDocument();
    expect(screen.getByTitle('src/custom.ts')).toBeInTheDocument();
    expect(screen.getByTitle('backend-custom.go')).toBeInTheDocument();
    expect(screen.getByTitle('new-untracked.txt')).toBeInTheDocument();
    expect(screen.getByTitle('temp.log')).toBeInTheDocument();
  });

  it('selects and deselects all files in a changelist group across repos', () => {
    const setFiles = vi.fn();
    const repoGroups = [
      { repo: repo1, files: [repo1.files[0]] },
      { repo: repo2, files: [repo2.files[0]] },
    ];

    render(
      <ChangelistGroup
        id="default"
        name="Default Changelist"
        repoGroups={repoGroups}
        multiRepo={true}
        singleRepo={false}
        selected={new Set()}
        setFiles={setFiles}
        onFile={vi.fn()}
        onContext={vi.fn()}
        onFolderContext={vi.fn()}
        onRepoContext={vi.fn()}
        onHeaderContextMenu={vi.fn()}
        viewMode="list"
        expansion={{ sequence: 0, expanded: true }}
        openWorkingChanges={vi.fn()}
      />,
    );

    const groupCheckbox = screen.getByLabelText('Default Changelist');
    fireEvent.click(groupCheckbox);

    // Expect setFiles called for repo-1 and repo-2
    expect(setFiles).toHaveBeenCalledWith('repo-1', ['src/App.tsx'], true);
    expect(setFiles).toHaveBeenCalledWith('repo-2', ['server.go'], true);
  });

  it('triggers header context menu with changelist id', () => {
    const onHeaderContextMenu = vi.fn();
    const repoGroups = [
      { repo: repo1, files: [repo1.files[0]] },
    ];

    render(
      <ChangelistGroup
        id="custom-1"
        name="My Changes"
        repoGroups={repoGroups}
        multiRepo={false}
        singleRepo={true}
        selected={new Set()}
        setFiles={vi.fn()}
        onFile={vi.fn()}
        onContext={vi.fn()}
        onFolderContext={vi.fn()}
        onRepoContext={vi.fn()}
        onHeaderContextMenu={onHeaderContextMenu}
        viewMode="list"
        expansion={{ sequence: 0, expanded: true }}
        openWorkingChanges={vi.fn()}
      />,
    );

    const heading = screen.getByText('My Changes').closest('.changelist-heading')!;
    fireEvent.contextMenu(heading);

    expect(onHeaderContextMenu).toHaveBeenCalledWith(expect.anything(), 'custom-1');
  });

  it('renders error banner and handles retry when changelist loading fails', async () => {
    const mockLoadChangelists = vi.fn();
    const { useAppStore } = await import('../store/appStore');
    useAppStore.setState({
      loadErrors: { 'changelists:repo-1': 'Connection timed out' },
      loadChangelists: mockLoadChangelists,
    });

    render(
      <ChangelistView
        repos={[repo1]}
        changelists={{}}
        selected={new Set()}
        setFiles={vi.fn()}
        onFile={vi.fn()}
        onContext={vi.fn()}
        onFolderContext={vi.fn()}
        onRepoContext={vi.fn()}
        onHeaderContextMenu={vi.fn()}
        onEmptyContextMenu={vi.fn()}
        viewMode="list"
        expansion={{ sequence: 0, expanded: true }}
        openWorkingChanges={vi.fn()}
      />,
    );

    expect(screen.getByText(/Connection timed out/)).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryBtn);

    expect(mockLoadChangelists).toHaveBeenCalledWith('repo-1');
  });

  it('does not place tracked files into Default Changelist when changelists fail to load initially without cache', async () => {
    const { useAppStore } = await import('../store/appStore');
    useAppStore.setState({
      loadErrors: { 'changelists:repo-1': 'Failed to fetch' },
    });

    render(
      <ChangelistView
        repos={[repo1]}
        changelists={{}}
        selected={new Set()}
        setFiles={vi.fn()}
        onFile={vi.fn()}
        onContext={vi.fn()}
        onFolderContext={vi.fn()}
        onRepoContext={vi.fn()}
        onHeaderContextMenu={vi.fn()}
        onEmptyContextMenu={vi.fn()}
        viewMode="list"
        expansion={{ sequence: 0, expanded: true }}
        openWorkingChanges={vi.fn()}
      />,
    );

    expect(screen.getByText('Default Changelist')).toBeInTheDocument();
    expect(screen.queryByTitle('src/App.tsx')).not.toBeInTheDocument();
    expect(screen.queryByTitle('src/custom.ts')).not.toBeInTheDocument();
    expect(screen.getByTitle('new-untracked.txt')).toBeInTheDocument();
  });
});
