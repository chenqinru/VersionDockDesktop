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

describe('BranchMenuPopover reference helpers', () => {
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
