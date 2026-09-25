import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VscodeChangesView } from './VscodeChangesView';
import type { RepositoryStatus } from '../bindings/generated';

const svnRepoOnlyModified: RepositoryStatus = {
  meta: {
    id: 'svn-repo-1',
    name: 'SVN Repo',
    rootPath: '/tmp/svn-repo',
    color: '#3794ff',
    kind: 'svn',
    parentRepoId: null,
    depth: 0,
    isSubmodule: false,
    isWorktree: false,
  },
  branch: '',
  revision: 'r123',
  ahead: 0,
  behind: 0,
  files: [
    { path: 'src/main.c', status: 'modified', staged: false, unstaged: true, conflicted: false },
    { path: 'README.txt', status: 'modified', staged: false, unstaged: true, conflicted: false },
  ],
  conflicts: 0,
  operation: null,
};

const svnRepoWithUntracked: RepositoryStatus = {
  meta: {
    id: 'svn-repo-2',
    name: 'SVN Repo 2',
    rootPath: '/tmp/svn-repo-2',
    color: '#3794ff',
    kind: 'svn',
    parentRepoId: null,
    depth: 0,
    isSubmodule: false,
    isWorktree: false,
  },
  branch: '',
  revision: 'r124',
  ahead: 0,
  behind: 0,
  files: [
    { path: 'src/main.c', status: 'modified', staged: false, unstaged: true, conflicted: false },
    { path: 'notes.txt', status: 'untracked', staged: false, unstaged: true, conflicted: false },
  ],
  conflicts: 0,
  operation: null,
};

const gitRepo: RepositoryStatus = {
  meta: {
    id: 'git-repo-1',
    name: 'Git Repo',
    rootPath: '/tmp/git-repo',
    color: '#4ec9b0',
    kind: 'git',
    parentRepoId: null,
    depth: 0,
    isSubmodule: false,
    isWorktree: false,
  },
  branch: 'main',
  revision: 'abc',
  ahead: 0,
  behind: 0,
  files: [
    { path: 'staged-file.ts', status: 'modified', staged: true, unstaged: false, conflicted: false },
    { path: 'unstaged-file.ts', status: 'modified', staged: false, unstaged: true, conflicted: false },
  ],
  conflicts: 0,
  operation: null,
};

afterEach(() => {
  cleanup();
});

describe('VscodeChangesView SVN and Git stage behavior', () => {
  it('does not display stage/add buttons for SVN when repo has no untracked files', () => {
    const onStage = vi.fn();
    render(
      <VscodeChangesView
        repos={[svnRepoOnlyModified]}
        selected={new Set()}
        setFiles={vi.fn()}
        onFile={vi.fn()}
        onContext={vi.fn()}
        onFolderContext={vi.fn()}
        onRepoContext={vi.fn()}
        viewMode="list"
        expansion={{ sequence: 0, expanded: true }}
        openWorkingChanges={vi.fn()}
        onStage={onStage}
        onUnstage={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );

    // Single-repo top header renders repo name and branch trigger
    expect(screen.getByText('SVN Repo')).toBeInTheDocument();
    expect(screen.getByText('r123')).toBeInTheDocument();

    // Changes section header hover: should not have stage/add button
    const changesHeader = screen.getByText('Changes').closest('.vscode-section-header')!;
    fireEvent.mouseEnter(changesHeader);
    expect(screen.queryByTitle('Stage All')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Add to SVN')).not.toBeInTheDocument();

    // File row hover: should not have Stage Changes
    const fileRow = screen.getByText('main.c').closest('.file-item')!;
    fireEvent.mouseEnter(fileRow);
    expect(screen.queryByTitle('Stage Changes')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Add to SVN')).not.toBeInTheDocument();
    // But should show discard
    expect(screen.getByTitle('Discard Changes')).toBeInTheDocument();
  });

  it('displays Add to SVN buttons and only stages untracked files when SVN has untracked files', () => {
    const onStage = vi.fn();
    render(
      <VscodeChangesView
        repos={[svnRepoWithUntracked]}
        selected={new Set()}
        setFiles={vi.fn()}
        onFile={vi.fn()}
        onContext={vi.fn()}
        onFolderContext={vi.fn()}
        onRepoContext={vi.fn()}
        viewMode="list"
        expansion={{ sequence: 0, expanded: true }}
        openWorkingChanges={vi.fn()}
        onStage={onStage}
        onUnstage={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );

    // Changes section header hover: shows "Add to SVN"
    const changesHeader = screen.getByText('Changes').closest('.vscode-section-header')!;
    fireEvent.mouseEnter(changesHeader);
    const headerAddBtn = screen.getByTitle('Add to SVN');
    expect(headerAddBtn).toBeInTheDocument();
    fireEvent.click(headerAddBtn);
    // Only notes.txt (untracked) should be staged
    expect(onStage).toHaveBeenCalledWith('svn-repo-2', ['notes.txt']);
    onStage.mockClear();

    // Untracked file row: shows "Add to SVN"
    const untrackedRow = screen.getByText('notes.txt').closest('.file-item')!;
    fireEvent.mouseEnter(untrackedRow);
    const fileAddBtn = untrackedRow.querySelector('button[title="Add to SVN"]');
    expect(fileAddBtn).toBeInTheDocument();
    fireEvent.click(fileAddBtn!);
    expect(onStage).toHaveBeenCalledWith('svn-repo-2', ['notes.txt']);
  });

  it('renders per-repo headers with actions when multiple repositories are present', () => {
    const onStage = vi.fn();
    const onDiscard = vi.fn();
    const openWorkingChanges = vi.fn();
    render(
      <VscodeChangesView
        repos={[svnRepoWithUntracked, gitRepo]}
        selected={new Set()}
        setFiles={vi.fn()}
        onFile={vi.fn()}
        onContext={vi.fn()}
        onFolderContext={vi.fn()}
        onRepoContext={vi.fn()}
        viewMode="list"
        expansion={{ sequence: 0, expanded: true }}
        openWorkingChanges={openWorkingChanges}
        onStage={onStage}
        onUnstage={vi.fn()}
        onDiscard={onDiscard}
      />,
    );

    // Repo heading for SVN Repo 2 inside Changes section
    const repoHeading = screen.getByText('SVN Repo 2').closest('.repo-heading')!;
    fireEvent.mouseEnter(repoHeading);
    const repoAddBtn = repoHeading.querySelector('button[title="Add to SVN"]');
    expect(repoAddBtn).toBeInTheDocument();
    fireEvent.click(repoAddBtn!);
    expect(onStage).toHaveBeenCalledWith('svn-repo-2', ['notes.txt']);

    const repoOpenChangesBtn = repoHeading.querySelector('button[title="Open Changes"]');
    expect(repoOpenChangesBtn).toBeInTheDocument();
    fireEvent.click(repoOpenChangesBtn!);
    expect(openWorkingChanges).toHaveBeenCalledWith('svn-repo-2', 'unstaged');

    const repoRollbackBtn = repoHeading.querySelector('button[title="Rollback All"]');
    expect(repoRollbackBtn).toBeInTheDocument();
    fireEvent.click(repoRollbackBtn!);
    expect(onDiscard).toHaveBeenCalledWith('svn-repo-2', ['src/main.c', 'notes.txt']);
  });

  it('handles Git stage, unstage, rollback, and section diffs properly across sections', () => {
    const onStage = vi.fn();
    const onUnstage = vi.fn();
    const onDiscard = vi.fn();
    const openWorkingChanges = vi.fn();
    render(
      <VscodeChangesView
        repos={[gitRepo]}
        selected={new Set()}
        setFiles={vi.fn()}
        onFile={vi.fn()}
        onContext={vi.fn()}
        onFolderContext={vi.fn()}
        onRepoContext={vi.fn()}
        viewMode="list"
        expansion={{ sequence: 0, expanded: true }}
        openWorkingChanges={openWorkingChanges}
        onStage={onStage}
        onUnstage={onUnstage}
        onDiscard={onDiscard}
      />,
    );

    // Staged Changes section header hover: Open Staged Changes & Unstage All
    const stagedHeader = screen.getByText('Staged Changes').closest('.vscode-section-header')!;
    fireEvent.mouseEnter(stagedHeader);
    const openStagedBtn = screen.getByTitle('Open Staged Changes');
    fireEvent.click(openStagedBtn);
    expect(openWorkingChanges).toHaveBeenCalledWith('git-repo-1', 'staged');

    const unstageAllBtn = screen.getByTitle('Unstage All');
    fireEvent.click(unstageAllBtn);
    expect(onUnstage).toHaveBeenCalledWith('git-repo-1', ['staged-file.ts']);

    // Changes section header hover: Open Changes, Rollback All, Stage All
    const changesHeader = screen.getByText('Changes').closest('.vscode-section-header')!;
    fireEvent.mouseEnter(changesHeader);
    const openChangesBtn = screen.getByTitle('Open Changes');
    fireEvent.click(openChangesBtn);
    expect(openWorkingChanges).toHaveBeenCalledWith('git-repo-1', 'unstaged');

    const rollbackAllBtn = screen.getByTitle('Rollback All');
    fireEvent.click(rollbackAllBtn);
    expect(onDiscard).toHaveBeenCalledWith('git-repo-1', ['unstaged-file.ts']);

    const stageAllBtn = screen.getByTitle('Stage All');
    fireEvent.click(stageAllBtn);
    expect(onStage).toHaveBeenCalledWith('git-repo-1', ['unstaged-file.ts']);
  });

  it('excludes truncated directories from batch Add to SVN and delegates single truncated row without bypass', () => {
    const svnRepoWithTruncated: RepositoryStatus = {
      meta: {
        id: 'svn-repo-3',
        name: 'SVN Repo 3',
        rootPath: '/tmp/svn-repo-3',
        color: '#3794ff',
        kind: 'svn',
        parentRepoId: null,
        depth: 0,
        isSubmodule: false,
        isWorktree: false,
      },
      branch: '',
      revision: 'r125',
      ahead: 0,
      behind: 0,
      files: [
        { path: 'file.txt', status: 'untracked', staged: false, unstaged: true, conflicted: false, isTruncated: false },
        { path: 'big-folder', status: 'untracked', staged: false, unstaged: true, conflicted: false, isTruncated: true },
      ],
      conflicts: 0,
      operation: null,
    };

    const onStage = vi.fn();
    render(
      <VscodeChangesView
        repos={[svnRepoWithTruncated]}
        selected={new Set()}
        setFiles={vi.fn()}
        onFile={vi.fn()}
        onContext={vi.fn()}
        onFolderContext={vi.fn()}
        onRepoContext={vi.fn()}
        viewMode="list"
        expansion={{ sequence: 0, expanded: true }}
        openWorkingChanges={vi.fn()}
        onStage={onStage}
        onUnstage={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );

    // Changes section header hover: clicks "Add to SVN" -> only file.txt staged, big-folder excluded
    const changesHeader = screen.getByText('Changes').closest('.vscode-section-header')!;
    fireEvent.mouseEnter(changesHeader);
    const headerAddBtn = screen.getByTitle('Add to SVN');
    fireEvent.click(headerAddBtn);
    expect(onStage).toHaveBeenCalledWith('svn-repo-3', ['file.txt']);
    onStage.mockClear();

    // Single truncated row hover: clicks recursive add -> calls onStage without bypass true
    const truncatedRow = screen.getByText('big-folder').closest('.file-item')!;
    fireEvent.mouseEnter(truncatedRow);
    const recursiveAddBtn = screen.getByTitle('Add directory recursively to SVN');
    expect(recursiveAddBtn).toBeInTheDocument();
    fireEvent.click(recursiveAddBtn);
    expect(onStage).toHaveBeenCalledWith('svn-repo-3', ['big-folder']);
  });

  it('renders VCS badges for mixed Git and SVN workspace and supports repository checkboxes', () => {
    const onToggleRepoSelection = vi.fn();
    render(
      <VscodeChangesView
        repos={[gitRepo, svnRepoOnlyModified]}
        selected={new Set()}
        setFiles={vi.fn()}
        onFile={vi.fn()}
        onContext={vi.fn()}
        onFolderContext={vi.fn()}
        onRepoContext={vi.fn()}
        viewMode="list"
        expansion={{ sequence: 0, expanded: true }}
        openWorkingChanges={vi.fn()}
        onStage={vi.fn()}
        onUnstage={vi.fn()}
        onDiscard={vi.fn()}
        selectedRepos={new Set(['git-repo-1'])}
        onToggleRepoSelection={onToggleRepoSelection}
      />,
    );

    // Mixed repository VCS badges
    expect(screen.getAllByText('GIT').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('SVN')).toBeInTheDocument();

    // Checkboxes in multi-repo: Git in staged, SVN in changes
    const checkboxes = screen.getAllByTitle('Include this repository in the commit') as HTMLInputElement[];
    expect(checkboxes.length).toBe(2);

    // Git repo is selected (in selectedRepos)
    expect(checkboxes[0].checked).toBe(true);
    // SVN repo is not in selectedRepos
    expect(checkboxes[1].checked).toBe(false);

    // Click SVN checkbox to toggle selection
    fireEvent.click(checkboxes[1]);
    expect(onToggleRepoSelection).toHaveBeenCalledWith('svn-repo-1');
  });
});

