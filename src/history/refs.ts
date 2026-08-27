import type { CommitNode } from '../bindings/generated';
import { currentPalette, isPrimaryBranch } from '../components/branchColor';

export interface RefGroup {
  key: string;
  label: string;
  remoteName: string; // name of the remote (e.g. "upstream", "origin"); empty for local
  isHead: boolean; // this is the current HEAD branch
  isLocal: boolean; // has a local branch
  isRemote: boolean; // has a remote counterpart
  isTag: boolean;
  isDetached: boolean; // HEAD is detached (on this tag or commit)
  isRemoteHead: boolean; // this is <remote>/HEAD (symbolic remote pointer)
  isSvnRevision?: boolean; // SVN HEAD/BASE revision marker, not a Git ref
}

export function formatRefLabel(group: RefGroup, remoteFallback: string): string {
  if (group.isLocal && group.isRemote) return `${group.remoteName || remoteFallback} & ${group.label}`;
  if (group.remoteName) return `${group.remoteName}/${group.label}`;
  return group.label;
}

export function splitRemoteRefName(
  refName: string,
  remoteNames: readonly string[] = [],
): { remoteName: string; name: string } | null {
  const shortName = refName.startsWith('refs/remotes/')
    ? refName.slice('refs/remotes/'.length)
    : refName;
  const configuredRemoteNames = Array.from(new Set(remoteNames.filter(Boolean))).sort((a, b) => b.length - a.length);
  const configuredRemote = configuredRemoteNames.find((remote) => shortName.startsWith(`${remote}/`));
  const slash = shortName.indexOf('/');
  if (!configuredRemote && slash < 0) return null;
  const remoteName = configuredRemote ?? shortName.slice(0, slash);
  return { remoteName, name: shortName.slice(remoteName.length + 1) };
}

export function branchRevisionRef(branch: { name: string; fullName?: string; isRemote?: boolean }, vcsKind: 'git' | 'svn'): string {
  if (vcsKind === 'git') {
    if (branch.fullName?.startsWith('refs/')) return branch.fullName;
    return branch.isRemote ? `refs/remotes/${branch.name}` : `refs/heads/${branch.name}`;
  }
  if (branch.name === 'SVN') return 'HEAD';
  if (branch.name === 'trunk' || branch.name.startsWith('branches/') || branch.name.startsWith('tags/')) {
    return branch.name;
  }
  return `branches/${branch.name}`;
}

export function tagRevisionRef(tagName: string, vcsKind: 'git' | 'svn'): string {
  return vcsKind === 'git' ? `refs/tags/${tagName}` : `tags/${tagName}`;
}

function normalizeRef(raw: string, configuredRemoteNames: readonly string[]): { kind: 'head-pointer'; branch: string }
  | { kind: 'detached-head' }
  | { kind: 'local'; name: string }
  | { kind: 'remote'; remoteName: string; name: string }
  | { kind: 'tag'; name: string }
  | null {
  if (raw.startsWith('HEAD -> ')) {
    const target = raw.slice('HEAD -> '.length);
    const branch = target.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : target;
    return { kind: 'head-pointer', branch };
  }
  if (raw === 'HEAD') return { kind: 'detached-head' };
  if (raw.startsWith('refs/heads/')) return { kind: 'local', name: raw.slice('refs/heads/'.length) };
  if (raw.startsWith('refs/remotes/')) {
    const remote = splitRemoteRefName(raw, configuredRemoteNames);
    return remote ? { kind: 'remote', ...remote } : null;
  }
  if (raw.startsWith('refs/tags/')) return { kind: 'tag', name: raw.slice('refs/tags/'.length) };
  if (raw.startsWith('tag: ')) {
    const n = raw.slice('tag: '.length);
    return { kind: 'tag', name: n.startsWith('refs/tags/') ? n.slice('refs/tags/'.length) : n };
  }
  if (raw.includes('/')) {
    const remote = splitRemoteRefName(raw, configuredRemoteNames);
    return remote ? { kind: 'remote', ...remote } : null;
  }
  return { kind: 'local', name: raw };
}

export function groupRefs(
  refs: string[],
  vcsKind: 'git' | 'svn' = 'git',
  remoteNames: readonly string[] = [],
): RefGroup[] {
  if (vcsKind === 'svn') {
    return Array.from(new Set(refs))
      .filter((ref) => ref === 'HEAD' || ref === 'BASE')
      .map((ref) => ({
        key: `svn:${ref}`,
        label: ref,
        remoteName: '',
        isHead: ref === 'HEAD',
        isLocal: false,
        isRemote: false,
        isTag: false,
        isDetached: false,
        isRemoteHead: false,
        isSvnRevision: true,
      }));
  }

  const configuredRemoteNames = Array.from(new Set(remoteNames.filter(Boolean))).sort((a, b) => b.length - a.length);
  const remotes = new Map<string, { remoteName: string; name: string }>();
  const locals = new Set<string>();
  const tags: string[] = [];
  let headBranch: string | null = null;
  let isDetached = false;
  const remoteHeadRemoteNames = new Set<string>();

  for (const ref of refs) {
    const parsed = normalizeRef(ref, configuredRemoteNames);
    if (!parsed) continue;
    switch (parsed.kind) {
      case 'head-pointer':
        headBranch = parsed.branch;
        locals.add(parsed.branch);
        break;
      case 'detached-head':
        isDetached = true;
        break;
      case 'local':
        locals.add(parsed.name);
        break;
      case 'remote':
        if (parsed.name.toUpperCase() === 'HEAD') {
          remoteHeadRemoteNames.add(parsed.remoteName);
        } else {
          remotes.set(`${parsed.remoteName}\0${parsed.name}`, {
            remoteName: parsed.remoteName,
            name: parsed.name,
          });
        }
        break;
      case 'tag':
        tags.push(parsed.name);
        break;
    }
  }

  if (headBranch !== null) isDetached = false;

  const groups: RefGroup[] = [];

  if (isDetached) {
    groups.push({
      key: 'HEAD',
      label: 'HEAD',
      remoteName: '',
      isHead: true,
      isLocal: false,
      isRemote: false,
      isTag: false,
      isDetached: true,
      isRemoteHead: false,
    });
  }

  for (const remoteHeadRemoteName of remoteHeadRemoteNames) {
    groups.push({
      key: `${remoteHeadRemoteName}/HEAD`,
      label: 'HEAD',
      remoteName: remoteHeadRemoteName,
      isHead: false,
      isLocal: false,
      isRemote: true,
      isTag: false,
      isDetached: false,
      isRemoteHead: true,
    });
  }

  for (const local of locals) {
    groups.push({
      key: local,
      label: local,
      remoteName: '',
      isHead: local === headBranch,
      isLocal: true,
      isRemote: false,
      isTag: false,
      isDetached: false,
      isRemoteHead: false,
    });
  }

  for (const { name, remoteName } of remotes.values()) {
    groups.push({
      key: `remote:${remoteName}:${name}`,
      label: name,
      remoteName,
      isHead: false,
      isLocal: false,
      isRemote: true,
      isTag: false,
      isDetached: false,
      isRemoteHead: false,
    });
  }

  for (const tag of tags) {
    groups.push({
      key: `tag:${tag}`,
      label: tag,
      remoteName: '',
      isHead: false,
      isLocal: false,
      isRemote: false,
      isTag: true,
      isDetached,
      isRemoteHead: false,
    });
  }

  groups.sort((a, b) => {
    if (a.isRemoteHead !== b.isRemoteHead) return a.isRemoteHead ? -1 : 1;
    if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
    if (a.isTag !== b.isTag) return a.isTag ? 1 : -1;
    if (a.label !== b.label) return a.label.localeCompare(b.label);
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    return 0;
  });

  return groups;
}

export function mergeLocalRemote(groups: RefGroup[]): RefGroup[] {
  const merged: RefGroup[] = [];
  const branchesByLabel = new Map<string, RefGroup[]>();
  for (const g of groups) {
    if (g.isTag || g.isRemoteHead || g.isDetached || g.isSvnRevision) {
      merged.push(g);
      continue;
    }
    const bucket = branchesByLabel.get(g.label) ?? [];
    bucket.push(g);
    branchesByLabel.set(g.label, bucket);
  }
  for (const bucket of branchesByLabel.values()) {
    const locals = bucket.filter((group) => group.isLocal);
    const remotes = bucket.filter((group) => group.isRemote);
    if (locals.length === 1 && remotes.length === 1) {
      merged.push({
        ...locals[0],
        isRemote: true,
        remoteName: remotes[0].remoteName,
      });
    } else {
      merged.push(...bucket);
    }
  }
  merged.sort((a, b) => {
    const rank = (g: RefGroup): number => {
      if (g.isSvnRevision) return g.label === 'HEAD' ? 0 : 1;
      if (g.isDetached) return 0;
      if (g.isRemoteHead) return 5;
      if (g.isTag) return 4;
      if (g.isRemote) return 3;
      return 2;
    };
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.label.localeCompare(b.label);
  });
  return merged;
}

export function anonymousLaneColor(laneIndex: number): string {
  const p = currentPalette();
  return p[laneIndex % p.length];
}

export type CommitRefKind = 'branch' | 'remote' | 'tag' | 'head' | 'svn';

export interface CommitRef {
  value: string;
  label: string;
  kind: CommitRefKind;
  isHead: boolean;
  isRemote: boolean;
}

function stripPrefix(value: string): string {
  return value
    .replace(/^HEAD -> /, '')
    .replace(/^tag: /, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/tags\//, '');
}

export function refLabel(value: string): string {
  return stripPrefix(value);
}

export function classifyRef(value: string): CommitRef {
  const label = stripPrefix(value);
  const isHead = value.includes('HEAD');
  const isRemote = value.includes('origin/') || value.includes('remotes/') || value.startsWith('refs/remotes/') || /^(upstream|gitee)\//.test(value);
  const isTag = value.startsWith('tag: ') || value.startsWith('refs/tags/');
  const isSvn = /^r\d+$/i.test(label) || value === 'BASE';
  return {
    value,
    label,
    isHead,
    isRemote,
    kind: isSvn ? 'svn' : isHead ? 'head' : isTag ? 'tag' : isRemote ? 'remote' : 'branch',
  };
}

export function commitRefs(commit: Pick<CommitNode, 'refs'>): CommitRef[] {
  return commit.refs.map(classifyRef);
}

export function primaryBranchRef(commit: Pick<CommitNode, 'refs'>): string | undefined {
  const refs = commitRefs(commit);
  return refs.find((ref) => ref.kind === 'head' && !ref.isRemote)?.label
    ?? refs.find((ref) => ref.kind === 'branch')?.label
    ?? refs.find((ref) => ref.kind === 'remote')?.label
    ?? refs.find((ref) => ref.kind === 'tag')?.label;
}

export { isPrimaryBranch };

export function refIcon(kind: CommitRefKind): string {
  if (kind === 'tag') return 'tag';
  if (kind === 'remote') return 'cloud';
  if (kind === 'head') return 'arrow-right';
  if (kind === 'svn') return 'versions';
  return 'git-branch';
}
