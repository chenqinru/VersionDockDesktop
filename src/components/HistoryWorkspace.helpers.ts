import type { BranchInfo, CommitFile, RepositoryStatus } from '../bindings/generated';
import { isPrimaryBranch } from './branchColor';
import { branchRevisionRef, tagRevisionRef } from '../history/refs';

export type BranchInstance = { repoId: string; repo: RepositoryStatus; branch: BranchInfo };
export type SidebarBranch = {
  key: string;
  name: string;
  ref: string;
  remote: boolean;
  remoteName?: string;
  current: boolean;
  instances: BranchInstance[];
  repoIds: string[];
  vcsKind: 'git' | 'svn';
};

export type SidebarTag = {
  key: string;
  name: string;
  ref: string;
  instances: Array<{ repo: RepositoryStatus; tag: { name: string; hash: string; date: string; tagType?: string | null } }>;
  repoIds: string[];
  vcsKind: 'git' | 'svn';
};

export type SidebarModel = {
  local: SidebarBranch[];
  remotes: Array<{ name: string; branches: SidebarBranch[] }>;
  tags: SidebarTag[];
};

export function sumBranchAheadBehind(branch: SidebarBranch): { ahead: number; behind: number } {
  return branch.instances.reduce((total, instance) => ({
    ahead: total.ahead + instance.branch.ahead,
    behind: total.behind + instance.branch.behind,
  }), { ahead: 0, behind: 0 });
}

export type HistoryRefOption = {
  id: string;
  label: string;
  icon: string;
  repoIds: string[];
  revisionsByRepo: Record<string, string>;
  group?: string;
};

export function buildHistoryRefOptions(
  repos: readonly RepositoryStatus[],
  branchesByRepo: Readonly<Record<string, readonly BranchInfo[]>>,
  tagsByRepo: Readonly<Record<string, ReadonlyArray<{ name: string }>>>,
  includeRemotes = false,
): HistoryRefOption[] {
  const branchValues = new Map<string, HistoryRefOption>();
  const tagValues = new Map<string, HistoryRefOption>();

  for (const repo of repos) {
    for (const branch of branchesByRepo[repo.meta.id] ?? []) {
      if (branch.remote && !includeRemotes) continue;
      if (branch.remote && branchBaseName(branch) === 'HEAD') continue;
      if (branch.name === 'HEAD') continue;
      const revision = branchRevisionRef({ name: branch.name, isRemote: branch.remote }, repo.meta.kind);
      const current = branchValues.get(revision);
      branchValues.set(revision, {
        id: revision,
        label: branch.name,
        icon: 'git-branch',
        group: branch.remote ? 'Remote' : 'Branches',
        repoIds: current ? [...new Set([...current.repoIds, repo.meta.id])] : [repo.meta.id],
        revisionsByRepo: { ...current?.revisionsByRepo, [repo.meta.id]: revision },
      });
    }
    for (const tag of tagsByRepo[repo.meta.id] ?? []) {
      const revision = tagRevisionRef(tag.name, repo.meta.kind);
      const current = tagValues.get(revision);
      tagValues.set(revision, {
        id: revision,
        label: tag.name,
        icon: 'tag',
        group: 'Tags',
        repoIds: current ? [...new Set([...current.repoIds, repo.meta.id])] : [repo.meta.id],
        revisionsByRepo: { ...current?.revisionsByRepo, [repo.meta.id]: revision },
      });
    }
  }

  const sortedBranches = [...branchValues.values()].sort((left, right) => left.label.localeCompare(right.label));
  const sortedTags = [...tagValues.values()].sort((left, right) => left.label.localeCompare(right.label));
  return [...sortedBranches, ...sortedTags];
}

function remoteNameFor(branch: BranchInfo): string {
  if (branch.remoteName) return branch.remoteName;
  return branch.name.split('/')[0] || 'remote';
}

function branchBaseName(branch: BranchInfo): string {
  if (!branch.remote) return branch.name;
  const remote = remoteNameFor(branch);
  return branch.name.startsWith(`${remote}/`) ? branch.name.slice(remote.length + 1) : branch.name;
}

function mergeSidebarBranches(
  repos: RepositoryStatus[],
  branchesByRepo: Record<string, BranchInfo[]>,
  remote: boolean,
  filter: string,
): SidebarBranch[] {
  const values = new Map<string, SidebarBranch>();
  const seenInstances = new Set<string>();
  const needle = filter.trim().toLowerCase();
  for (const repo of repos) {
    for (const branch of branchesByRepo[repo.meta.id] ?? []) {
      if (branch.remote !== remote) continue;
      if (!remote && branch.name === 'HEAD') continue;
      const instanceKey = `${repo.meta.id}\0${branch.name}`;
      if (seenInstances.has(instanceKey)) continue;
      seenInstances.add(instanceKey);
      const name = branchBaseName(branch);
      if (remote && name === 'HEAD') continue;
      const remoteName = remote ? remoteNameFor(branch) : undefined;
      const ref = branchRevisionRef({ name: branch.name, isRemote: branch.remote }, repo.meta.kind);
      const searchable = `${branch.name} ${name} ${remoteName ?? ''}`.toLowerCase();
      if (needle && !searchable.includes(needle)) continue;
      const key = remote ? `remote:${repo.meta.kind}:${remoteName}:${name}` : `local:${repo.meta.kind}:${name}`;
      const existing = values.get(key);
      if (existing) {
        if (!existing.repoIds.includes(repo.meta.id)) existing.repoIds.push(repo.meta.id);
        existing.instances.push({ repoId: repo.meta.id, repo, branch });
        existing.current ||= branch.current;
      } else {
        values.set(key, {
          key,
          name,
          ref,
          remote,
          remoteName,
          current: branch.current,
          instances: [{ repoId: repo.meta.id, repo, branch }],
          repoIds: [repo.meta.id],
          vcsKind: repo.meta.kind,
        });
      }
    }
  }
  return [...values.values()].sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    const leftMainline = isPrimaryBranch(left.name);
    const rightMainline = isPrimaryBranch(right.name);
    if (leftMainline !== rightMainline) return leftMainline ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function mergeSidebarTags(
  repos: RepositoryStatus[],
  tagsByRepo: Record<string, Array<{ name: string; hash: string; date: string; tagType?: string | null }>>,
  filter: string,
): SidebarTag[] {
  const values = new Map<string, SidebarTag>();
  const needle = filter.trim().toLowerCase();
  for (const repo of repos) {
    for (const tag of tagsByRepo[repo.meta.id] ?? []) {
      if (needle && !tag.name.toLowerCase().includes(needle)) continue;
      const key = `${repo.meta.kind}:${tag.name}`;
      const existing = values.get(key);
      if (existing) {
        if (!existing.repoIds.includes(repo.meta.id)) existing.repoIds.push(repo.meta.id);
        existing.instances.push({ repo, tag });
      } else {
        values.set(key, {
          key,
          name: tag.name,
          ref: tagRevisionRef(tag.name, repo.meta.kind),
          instances: [{ repo, tag }],
          repoIds: [repo.meta.id],
          vcsKind: repo.meta.kind,
        });
      }
    }
  }
  return [...values.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function buildSidebarModel(
  repos: RepositoryStatus[],
  branchesByRepo: Record<string, BranchInfo[]>,
  tagsByRepo: Record<string, Array<{ name: string; hash: string; date: string; tagType?: string | null }>>,
  filter = '',
): SidebarModel {
  const local = mergeSidebarBranches(repos, branchesByRepo, false, filter);
  const remoteValues = mergeSidebarBranches(repos, branchesByRepo, true, filter);
  const remotes = new Map<string, SidebarBranch[]>();
  for (const branch of remoteValues) {
    const name = branch.remoteName ?? 'remote';
    remotes.set(name, [...(remotes.get(name) ?? []), branch]);
  }
  return {
    local,
    remotes: [...remotes.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, branches]) => ({ name, branches })),
    tags: mergeSidebarTags(repos, tagsByRepo, filter),
  };
}

export type DetailTree = { name: string; path: string; children: DetailTree[]; file?: CommitFile; fileCount: number };
export function buildDetailTree(files: CommitFile[]): DetailTree[] {
  const root: DetailTree[] = [];
  for (const file of files) {
    let nodes = root;
    file.path.split('/').forEach((name, index, parts) => {
      const path = parts.slice(0, index + 1).join('/');
      let node = nodes.find((item) => item.name === name);
      if (!node) { node = { name, path, children: [], fileCount: 0 }; nodes.push(node); }
      if (index === parts.length - 1) node.file = file;
      nodes = node.children;
    });
  }
  const count = (node: DetailTree): number => node.file ? 1 : node.children.reduce((total, child) => total + count(child), 0);
  const visit = (nodes: DetailTree[]) => nodes.forEach((node) => { node.fileCount = count(node); visit(node.children); });
  visit(root);
  return root;
}

export function collapseDetailTree(node: DetailTree): DetailTree {
  if (node.file) return node;
  let current = { ...node, children: node.children.map(collapseDetailTree) };
  while (!current.file && current.children.length === 1 && !current.children[0].file) {
    const child = current.children[0];
    current = { ...child, name: `${current.name}/${child.name}`, path: child.path };
  }
  return current;
}
