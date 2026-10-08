import { describe, expect, it } from 'vitest';
import { branchRevisionRef, classifyRef, commitRefs, groupRefs, isPrimaryBranch, mergeLocalRemote, primaryBranchRef } from './refs';

describe('history refs', () => {
  it('sorts tag numbers naturally while retaining branch ranks and lexical branch order', () => {
    const raw = ['refs/tags/v1.10', 'refs/heads/feature2', 'refs/tags/v1.2', 'refs/tags/v1.1', 'refs/heads/feature10', 'refs/heads/main', 'refs/remotes/origin/main'];
    const groups = groupRefs(raw, 'git', ['origin']);
    expect(groups.map(group => group.label)).toEqual(['main', 'feature10', 'feature2', 'main', 'v1.1', 'v1.2', 'v1.10']);
    expect(mergeLocalRemote(groups).map(group => group.label)).toEqual(['main', 'feature10', 'feature2', 'v1.1', 'v1.2', 'v1.10']);
  });

  it('classifies local, remote, tag and HEAD refs', () => {
    expect(classifyRef('HEAD -> main')).toMatchObject({ label: 'main', kind: 'head', isHead: true });
    expect(classifyRef('origin/main')).toMatchObject({ label: 'origin/main', kind: 'remote', isRemote: true });
    expect(classifyRef('tag: v1.0.0')).toMatchObject({ label: 'v1.0.0', kind: 'tag' });
    expect(classifyRef('r7453')).toMatchObject({ label: 'r7453', kind: 'svn' });
  });

  it('prefers the local HEAD branch as the lane identity', () => {
    expect(primaryBranchRef({ refs: ['origin/main', 'HEAD -> feature/ui'] })).toBe('feature/ui');
    expect(commitRefs({ refs: ['main', 'origin/main'] }).map((ref) => ref.label)).toEqual(['main', 'origin/main']);
  });

  it('recognizes only the exact primary branch names used by VersionDock', () => {
    expect(isPrimaryBranch('main')).toBe(true);
    expect(isPrimaryBranch('prod/task-center')).toBe(false);
    expect(isPrimaryBranch('release/candidate')).toBe(false);
    expect(isPrimaryBranch('feature/main')).toBe(false);
  });

  it('groups and merges matching local and remote refs into unified badges', () => {
    const rawRefs = ['HEAD -> main', 'main', 'origin/main', 'tag: v1.0.0'];
    const groups = groupRefs(rawRefs, 'git', ['origin']);
    const merged = mergeLocalRemote(groups);

    const mainMerged = merged.find((g) => g.label === 'main');
    expect(mainMerged).toBeDefined();
    expect(mainMerged?.isLocal).toBe(true);
    expect(mainMerged?.isRemote).toBe(true);
    expect(mainMerged?.remoteName).toBe('origin');

    const tagGroup = merged.find((g) => g.isTag);
    expect(tagGroup?.label).toBe('v1.0.0');
  });

  it('sorts primary branches first and leaves remote HEAD at the end for callers to hide', () => {
    const groups = groupRefs([
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/zeta',
      'refs/heads/feature/ui',
      'refs/heads/main',
      'refs/tags/v1.0.0',
    ], 'git', ['origin']);
    expect(groups.map((group) => group.key)).toEqual([
      'main',
      'feature/ui',
      'remote:origin:zeta',
      'tag:v1.0.0',
      'origin/HEAD',
    ]);
  });

  it('passes SVN branch names without adding a branches prefix', () => {
    expect(branchRevisionRef({ name: 'feature/ui' }, 'svn')).toBe('feature/ui');
    expect(branchRevisionRef({ name: 'trunk' }, 'svn')).toBe('trunk');
  });
});
