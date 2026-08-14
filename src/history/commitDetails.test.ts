import { describe, expect, it } from 'vitest';
import type { CommitDetail, CommitNode, RepositoryStatus } from '../bindings/generated';
import { buildCommitFileTargets, commitKey } from './commitDetails';

const repo: RepositoryStatus = {
  meta: { id: 'repo', name: 'Repo', rootPath: '/tmp/repo', color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
};

const svnRepo: RepositoryStatus = {
  ...repo,
  meta: { ...repo.meta, id: 'svn-repo', kind: 'svn' },
};

const commit = (hash: string, parent: string | undefined): CommitNode => ({
  repoId: 'repo', hash, shortHash: hash.slice(0, 8), parents: parent ? [parent] : [], author: 'Ada', email: 'ada@example.test', authorDate: hash, committerDate: hash, message: hash, refs: [],
});

describe('commit detail aggregation', () => {
  it('merges repeated paths and carries the selected commit range to Diff', () => {
    const newest = commit('a'.repeat(40), 'b'.repeat(40));
    const oldest = commit('b'.repeat(40), 'c'.repeat(40));
    const details: Record<string, CommitDetail> = {
      [commitKey('repo', newest.hash)]: { commit: newest, fullMessage: newest.message, branches: { local: [], remote: [], tags: [] }, files: [{ path: 'src/App.tsx', status: 'M', added: 2, removed: 1 }] },
      [commitKey('repo', oldest.hash)]: { commit: oldest, fullMessage: oldest.message, branches: { local: [], remote: [], tags: [] }, files: [{ path: 'src/App.tsx', status: 'M', added: 3, removed: 4 }] },
    };
    const files = buildCommitFileTargets([newest, oldest], details, [repo]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'src/App.tsx', added: 5, removed: 5, fromRevision: 'c'.repeat(40), toRevision: 'a'.repeat(40), commitHash: 'b'.repeat(40) });
    expect(files[0].commitHashes).toEqual([newest.hash, oldest.hash]);
  });

  it('uses numeric SVN revisions for a multi-revision Diff range', () => {
    const newest = { ...commit('2', '1'), repoId: 'svn-repo' };
    const oldest = { ...commit('1', undefined), repoId: 'svn-repo' };
    const details: Record<string, CommitDetail> = {
      [commitKey('svn-repo', newest.hash)]: { commit: newest, fullMessage: newest.message, branches: { local: [], remote: [], tags: [] }, files: [{ path: '中文 file.txt', status: 'M', added: 1, removed: 0 }] },
      [commitKey('svn-repo', oldest.hash)]: { commit: oldest, fullMessage: oldest.message, branches: { local: [], remote: [], tags: [] }, files: [{ path: '中文 file.txt', status: 'A', added: null, removed: null }] },
    };
    const files = buildCommitFileTargets([newest, oldest], details, [svnRepo]);
    expect(files[0]).toMatchObject({ fromRevision: '0', toRevision: '2' });
  });
});
