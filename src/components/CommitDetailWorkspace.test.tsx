import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommitDetailWorkspace } from './CommitDetailWorkspace';
import { useAppStore } from '../store/appStore';
import { commitKey } from '../history/commitDetails';
import type { CommitDetail, CommitNode, WorkspaceSnapshot } from '../bindings/generated';

const repository = {
  meta: { id: 'repo', name: 'Example Repo', rootPath: '/tmp/repo', color: '#4EC9B0', kind: 'git' as const, parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch: 'main', revision: 'abc1234', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
};

const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'workspace', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true },
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
  repositories: [repository],
};

function commit(hash: string, message: string, date: string): CommitNode {
  return {
    repoId: 'repo', hash, shortHash: hash.slice(0, 7), parents: [], author: 'Ada Lovelace', email: 'ada@example.test',
    authorDate: date, committerDate: date, message, refs: ['HEAD -> main'],
  };
}

function detail(value: CommitNode, body: string, path: string): CommitDetail {
  return {
    commit: value,
    fullMessage: `${value.message}\n\n${body}`,
    files: [{ path, status: 'M', added: 2, removed: 1 }],
    branches: { local: ['main'], remote: ['origin/main'], tags: [] },
  };
}

const originalBack = useAppStore.getState().backToHistory;

afterEach(() => {
  cleanup();
  for (const key of Object.keys(localStorage)) if (key.startsWith('versiondock:detailView:')) localStorage.removeItem(key);
  useAppStore.setState({
    snapshot: undefined,
    selectedCommit: undefined,
    selectedCommits: [], updateDetailCommits: [],
    selectedCommitDetails: {},
    selectedCommitLoading: {},
    backToHistory: originalBack,
    mode: 'history',
    historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null },
  });
});

describe('CommitDetailWorkspace', () => {
  it('renders even a one-commit update as an aggregated Update details view', () => {
    const selected = commit('update-hash', 'Update commit', '2026-08-27T10:00:00Z');
    const selectedDetail = detail(selected, 'Update full message.', 'updated.txt');
    const original = commit('original-log', 'Original log selection', '2026-08-25T10:00:00Z');
    useAppStore.setState({ snapshot, selectedCommit: detail(original, 'Original body.', 'original.txt'), selectedCommits: [original], updateDetailCommits: [selected], selectedCommitDetails: { [commitKey('repo', selected.hash)]: selectedDetail }, mode: 'update-details' });
    render(<CommitDetailWorkspace />);
    expect(screen.getByRole('region', { name: 'Update details' })).toBeInTheDocument();
    expect(screen.getAllByText('1 commit selected').length).toBeGreaterThan(0);
    expect(screen.getByText('Selected time range')).toBeInTheDocument();
    expect(screen.getByText('Update full message.')).toBeInTheDocument();
    expect(screen.queryByText('Original body.')).not.toBeInTheDocument();
    expect(screen.queryByText('original.txt')).not.toBeInTheDocument();
    expect(useAppStore.getState().selectedCommits).toEqual([original]);
    fireEvent.contextMenu(screen.getByText('updated.txt').closest('button')!);
    expect(screen.getByRole('menuitem', { name: 'Show Diff' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Revert Selected Changes' })).not.toBeInTheDocument();
  });

  it('opens a full single-commit detail instead of a file preview', () => {
    const selected = commit('abc1234567890', 'feat: add commit detail', '2026-08-26T10:00:00Z');
    const selectedDetail = detail(selected, 'Complete commit message body.', 'src/detail.tsx');
    const back = vi.fn();
    useAppStore.setState({
      snapshot,
      selectedCommit: selectedDetail,
      selectedCommits: [selected],
      selectedCommitDetails: { [commitKey('repo', 'abc1234567890')]: selectedDetail },
      backToHistory: back,
      mode: 'commit-detail',
    });

    render(<CommitDetailWorkspace />);

    expect(screen.getByText('Commit abc1234')).toBeInTheDocument();
    expect(screen.getByText('abc1234567890')).toBeInTheDocument();
    expect(screen.getByText('ada@example.test')).toBeInTheDocument();
    expect(screen.getByText(/Complete commit message body/)).toBeInTheDocument();
    expect(document.querySelector('.commit-detail-expanded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to history' }));
    expect(back).toHaveBeenCalledOnce();
  });

  it('opens an aggregated detail for a multi-commit selection', () => {
    const newest = commit('bbbbbbb2222222', 'fix: newest change', '2026-08-27T10:00:00Z');
    const oldest = commit('aaaaaaa1111111', 'feat: oldest change', '2026-08-26T10:00:00Z');
    const newestDetail = detail(newest, 'Newest full message.', 'src/newest.ts');
    const oldestDetail = detail(oldest, 'Oldest full message.', 'src/oldest.ts');
    useAppStore.setState({
      snapshot,
      selectedCommit: newestDetail,
      selectedCommits: [newest, oldest],
      selectedCommitDetails: {
        [commitKey('repo', 'bbbbbbb2222222')]: newestDetail,
        [commitKey('repo', 'aaaaaaa1111111')]: oldestDetail,
      },
      mode: 'commit-detail',
    });

    render(<CommitDetailWorkspace />);

    expect(screen.getAllByText('Aggregated commit selection').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2 commits selected').length).toBeGreaterThan(0);
    expect(screen.getByText('fix: newest change')).toBeInTheDocument();
    expect(screen.getByText('feat: oldest change')).toBeInTheDocument();
    expect(screen.getByText('Newest full message.')).toBeInTheDocument();
    expect(screen.getByText('Oldest full message.')).toBeInTheDocument();
    expect(screen.getAllByText('Example Repo')).toHaveLength(2);
  });
  it('shows all commit files independently of the log path filter and uses the single-detail menu', () => {
    const selected = commit('single-detail-hash', 'feat: complete detail', '2026-08-26T10:00:00Z');
    const selectedDetail = detail(selected, 'Full message.', 'src/detail.tsx');
    selectedDetail.files.push({ path: 'README.md', status: 'A', added: 1, removed: 0 });
    useAppStore.setState({ snapshot, selectedCommit: selectedDetail, selectedCommits: [selected], selectedCommitDetails: { [commitKey('repo', selected.hash)]: selectedDetail }, historyQuery: { text: null, author: null, fromDate: null, toDate: null, path: 'src/detail.tsx', revision: null } });
    render(<CommitDetailWorkspace />);
    expect(screen.getByText('README.md')).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText('README.md').closest('button')!);
    expect(screen.getByRole('menuitem', { name: 'Revert Selected Changes' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Cherry-Pick Selected Changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'File history' })).not.toBeInTheDocument();
  });

  it('keeps file mutations out of the aggregated detail menu', () => {
    const newest = commit('newest', 'New', '2026-08-27T10:00:00Z');
    const oldest = commit('oldest', 'Old', '2026-08-26T10:00:00Z');
    const newestDetail = detail(newest, 'New body', 'shared.txt');
    const oldestDetail = detail(oldest, 'Old body', 'shared.txt');
    useAppStore.setState({ snapshot, selectedCommit: newestDetail, selectedCommits: [newest, oldest], selectedCommitDetails: { [commitKey('repo', newest.hash)]: newestDetail, [commitKey('repo', oldest.hash)]: oldestDetail } });
    render(<CommitDetailWorkspace />);
    fireEvent.contextMenu(screen.getByText('shared.txt').closest('button')!);
    expect(screen.getByRole('menuitem', { name: 'Show Diff' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Revert Selected Changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Cherry-Pick Selected Changes' })).not.toBeInTheDocument();
  });

});
