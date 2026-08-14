import { describe, expect, it } from 'vitest';
import type { CommitNode } from '../bindings/generated';
import { layoutCommits } from './commitGraphLayout';

const commit = (repoId: string, hash: string, parents: string[]): CommitNode => ({
  repoId, hash, shortHash: hash, parents, author: 'Ada', email: '', authorDate: '', committerDate: '', message: hash, refs: [],
});

const refCommit = (repoId: string, hash: string, parents: string[], refs: string[]): CommitNode => ({ ...commit(repoId, hash, parents), refs });

describe('layoutCommits', () => {
  it('resets graph lanes at repository block boundaries', () => {
    const values = layoutCommits([
      commit('a', 'a2', ['a1']), commit('a', 'a1', []),
      commit('b', 'b2', ['b1']), commit('b', 'b1', []),
    ]);
    expect(values.map((value) => value.lane)).toEqual([0, 0, 0, 0]);
  });

  it('keeps the primary branch on lane zero when a feature commit appears first', () => {
    const values = layoutCommits([
      refCommit('repo', 'feature', ['main'], ['feature/ui']),
      refCommit('repo', 'main', ['root'], ['HEAD -> main']),
      commit('repo', 'root', []),
    ]);
    expect(values.map((value) => value.lane)).toEqual([1, 0, 0]);
    expect(values[1].segments.some((segment) => segment.from === 0 && segment.to === 0)).toBe(true);
  });

  it('allocates a secondary lane for a merge parent and compresses it after the fork ends', () => {
    const values = layoutCommits([
      refCommit('repo', 'merge', ['main', 'feature'], ['HEAD -> main']),
      commit('repo', 'main', ['root']),
      commit('repo', 'feature', ['feature-root']),
      commit('repo', 'root', []),
      commit('repo', 'feature-root', []),
    ]);
    expect(values[0].segments.filter((segment) => segment.start === 'middle')).toHaveLength(2);
    expect(values[0].laneCount).toBeGreaterThanOrEqual(2);
    expect(values[3].lane).toBe(0);
    expect(values[4].lane).toBe(0);
  });

  it('does not connect a missing parent or a parent from another repository', () => {
    const values = layoutCommits([
      commit('repo-a', 'head', ['missing']),
      commit('repo-b', 'head', ['missing']),
    ]);
    expect(values.every((value) => value.lane === 0 && value.laneCount === 1)).toBe(true);
    expect(values[0].segments.every((segment) => segment.to === 0)).toBe(true);
  });

  it('keeps interleaved repository graphs on independent lane coordinates', () => {
    const values = layoutCommits([
      refCommit('repo-a', 'feature', ['main'], ['feature/a']),
      refCommit('repo-b', 'feature', ['main'], ['feature/b']),
      refCommit('repo-a', 'main', ['root'], ['HEAD -> main']),
      refCommit('repo-b', 'main', ['root'], ['HEAD -> main']),
      commit('repo-a', 'root', []),
      commit('repo-b', 'root', []),
    ]);

    expect(values.filter((value) => value.repoId === 'repo-a').map((value) => value.lane)).toEqual([1, 0, 0]);
    expect(values.filter((value) => value.repoId === 'repo-b').map((value) => value.lane)).toEqual([1, 0, 0]);
  });
});
