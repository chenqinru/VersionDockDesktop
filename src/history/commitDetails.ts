import type { CommitDetail, CommitFile, CommitNode, RepositoryStatus } from '../bindings/generated';

export type DetailFileTarget = CommitFile & {
  repoId: string;
  commitHash: string;
  commitHashes?: string[];
  fromRevision?: string;
  toRevision?: string;
  comparisonBaseHash?: string;
  isMergeParentDiff?: boolean;
};

export type SelectedCommitDetail = {
  commit: CommitNode;
  detail: CommitDetail;
};

export function commitKey(repoId: string, hash: string): string {
  return `${repoId}\0${hash}`;
}

export function normalizeHistoryPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

export function isSameHistoryFilePath(historyPath: string, commitPath: string): boolean {
  const normalizedHistoryPath = normalizeHistoryPath(historyPath);
  const normalizedCommitPath = normalizeHistoryPath(commitPath);
  if (!normalizedHistoryPath || !normalizedCommitPath) return false;
  return normalizedHistoryPath === normalizedCommitPath
    || normalizedHistoryPath.endsWith(`/${normalizedCommitPath}`)
    || normalizedCommitPath.endsWith(`/${normalizedHistoryPath}`);
}

export function filterFilesForHistoryPath<T extends { path: string }>(files: T[], historyPath: string): T[] {
  const normalizedHistoryPath = normalizeHistoryPath(historyPath);
  if (!normalizedHistoryPath) return files;
  const exactMatches = files.filter((file) => normalizeHistoryPath(file.path) === normalizedHistoryPath);
  if (exactMatches.length > 0) return exactMatches;

  const mappedMatches = files.filter((file) => isSameHistoryFilePath(normalizedHistoryPath, file.path));
  if (mappedMatches.length <= 1) return mappedMatches;

  const maxPathLength = Math.max(...mappedMatches.map((file) => normalizeHistoryPath(file.path).length));
  return mappedMatches.filter((file) => normalizeHistoryPath(file.path).length === maxPathLength);
}

export function buildCommitFileTargets(
  commits: CommitNode[],
  details: Record<string, CommitDetail>,
  repositories: RepositoryStatus[],
  historyPath?: string | null,
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
  // commits 是从新到旧的。先处理旧提交，后处理新提交，较新提交的 status 和 commitHash 会保留在目标中
  const orderedCommits = [...commits].reverse();
  for (const commit of orderedCommits) {
    const detail = details[commitKey(commit.repoId, commit.hash)];
    if (!detail) continue;
    const rawFiles = historyPath ? filterFilesForHistoryPath(detail.files, historyPath) : detail.files;
    for (const file of rawFiles) {
      const key = `${commit.repoId}\0${file.path}`;
      const range = ranges.get(commit.repoId);
      const previous = targets.get(key);
      const commitHashes = [...new Set([commit.hash, ...(previous?.commitHashes ?? (previous ? [previous.commitHash] : []))])];
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
