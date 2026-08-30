import type { RepositoryStatus } from '../../bindings/generated';

export function resolveSubmoduleOperationTarget(repositories: RepositoryStatus[], submoduleRepoId: string | null) {
  const submodule = repositories.find((repository) => repository.meta.id === submoduleRepoId && repository.meta.isSubmodule);
  const parent = submodule?.meta.parentRepoId
    ? repositories.find((repository) => repository.meta.id === submodule.meta.parentRepoId)
    : undefined;
  if (!submodule || !parent) return undefined;
  const parentRoot = parent.meta.rootPath.replaceAll('\\', '/').replace(/\/+$/, '');
  const submoduleRoot = submodule.meta.rootPath.replaceAll('\\', '/').replace(/\/+$/, '');
  const prefix = `${parentRoot}/`;
  if (!submoduleRoot.startsWith(prefix)) return undefined;
  const path = submoduleRoot.slice(prefix.length);
  if (!path || path.split('/').some((part) => !part || part === '.' || part === '..')) return undefined;
  return { parent, submodule, path };
}
