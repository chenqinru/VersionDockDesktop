import type { RepositoryStatus } from '../bindings/generated';

export function hasMixedRepositoryKinds(repositories: readonly RepositoryStatus[]): boolean {
  return repositories.some((repo) => repo.meta.kind === 'git') && repositories.some((repo) => repo.meta.kind === 'svn');
}

export function repositoryLabel(repo: RepositoryStatus, mixed: boolean): string {
  return mixed ? `${repo.meta.name} [${repo.meta.kind === 'svn' ? 'SVN' : 'Git'}]` : repo.meta.name;
}
