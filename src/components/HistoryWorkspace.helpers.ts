import type { BranchInfo, CommitFile, RepositoryStatus } from '../bindings/generated';
import { branchRevisionRef, tagRevisionRef } from '../history/refs';

type BranchInstance = { repoId: string; repo: RepositoryStatus; branch: BranchInfo };
export type MergedBranch = { name: string; instances: BranchInstance[]; current: boolean; remote: boolean };

const MAINLINE_BRANCH = /^(main|master|prod|develop|dev|release)(?:[/-].*)?$/i;

// Keep the sidebar ordering aligned with VersionDock's BranchSidebar. These
// are exact branch names; names such as `release/candidate` remain regular
// branches in the reference implementation.
const SIDEBAR_PRIMARY_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'dev', 'release']);

function isSidebarPrimaryBranch(name: string): boolean {
  return SIDEBAR_PRIMARY_BRANCHES.has(name.toLowerCase());
}

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
  instances: Array<{ repo: RepositoryStatus; tag: { name: string; hash: string; date: string } }>;
  repoIds: string[];
  vcsKind: 'git' | 'svn';
};

export type SidebarModel = {
  local: SidebarBranch[];
  remotes: Array<{ name: string; branches: SidebarBranch[] }>;
  tags: SidebarTag[];
};

export type HistoryRefOption = {
  id: string;
  label: string;
  icon: string;
  repoIds: string[];
  revisionsByRepo: Record<string, string>;
};

export function buildHistoryRefOptions(
  repos: readonly RepositoryStatus[],
  branchesByRepo: Readonly<Record<string, readonly BranchInfo[]>>,
  tagsByRepo: Readonly<Record<string, ReadonlyArray<{ name: string }>>>,
): HistoryRefOption[] {
  const values = new Map<string, HistoryRefOption>();
  const add = (id: string, icon: string, repoId: string, revision: string) => {
    const current = values.get(id);
    values.set(id, {
      id,
      label: id,
      icon,
      repoIds: current ? [...new Set([...current.repoIds, repoId])] : [repoId],
      revisionsByRepo: { ...current?.revisionsByRepo, [repoId]: revision },
    });
  };
  for (const repo of repos) {
    for (const branch of branchesByRepo[repo.meta.id] ?? []) {
      add(branch.name, branch.remote ? 'cloud' : 'git-branch', repo.meta.id, branchRevisionRef({ name: branch.name, isRemote: branch.remote }, repo.meta.kind));
    }
    for (const tag of tagsByRepo[repo.meta.id] ?? []) {
      add(tag.name, 'tag', repo.meta.id, tagRevisionRef(tag.name, repo.meta.kind));
    }
  }
  return [...values.values()].sort((left, right) => left.label.localeCompare(right.label));
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
  const needle = filter.trim().toLowerCase();
  for (const repo of repos) {
    for (const branch of branchesByRepo[repo.meta.id] ?? []) {
      if (branch.remote !== remote) continue;
      const name = branchBaseName(branch);
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
    const leftMainline = isSidebarPrimaryBranch(left.name);
    const rightMainline = isSidebarPrimaryBranch(right.name);
    if (leftMainline !== rightMainline) return leftMainline ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function mergeSidebarTags(
  repos: RepositoryStatus[],
  tagsByRepo: Record<string, Array<{ name: string; hash: string; date: string }>>,
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
  tagsByRepo: Record<string, Array<{ name: string; hash: string; date: string }>>,
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

export function mergeBranches(repos: RepositoryStatus[], branchesByRepo: Record<string, BranchInfo[]>, remote: boolean): MergedBranch[] {
  const values = new Map<string, MergedBranch>();
  const seenInstances = new Set<string>();
  for (const repo of repos) for (const branch of branchesByRepo[repo.meta.id] ?? []) {
    if (branch.remote !== remote) continue;
    // Keep the remote namespace: within one repository, `origin/main` and
    // `upstream/main` are different refs and must never be merged together.
    const name = branch.name;
    const key = `${remote ? 'remote' : 'local'}:${name}`;
    const instanceKey = `${repo.meta.id}\0${branch.name}`;
    if (seenInstances.has(instanceKey)) continue;
    seenInstances.add(instanceKey);
    const value = values.get(key) ?? { name, instances: [], current: false, remote };
    value.instances.push({ repoId: repo.meta.id, repo, branch });
    value.current ||= branch.current;
    values.set(key, value);
  }
  return [...values.values()].sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
}

export function splitVisibleBranches(entries: MergedBranch[], searching: boolean) {
  if (searching) return { primary: entries, other: [] as MergedBranch[] };
  return entries.reduce<{ primary: MergedBranch[]; other: MergedBranch[] }>((groups, entry) => {
    const sharedAcrossRepositories = new Set(entry.instances.map((instance) => instance.repoId)).size > 1;
    (entry.current || MAINLINE_BRANCH.test(entry.name) || sharedAcrossRepositories ? groups.primary : groups.other).push(entry);
    return groups;
  }, { primary: [], other: [] });
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
