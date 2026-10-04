import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchInfo, RepositoryStatus, WorkspaceSnapshot } from '../../bindings/generated';
import { MockBridge } from '../../platform/bridge';
import { BridgeContext } from '../../platform/context';
import { useAppStore } from '../../store/appStore';
import { BranchMenuPopover } from './BranchMenuPopover';
import { BranchStatusBarItem } from './BranchStatusBarItem';
import { commonRepositoryRefs, deriveBranchStatus, relativeBranchDate, truncateBranchName } from './branchStatus';
import { positionBranchSubmenu } from './branchMenuPosition';
import { choiceDialog, confirmDialog, multiChoiceDialog, promptDialog } from '../dialogService';

vi.mock('../dialogService', () => ({ promptDialog: vi.fn(), choiceDialog: vi.fn(), confirmDialog: vi.fn(), multiChoiceDialog: vi.fn(), currentDialog: () => null }));

const repo = (id: string, kind: 'git' | 'svn' = 'git'): RepositoryStatus => ({
  meta: { id, name: id, rootPath: `/test/${id}`, kind, color: '#888', depth: 0, parentRepoId: null, isSubmodule: false, isWorktree: false },
  branch: 'main', revision: 'abc1234', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
});
const branch = (name: string, current = false, remote = false): BranchInfo => ({ name, current, remote, upstream: null, ahead: 0, behind: 0, lastCommitMessage: 'Improve login validation', lastCommitDate: '2026-09-01T00:00:00Z' });
const original = useAppStore.getState();
const snapshot = (repositories: RepositoryStatus[]): WorkspaceSnapshot => ({ workspace: { id: 'ws', name: 'ws', paths: ['/test'], lastOpenedAt: '', available: true }, repositories, tools: { git: true, svn: true, svnadmin: true }, generation: 1 });
const refs = { alpha: [branch('main', true), branch('feature/login'), branch('origin/main', false, true)], beta: [branch('main'), branch('feature/login', true)] };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAppStore.setState({ ...original, snapshot: snapshot([repo('alpha'), { ...repo('beta'), branch: 'feature/login' }]), selectedRepoId: 'alpha', branchesByRepo: refs, tagsByRepo: {}, operations: {}, remotes: {},
    branchOperation: vi.fn().mockResolvedValue({ completed: true, conflicted: false }), tagOperation: vi.fn().mockResolvedValue(undefined), svnOperation: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined), loadRemotes: vi.fn().mockResolvedValue(undefined), openConflicts: vi.fn(), sync: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => { cleanup(); useAppStore.setState(original, true); vi.useRealTimers(); });

function renderMenu(props: Partial<Parameters<typeof BranchMenuPopover>[0]> = {}) {
  const bridge = new MockBridge((command) => command.type === 'branches' ? useAppStore.getState().branchesByRepo[command.payload.repo_id] ?? [] : command.type === 'tags' ? [] : command.type === 'svnIgnoreEntries' ? [{ directory: 'nested', source: 'svn:ignore', patterns: ['cache', 'keep'] }] : true);
  const close = vi.fn();
  render(<BridgeContext.Provider value={bridge}><BranchMenuPopover anchorRect={new DOMRect(10, 700, 80, 20)} onClose={close} placement="bottomLeft" {...props} /></BridgeContext.Provider>);
  return close;
}

describe('branch menu interactions', () => {
  it('opens at bottom left, filters by details, and supports keyboard entry and Back', async () => {
    renderMenu();
    const root = screen.getByRole('dialog', { name: 'VersionDock: Git/SVN Menu' });
    expect(root.style.left).toBe('8px');
    fireEvent.change(within(root).getByRole('combobox'), { target: { value: 'alpha' } });
    expect(within(root).queryByText('Fetch All')).not.toBeInTheDocument();
    fireEvent.keyDown(within(root).getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(within(root).getByRole('combobox'), { key: 'Enter' });
    const sub = screen.getByRole('dialog', { name: 'alpha — Branches' });
    fireEvent.change(within(sub).getByRole('combobox'), { target: { value: 'login validation' } });
    expect(within(sub).getAllByText('Improve login validation · ' + relativeBranchDate('2026-09-01T00:00:00Z')).length).toBeGreaterThan(0);
    fireEvent.change(within(sub).getByRole('combobox'), { target: { value: 'zz-no-match' } });
    expect(within(sub).getByText('No matches')).toBeInTheDocument();
    fireEvent.click(within(sub).getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('dialog', { name: 'alpha — Branches' })).not.toBeInTheDocument();
    expect(within(root).getByRole('combobox')).toHaveFocus();
    await waitFor(() => expect(useAppStore.getState().branchesByRepo.alpha).toEqual(refs.alpha));
  });

  it('marks a common branch current when any Git repository uses it and excludes SVN from checkout', async () => {
    useAppStore.setState({ snapshot: snapshot([repo('alpha'), { ...repo('beta'), branch: 'feature/login' }, repo('assets', 'svn')]) });
    renderMenu();
    const root = screen.getByRole('dialog', { name: 'VersionDock: Git/SVN Menu' });
    const current = within(root).getByRole('option', { name: 'main current' });
    fireEvent.click(current);
    const actions = screen.getByRole('dialog', { name: 'main' });
    expect(within(actions).queryByText(/Compare/)).not.toBeInTheDocument();
    fireEvent.click(within(actions).getByRole('option', { name: 'Checkout' }));
    await waitFor(() => expect(useAppStore.getState().branchOperation).toHaveBeenCalledTimes(2));
    expect(useAppStore.getState().branchOperation).toHaveBeenCalledWith({ type: 'checkout', name: 'main' }, 'alpha');
    expect(useAppStore.getState().branchOperation).toHaveBeenCalledWith({ type: 'checkout', name: 'main' }, 'beta');
  });

  it('opens the actual conflict workspace', () => {
    useAppStore.setState({ snapshot: snapshot([{ ...repo('alpha'), conflicts: 2 }]) });
    renderMenu();
    fireEvent.click(screen.getByRole('option', { name: /Resolve Conflicts/ }));
    expect(useAppStore.getState().openConflicts).toHaveBeenCalledOnce();
  });

  it('keeps ordinary SVN update conflicts non-abortable and exposes a tracked merge', () => {
    const svn = { ...repo('assets', 'svn'), conflicts: 1 };
    useAppStore.setState({ snapshot: snapshot([svn]) });
    renderMenu({ repoOnly: true, initialRepoId: 'assets' });
    expect(screen.getByText('Resolve Conflicts')).toBeInTheDocument();
    expect(screen.queryByText('Abort Merge')).not.toBeInTheDocument();
    act(() => useAppStore.setState({ snapshot: snapshot([{ ...svn, operation: 'merge' }]) }));
    expect(screen.getByText('Abort Merge')).toBeInTheDocument();
  });

  it('creates an SVN branch from the current working copy using one name prompt', async () => {
    useAppStore.setState({ snapshot: snapshot([repo('assets', 'svn')]) });
    vi.mocked(promptDialog).mockResolvedValue('release');
    renderMenu({ repoOnly: true, initialRepoId: 'assets' });
    fireEvent.click(screen.getByRole('option', { name: 'SVN Create Branch…' }));
    await waitFor(() => expect(useAppStore.getState().branchOperation).toHaveBeenCalledWith({ type: 'create', name: 'release', from: null, checkout: false }, 'assets'));
    expect(promptDialog).toHaveBeenCalledOnce();
  });

  it('offers SVN files before asking for an optional lock message', async () => {
    const svn = { ...repo('assets', 'svn'), files: [{ path: 'tracked.txt', status: 'modified', staged: false, unstaged: true, conflicted: false }, { path: 'new.txt', status: 'untracked', staged: false, unstaged: true, conflicted: false }] };
    useAppStore.setState({ snapshot: snapshot([svn]) });
    vi.mocked(choiceDialog).mockResolvedValue('tracked.txt');
    vi.mocked(promptDialog).mockResolvedValue('');
    renderMenu({ repoOnly: true, initialRepoId: 'assets' });
    fireEvent.click(screen.getByRole('option', { name: 'SVN Lock' }));
    await waitFor(() => expect(useAppStore.getState().svnOperation).toHaveBeenCalledWith('assets', { type: 'lock', paths: ['tracked.txt'], message: null, force: false }));
    expect(vi.mocked(choiceDialog).mock.calls[0][0].choices.map((item) => item.id)).toEqual(['tracked.txt', '__custom__']);
  });

  it('provides force deletion of common local branches with the chosen force flag', async () => {
    vi.mocked(choiceDialog).mockResolvedValue('force');
    renderMenu();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'VersionDock: Git/SVN Menu' })).getByRole('option', { name: 'feature/login current' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'feature/login' })).getByRole('option', { name: 'Delete…' }));
    await waitFor(() => expect(useAppStore.getState().branchOperation).toHaveBeenCalledWith({ type: 'delete', name: 'feature/login', force: true }, 'alpha'));
    expect(vi.mocked(choiceDialog).mock.calls[0][0].choices.map((item) => item.id)).toEqual(['delete', 'force']);
  });

  it('removes chosen SVN ignore entries across directories through the VCS operation', async () => {
    useAppStore.setState({ snapshot: snapshot([repo('assets', 'svn')]) });
    vi.mocked(choiceDialog).mockResolvedValue('remove');
    vi.mocked(multiChoiceDialog).mockResolvedValue([JSON.stringify(['nested', 'cache'])]);
    vi.mocked(confirmDialog).mockResolvedValue(true);
    renderMenu({ repoOnly: true, initialRepoId: 'assets' });
    fireEvent.click(screen.getByRole('option', { name: 'Manage SVN Ignore...' }));
    expect(vi.mocked(multiChoiceDialog)).not.toHaveBeenCalled();
    await waitFor(() => expect(vi.mocked(multiChoiceDialog)).toHaveBeenCalledWith(expect.objectContaining({ initialSelected: [] })));
    await waitFor(() => expect(useAppStore.getState().svnOperation).toHaveBeenCalledWith('assets', { type: 'removeIgnoreEntries', entries: [{ directory: 'nested', source: 'svn:ignore', patterns: ['cache'] }] }));
  });

  it('retains the anchor position of other branch menu entry points and returns through Escape', () => {
    renderMenu({ placement: 'anchor', repoOnly: true, initialRepoId: 'alpha', directBranch: { repoId: 'beta', branchName: 'main', isCurrent: false }, anchorRect: new DOMRect(100, 100, 60, 20) });
    const actions = screen.getByRole('dialog', { name: 'main — beta' });
    expect(actions.style.left).toBe('100px');
    expect(within(actions).getByText("Compare 'feature/login' with 'main'")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'beta — Branches' })).toBeInTheDocument();
  });
});

describe('branch status derivation and bounds', () => {
  it('deduplicates common refs per repository and removes synthetic HEAD entries', () => {
    expect(commonRepositoryRefs([repo('alpha'), repo('beta'), repo('assets', 'svn')], { alpha: [branch('z'), branch('a'), branch('a'), branch('HEAD'), branch('origin/HEAD', false, true)], beta: [branch('a'), branch('z'), branch('HEAD'), branch('origin/HEAD', false, true)] }, {}).commonLocalBranches).toEqual(['a', 'z']);
    expect(commonRepositoryRefs([repo('alpha')], { alpha: [branch('origin/HEAD', false, true)] }, {}).commonRemoteBranches).toEqual([]);
  });
  it('includes SVN operation suffix before worktrees and truncates both branch names', () => {
    const long = 'feature/very-long-branch-name-with-ticket-123';
    const result = deriveBranchStatus([{ ...repo('alpha'), branch: long }, { ...repo('assets', 'svn'), branch: long, operation: 'merge' }, { ...repo('wt'), meta: { ...repo('wt').meta, isWorktree: true }, branch: long }], {}, 'alpha', (s) => s);
    expect(result.headLabel).toBe(`${truncateBranchName(long)} (merging)  |  ${truncateBranchName(long)}`);
    expect(result.hasOngoingOperation).toBe(true);
    expect(result.branchesDiverged).toBe(false);
  });
  it('shows a repository table on hover, including no upstream and active repository', () => {
    vi.useFakeTimers();
    render(<BranchStatusBarItem />);
    fireEvent.mouseEnter(screen.getByRole('button'));
    act(() => vi.advanceTimersByTime(500));
    const tooltip = screen.getByRole('tooltip');
    expect(within(tooltip).getByRole('columnheader', { name: 'Sync' })).toBeInTheDocument();
    expect(within(tooltip).getAllByText('(no upstream)')).toHaveLength(2);
    expect(within(tooltip).getByText('(Current)')).toBeInTheDocument();
  });
  it.each([100, 500])('dismisses branch help on press after %s ms and cancels pending hover', (elapsed) => {
    vi.useFakeTimers();
    const bridge = new MockBridge(() => []);
    render(<BridgeContext.Provider value={bridge}><BranchStatusBarItem /></BridgeContext.Provider>);
    const anchor = screen.getByRole('button');
    fireEvent.mouseEnter(anchor);
    act(() => vi.advanceTimersByTime(elapsed));
    expect(Boolean(screen.queryByRole('tooltip'))).toBe(elapsed === 500);
    fireEvent.pointerDown(anchor);
    fireEvent.focus(anchor);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(anchor).not.toHaveAttribute('aria-describedby');
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.click(anchor);
    expect(screen.getByRole('dialog', { name: 'VersionDock: Git/SVN Menu' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseLeave(anchor);
    fireEvent.mouseEnter(anchor);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('formats timestamps in the active UI language and handles recent or invalid values', () => {
    const t = (key: string, ...args: (string | number)[]) => key === '{0} minutes ago' ? `${args[0]} 分钟前` : key;
    expect(relativeBranchDate('2026-10-02T10:00:00Z', t, Date.parse('2026-10-02T10:15:00Z'))).toBe('15 分钟前');
    expect(relativeBranchDate('2026-10-02T10:00:00Z', undefined, Date.parse('2026-10-02T10:00:03Z'))).toBe('just now');
    expect(relativeBranchDate('invalid')).toBe('invalid');
  });

  it('places children towards free space and clamps narrow viewports', () => {
    const item = new DOMRect(1040, 700, 360, 30);
    const wide = positionBranchSubmenu(item, item, 1440, 800);
    expect(wide.left).toBe(676);
    const narrow = positionBranchSubmenu(item, item, 700, 500);
    expect(narrow.left).toBe(332);
    expect(narrow.top + Math.min(260, narrow.maxHeight)).toBeLessThanOrEqual(470);
  });
});
