import type { CommitNode } from '../bindings/generated';
import { commitKey } from './commitDetails';

export type HistoryAuthorCommit = Pick<CommitNode, 'repoId' | 'hash' | 'author' | 'email'>;

export function buildHistoryAuthorOptions(commits: readonly HistoryAuthorCommit[]) {
  const identities = new Map<string, { name: string; email: string; repoId: string; keys: Set<string> }>();
  for (const commit of commits) {
    const name = commit.author || commit.email;
    const value = commit.email || name;
    if (!value) continue;
    const entry = identities.get(value) ?? { name, email: commit.email, repoId: commit.repoId, keys: new Set<string>() };
    entry.keys.add(commitKey(commit.repoId, commit.hash));
    identities.set(value, entry);
  }
  return [...identities.entries()]
    .sort(([, left], [, right]) => left.name.localeCompare(right.name))
    .map(([id, entry]) => ({ id, label: entry.name, sublabel: entry.email, count: entry.keys.size, avatarName: entry.name, avatarEmail: entry.email, avatarRepoId: entry.repoId }));
}
