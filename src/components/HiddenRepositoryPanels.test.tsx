import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryStatus } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { ShelfPanel } from './ShelfPanel';
import { StashPanel } from './StashPanel';
import { SubmodulePanel } from './SubmodulePanel';
import { SubtreePanel } from './SubtreePanel';
import { SyncPanel } from './SyncPanel';
import { WorktreePanel } from './WorktreePanel';

const original = useAppStore.getState();
const repo: RepositoryStatus = {
  meta: { id: 'repo', name: 'Repository', rootPath: '/tmp/repo', kind: 'git', color: '#4080c0', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch: 'main', revision: 'head', ahead: 0, behind: 0, conflicts: 0, files: [], operation: null,
};
const loaders = ['loadStashes', 'loadShelves', 'loadWorktrees', 'loadSubtrees', 'loadSubmodules', 'loadUnpushedCommits', 'loadIncomingCommits'] as const;
afterEach(() => { cleanup(); useAppStore.setState(original, true); });

describe('hidden repository panels', () => {
  it.each([
    { name: 'stash', Component: StashPanel, expected: ['loadStashes'] },
    { name: 'shelf', Component: ShelfPanel, expected: ['loadShelves'] },
    { name: 'worktree', Component: WorktreePanel, expected: ['loadWorktrees'] },
    { name: 'subtree', Component: SubtreePanel, expected: ['loadSubtrees'] },
    { name: 'submodule', Component: SubmodulePanel, expected: ['loadSubmodules'] },
    { name: 'sync', Component: SyncPanel, expected: ['loadUnpushedCommits', 'loadIncomingCommits'] },
  ])('pauses missing $name reads while hidden and resumes when shown', async ({ Component, expected }) => {
    const load = Object.fromEntries(loaders.map(key => [key, vi.fn().mockResolvedValue(undefined)]));
    useAppStore.setState({ ...load, bridge: undefined, snapshot: undefined, stashes: {}, shelves: {}, worktrees: {}, subtrees: {}, submodules: {}, unpushedCommits: {}, incomingCommits: {}, loadErrors: {} });
    const view = render(<Component active={false} repos={[repo]} />);
    await act(async () => {});
    for (const key of expected) expect(load[key]).not.toHaveBeenCalled();
    view.rerender(<Component active repos={[repo]} />);
    await act(async () => {});
    for (const key of expected) expect(load[key]).toHaveBeenCalledOnce();
    const nextRepo = { ...repo, meta: { ...repo.meta, id: 'other' } };
    view.rerender(<Component active={false} repos={[nextRepo]} />);
    await act(async () => {});
    for (const key of expected) expect(load[key]).toHaveBeenCalledOnce();
  });
});
