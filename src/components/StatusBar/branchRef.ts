import type { RepositoryStatus, BranchInfo } from '../../bindings/generated';

export function getRepoEffectiveRef(
  r: RepositoryStatus,
  branchesByRepo: Record<string, BranchInfo[] | undefined>
): string {
  const bList = branchesByRepo[r.meta.id] ?? [];
  const currentBranch = bList.find((b) => b.current);
  if (currentBranch?.detachedTag) return currentBranch.detachedTag;
  if (currentBranch?.detachedHash) return currentBranch.detachedHash;
  if (r.branch && r.branch !== 'HEAD' && !r.branch.startsWith('HEAD (')) {
    return r.branch;
  }
  if (currentBranch?.name && currentBranch.name !== 'HEAD') {
    return currentBranch.name;
  }
  return r.revision ? r.revision.slice(0, 7) : (r.branch || 'HEAD');
}

export function getRepoCompareBase(
  r: RepositoryStatus,
  branchesByRepo: Record<string, BranchInfo[] | undefined>
): string {
  const bList = branchesByRepo[r.meta.id] ?? [];
  const currentBranch = bList.find((b) => b.current);
  if (currentBranch?.name && !currentBranch.name.startsWith('HEAD (')) {
    return currentBranch.name;
  }
  if (r.branch && !r.branch.startsWith('HEAD') && !r.branch.includes(' ')) {
    return r.branch;
  }
  return 'HEAD';
}

export function getRepoRefIcon(
  r: RepositoryStatus,
  branchesByRepo: Record<string, BranchInfo[] | undefined>
): 'tag' | 'git-commit' | 'git-branch' {
  const bList = branchesByRepo[r.meta.id] ?? [];
  const currentBranch = bList.find((b) => b.current);
  if (currentBranch?.detachedTag) return 'tag';
  if (currentBranch?.detachedHash) return 'git-commit';
  if (r.meta.kind === 'git' && (r.branch === 'HEAD' || r.branch.startsWith('HEAD ('))) return 'git-commit';
  return 'git-branch';
}

export function formatRepoOperationLabel(
  operation: string | null | undefined,
  t: (key: string) => string = (k) => k
): string {
  if (!operation) return '';
  const op = operation.toLowerCase();
  const label = op === 'merge'
    ? t('merging')
    : op === 'rebase'
    ? t('rebasing')
    : op === 'cherry-pick'
    ? t('cherry-picking')
    : op === 'revert'
    ? t('reverting')
    : op;
  return ` (${label})`;
}

export function isMixedRepoWorkspace(
  repos: Array<{ meta: { kind?: string } }>
): boolean {
  const hasGit = repos.some((r) => r.meta.kind !== 'svn');
  const hasSvn = repos.some((r) => r.meta.kind === 'svn');
  return hasGit && hasSvn;
}

export function getRepoKindLabel(kind?: string): string {
  return kind === 'svn' ? 'SVN' : 'Git';
}

export function formatRepoDisplayName(
  repoName: string,
  kind: string | undefined,
  isMixed: boolean
): string {
  if (!isMixed) return repoName;
  return `${repoName} [${getRepoKindLabel(kind)}]`;
}

export type AbortableVcsOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export function isAbortableVcsOperation(op?: string | null): op is AbortableVcsOperation {
  if (!op) return false;
  return ['merge', 'rebase', 'cherry-pick', 'revert'].includes(op.toLowerCase());
}

export function getAbortOperationLabels(
  op: string,
  repoName: string,
  t: (key: string, ...args: (string | number)[]) => string = (k) => k
): { title: string; description: string; confirmMessage: string } {
  const normalized = op.toLowerCase();
  const isMerge = normalized === 'merge';

  const title = isMerge
    ? t('Abort Merge')
    : normalized === 'rebase'
    ? t('Abort Rebase')
    : normalized === 'cherry-pick'
    ? t('Abort Cherry-pick')
    : normalized === 'revert'
    ? t('Abort Revert')
    : t('Abort Operation');

  const description = isMerge
    ? t('Merge in progress — abort and restore previous state')
    : normalized === 'rebase'
    ? t('Rebase in progress — abort and restore previous state')
    : normalized === 'cherry-pick'
    ? t('Cherry-pick in progress — abort and restore previous state')
    : normalized === 'revert'
    ? t('Revert in progress — abort and restore previous state')
    : '';

  const opName = normalized === 'merge'
    ? t('merge')
    : normalized === 'rebase'
    ? t('rebase')
    : normalized === 'cherry-pick'
    ? t('cherry-pick')
    : normalized === 'revert'
    ? t('revert')
    : normalized;

  const confirmMessage = isMerge
    ? t('VersionDock [{0}]: Abort merge? This will restore the repository to its pre-merge state.', repoName)
    : t('VersionDock [{0}]: Abort {1}? This will restore the repository to its previous state.', repoName, opName);

  return { title, description, confirmMessage };
}
