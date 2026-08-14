import type { CommitNode } from '../bindings/generated';

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

export function isPrimaryBranch(name: string): boolean {
  return /^(main|master|prod|develop|development|dev|trunk|release)(?:[/-].*)?$/i.test(name);
}

export function refIcon(kind: CommitRefKind): string {
  if (kind === 'tag') return 'tag';
  if (kind === 'remote') return 'cloud';
  if (kind === 'head') return 'arrow-right';
  if (kind === 'svn') return 'versions';
  return 'git-branch';
}
