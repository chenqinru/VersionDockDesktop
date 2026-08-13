import { describe, expect, it } from 'vitest';
import type { CommitNode } from '../bindings/generated';
import { layoutCommits } from './commitGraphLayout';

const commit = (repoId: string, hash: string, parents: string[]): CommitNode => ({
  repoId, hash, shortHash: hash, parents, author: 'Ada', email: '', authorDate: '', committerDate: '', message: hash, refs: [],
});

describe('layoutCommits', () => {
  it('resets graph lanes at repository block boundaries', () => {
    const values = layoutCommits([
      commit('a', 'a2', ['a1']), commit('a', 'a1', []),
      commit('b', 'b2', ['b1']), commit('b', 'b1', []),
    ]);
    expect(values.map((value) => value.lane)).toEqual([0, 0, 0, 0]);
  });
});
