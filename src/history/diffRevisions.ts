import type { CommitNode } from '../bindings/generated';
import { commitComparisonBase } from './commitDetails';

export function resolveDiffRevisions(
  kind: 'git' | 'svn',
  target: { staged?: boolean; revision?: string; fromRevision?: string; toRevision?: string },
  commit?: Pick<CommitNode, 'hash' | 'parents'>,
) {
  const working = target.toRevision === 'WORKTREE' || target.toRevision === 'WORKING' || (!target.revision && !target.toRevision);
  const oldRevision = target.fromRevision ?? (commit ? commitComparisonBase(commit, kind)
    : target.revision ? kind === 'svn' ? commitComparisonBase({ hash: target.revision, parents: [] }, kind) : `${target.revision}~1`
      : kind === 'svn' ? 'BASE' : target.staged ? 'HEAD' : 'INDEX');
  const newRevision = working ? kind === 'svn' ? 'WORKING' : target.staged ? 'INDEX' : 'WORKTREE' : target.toRevision ?? target.revision;
  return { oldRevision, newRevision };
}
