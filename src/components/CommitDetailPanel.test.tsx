import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommitDetailPanel } from './CommitDetailPanel';
import { DialogHost } from './DialogHost';
import { publishDialog } from './dialogService';
import { useAppStore } from '../store/appStore';
import { commitKey } from '../history/commitDetails';
import type { CommitDetail, CommitNode, WorkspaceSnapshot } from '../bindings/generated';

const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'workspace', name: 'Test', paths: ['/tmp/test'], lastOpenedAt: '', available: true },
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
  repositories: [{
    meta: { id: 'repo-1', name: 'Repo 1', rootPath: '/tmp/test', color: '#4EC9B0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
    branch: 'main', revision: 'merge1234', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
  }],
};

const mergeCommit: CommitNode = {
  repoId: 'repo-1',
  hash: 'merge1234567890',
  shortHash: 'merge12',
  parents: ['parent11111111', 'parent22222222'],
  author: 'Alice',
  email: 'alice@example.test',
  authorDate: '2026-08-16T10:00:00Z',
  committerDate: '2026-08-16T10:00:00Z',
  message: 'Merge branch feature into main',
  refs: ['HEAD -> main'],
};

const mergeDetail: CommitDetail = {
  commit: mergeCommit,
  fullMessage: 'Merge branch feature into main\n\nDetailed merge description',
  files: [],
  branches: { local: ['main'], remote: ['origin/main'], tags: [] },
  mergeParentChanges: [
    {
      hash: 'parent11111111',
      shortHash: 'parent1',
      message: 'fix: something on main',
      authorName: 'Bob',
      authorDate: '2026-08-15T12:00:00Z',
      parentIndex: 0,
      fileCount: 2,
    },
    {
      hash: 'parent22222222',
      shortHash: 'parent2',
      message: 'feat: add new feature',
      authorName: 'Charlie',
      authorDate: '2026-08-15T14:00:00Z',
      parentIndex: 1,
      fileCount: 1,
    },
  ],
};

const directoryCommit: CommitNode = {
  ...mergeCommit,
  hash: 'directory1234567890',
  shortHash: 'director',
  parents: ['directory-parent'],
  message: 'feat: directory actions',
};

const directoryDetail: CommitDetail = {
  commit: directoryCommit,
  fullMessage: directoryCommit.message,
  branches: { local: ['main'], remote: [], tags: [] },
  files: [
    { path: 'src/alpha.ts', status: 'M', added: 2, removed: 1 },
    { path: 'src/nested/beta.ts', status: 'A', added: 4, removed: 0 },
    { path: 'README.md', status: 'M', added: 1, removed: 1 },
  ],
};

const originalHistoryOperation = useAppStore.getState().historyOperation;

afterEach(() => {
  cleanup();
  publishDialog(undefined);
  useAppStore.setState({
    snapshot: undefined,
    selectedCommit: undefined,
    selectedCommits: [],
    selectedCommitDetails: {},
    selectedCommitLoading: {},
    mergeParentFiles: {},
    mergeParentFilesLoading: {},
    historyOperation: originalHistoryOperation,
    mode: 'history',
  });
});

describe('CommitDetailPanel merge commits', () => {
  it('shows HEAD explicitly and excludes symbolic remote HEAD references', () => {
    const detail: CommitDetail = {
      ...mergeDetail,
      branches: { local: ['main', 'feature/ui', 'zeta'], remote: ['origin/main', 'origin/HEAD'], tags: ['v1.0.0'], isHead: true },
    };
    useAppStore.setState({
      snapshot,
      selectedCommit: detail,
      selectedCommits: [mergeCommit],
      selectedCommitDetails: { [commitKey(mergeCommit.repoId, mergeCommit.hash)]: detail },
    });
    const { container } = render(<CommitDetailPanel onCollapse={vi.fn()} />);
    const labels = [...container.querySelectorAll('.detail-refs em')].map((element) => element.textContent);
    expect(labels[0]).toBe('HEAD');
    expect(labels).toContain('main');
    expect(labels).toContain('origin/main');
    expect(labels).not.toContain('origin/HEAD');
    fireEvent.click(screen.getByRole('button', { name: '+1 more' }));
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('keeps the selected detail visible while an unrelated hover preview loads', () => {
    useAppStore.setState({
      snapshot,
      selectedCommit: directoryDetail,
      selectedCommits: [directoryCommit],
      selectedCommitDetails: { [commitKey(directoryCommit.repoId, directoryCommit.hash)]: directoryDetail },
      selectedCommitLoading: {},
    });
    render(<CommitDetailPanel onCollapse={vi.fn()} />);
    expect(screen.getByText('alpha.ts')).toBeInTheDocument();

    useAppStore.setState({ selectedCommitLoading: { 'repo-1:hover-preview': true } });

    expect(screen.getByText('alpha.ts')).toBeInTheDocument();
    expect(screen.queryByText('Loading files...')).not.toBeInTheDocument();
  });

  it('shows only restore and cherry-pick actions on directories and applies every descendant file', async () => {
    const historyOperation = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      snapshot,
      selectedCommit: directoryDetail,
      selectedCommits: [directoryCommit],
      selectedCommitDetails: { [commitKey(directoryCommit.repoId, directoryCommit.hash)]: directoryDetail },
      historyOperation,
    });

    render(<><CommitDetailPanel onCollapse={vi.fn()} /><DialogHost /></>);

    fireEvent.contextMenu(screen.getByTitle('src'));
    expect(screen.getByText('Revert Selected Changes')).toBeInTheDocument();
    expect(screen.getByText('Cherry-Pick Selected Changes')).toBeInTheDocument();
    expect(screen.queryByText('Show Diff')).not.toBeInTheDocument();
    expect(screen.queryByText('Open file')).not.toBeInTheDocument();
    expect(screen.queryByText('File history')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Revert Selected Changes'));
    expect(screen.getByRole('dialog')).toHaveTextContent('2 files');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(historyOperation).toHaveBeenCalledWith('repo-1', {
      type: 'revertPaths',
      entries: [
        { revision: directoryCommit.hash, path: 'src/alpha.ts', status: 'M' },
        { revision: directoryCommit.hash, path: 'src/nested/beta.ts', status: 'A' },
      ],
    }));

    fireEvent.contextMenu(screen.getByTitle('Repo 1'));
    expect(screen.queryByText('Show Diff')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Cherry-Pick Selected Changes'));
    expect(screen.getByRole('dialog')).toHaveTextContent('3 files');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(historyOperation).toHaveBeenLastCalledWith('repo-1', {
      type: 'applyPaths',
      entries: [
        { revision: directoryCommit.hash, path: 'src/alpha.ts', status: 'M' },
        { revision: directoryCommit.hash, path: 'src/nested/beta.ts', status: 'A' },
        { revision: directoryCommit.hash, path: 'README.md', status: 'M' },
      ],
    }));
  });

  it('opens the commit-detail workspace instead of previewing the first changed file', () => {
    useAppStore.setState({
      snapshot,
      selectedCommit: mergeDetail,
      selectedCommits: [mergeCommit],
      selectedCommitDetails: { 'repo-1:merge1234567890': mergeDetail },
      mode: 'history',
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    expect(screen.queryByTitle('Open preview')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Open Commit Detail'));
    expect(useAppStore.getState().mode).toBe('commit-detail');
  });

  it('renders "No merge conflicts" and merge parent change groups for merge commits with empty combined diff', () => {
    useAppStore.setState({
      snapshot,
      selectedCommit: mergeDetail,
      selectedCommits: [mergeCommit],
      selectedCommitDetails: { 'repo-1:merge1234567890': mergeDetail },
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    expect(screen.getByText('No merge conflicts')).toBeInTheDocument();
    expect(screen.getByText('Changes from parent1')).toBeInTheDocument();
    expect(screen.getByText('fix: something on main')).toBeInTheDocument();
    expect(screen.getByText('2 files')).toBeInTheDocument();

    expect(screen.getByText('Changes from parent2')).toBeInTheDocument();
    expect(screen.getByText('feat: add new feature')).toBeInTheDocument();
    expect(screen.getByText('1 file')).toBeInTheDocument();
  });

  it('loads and renders parent files when expanding a merge parent change group, and opens diff with range', async () => {
    const openDiff = vi.fn().mockResolvedValue(undefined);
    const loadMergeParentFiles = vi.fn().mockImplementation(async (_repoId, _rev, parentHash) => {
      const cacheKey = `repo-1\0merge1234567890\0${parentHash}`;
      const files = parentHash === 'parent22222222'
        ? [{ path: 'src/feature.ts', status: 'A', added: 10, removed: 0 }]
        : [{ path: 'src/main-fix.ts', status: 'M', added: 1, removed: 1 }];
      useAppStore.setState((state) => ({
        mergeParentFiles: { ...state.mergeParentFiles, [cacheKey]: files },
      }));
      return files;
    });

    useAppStore.setState({
      snapshot,
      selectedCommit: mergeDetail,
      selectedCommits: [mergeCommit],
      selectedCommitDetails: { 'repo-1:merge1234567890': mergeDetail },
      openDiff,
      loadMergeParentFiles,
    });

    render(<CommitDetailPanel onCollapse={vi.fn()} />);

    const parent2Row = screen.getByRole('button', { name: /Changes from parent2/ });
    fireEvent.click(parent2Row);

    expect(loadMergeParentFiles).toHaveBeenCalledWith('repo-1', 'merge1234567890', 'parent22222222');

    await waitFor(() => {
      expect(screen.getByText('feature.ts')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('feature.ts'));
    expect(openDiff).toHaveBeenCalledWith(
      'repo-1',
      'src/feature.ts',
      false,
      undefined,
      { fromRevision: 'parent22222222', toRevision: 'merge1234567890' },
    );
  });
});
