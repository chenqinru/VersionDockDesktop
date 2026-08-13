import type { BranchInfo, CommitFile, RepositoryStatus } from '../bindings/generated';

type BranchInstance = { repoId: string; repo: RepositoryStatus; branch: BranchInfo };
export type MergedBranch = { name: string; instances: BranchInstance[]; current: boolean; remote: boolean };

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

const MAINLINE_BRANCH = /^(main|master|prod|develop|dev|release)(?:[/-].*)?$/i;
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
