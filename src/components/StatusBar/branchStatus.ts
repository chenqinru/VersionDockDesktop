import type { BranchInfo, OperationDomain, RepositoryStatus, TagInfo } from '../../bindings/generated';
import { formatRepoOperationLabel, getRepoEffectiveRef, getRepoRefIcon } from './branchRef';

// Reads and editor activity must not block the VCS menu or show an operation spinner.
export const BRANCH_STATUS_DOMAINS: OperationDomain[] = [
  'branch', 'tag', 'commit', 'sync', 'conflict', 'stash', 'shelf', 'changelist',
  'worktree', 'subtree', 'submodule', 'remote', 'history', 'svnAccount', 'system',
];

export function truncateBranchName(name: string, maxLength = 28): string {
  if (name.length <= maxLength) return name;
  const keep = Math.floor((maxLength - 3) / 2);
  return `${name.slice(0, keep)}...${name.slice(-keep)}`;
}

export function deriveBranchStatus(
  repositories: RepositoryStatus[],
  branches: Record<string, BranchInfo[] | undefined>,
  selectedRepoId: string | undefined,
  t: (key: string) => string,
) {
  const primary = repositories.filter((r) => !r.meta.isWorktree);
  const targets = primary.length ? primary : repositories;
  const worktrees = primary.length ? repositories.filter((r) => r.meta.isWorktree) : [];
  const topLevel = targets.filter((r) => r.meta.kind === 'git' && !r.meta.isSubmodule);
  const names = [...new Set(targets.map((r) => getRepoEffectiveRef(r, branches)))];
  const selected = targets.find((r) => r.meta.id === selectedRepoId);
  const selectedName = selected && getRepoEffectiveRef(selected, branches);
  if (selectedName) names.sort((a, b) => a === selectedName ? -1 : b === selectedName ? 1 : 0);
  const operations = [...new Set(targets.map((r) => r.operation).filter((op): op is string => Boolean(op)))];
  const opLabel = operations.map((op) => formatRepoOperationLabel(op, t).trim().slice(1, -1)).join('/');
  const wtNames = [...new Set(worktrees.map((r) => getRepoEffectiveRef(r, branches)))];
  const wtSuffix = wtNames.length === 1 ? `  |  ${truncateBranchName(wtNames[0])}`
    : wtNames.length > 1 ? `  |  +${wtNames.length} ${t('worktrees')}` : '';
  const icons = targets.map((r) => getRepoRefIcon(r, branches));
  const totalConflicts = targets.reduce((sum, r) => sum + r.conflicts, 0);
  return {
    targets, worktrees,
    headLabel: targets.length ? `${truncateBranchName(names[0] ?? 'HEAD')}${names.length > 1 ? ` +${names.length - 1}` : ''}${opLabel ? ` (${opLabel})` : ''}${wtSuffix}` : t('No repo'),
    headIconName: !targets.length || icons.includes('git-branch') ? 'git-branch' : icons.includes('tag') ? 'tag' : 'git-commit',
    hasUncommitted: repositories.some((r) => r.files.length > 0),
    hasConflicts: totalConflicts > 0,
    hasOngoingOperation: operations.length > 0,
    opLabel, totalConflicts,
    totalBehind: targets.reduce((sum, r) => sum + r.behind, 0),
    totalAhead: targets.reduce((sum, r) => sum + (r.meta.kind === 'git' ? r.ahead : 0), 0),
    branchesDiverged: new Set(topLevel.map((r) => getRepoEffectiveRef(r, branches))).size > 1,
  };
}

export function commonRepositoryRefs(
  repositories: RepositoryStatus[],
  branches: Record<string, BranchInfo[] | undefined>,
  tags: Record<string, TagInfo[] | undefined>,
) {
  const git = repositories.filter((r) => r.meta.kind === 'git');
  const intersection = (values: string[][], numeric = false) => values.length
    ? [...new Set(values[0])].filter((name) => values.every((items) => items.includes(name))).sort((a, b) => a.localeCompare(b, undefined, { numeric })) : [];
  return {
    commonLocalBranches: intersection(git.map((r) => (branches[r.meta.id] ?? []).filter((b) => !b.remote && b.name !== 'HEAD').map((b) => b.name))),
    commonRemoteBranches: intersection(git.map((r) => (branches[r.meta.id] ?? []).filter((b) => b.remote && !b.name.endsWith('/HEAD')).map((b) => b.name))),
    commonTags: intersection(git.map((r) => (tags[r.meta.id] ?? []).map((tag) => tag.name)), true),
  };
}

export function relativeBranchDate(value: string, t: (key: string, ...args: (string | number)[]) => string = (key, ...args) => args.reduce<string>((text, arg, i) => text.replaceAll(`{${i}}`, String(arg)), key), now = Date.now()): string {
  const stamp = new Date(value).getTime();
  if (!Number.isFinite(stamp)) return value;
  const seconds = Math.max(0, (now - stamp) / 1000);
  if (seconds < 60) return t('just now');
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']] as const;
  const [size, unit] = units.find(([size]) => seconds >= size) ?? units[units.length - 1];
  const count = Math.floor(seconds / size);
  return t(count === 1 ? `{0} ${unit} ago` : `{0} ${unit}s ago`, count);
}
