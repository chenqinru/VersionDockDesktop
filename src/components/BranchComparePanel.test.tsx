import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BranchComparePanel } from './BranchComparePanel';
import { useAppStore } from '../store/appStore';
import type { BranchCompareResult, BranchInfo, CommitNode, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';

const commit1: CommitNode = {
  repoId: 'repo',
  hash: '1111111111111111111111111111111111111111',
  shortHash: '1111111',
  parents: [],
  author: 'Alice',
  email: 'alice@example.com',
  authorDate: '2026-09-01T10:00:00Z',
  committerDate: '2026-09-01T10:00:00Z',
  message: 'Initial commit',
  refs: [],
  incoming: false,
  unpushed: false,
};

const commit2: CommitNode = {
  repoId: 'repo',
  hash: '2222222222222222222222222222222222222222',
  shortHash: '2222222',
  parents: [],
  author: 'Bob',
  email: 'bob@example.com',
  authorDate: '2026-09-02T10:00:00Z',
  committerDate: '2026-09-02T10:00:00Z',
  message: 'feat: add feature',
  refs: [],
  incoming: false,
  unpushed: false,
};

const branches: BranchInfo[] = [
  { name: 'main', current: true, remote: false, upstream: null, ahead: 0, behind: 0 },
  { name: 'feature', current: false, remote: false, upstream: null, ahead: 0, behind: 0 },
];

const repository: RepositoryStatus = {
  meta: {
    id: 'repo',
    name: 'Repository',
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
  conflicts: 0,
  operation: null,
  files: [],
};

const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'workspace', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true },
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
  repositories: [repository],
};

const comparison: BranchCompareResult = {
  base: 'refs/heads/main',
  target: 'feature',
  baseCommits: [commit1],
  targetCommits: [commit2],
  files: [],
};

afterEach(() => {
  cleanup();
  useAppStore.setState({
    snapshot: undefined,
    branchesByRepo: {},
    comparison: undefined,
  });
});

describe('BranchComparePanel', () => {
  it('renders initial comparison commits and queries backend on filter input', async () => {
    const compareBranchCommits = vi.fn().mockImplementation(async (_repoId, _base, _target, side, query) => {
      if (side === 'targetOnly' && query.text === 'feat.*') {
        return [commit2];
      }
      return [];
    });

    useAppStore.setState({
      snapshot,
      branchesByRepo: { repo: branches },
      comparison,
      compareBranchCommits,
    });

    render(
      <BranchComparePanel
        repoId="repo"
        initialTarget="feature"
        close={() => {}}
        renderCommits={(commits) => (
          <ul>
            {commits.map((c) => (
              <li key={c.hash}>{c.message}</li>
            ))}
          </ul>
        )}
      />
    );

    // Initial render displays base and target commits
    expect(screen.getByText('Initial commit')).toBeInTheDocument();
    expect(screen.getByText('feat: add feature')).toBeInTheDocument();

    // Type regex into target search input (the first search input is in targetOnly pane)
    const inputs = screen.getAllByPlaceholderText('Search commits…');
    fireEvent.change(inputs[0], { target: { value: 'feat.*' } });

    await waitFor(() => {
      expect(compareBranchCommits).toHaveBeenCalledWith(
        'repo',
        'refs/heads/main',
        'feature',
        'targetOnly',
        expect.objectContaining({ text: 'feat.*' }),
        expect.any(AbortSignal)
      );
    });

    expect(screen.getByText('feat: add feature')).toBeInTheDocument();

    // Click clear filters button
    const clearBtn = screen.getByTitle('Clear all filters');
    fireEvent.click(clearBtn);

    // Initial state restored without filters
    expect(screen.getByText('feat: add feature')).toBeInTheDocument();
  });

  it('renders author avatar in options and shows leading avatar when selected', async () => {
    const compareBranchCommits = vi.fn().mockImplementation(async () => [commit2]);

    useAppStore.setState({
      snapshot,
      branchesByRepo: { repo: branches },
      comparison,
      compareBranchCommits,
    });

    render(
      <BranchComparePanel
        repoId="repo"
        initialTarget="feature"
        close={() => {}}
        renderCommits={(commits) => (
          <ul>
            {commits.map((c) => (
              <li key={c.hash}>{c.message}</li>
            ))}
          </ul>
        )}
      />
    );

    // Open author filter popover in the first pane
    const authorButtons = screen.getAllByRole('button', { name: /Author…/ });
    fireEvent.click(authorButtons[0]);

    // Should see Bob in the popover with avatar initials
    expect(screen.getByText('Bob')).toBeInTheDocument();
    // AuthorAvatar renders initials "BO" for Bob
    expect(screen.getByText('BO')).toBeInTheDocument();

    // Select Bob
    fireEvent.click(screen.getByText('Bob'));

    await waitFor(() => {
      expect(compareBranchCommits).toHaveBeenCalledWith(
        'repo',
        'refs/heads/main',
        'feature',
        'targetOnly',
        expect.objectContaining({ author: 'Bob' }),
        expect.any(AbortSignal)
      );
    });

    // The filter button label should now display Bob and have avatar rendered
    expect(screen.getByRole('button', { name: /Bob/ })).toBeInTheDocument();
  });
  it.each([
    [{ name: 'HEAD', current: true, remote: false, upstream: null, ahead: 0, behind: 0, detachedTag: 'v1' }, 'refs/tags/v1'],
    [{ name: 'HEAD', current: true, remote: false, upstream: null, ahead: 0, behind: 0, detachedHash: 'abcdef123' }, 'abcdef123'],
  ])('compares from the detached HEAD identity rather than a pseudo branch', async (head, base) => {
    const compareBranches = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ snapshot, branchesByRepo: { repo: [head, branches[1]] }, comparison: undefined, compareBranches });
    render(<BranchComparePanel repoId="repo" initialTarget="refs/heads/feature" close={() => {}} renderCommits={() => null} />);
    await waitFor(() => expect(compareBranches).toHaveBeenCalledWith('repo', base, 'refs/heads/feature'));
  });

});
