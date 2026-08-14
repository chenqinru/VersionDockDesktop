import type { CommitDetail, CommitFile, CommitNode, RepositoryStatus } from '../bindings/generated';

export type DetailFileTarget = CommitFile & {
  repoId: string;
  commitHash: string;
  commitHashes?: string[];
  fromRevision?: string;
  toRevision?: string;
};

export type SelectedCommitDetail = {
  commit: CommitNode;
  detail: CommitDetail;
};

export function commitKey(repoId: string, hash: string): string {
  return `${repoId}\0${hash}`;
}

export function buildCommitFileTargets(
  commits: CommitNode[],
  details: Record<string, CommitDetail>,
  repositories: RepositoryStatus[],
): DetailFileTarget[] {
  const repoKinds = new Map(repositories.map((repo) => [repo.meta.id, repo.meta.kind]));
  const ranges = new Map<string, { fromRevision?: string; toRevision?: string }>();
  const commitsByRepo = new Map<string, CommitNode[]>();
  for (const commit of commits) commitsByRepo.set(commit.repoId, [...(commitsByRepo.get(commit.repoId) ?? []), commit]);

  for (const [repoId, repoCommits] of commitsByRepo) {
    if (repoCommits.length < 2) continue;
    const oldest = repoCommits[repoCommits.length - 1];
    const newest = repoCommits[0];
    if (repoKinds.get(repoId) === 'git' && oldest.parents[0]) {
      ranges.set(repoId, { fromRevision: oldest.parents[0], toRevision: newest.hash });
    } else if (repoKinds.get(repoId) === 'svn') {
      const revision = Number.parseInt(oldest.hash.replace(/^r/i, ''), 10);
      if (Number.isFinite(revision) && revision > 0) ranges.set(repoId, { fromRevision: String(revision - 1), toRevision: newest.hash });
    }
  }

  const targets = new Map<string, DetailFileTarget>();
  for (const commit of commits) {
    const detail = details[commitKey(commit.repoId, commit.hash)];
    if (!detail) continue;
    for (const file of detail.files) {
      const key = `${commit.repoId}\0${file.path}`;
      const range = ranges.get(commit.repoId);
      const previous = targets.get(key);
      const commitHashes = [...new Set([...(previous?.commitHashes ?? (previous ? [previous.commitHash] : [])), commit.hash])];
      targets.set(key, {
        ...(previous ?? file),
        ...file,
        repoId: commit.repoId,
        commitHash: commit.hash,
        commitHashes,
        added: previous?.added == null && file.added == null ? null : (previous?.added ?? 0) + (file.added ?? 0),
        removed: previous?.removed == null && file.removed == null ? null : (previous?.removed ?? 0) + (file.removed ?? 0),
        fromRevision: range?.fromRevision,
        toRevision: range?.toRevision,
      });
    }
  }
  return [...targets.values()];
}

export function fileTargetRevision(target: DetailFileTarget): string | undefined {
  return target.toRevision ? undefined : target.commitHash;
}
