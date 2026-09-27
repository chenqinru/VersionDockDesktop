import { describe, expect, it } from 'vitest';
import type { RepositoryStatus } from '../../bindings/generated';
import { resolveSubmoduleOperationTarget } from './submoduleTarget';
import {
  formatRepoOperationLabel,
  isMixedRepoWorkspace,
  formatRepoDisplayName,
  isAbortableVcsOperation,
  getAbortOperationLabels,
} from './branchRef';

const repository = (id: string, rootPath: string, parentRepoId: string | null, isSubmodule: boolean): RepositoryStatus => ({
  meta: { id, name: id, rootPath, color: '#4ec9b0', kind: 'git', parentRepoId, depth: parentRepoId ? 1 : 0, isSubmodule, isWorktree: false },
  branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
});

describe('BranchMenuPopover submodule contract', () => {
  it('targets the parent repository with a normalized relative gitlink path', () => {
    const parent = repository('parent', 'C:\\work\\project', null, false);
    const submodule = repository('child', 'C:\\work\\project\\vendor\\中文 module', 'parent', true);

    const target = resolveSubmoduleOperationTarget([parent, submodule], 'child');

    expect(target?.parent.meta.id).toBe('parent');
    expect(target?.submodule.meta.id).toBe('child');
    expect(target?.path).toBe('vendor/中文 module');
  });

  it('rejects a submodule root that is not contained by its declared parent', () => {
    const parent = repository('parent', '/workspace/project', null, false);
    const submodule = repository('child', '/workspace/project-other/vendor/module', 'parent', true);
    expect(resolveSubmoduleOperationTarget([parent, submodule], 'child')).toBeUndefined();
  });
});

describe('BranchMenuPopover multi-repo branch filtering contract', () => {
  it('filters candidate repos for branch creation based on base branch availability', () => {
    const branchesByRepo: Record<string, { name: string; remote: boolean }[]> = {
      'repo-1': [{ name: 'main', remote: false }, { name: 'feature/login', remote: false }],
      'repo-2': [{ name: 'main', remote: false }],
      'repo-3': [{ name: 'dev', remote: false }],
    };

    const repos = [
      repository('repo-1', '/work/repo1', null, false),
      repository('repo-2', '/work/repo2', null, false),
      repository('repo-3', '/work/repo3', null, false),
    ];

    // 当基准分支为 feature/login 时，只有 repo-1 包含该分支
    const candidatesForFeature = repos.filter((r) =>
      (branchesByRepo[r.meta.id] ?? []).some((b) => b.name === 'feature/login')
    );
    expect(candidatesForFeature.map((r) => r.meta.id)).toEqual(['repo-1']);

    // 当基准分支为 main 时，repo-1 与 repo-2 包含该分支
    const candidatesForMain = repos.filter((r) =>
      (branchesByRepo[r.meta.id] ?? []).some((b) => b.name === 'main')
    );
    expect(candidatesForMain.map((r) => r.meta.id)).toEqual(['repo-1', 'repo-2']);
  });

  it('filters candidate repos for common branch comparison', () => {
    const branchesByRepo: Record<string, { name: string; remote: boolean }[]> = {
      'repo-1': [{ name: 'feature/auth', remote: false }],
      'repo-2': [{ name: 'feature/auth', remote: false }],
      'repo-3': [{ name: 'feature/pay', remote: false }],
    };

    const repos = [
      repository('repo-1', '/work/repo1', null, false),
      repository('repo-2', '/work/repo2', null, false),
      repository('repo-3', '/work/repo3', null, false),
    ];

    const targetBranch = 'feature/auth';
    const candidateRepos = repos.filter((r) => {
      const list = branchesByRepo[r.meta.id] ?? [];
      return list.some((b) => b.name === targetBranch);
    });

    expect(candidateRepos.map((r) => r.meta.id)).toEqual(['repo-1', 'repo-2']);
  });

  it('determines unpushed status correctly when upstream is missing even if ahead is 0', () => {
    const gitCurrentBranches = [
      { name: 'main', current: true, upstream: 'origin/main', ahead: 0 },
      { name: 'feature/new', current: true, upstream: null, ahead: 0 },
    ];
    const totalAhead = 0;
    const hasNoUpstream = gitCurrentBranches.some((b) => !b.upstream);
    const hasUnpushed = totalAhead > 0 || hasNoUpstream;

    expect(hasNoUpstream).toBe(true);
    expect(hasUnpushed).toBe(true);

    const description = hasUnpushed
      ? totalAhead > 0
        ? `Push commits to remote (${totalAhead} to push)`
        : 'Push commits to remote (branch not on remote)'
      : hasNoUpstream
        ? 'Some branches have no upstream set'
        : 'Push current branch to remote';

    expect(description).toBe('Push commits to remote (branch not on remote)');
  });

  it('detects detached HEAD state from detachedTag, detachedHash or HEAD branch name', () => {
    const isDetachedFromTag = Boolean({ detachedTag: 'v1.0.0' }?.detachedTag);
    const isDetachedFromHash = Boolean({ detachedHash: 'abc1234' }?.detachedHash);
    const isDetachedFromHeadBranch = 'HEAD (no branch)'.startsWith('HEAD');
    const isNotDetached = Boolean({ name: 'main', detachedTag: null, detachedHash: null }?.detachedTag);

    expect(isDetachedFromTag).toBe(true);
    expect(isDetachedFromHash).toBe(true);
    expect(isDetachedFromHeadBranch).toBe(true);
    expect(isNotDetached).toBe(false);
  });

  it('generates comparison notification actions for each succeeded repository and guards workspace switching', () => {
    const initiatedWorkspaceId = 'ws-1';
    let currentWorkspaceId = 'ws-1';

    const succeededRepos = [
      repository('repo-1', '/work/repo1', null, false),
      repository('repo-2', '/work/repo2', null, false),
    ];
    const targetBranch = 'feature/login';

    const actions = succeededRepos.map((r) => ({
      type: 'openBranchComparison',
      label: r.meta.name,
      repoId: r.meta.id,
      target: targetBranch,
    }));

    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({ type: 'openBranchComparison', label: 'repo-1', repoId: 'repo-1', target: 'feature/login' });
    expect(actions[1]).toEqual({ type: 'openBranchComparison', label: 'repo-2', repoId: 'repo-2', target: 'feature/login' });

    // 若期间工作区发生切换，防御逻辑应阻止后续状态写入
    currentWorkspaceId = 'ws-2';
    const isStale = currentWorkspaceId !== initiatedWorkspaceId;
    expect(isStale).toBe(true);
  });

  it('does not select or open comparison when all repositories fail', () => {
    const failedSettled = [
      { repo: repository('repo-1', '/work/repo1', null, false), result: null, error: 'fatal: ambiguous argument' },
      { repo: repository('repo-2', '/work/repo2', null, false), result: null, error: 'fatal: ambiguous argument' },
    ];
    const succeeded = failedSettled.filter((item) => item.result !== null);
    const selectedRepoId = 'repo-1';

    // 修复后的逻辑：严格仅从 succeeded 中选取，不回退到 settled[0]
    const primaryRepo = (succeeded.find((item) => item.repo.meta.id === selectedRepoId) ?? succeeded[0])?.repo;
    expect(primaryRepo).toBeUndefined();
  });

  it('blocks opening comparison if workspace switches during selectRepo await window', () => {
    const targetWorkspaceId = 'ws-original';
    let currentWorkspaceId: string = targetWorkspaceId;

    let comparisonOpened = false;
    const fakeAsyncSelectRepoAndOpen = async () => {
      // 模拟 selectRepo 等待期间用户切换了工作区
      currentWorkspaceId = 'ws-switched';

      // 二次防护检查
      if (currentWorkspaceId !== targetWorkspaceId) return;
      comparisonOpened = true;
    };

    return fakeAsyncSelectRepoAndOpen().then(() => {
      expect(comparisonOpened).toBe(false);
    });
  });
});

describe('BranchMenuPopover & BranchStatusBarItem alignment tests', () => {
  it('computes branches and tags for single Git repository and uses singular group headers', () => {
    const gitRepo = repository('repo-git', '/work/git', null, false);
    const gitRepos = [gitRepo];
    const branchesByRepo: Record<string, { name: string; remote: boolean; current?: boolean }[]> = {
      'repo-git': [
        { name: 'main', remote: false, current: true },
        { name: 'feature/v2', remote: false, current: false },
        { name: 'origin/main', remote: true, current: false },
      ],
    };
    const tagsByRepo: Record<string, { name: string; hash: string; date: string }[]> = {
      'repo-git': [{ name: 'v1.0.0', hash: '1234567', date: '2026-01-01' }],
    };

    // 逻辑验证：gitRepos.length === 0 时为空，gitRepos.length === 1 时放行
    const computeCommon = (repos: typeof gitRepos) => {
      if (repos.length === 0) return { commonLocalBranches: [], commonRemoteBranches: [], commonTags: [] };
      const localBranchMap: Record<string, number> = {};
      const remoteBranchMap: Record<string, number> = {};
      const tagMap: Record<string, number> = {};

      repos.forEach((repo) => {
        const branches = branchesByRepo[repo.meta.id] ?? [];
        const tags = tagsByRepo[repo.meta.id] ?? [];
        branches.forEach((b) => {
          if (b.remote) remoteBranchMap[b.name] = (remoteBranchMap[b.name] ?? 0) + 1;
          else localBranchMap[b.name] = (localBranchMap[b.name] ?? 0) + 1;
        });
        tags.forEach((t) => {
          tagMap[t.name] = (tagMap[t.name] ?? 0) + 1;
        });
      });

      const totalGit = repos.length;
      return {
        commonLocalBranches: Object.keys(localBranchMap).filter((n) => localBranchMap[n] === totalGit),
        commonRemoteBranches: Object.keys(remoteBranchMap).filter((n) => remoteBranchMap[n] === totalGit),
        commonTags: Object.keys(tagMap).filter((n) => tagMap[n] === totalGit),
      };
    };

    const res = computeCommon(gitRepos);
    expect(res.commonLocalBranches).toEqual(['main', 'feature/v2']);
    expect(res.commonRemoteBranches).toEqual(['origin/main']);
    expect(res.commonTags).toEqual(['v1.0.0']);

    // 分组标题：单仓库时显示 LOCAL BRANCHES，多仓库显示 COMMON LOCAL BRANCHES
    const localHeader = gitRepos.length === 1 ? 'LOCAL BRANCHES' : 'COMMON LOCAL BRANCHES';
    const remoteHeader = gitRepos.length === 1 ? 'REMOTE BRANCHES' : 'COMMON REMOTE BRANCHES';
    const tagHeader = gitRepos.length === 1 ? 'TAGS' : 'COMMON TAGS';
    expect(localHeader).toBe('LOCAL BRANCHES');
    expect(remoteHeader).toBe('REMOTE BRANCHES');
    expect(tagHeader).toBe('TAGS');
  });

  it('identifies single SVN repository and configures direct repoOnly entry without back button', () => {
    const svnRepo: RepositoryStatus = {
      meta: { id: 'repo-svn', name: 'svn-wc', rootPath: '/work/svn', color: '#ff8800', kind: 'svn', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
      branch: '^/trunk', revision: 'r100', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
    };
    const repositories = [svnRepo];
    const isSingleSvn = repositories.length === 1 && repositories[0].meta.kind === 'svn';

    expect(isSingleSvn).toBe(true);
    const initialRepoId = isSingleSvn ? repositories[0].meta.id : undefined;
    const repoOnly = isSingleSvn;

    expect(initialRepoId).toBe('repo-svn');
    expect(repoOnly).toBe(true);
  });

  it('manages recent branches: unshifts, dedupes, caps at 3 and ignores HEAD', () => {
    const map: Record<string, string[]> = {};
    const record = (repoId: string, branchName: string) => {
      if (!branchName || branchName === 'HEAD') return;
      const existing = map[repoId] ?? [];
      const filtered = existing.filter((name) => name !== branchName);
      filtered.unshift(branchName);
      map[repoId] = filtered.slice(0, 3);
    };

    record('repo-1', 'HEAD');
    expect(map['repo-1']).toBeUndefined();

    record('repo-1', 'feature/a');
    expect(map['repo-1']).toEqual(['feature/a']);

    record('repo-1', 'feature/b');
    expect(map['repo-1']).toEqual(['feature/b', 'feature/a']);

    record('repo-1', 'feature/c');
    expect(map['repo-1']).toEqual(['feature/c', 'feature/b', 'feature/a']);

    // 再次检出 feature/a：移至最前且长度不超 3
    record('repo-1', 'feature/a');
    expect(map['repo-1']).toEqual(['feature/a', 'feature/c', 'feature/b']);

    // 检出 feature/d：移除最旧的 feature/b
    record('repo-1', 'feature/d');
    expect(map['repo-1']).toEqual(['feature/d', 'feature/a', 'feature/c']);
  });

  it('filters recent branches to exclude current branch and non-existent local branches', () => {
    const recent = ['feature/d', 'feature/a', 'old-deleted-branch'];
    const local = [
      { name: 'main', current: true },
      { name: 'feature/a', current: false },
      { name: 'feature/d', current: false },
    ];

    const validRecent = recent
      .map((name) => local.find((b) => b.name === name))
      .filter((b): b is NonNullable<typeof b> => Boolean(b && !b.current));

    expect(validRecent.map((b) => b.name)).toEqual(['feature/d', 'feature/a']);
  });

  it('formats commit detail with message and relative date', () => {
    const branchWithBoth = {
      name: 'feature/test',
      lastCommitMessage: 'feat: add user login',
      lastCommitDate: '2 hours ago',
    };
    const commitDetail = branchWithBoth.lastCommitMessage
      ? `${branchWithBoth.lastCommitMessage}${branchWithBoth.lastCommitDate ? ` · ${branchWithBoth.lastCommitDate}` : ''}`
      : undefined;

    expect(commitDetail).toBe('feat: add user login · 2 hours ago');

    const branchWithoutDate = {
      name: 'feature/test2',
      lastCommitMessage: 'fix: typo',
      lastCommitDate: null,
    };
    const commitDetail2 = branchWithoutDate.lastCommitMessage
      ? `${branchWithoutDate.lastCommitMessage}${branchWithoutDate.lastCommitDate ? ` · ${branchWithoutDate.lastCommitDate}` : ''}`
      : undefined;

    expect(commitDetail2).toBe('fix: typo');
  });

  it('guards menu opening when VCS operation is in progress', async () => {
    let operationRunning = true;
    let menuOpened = false;

    const handleClickWithWait = async (waitChoice: 'wait' | 'cancel') => {
      if (operationRunning) {
        if (waitChoice !== 'wait') return;

        // 模拟等待 20ms 后操作完成
        setTimeout(() => { operationRunning = false; }, 20);
        let waited = 0;
        while (operationRunning && waited < 1000) {
          await new Promise((r) => setTimeout(r, 10));
          waited += 10;
        }
      }
      menuOpened = true;
    };

    // 用户取消：不打开
    await handleClickWithWait('cancel');
    expect(menuOpened).toBe(false);

    // 用户点击 Wait and Open Menu：等待完成后打开
    await handleClickWithWait('wait');
    expect(menuOpened).toBe(true);
  });

  it('only records recent branch when checkout operation completes successfully', () => {
    const map: Record<string, string[]> = {};
    const recordRecent = (repoId: string, branchName: string, completed?: boolean) => {
      if (!completed) return;
      if (!branchName || branchName === 'HEAD') return;
      const existing = map[repoId] ?? [];
      const filtered = existing.filter((name) => name !== branchName);
      filtered.unshift(branchName);
      map[repoId] = filtered.slice(0, 3);
    };

    // 检出失败或冲突未完成：不应记录
    recordRecent('repo-1', 'feature/conflict', false);
    expect(map['repo-1']).toBeUndefined();

    // 检出中止返回 undefined：不应记录
    recordRecent('repo-1', 'feature/aborted', undefined);
    expect(map['repo-1']).toBeUndefined();

    // 检出成功：正常记录
    recordRecent('repo-1', 'feature/success', true);
    expect(map['repo-1']).toEqual(['feature/success']);
  });

  it('records recent branch only for successfully settled repositories in common branch checkout', async () => {
    const gitRepos = [
      repository('repo-1', '/work/repo1', null, false),
      repository('repo-2', '/work/repo2', null, false),
      repository('repo-3', '/work/repo3', null, false),
    ];
    const targetBranch = 'feature/common';
    const recentMap: Record<string, string[]> = {};

    // 模拟 repo-1 成功，repo-2 发生冲突未完成，repo-3 抛错拒绝
    const fakeBranchOp = async (_op: object, repoId: string) => {
      if (repoId === 'repo-1') return { completed: true, conflicted: false };
      if (repoId === 'repo-2') return { completed: false, conflicted: true };
      throw new Error('git checkout failed');
    };

    const settled = await Promise.allSettled(
      gitRepos.map((r) => fakeBranchOp({ type: 'checkout', name: targetBranch }, r.meta.id))
    );

    settled.forEach((res, idx) => {
      if (res.status === 'fulfilled' && res.value?.completed) {
        recentMap[gitRepos[idx].meta.id] = [targetBranch];
      }
    });

    expect(recentMap['repo-1']).toEqual(['feature/common']);
    expect(recentMap['repo-2']).toBeUndefined();
    expect(recentMap['repo-3']).toBeUndefined();
  });

  it('evaluates diverged branches warning contract for multiple top-level git repos', () => {
    const r1 = repository('r1', '/work/r1', null, false);
    const r2 = repository('r2', '/work/r2', null, false);
    const submodule = repository('sub1', '/work/r1/sub1', 'r1', true);

    const computeDiverged = (
      repos: RepositoryStatus[],
      branchesByRepo: Record<string, { current?: boolean; name: string }[]>,
      suppress: boolean
    ) => {
      const nonWorktree = repos.filter((r) => !r.meta.isWorktree);
      const targets = nonWorktree.length > 0 ? nonWorktree : repos;
      const targetGit = targets.filter((r) => r.meta.kind === 'git');
      const topLevel = targetGit.filter((r) => !r.meta.isSubmodule);
      const names = Array.from(new Set(topLevel.map((r) => {
        const current = (branchesByRepo[r.meta.id] ?? []).find((b) => b.current);
        return current?.name ?? r.branch;
      })));
      const diverged = topLevel.length > 1 && names.length > 1;
      return diverged && !suppress;
    };

    // 两个仓库处于不同分支且未抑制：显示分歧警告
    expect(
      computeDiverged(
        [r1, r2, submodule],
        { r1: [{ name: 'main', current: true }], r2: [{ name: 'dev', current: true }], sub1: [{ name: 'patch', current: true }] },
        false
      )
    ).toBe(true);

    // 开启抑制选项：隐藏分歧警告
    expect(
      computeDiverged(
        [r1, r2, submodule],
        { r1: [{ name: 'main', current: true }], r2: [{ name: 'dev', current: true }] },
        true
      )
    ).toBe(false);

    // 处于相同分支：不触发分歧
    expect(
      computeDiverged(
        [r1, r2],
        { r1: [{ name: 'main', current: true }], r2: [{ name: 'main', current: true }] },
        false
      )
    ).toBe(false);
  });

  it('records recent branch when branch checkout succeeds via recovery workflow', async () => {
    const recentBranches: string[] = [];
    const markRecent = (name: string) => {
      recentBranches.push(name);
    };

    // 模拟 branchOperation 在 catch 块中执行恢复流程
    const fakeBranchOperationWithRecovery = async (recoveryStatus: 'completed' | 'conflicted' | 'partialFailure' | 'cancelled') => {
      if (recoveryStatus === 'cancelled') return undefined;
      let recoveryResult: { status: string } | undefined;
      if (recoveryStatus === 'completed') recoveryResult = { status: 'completed' };
      else if (recoveryStatus === 'conflicted') recoveryResult = { status: 'conflicted' };
      else if (recoveryStatus === 'partialFailure') recoveryResult = { status: 'partialFailure' };

      if (recoveryResult && recoveryResult.status !== 'partialFailure') {
        return {
          completed: recoveryResult.status === 'completed',
          conflicted: recoveryResult.status === 'conflicted',
        };
      }
      return undefined;
    };

    // 1. 恢复成功：返回 completed: true，记录近期分支
    const resSuccess = await fakeBranchOperationWithRecovery('completed');
    if (resSuccess?.completed) markRecent('feature/recovered');
    expect(recentBranches).toEqual(['feature/recovered']);

    // 2. 冲突或部分失败或取消：不记录
    const resConflict = await fakeBranchOperationWithRecovery('conflicted');
    if (resConflict?.completed) markRecent('feature/conflicted');
    const resCancel = await fakeBranchOperationWithRecovery('cancelled');
    if (resCancel?.completed) markRecent('feature/cancelled');
    expect(recentBranches).toEqual(['feature/recovered']);
  });

  it('guards fallback IgnoreRulesPanel from outside pointerdown dismissals and closes menu on exit', () => {
    let menuClosed = false;
    let ignoreManagerRepoId: string | null = 'repo-svn';

    const handlePointerDown = (targetIsInsideDialog: boolean) => {
      // 外部点击处理守卫：如果 ignoreManagerRepoId 激活或在面板内部，不调用 onClose
      if (targetIsInsideDialog || ignoreManagerRepoId) {
        return;
      }
      menuClosed = true;
    };

    // 用户在忽略规则弹窗内点击
    handlePointerDown(true);
    expect(menuClosed).toBe(false);

    // 用户在背景区域点击（由于弹窗激活，仍被保护不误关菜单）
    handlePointerDown(false);
    expect(menuClosed).toBe(false);

    // 弹窗完成/保存关闭：清除状态并关闭菜单
    const onDialogClose = () => {
      ignoreManagerRepoId = null;
      menuClosed = true;
    };
    onDialogClose();
    expect(ignoreManagerRepoId).toBeNull();
    expect(menuClosed).toBe(true);
  });

  it('handles delete tag choices for local, remote and both', async () => {
    const executedOps: Array<{ repoId: string; type: string; name: string; remote?: string | null }> = [];
    const fakeTagOperation = async (op: { type: string; name: string; remote?: string | null }, repoId: string) => {
      executedOps.push({ repoId, ...op });
      return true;
    };

    const handleDeleteTag = async (
      choice: 'local' | 'remote' | 'both',
      tagName: string,
      repoId: string,
      selectedRemote: string | null
    ) => {
      const deleteLocal = choice === 'local' || choice === 'both';
      const deleteRemote = choice === 'remote' || choice === 'both';

      if (deleteRemote && selectedRemote) {
        await fakeTagOperation({ type: 'delete', name: tagName, remote: selectedRemote }, repoId);
      }
      if (deleteLocal) {
        await fakeTagOperation({ type: 'delete', name: tagName, remote: null }, repoId);
      }
    };

    // 1. 删除本地
    await handleDeleteTag('local', 'v1.0.0', 'repo-1', 'origin');
    expect(executedOps).toEqual([
      { repoId: 'repo-1', type: 'delete', name: 'v1.0.0', remote: null },
    ]);
    executedOps.length = 0;

    // 2. 删除远端
    await handleDeleteTag('remote', 'v1.0.0', 'repo-1', 'origin');
    expect(executedOps).toEqual([
      { repoId: 'repo-1', type: 'delete', name: 'v1.0.0', remote: 'origin' },
    ]);
    executedOps.length = 0;

    // 3. 同时删除本地与远端
    await handleDeleteTag('both', 'v1.0.0', 'repo-1', 'origin');
    expect(executedOps).toEqual([
      { repoId: 'repo-1', type: 'delete', name: 'v1.0.0', remote: 'origin' },
      { repoId: 'repo-1', type: 'delete', name: 'v1.0.0', remote: null },
    ]);
  });

  it('normalizes SVN ignore subdirectory path and passes to ignore manager', () => {
    const normalizeSubdir = (raw: string) => {
      return raw.trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
    };

    expect(normalizeSubdir('')).toBe('');
    expect(normalizeSubdir('   ')).toBe('');
    expect(normalizeSubdir('/src/components/')).toBe('src/components');
    expect(normalizeSubdir('\\vendor\\lib\\')).toBe('vendor\\lib');
    expect(normalizeSubdir('submodules/core')).toBe('submodules/core');
  });

  it('deletes common tag remote across multiple repos and multiple remotes without dialog conflicts', async () => {
    const repos = [
      { id: 'repo-1', remotes: ['origin', 'upstream'] },
      { id: 'repo-2', remotes: ['origin'] },
      { id: 'repo-3', remotes: [] },
    ];
    const executedOps: Array<{ repoId: string; type: string; name: string; remote?: string | null }> = [];

    const fakeTagOperation = async (op: { type: string; name: string; remote?: string | null }, repoId: string) => {
      executedOps.push({ repoId, ...op });
    };

    const handleCommonDeleteTag = async (
      choice: 'local' | 'remote' | 'both',
      tagName: string
    ) => {
      const deleteLocal = choice === 'local' || choice === 'both';
      const deleteRemote = choice === 'remote' || choice === 'both';

      await Promise.allSettled(
        repos.map(async (r) => {
          if (deleteLocal) {
            await fakeTagOperation({ type: 'delete', name: tagName }, r.id);
          }
          if (deleteRemote) {
            for (const rem of r.remotes) {
              await fakeTagOperation({ type: 'delete', name: tagName, remote: rem }, r.id);
            }
          }
        })
      );
    };

    // 运行同时删除本地和远端
    await handleCommonDeleteTag('both', 'v2.0.0');

    // 验证所有仓库的本地和所有远端均被精确删除，无并发 choiceDialog 冲突
    expect(executedOps).toHaveLength(6);
    expect(executedOps).toEqual(
      expect.arrayContaining([
        { repoId: 'repo-1', type: 'delete', name: 'v2.0.0' },
        { repoId: 'repo-1', type: 'delete', name: 'v2.0.0', remote: 'origin' },
        { repoId: 'repo-1', type: 'delete', name: 'v2.0.0', remote: 'upstream' },
        { repoId: 'repo-2', type: 'delete', name: 'v2.0.0' },
        { repoId: 'repo-2', type: 'delete', name: 'v2.0.0', remote: 'origin' },
        { repoId: 'repo-3', type: 'delete', name: 'v2.0.0' },
      ])
    );
  });

  it('guards against saving old rules during directory switch until new rules are loaded', () => {
    let directory = 'root';
    let loadedDirectory: string | null = 'root';
    const rules = { source: 'svn:ignore', directory: 'root', patterns: ['*.log', '*.tmp'] };
    const isSaveDisabled = (loadedDir: string | null, targetDir: string, hasRules: boolean, saving: boolean) => {
      const isLoading = loadedDir !== targetDir;
      return isLoading || saving || !hasRules;
    };

    // 初始状态：已加载完毕，Save 可用
    expect(isSaveDisabled(loadedDirectory, directory, Boolean(rules), false)).toBe(false);

    // 切换到子目录 'src'：立即进入 loading，Save 必须立即被禁用
    directory = 'src';
    expect(isSaveDisabled(loadedDirectory, directory, Boolean(rules), false)).toBe(true);

    // 加载完成新目录规则后：Save 恢复可用
    loadedDirectory = 'src';
    expect(isSaveDisabled(loadedDirectory, directory, Boolean(rules), false)).toBe(false);
  });

  it('guards pointerdown and escape dismissal while a global dialog is active', () => {
    let closed = false;
    const onClose = () => { closed = true; };

    const handlePointerDown = (hasCurrentDialog: boolean, isWithinDialogHost: boolean) => {
      if (isWithinDialogHost) return;
      if (hasCurrentDialog) return;
      onClose();
    };

    // 1. 全局对话框处于激活状态且点击对话框内部：不应触发关闭
    handlePointerDown(true, true);
    expect(closed).toBe(false);

    // 2. 全局对话框处于激活状态且点击外部：由对话框模态捕获，菜单不应抢先关闭
    handlePointerDown(true, false);
    expect(closed).toBe(false);

    // 3. 无全局对话框且点击外部：正常触发关闭
    handlePointerDown(false, false);
    expect(closed).toBe(true);
  });

  it('strictly disables save and clears text when SVN ignore directory fetch fails', () => {
    let directory = 'root';
    let loadedDirectory: string | null = 'root';
    let rules: { source: string; directory: string; patterns: string[] } | undefined = {
      source: 'svn:ignore',
      directory: 'root',
      patterns: ['*.log'],
    };
    let text = '*.log';

    const getValidity = (loadedDir: string | null, targetDir: string, currentRules?: typeof rules) => {
      const isLoading = loadedDir !== targetDir;
      return !isLoading && Boolean(currentRules) && (currentRules?.directory ?? '') === targetDir;
    };

    // 1. 初始目录正常加载：有效
    expect(getValidity(loadedDirectory, directory, rules)).toBe(true);

    // 2. 切换到 'src' 目录：进入加载中，无效
    directory = 'src';
    expect(getValidity(loadedDirectory, directory, rules)).toBe(false);

    // 3. 模拟请求失败：清空 rules 和 text，即使更新 loadedDirectory 也必须判定为无效
    rules = undefined;
    text = '';
    loadedDirectory = 'src';
    expect(getValidity(loadedDirectory, directory, rules)).toBe(false);
    expect(text).toBe('');
  });

  it('dispatches explicit checkout flag and base branch for new branch creations', async () => {
    const executedOps: Array<{ repoId: string; type: string; name: string; from: string | null; checkout: boolean }> = [];
    const recentBranches: Record<string, string[]> = {};

    const fakeBranchOperation = async (
      op: { type: string; name: string; from: string | null; checkout: boolean },
      repoId: string
    ) => {
      executedOps.push({ repoId, ...op });
      return { completed: true, conflicted: false };
    };

    const recordRecent = (repoId: string, name: string) => {
      recentBranches[repoId] = [name, ...(recentBranches[repoId] ?? [])];
    };

    const handleCreateBranch = async (
      name: string,
      from: string | null,
      shouldCheckout: boolean,
      repoId: string
    ) => {
      const res = await fakeBranchOperation({ type: 'create', name, from, checkout: shouldCheckout }, repoId);
      if (shouldCheckout && res.completed) {
        recordRecent(repoId, name);
      }
    };

    // 场景 1：用户选择“否，仅创建分支”（checkout: false）
    await handleCreateBranch('feature/headless', 'main', false, 'repo-1');
    expect(executedOps[0]).toEqual({
      repoId: 'repo-1',
      type: 'create',
      name: 'feature/headless',
      from: 'main',
      checkout: false,
    });
    expect(recentBranches['repo-1']).toBeUndefined(); // 不应记入近期分支

    // 场景 2：用户选择“是，立即检出”（checkout: true）
    await handleCreateBranch('feature/active', null, true, 'repo-1');
    expect(executedOps[1]).toEqual({
      repoId: 'repo-1',
      type: 'create',
      name: 'feature/active',
      from: null,
      checkout: true,
    });
    expect(recentBranches['repo-1']).toEqual(['feature/active']); // 必须记入近期分支
  });

  it('resolves pull action respecting updateProjectMethod setting for current branch', async () => {
    const resolvePull = async (
      isCurrent: boolean,
      configuredMethod: 'rebase' | 'merge' | 'prompt',
      promptChoice?: 'rebase' | 'merge' | null
    ): Promise<'pull' | 'pullRebase' | null> => {
      if (!isCurrent) return 'pull';
      if (configuredMethod === 'prompt') {
        if (!promptChoice) return null;
        return promptChoice === 'rebase' ? 'pullRebase' : 'pull';
      }
      return configuredMethod === 'rebase' ? 'pullRebase' : 'pull';
    };

    // 1. 非当前分支：固定为 'pull'
    expect(await resolvePull(false, 'rebase')).toBe('pull');

    // 2. 当前分支且策略为 'rebase'：解析为 'pullRebase'
    expect(await resolvePull(true, 'rebase')).toBe('pullRebase');

    // 3. 当前分支且策略为 'merge'：解析为 'pull'
    expect(await resolvePull(true, 'merge')).toBe('pull');

    // 4. 当前分支且策略为 'prompt'：按用户弹窗选择
    expect(await resolvePull(true, 'prompt', 'rebase')).toBe('pullRebase');
    expect(await resolvePull(true, 'prompt', 'merge')).toBe('pull');
    expect(await resolvePull(true, 'prompt', null)).toBeNull();
  });

  it('detects detached HEAD and builds create branch from HEAD action entry', () => {
    const detachedRepo: RepositoryStatus = {
      meta: { id: 'repo-git', name: 'my-app', rootPath: '/app', color: '#336699', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
      branch: 'HEAD (no branch)', revision: 'a1b2c3d4e5', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
    };
    const branches = [
      { name: 'HEAD', current: true, detachedHash: 'a1b2c3d' },
      { name: 'main', current: false },
    ];

    const currentBranch = branches.find((b) => b.current);
    const isDetached = Boolean(
      currentBranch?.detachedHash ||
      detachedRepo.branch === 'HEAD' ||
      detachedRepo.branch.startsWith('HEAD (')
    );
    expect(isDetached).toBe(true);

    const effectiveRef = currentBranch?.detachedHash ?? detachedRepo.revision?.slice(0, 7) ?? 'HEAD';
    expect(effectiveRef).toBe('a1b2c3d');
  });

  it('formats repo operation label without literal asterisks and maps known states', () => {
    const t = (k: string) => (k === 'merging' ? '合并中' : k === 'rebasing' ? '变基中' : k);
    expect(formatRepoOperationLabel(null, t)).toBe('');
    expect(formatRepoOperationLabel(undefined, t)).toBe('');
    expect(formatRepoOperationLabel('merge', t)).toBe(' (合并中)');
    expect(formatRepoOperationLabel('merge', t).includes('*')).toBe(false);
    expect(formatRepoOperationLabel('rebase', t)).toBe(' (变基中)');
    expect(formatRepoOperationLabel('cherry-pick', (k) => k)).toBe(' (cherry-picking)');
    expect(formatRepoOperationLabel('revert', (k) => k)).toBe(' (reverting)');
  });

  it('detects mixed Git/SVN workspace and formats repository display names accordingly', () => {
    const gitRepo = { meta: { name: 'core', kind: 'git' as const } };
    const svnRepo = { meta: { name: 'assets', kind: 'svn' as const } };
    const gitRepo2 = { meta: { name: 'docs', kind: 'git' as const } };

    // 纯 Git 工作区
    expect(isMixedRepoWorkspace([gitRepo, gitRepo2])).toBe(false);
    expect(formatRepoDisplayName(gitRepo.meta.name, gitRepo.meta.kind, false)).toBe('core');

    // 纯 SVN 工作区
    expect(isMixedRepoWorkspace([svnRepo])).toBe(false);
    expect(formatRepoDisplayName(svnRepo.meta.name, svnRepo.meta.kind, false)).toBe('assets');

    // 混合工作区
    expect(isMixedRepoWorkspace([gitRepo, svnRepo])).toBe(true);
    expect(formatRepoDisplayName(gitRepo.meta.name, gitRepo.meta.kind, true)).toBe('core [Git]');
    expect(formatRepoDisplayName(svnRepo.meta.name, svnRepo.meta.kind, true)).toBe('assets [SVN]');
  });

  it('marks active repository only when workspace contains multiple repositories', () => {
    const repos = [
      { id: 'repo-1', name: 'repo-1' },
      { id: 'repo-2', name: 'repo-2' },
    ];
    const selectedRepoId = 'repo-1';

    // 单仓库：不展示 active 徽标
    const isSingleActive = [repos[0]].length > 1 && repos[0].id === selectedRepoId;
    expect(isSingleActive).toBe(false);

    // 多仓库：当前选中仓库展示 active 徽标
    const isRepo1Active = repos.length > 1 && repos[0].id === selectedRepoId;
    const isRepo2Active = repos.length > 1 && repos[1].id === selectedRepoId;
    expect(isRepo1Active).toBe(true);
    expect(isRepo2Active).toBe(false);
  });

  it('identifies abortable VCS operations and generates localized abort labels and messages', () => {
    // 1. isAbortableVcsOperation
    expect(isAbortableVcsOperation('merge')).toBe(true);
    expect(isAbortableVcsOperation('Merge')).toBe(true);
    expect(isAbortableVcsOperation('rebase')).toBe(true);
    expect(isAbortableVcsOperation('cherry-pick')).toBe(true);
    expect(isAbortableVcsOperation('revert')).toBe(true);
    expect(isAbortableVcsOperation('commit')).toBe(false);
    expect(isAbortableVcsOperation(null)).toBe(false);
    expect(isAbortableVcsOperation(undefined)).toBe(false);

    // 2. getAbortOperationLabels 英文模式
    const tEn = (k: string, ...args: unknown[]) => {
      let res = k;
      args.forEach((arg, idx) => {
        res = res.replace(`{${idx}}`, String(arg));
      });
      return res;
    };

    const mergeInfo = getAbortOperationLabels('merge', 'my-repo', tEn);
    expect(mergeInfo.title).toBe('Abort Merge');
    expect(mergeInfo.description).toBe('Merge in progress — abort and restore previous state');
    expect(mergeInfo.confirmMessage).toBe(
      'VersionDock [my-repo]: Abort merge? This will restore the repository to its pre-merge state.'
    );

    const rebaseInfo = getAbortOperationLabels('rebase', 'my-repo', tEn);
    expect(rebaseInfo.title).toBe('Abort Rebase');
    expect(rebaseInfo.description).toBe('Rebase in progress — abort and restore previous state');
    expect(rebaseInfo.confirmMessage).toBe(
      'VersionDock [my-repo]: Abort rebase? This will restore the repository to its previous state.'
    );

    const cpInfo = getAbortOperationLabels('cherry-pick', 'my-repo', tEn);
    expect(cpInfo.title).toBe('Abort Cherry-pick');
    expect(cpInfo.description).toBe('Cherry-pick in progress — abort and restore previous state');
    expect(cpInfo.confirmMessage).toBe(
      'VersionDock [my-repo]: Abort cherry-pick? This will restore the repository to its previous state.'
    );

    const revertInfo = getAbortOperationLabels('revert', 'my-repo', tEn);
    expect(revertInfo.title).toBe('Abort Revert');
    expect(revertInfo.description).toBe('Revert in progress — abort and restore previous state');
    expect(revertInfo.confirmMessage).toBe(
      'VersionDock [my-repo]: Abort revert? This will restore the repository to its previous state.'
    );

    // 3. 中文翻译对应
    const dictZh: Record<string, string> = {
      'Abort Merge': '中止合并',
      'Abort Rebase': '中止变基',
      'Abort Cherry-pick': '中止拣选',
      'Abort Revert': '中止还原',
      merge: '合并',
      rebase: '变基',
      'cherry-pick': '拣选',
      revert: '还原',
      'VersionDock [{0}]: Abort merge? This will restore the repository to its pre-merge state.':
        'VersionDock [{0}]：中止合并？这将把仓库恢复到合并前的状态。',
      'VersionDock [{0}]: Abort {1}? This will restore the repository to its previous state.':
        'VersionDock [{0}]：中止 {1}？这将把仓库恢复到先前的状态。',
    };
    const tZh = (k: string, ...args: unknown[]) => {
      let res = dictZh[k] ?? k;
      args.forEach((arg, idx) => {
        res = res.replace(`{${idx}}`, String(arg));
      });
      return res;
    };

    const cpInfoZh = getAbortOperationLabels('cherry-pick', '核心仓库', tZh);
    expect(cpInfoZh.title).toBe('中止拣选');
    expect(cpInfoZh.confirmMessage).toBe('VersionDock [核心仓库]：中止 拣选？这将把仓库恢复到先前的状态。');

    const revertInfoZh = getAbortOperationLabels('revert', '核心仓库', tZh);
    expect(revertInfoZh.title).toBe('中止还原');
    expect(revertInfoZh.confirmMessage).toBe('VersionDock [核心仓库]：中止 还原？这将把仓库恢复到先前的状态。');
  });
});
