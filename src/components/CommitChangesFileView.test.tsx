import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitNode, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { CommitChangesWorkspace } from './CommitChangesWorkspace';

const original = useAppStore.getState();
const repository: RepositoryStatus = {
  meta: { id: 'repo', name: 'Repo', rootPath: '/tmp/repo', color: '#999', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch: 'main', revision: 'one', ahead: 0, behind: 0, conflicts: 0, operation: null,
  files: ['src/deep/first.ts', 'src/deep/second.ts'].map((path) => ({ path, status: 'modified', staged: true, unstaged: true, conflicted: false })),
};
const snapshot: WorkspaceSnapshot = { workspace: { id: 'qa', name: 'QA', paths: ['/tmp/repo'], lastOpenedAt: '', available: true }, generation: 1, tools: { git: true, svn: true, svnadmin: true }, repositories: [repository] };
const preference = 'versiondock:changesFileView';
beforeEach(() => localStorage.removeItem(preference));
afterEach(() => { cleanup(); localStorage.removeItem(preference); useAppStore.setState(original, true); });

function setupWorking() {
  const requests: Array<{ path: string; staged: boolean }> = [];
  const bridge = new MockBridge((command) => {
    if (command.type === 'fileDiff') {
      requests.push({ path: command.payload.relative_path, staged: command.payload.staged });
      return { path: command.payload.relative_path, content: '', language: 'text', binary: false, truncated: false, lineCount: 0 };
    }
    return true;
  });
  useAppStore.setState({ bridge, snapshot, allRepositories: [repository], selectedRepoId: 'repo', changesDiff: undefined, changesDiffTarget: undefined, changesDiffLoading: false, changesDiffError: undefined });
  useAppStore.getState().openWorkingChanges('repo');
  return { ...render(<CommitChangesWorkspace />), requests };
}

describe('changes file view switching', () => {
  it('keeps the selected diff and full-path context target when switching views', async () => {
    const history = vi.fn();
    useAppStore.setState({ openFileHistory: history });
    const { container, requests } = setupWorking();
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.click(screen.getAllByRole('button', { name: 'src/deep/second.ts' })[1]);
    await waitFor(() => expect(requests).toHaveLength(2));
    const loaded = useAppStore.getState().changesDiff;
    fireEvent.click(screen.getByRole('button', { name: 'Tree view' }));
    expect(container.querySelector('.changes-file-row.selected')).toHaveTextContent('second.ts');
    expect(container.querySelector('.changes-file-row.selected')).toHaveAttribute('aria-label', 'src/deep/second.ts');
    expect(screen.getAllByRole('button', { name: 'src/deep' })).toHaveLength(2);
    fireEvent.contextMenu(container.querySelector('.changes-file-row.selected')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'File history' }));
    expect(history).toHaveBeenCalledWith('repo', 'src/deep/second.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Flat list' }));
    expect(container.querySelector('.changes-file-row.selected')).toHaveTextContent('src/deep/second.ts');
    expect(requests).toHaveLength(2);
    expect(useAppStore.getState().changesDiff).toBe(loaded);
  });

  it('keeps staged and unstaged directories independent and supports expanding and collapsing all', async () => {
    const { requests } = setupWorking();
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Tree view' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'src/deep' })[0]);
    expect(screen.getAllByRole('button', { name: 'src/deep/first.ts' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'src/deep' })[0]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('button', { name: 'src/deep' })[1]).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'src/deep/first.ts' }));
    await waitFor(() => expect(requests[1]).toEqual({ path: 'src/deep/first.ts', staged: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByRole('button', { name: 'src/deep/first.ts' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByRole('button', { name: 'src/deep/first.ts' })).toHaveLength(2);
    expect(requests).toHaveLength(2);
  });

  it('does not merge same-path files or directory state across commit repositories', () => {
    const other = { ...repository, meta: { ...repository.meta, id: 'other', name: 'Other' } };
    const commits: CommitNode[] = [repository, other].map((repo) => ({ repoId: repo.meta.id, hash: 'one', shortHash: 'one', parents: [], message: 'Commit', author: 'QA', email: '', authorDate: '', committerDate: '', refs: [] }));
    const files = commits.map((commit) => ({ repoId: commit.repoId, commitHash: commit.hash, path: 'src/deep/first.ts', status: 'M', added: 1, removed: 1 }));
    const load = vi.fn();
    useAppStore.setState({ snapshot: { ...snapshot, repositories: [repository, other] }, changes: { kind: 'commits', commits, files }, loadChangesDiff: load, changesDiff: undefined });
    render(<CommitChangesWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Tree view' }));
    const groups = screen.getAllByRole('group', { name: 'src/deep' });
    expect(groups).toHaveLength(2);
    fireEvent.click(within(groups[1]).getByRole('button', { name: 'src/deep/first.ts' }));
    expect(load).toHaveBeenLastCalledWith(files[1]);
    fireEvent.click(screen.getAllByRole('button', { name: 'src/deep' })[0]);
    expect(screen.getByRole('button', { name: 'src/deep/first.ts' })).toHaveAttribute('aria-current', 'true');
  });

  it('remembers the view preference and reveals selected files on return to tree view', async () => {
    const { unmount, requests } = setupWorking();
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Tree view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Flat list' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tree view' }));
    expect(screen.getAllByRole('button', { name: 'src/deep/first.ts' })).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(localStorage.getItem(preference)).toBe('tree');
    unmount();
    render(<CommitChangesWorkspace />);
    expect(screen.getByRole('button', { name: 'Tree view' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button', { name: 'src/deep' })).toHaveLength(2);
  });
});
