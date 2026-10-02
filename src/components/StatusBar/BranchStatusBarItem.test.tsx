import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BranchStatusBarItem } from './BranchStatusBarItem';
import { getRepoEffectiveRef, getRepoCompareBase, getRepoRefIcon, formatRepoOperationLabel } from './branchRef';
import { useAppStore } from '../../store/appStore';
import type { RepositoryStatus } from '../../bindings/generated';

afterEach(() => {
  cleanup();
});

const makeRepo = (id: string, isWorktree: boolean, filesCount: number): RepositoryStatus => ({
  meta: {
    id,
    name: id,
    rootPath: `/test/${id}`,
    color: '#3388ff',
    kind: 'git',
    parentRepoId: isWorktree ? 'main-repo' : null,
    depth: 0,
    isSubmodule: false,
    isWorktree,
  },
  branch: 'main',
  revision: 'hash123',
  ahead: 0,
  behind: 0,
  files: Array.from({ length: filesCount }, (_, i) => ({
    path: `file${i}.txt`,
    staged: false,
    unstaged: true,
    conflicted: false,
    status: 'modified',
  })),
  conflicts: 0,
  operation: null,
});

describe('BranchStatusBarItem dirty state contract', () => {
  it('shows dirty dot when only a worktree has uncommitted files', () => {
    const mainRepo = makeRepo('main-repo', false, 0);
    const worktreeRepo = makeRepo('worktree-repo', true, 2);

    useAppStore.setState({
      snapshot: {
        workspace: { id: 'ws-1', name: 'ws-1', paths: ['/test'], lastOpenedAt: '2026-01-01T00:00:00Z', available: true },
        repositories: [mainRepo, worktreeRepo],
        tools: { git: true, svn: false, svnadmin: false },
        generation: 1,
      },
    });

    render(<BranchStatusBarItem />);

    const dirtyDot = screen.getByTitle('Uncommitted changes');
    expect(dirtyDot).toBeInTheDocument();
    expect(dirtyDot).toHaveTextContent('●');

    const button = screen.getByRole('button');
    expect(button.className).toContain('has-dirty');
  });

  it('does not show dirty dot when all repos including worktrees are clean', () => {
    const mainRepo = makeRepo('main-repo', false, 0);
    const worktreeRepo = makeRepo('worktree-repo', true, 0);

    useAppStore.setState({
      snapshot: {
        workspace: { id: 'ws-1', name: 'ws-1', paths: ['/test'], lastOpenedAt: '2026-01-01T00:00:00Z', available: true },
        repositories: [mainRepo, worktreeRepo],
        tools: { git: true, svn: false, svnadmin: false },
        generation: 1,
      },
    });

    render(<BranchStatusBarItem />);

    expect(screen.queryByTitle('Uncommitted changes')).not.toBeInTheDocument();
    const button = screen.getByRole('button');
    expect(button.className).not.toContain('has-dirty');
  });

  it('renders detached tag name and tag icon when on a detached tag', () => {
    const mainRepo = makeRepo('main-repo', false, 0);

    useAppStore.setState({
      snapshot: {
        workspace: { id: 'ws-1', name: 'ws-1', paths: ['/test'], lastOpenedAt: '2026-01-01T00:00:00Z', available: true },
        repositories: [mainRepo],
        tools: { git: true, svn: false, svnadmin: false },
        generation: 1,
      },
      branchesByRepo: {
        'main-repo': [
          { name: 'HEAD', current: true, remote: false, ahead: 0, behind: 0, upstream: null, detachedTag: 'v2.1.0' },
        ],
      },
    });

    render(<BranchStatusBarItem />);

    const label = screen.getByText('v2.1.0');
    expect(label).toBeInTheDocument();
    const tagIcon = document.querySelector('.codicon-tag');
    expect(tagIcon).toBeInTheDocument();
  });

  it('renders detached hash and git-commit icon when on a detached commit', () => {
    const mainRepo = makeRepo('main-repo', false, 0);

    useAppStore.setState({
      snapshot: {
        workspace: { id: 'ws-1', name: 'ws-1', paths: ['/test'], lastOpenedAt: '2026-01-01T00:00:00Z', available: true },
        repositories: [mainRepo],
        tools: { git: true, svn: false, svnadmin: false },
        generation: 1,
      },
      branchesByRepo: {
        'main-repo': [
          { name: 'HEAD', current: true, remote: false, ahead: 0, behind: 0, upstream: null, detachedHash: '7b2a9ef' },
        ],
      },
    });

    render(<BranchStatusBarItem />);

    const label = screen.getByText('7b2a9ef');
    expect(label).toBeInTheDocument();
    const commitIcon = document.querySelector('.codicon-git-commit');
    expect(commitIcon).toBeInTheDocument();
  });

  it('renders effective ref (detachedTag / detachedHash) in multi-repo tooltip', () => {
    const repoA = { ...makeRepo('repo-a', false, 0), branch: 'HEAD (detached at v1.5.0)' };
    const repoB = { ...makeRepo('repo-b', false, 0), branch: 'HEAD (detached at 3c4d5e6)' };

    useAppStore.setState({
      snapshot: {
        workspace: { id: 'ws-1', name: 'ws-1', paths: ['/test'], lastOpenedAt: '2026-01-01T00:00:00Z', available: true },
        repositories: [repoA, repoB],
        tools: { git: true, svn: false, svnadmin: false },
        generation: 1,
      },
      branchesByRepo: {
        'repo-a': [
          { name: 'HEAD', current: true, remote: false, ahead: 0, behind: 0, upstream: null, detachedTag: 'v1.5.0' },
        ],
        'repo-b': [
          { name: 'HEAD', current: true, remote: false, ahead: 0, behind: 0, upstream: null, detachedHash: '3c4d5e6' },
        ],
      },
    });

    render(<BranchStatusBarItem />);

    const button = screen.getByRole('button');
    const tooltip = button.getAttribute('aria-label') ?? '';
    expect(tooltip).toContain('repo-a: v1.5.0');
    expect(tooltip).toContain('repo-b: 3c4d5e6');
    expect(tooltip).not.toContain('HEAD (detached at');
  });

  it('correctly resolves effective ref using getRepoEffectiveRef helper', () => {
    const rTag = { ...makeRepo('r1', false, 0), branch: 'HEAD (detached at v2.0)' };
    const rHash = { ...makeRepo('r2', false, 0), branch: 'HEAD (detached at 1234567)' };
    const rNamed = { ...makeRepo('r3', false, 0), branch: 'feature/auth' };
    const rSvn = { ...makeRepo('r4', false, 0), branch: '', revision: 'r123456789' };

    const branchesByRepo = {
      r1: [{ name: 'HEAD', current: true, remote: false, ahead: 0, behind: 0, upstream: null, detachedTag: 'v2.0' }],
      r2: [{ name: 'HEAD', current: true, remote: false, ahead: 0, behind: 0, upstream: null, detachedHash: '1234567' }],
      r3: [{ name: 'feature/auth', current: true, remote: false, ahead: 0, behind: 0, upstream: null }],
      r4: [],
    };

    expect(getRepoEffectiveRef(rTag, branchesByRepo)).toBe('v2.0');
    expect(getRepoEffectiveRef(rHash, branchesByRepo)).toBe('1234567');
    expect(getRepoEffectiveRef(rNamed, branchesByRepo)).toBe('feature/auth');
    expect(getRepoEffectiveRef(rSvn, branchesByRepo)).toBe('r123456');
  });

  it('resolves valid compare base ref without leaking detached HEAD status strings', () => {
    const rDetachedNoBranch = { ...makeRepo('r1', false, 0), branch: 'HEAD (no branch)' };
    const rDetachedAt = { ...makeRepo('r2', false, 0), branch: 'HEAD (detached at abc1234)' };
    const rNamed = { ...makeRepo('r3', false, 0), branch: 'main' };

    const branchesByRepo = {
      r1: [{ name: 'HEAD', current: true, remote: false, ahead: 0, behind: 0, upstream: null }],
      r2: [], // 尚未加载分支列表
      r3: [{ name: 'main', current: true, remote: false, ahead: 0, behind: 0, upstream: null }],
    };

    expect(getRepoCompareBase(rDetachedNoBranch, branchesByRepo)).toBe('HEAD');
    expect(getRepoCompareBase(rDetachedAt, branchesByRepo)).toBe('HEAD');
    expect(getRepoCompareBase(rNamed, branchesByRepo)).toBe('main');
  });

  it('resolves correct codicon for detached tags, detached commits and branches', () => {
    const rTag = makeRepo('r1', false, 0);
    const rCommit = makeRepo('r2', false, 0);
    const rBranch = makeRepo('r3', false, 0);

    const branchesByRepo = {
      r1: [{ name: 'HEAD', current: true, remote: false, ahead: 0, behind: 0, upstream: null, detachedTag: 'v1.0.0' }],
      r2: [{ name: 'HEAD', current: true, remote: false, ahead: 0, behind: 0, upstream: null, detachedHash: 'a1b2c3d' }],
      r3: [{ name: 'feature/login', current: true, remote: false, ahead: 0, behind: 0, upstream: null }],
    };

    expect(getRepoRefIcon(rTag, branchesByRepo)).toBe('tag');
    expect(getRepoRefIcon(rCommit, branchesByRepo)).toBe('git-commit');
    expect(getRepoRefIcon(rBranch, branchesByRepo)).toBe('git-branch');
  });

  it('formats operation labels as clean text without markdown asterisks for React rendering', () => {
    expect(formatRepoOperationLabel('merge')).toBe(' (merging)');
    expect(formatRepoOperationLabel('rebase')).toBe(' (rebasing)');
    expect(formatRepoOperationLabel('cherry-pick')).toBe(' (cherry-picking)');
    expect(formatRepoOperationLabel('revert')).toBe(' (reverting)');
    expect(formatRepoOperationLabel('merge').includes('*')).toBe(false);
    expect(formatRepoOperationLabel(null)).toBe('');
    expect(formatRepoOperationLabel(undefined)).toBe('');
  });
});
