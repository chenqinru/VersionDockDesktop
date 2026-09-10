import { describe, expect, it } from 'vitest';
import { buildPullRequestUrl } from './prUrlHelper';

describe('prUrlHelper', () => {
  it('builds PR URL for GitHub SSH and HTTPS remotes', () => {
    const ssh = buildPullRequestUrl('git@github.com:facebook/react.git', 'feature/hooks');
    expect(ssh).toEqual({
      platform: 'GitHub',
      url: 'https://github.com/facebook/react/pull/new/feature%2Fhooks',
    });

    const https = buildPullRequestUrl('https://github.com/vuejs/core.git', 'v3-compat');
    expect(https).toEqual({
      platform: 'GitHub',
      url: 'https://github.com/vuejs/core/pull/new/v3-compat',
    });
  });

  it('builds MR URL for GitLab', () => {
    const gitlab = buildPullRequestUrl('git@gitlab.com:gitlab-org/gitlab.git', 'patch-1');
    expect(gitlab?.platform).toBe('GitLab');
    expect(gitlab?.url).toContain('/-/merge_requests/new');
  });

  it('builds PR URL for Gitee and Bitbucket', () => {
    const gitee = buildPullRequestUrl('https://gitee.com/oschina/git-osc.git', 'dev');
    expect(gitee?.platform).toBe('Gitee');

    const bitbucket = buildPullRequestUrl('git@bitbucket.org:atlassian/repo.git', 'hotfix');
    expect(bitbucket?.platform).toBe('Bitbucket');
  });

  it('returns undefined for invalid remotes or branch names', () => {
    expect(buildPullRequestUrl('', 'main')).toBeUndefined();
    expect(buildPullRequestUrl('git@github.com:foo/bar.git', 'HEAD')).toBeUndefined();
    expect(buildPullRequestUrl('invalid-url', 'feature')).toBeUndefined();
  });
});
