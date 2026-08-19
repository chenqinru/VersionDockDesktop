import { describe, expect, it } from 'vitest';
import { classifyRef, commitRefs, groupRefs, isPrimaryBranch, mergeLocalRemote, primaryBranchRef } from './refs';

describe('history refs', () => {
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

  it('recognizes primary branch families used by the reference panel', () => {
    expect(isPrimaryBranch('main')).toBe(true);
    expect(isPrimaryBranch('prod/task-center')).toBe(true);
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
});

