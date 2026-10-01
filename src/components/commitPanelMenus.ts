import type { FileChange, RepositoryStatus } from '../bindings/generated';
import type { ContextMenuEntry } from './ContextMenu';

interface ChangeMenuTarget {
  repo: RepositoryStatus;
  files: FileChange[];
  kind: 'file' | 'folder' | 'repo';
  path?: string;
  stagedSection?: boolean;
  changelistId?: string;
  mode: string;
  hasCustomChangelists: boolean;
}

export function buildChangeContextMenu(value: ChangeMenuTarget, t: (key: string, ...args: Array<string | number>) => string): ContextMenuEntry[] {
  const { repo, files, kind, stagedSection, mode } = value;
  const file = kind === 'file' ? files[0] : undefined;
  const git = repo.meta.kind === 'git';
  const allUntracked = files.length > 0 && files.every((entry) => entry.status === 'untracked');
  const items: ContextMenuEntry[] = [];
  const separator = () => items.push({ separator: true });
  const add = (id: string, label: string, icon: string, danger = false) => items.push({ id, label: t(label), icon, danger });
  const staged = stagedSection ?? Boolean(file?.staged && !file.unstaged);
  if (file?.submodule) {
    add(staged ? 'unstage' : 'stage', staged ? 'Unstage' : 'Stage', staged ? 'remove' : 'add');
    separator();
    add('submodule-update-parent', 'Update Submodule (Sync to Commit)', 'sync');
    add('submodule-reveal-panel', 'Reveal in Submodules Panel', 'repo-clone');
    add('submodule-diff', 'Show Pointer Diff', 'diff');
    separator();
    add('submodule-open-window', 'Open in New Window', 'link-external');
    add('refresh', 'Refresh', 'refresh');
    return items;
  }
  const vscode = mode === 'vscode' && git && stagedSection !== undefined;
  if (file?.conflicted && !vscode) {
    add('resolve', 'Resolve Conflicts', 'git-merge');
    add('accept-yours', 'Accept Yours', 'check');
    add('accept-theirs', 'Accept Theirs', 'check-all');
    separator();
  }
  if (vscode) {
    add(stagedSection ? 'unstage' : 'stage', stagedSection ? kind === 'repo' ? 'Unstage All' : kind === 'folder' ? 'Unstage Folder' : 'Unstage' : kind === 'repo' ? 'Stage All' : kind === 'folder' ? 'Stage Folder' : 'Stage', stagedSection ? 'remove' : 'add');
  } else if (allUntracked || (!git && kind === 'repo' && files.some((entry) => entry.status === 'untracked')) || (mode === 'changelists' && kind === 'repo' && value.changelistId && !['default', 'unassigned'].includes(value.changelistId))) {
    add('stage', git ? 'Add to Git' : file?.isTruncated ? 'Add directory recursively to SVN' : 'Add to SVN', 'add');
  }
  if (!(vscode && stagedSection) && files.some((entry) => !entry.isTruncated)) {
    add('rollback', 'Rollback', 'discard');
    if (git) {
      add('shelf', kind === 'file' ? 'Shelve' : 'Shelve Changes', 'archive');
      add('stash', kind === 'file' ? 'Stash' : 'Stash Changes', 'save');
    }
  }
  if (file) {
    if (vscode) separator();
    add(staged ? 'diff-staged' : 'diff-unstaged', 'Show Diff', 'diff');
    add('open', 'Jump to Source', 'go-to-file');
    if (!allUntracked || vscode) {
      add('reveal-explorer', 'Reveal in Explorer', 'list-tree');
      add('reveal', /Mac/i.test(navigator.platform) ? 'Reveal in Finder' : /Win/i.test(navigator.platform) ? 'Show in Explorer' : 'Show in File Manager', 'folder-opened');
    }
  }
  if (kind !== 'repo' && value.path && !(vscode && stagedSection) && (git || allUntracked)) {
    separator();
    add('ignore', git ? 'Add to .gitignore' : 'Add to SVN Ignore', 'exclude');
  }
  if (kind !== 'repo' && files.length && !files.some((entry) => entry.isTruncated) && !(vscode && stagedSection)) {
    separator();
    add('delete', 'Delete', 'trash', true);
  }
  if (mode === 'changelists' && value.hasCustomChangelists && !allUntracked && files.length && !vscode) {
    separator();
    add('move-to-changelist', 'Move to Changelist…', 'list-unordered');
  }
  if (kind === 'repo') {
    separator();
    add('manage', 'Manage Repository', 'git-branch');
    add('view-log', git ? 'View Git Log' : 'View SVN Log', 'git-commit');
    separator();
    add('hide-repo', 'Hide Repository', 'eye-closed');
  }
  separator();
  add('refresh', 'Refresh', 'refresh');
  if (!git) { separator(); add('manage-ignore', 'Manage SVN Ignore...', 'list-unordered'); }
  return items.filter((item, index) => !('separator' in item && item.separator) || index > 0 && !('separator' in items[index - 1] && items[index - 1].separator));
}
