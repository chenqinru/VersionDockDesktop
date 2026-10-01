import type { RepositoryStatus } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { getRepoEffectiveRef, getRepoRefIcon } from './StatusBar/branchRef';
import { BranchRefBadge } from './BranchRefBadge';
import { branchColor, tagColor } from './branchColor';

export function RepositoryBranchBadge({ repo, className }: { repo: RepositoryStatus; className?: string }) {
  const branches = useAppStore((state) => state.branchesByRepo);
  const label = getRepoEffectiveRef(repo, branches);
  const icon = getRepoRefIcon(repo, branches);
  const detached = repo.branch === 'HEAD' || repo.branch.startsWith('HEAD (');
  const kind = repo.meta.isWorktree ? 'worktree' : icon === 'tag' ? 'tag' : icon === 'git-commit' || detached ? 'head' : 'branch';
  const color = kind === 'tag' ? tagColor() : kind === 'head' ? tagColor() : branchColor(label);
  return <BranchRefBadge label={label} kind={kind} color={color} className={className} />;
}
