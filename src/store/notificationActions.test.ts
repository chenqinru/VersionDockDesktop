import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapData, BranchInfo, BridgeCommand, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeError, MockBridge } from '../platform/bridge';
import { currentDialog, publishDialog } from '../components/dialogService';
import { openExternalLink } from '../services/updater';
import { useAppStore } from './appStore';

vi.mock('../services/updater', () => ({ checkAppUpdate: vi.fn(), openExternalLink: vi.fn(async () => undefined) }));

const repo: RepositoryStatus = { meta: { id: 'repo', name: 'Project', rootPath: '/tmp/project', color: '#fff', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'revision', ahead: 0, behind: 0, conflicts: 0, operation: null, files: [] };
const workspace: WorkspaceSnapshot = { workspace: { id: 'workspace', name: 'Project', paths: ['/tmp/project'], lastOpenedAt: '', available: true }, generation: 1, repositories: [repo], tools: { git: true, svn: true, svnadmin: true } };
const bootstrap: BootstrapData = { applicationSessionId: 'actions-test', state: { recentWorkspaces: [], lastWorkspaceId: null, activeTab: 'changes' }, tools: workspace.tools, capabilities: { ai: false, stash: true, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: true } };
const branch = (name: string, current = false, remote = false, upstream: string | null = null): BranchInfo => ({ name, current, remote, remoteName: remote ? 'origin' : null, upstream, ahead: 0, behind: 0, detachedTag: null, detachedHash: null, lastCommitMessage: null, lastCommitDate: null });

function setup(handler?: ConstructorParameters<typeof MockBridge>[0]) {
  const calls: BridgeCommand[] = [];
  const bridge = new MockBridge((command) => {
    calls.push(command);
    const result = handler?.(command);
    if (result !== undefined) return result;
    if (command.type === 'workspaceRefresh') return workspace;
    if (command.type === 'history') return { commits: [], hasMore: false };
    if (command.type === 'repositoryStatus') return repo;
    if (command.type === 'branchOperation') return { completed: true, conflicted: false };
    if (command.type === 'sync') return { output: 'done', update: null };
    if (command.type === 'branches') return [branch('main', true)];
    if (command.type === 'runtimeCapabilities') return null;
    return [];
  });
  useAppStore.setState({ bridge, bootstrap, ready: true, snapshot: workspace, allRepositories: [repo], tabs: [workspace.workspace], activeTabId: workspace.workspace.id, selectedRepoId: repo.meta.id, notifications: [], toastNotificationIds: [], notificationCenterOpen: false, sessions: {}, operations: {}, branchesByRepo: {}, historyByRepo: {}, stashes: {} });
  return Object.assign(bridge, { calls });
}

afterEach(() => {
  useAppStore.getState().dispose();
  publishDialog(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('notification button parity', () => {
  it('opens the conflict panel rather than only selecting changes', async () => {
    setup();
    const id = useAppStore.getState().addNotification({ type: 'warning', title: 'Conflicts', message: 'Resolve', actions: [{ type: 'openConflicts', label: 'Resolve Conflicts' }] });
    await useAppStore.getState().performNotificationAction(id, 0);
    expect(useAppStore.getState().mode).toBe('conflicts');
  });

  it('uses the pushed remote and branch for Create Pull Request without switching workspace', async () => {
    const bridge = setup((command) => command.type === 'remotes' ? [{ name: 'other', fetchUrl: 'https://gitlab.com/team/other.git', pushUrl: null }, { name: 'origin', fetchUrl: 'https://github.com/team/project.git', pushUrl: null }] : undefined);
    const switchTab = vi.spyOn(useAppStore.getState(), 'switchTab');
    await useAppStore.getState().sync('repo', 'push', true, { remote: 'origin', branch: 'feature/test' });
    const notification = useAppStore.getState().notifications.find((item) => item.title === 'Branch Pushed')!;
    expect(notification.actions[0]).toEqual({ type: 'openExternal', label: 'Create Pull Request', url: 'https://github.com/team/project/pull/new/feature%2Ftest' });
    useAppStore.setState({ activeTabId: 'another' });
    await useAppStore.getState().performNotificationAction(notification.id, 0);
    expect(openExternalLink).toHaveBeenCalledWith('https://github.com/team/project/pull/new/feature%2Ftest');
    expect(switchTab).not.toHaveBeenCalled();
    expect(bridge.calls.some((command) => command.type === 'sync')).toBe(true);
  });

  it('offers Create Branch after detached HEAD commit and submits the captured revision', async () => {
    const detached = { ...repo, branch: 'HEAD (no branch)', revision: 'detached-commit' };
    const bridge = setup((command) => command.type === 'repositoryStatus' ? detached : undefined);
    await useAppStore.getState().commit('repo', 'message', false, [], false);
    const notification = useAppStore.getState().notifications.find((item) => item.title === 'Detached HEAD')!;
    const pending = useAppStore.getState().performNotificationAction(notification.id, 0);
    expect(currentDialog()?.title).toBe('Create Branch from Current Commit');
    currentDialog()?.resolve('keep-my-work');
    await pending;
    expect(bridge.calls).toContainEqual({ type: 'branchOperation', payload: { workspace_id: 'workspace', repo_id: 'repo', operation: { type: 'create', name: 'keep-my-work', from: 'detached-commit', checkout: true } } });
  });

  it.each(['continueOperation', 'abortOperation', 'skipOperation'] as const)('executes %s through the native operation command', async (type) => {
    const bridge = setup((command) => command.type === 'repositoryStatus' ? { ...repo, operation: 'cherry-pick' } : undefined);
    const id = useAppStore.getState().addNotification({ type: 'warning', title: 'Conflict', message: 'Choose an action', actions: [{ type, label: 'Action', repoId: 'repo', operation: 'cherry-pick' }] });
    await useAppStore.getState().performNotificationAction(id, 0);
    expect(bridge.calls).toContainEqual({ type: type === 'abortOperation' ? 'abortRepositoryOperation' : 'continueRepositoryOperation', payload: { workspace_id: 'workspace', repo_id: 'repo', operation: 'cherry-pick', ...(type === 'skipOperation' ? { skip: true } : {}) } });
  });

  it('blocks repeated clicks and stale repository operations', async () => {
    let resolve!: (status: RepositoryStatus) => void;
    const bridge = setup((command) => command.type === 'repositoryStatus' ? new Promise<RepositoryStatus>((done) => { resolve = done; }) : undefined);
    const id = useAppStore.getState().addNotification({ type: 'warning', title: 'Conflict', message: 'Old rebase', actions: [{ type: 'continueOperation', label: 'Continue', repoId: 'repo', operation: 'rebase' }] });
    const first = useAppStore.getState().performNotificationAction(id, 0);
    await useAppStore.getState().performNotificationAction(id, 0);
    expect(bridge.calls.filter((command) => command.type === 'repositoryStatus')).toHaveLength(1);
    resolve({ ...repo, operation: 'cherry-pick' });
    await first;
    expect(bridge.calls.some((command) => command.type === 'continueRepositoryOperation')).toBe(false);
  });

  it('offers Unlock for index lock errors and unlocks only the repository in that notification', async () => {
    let failed = false;
    const bridge = setup((command) => {
      if (command.type === 'branchOperation' && !failed) { failed = true; throw new BridgeError({ code: 'GIT_INDEX_BUSY', message: 'Git index is busy: .git/index.lock', recoverable: true, command: null, exitCode: null, stderr: null }); }
      return undefined;
    });
    await useAppStore.getState().branchOperation({ type: 'create', name: 'new' }, 'repo');
    const notification = useAppStore.getState().notifications.find((item) => item.type === 'error')!;
    expect(notification.actions).toContainEqual({ type: 'unlockIndex', label: 'Unlock', repoId: 'repo' });
    await useAppStore.getState().performNotificationAction(notification.id, 0);
    expect(bridge.calls).toContainEqual({ type: 'gitUnlockIndex', payload: { workspace_id: 'workspace', repo_id: 'repo' } });
  });

  it('offers rebase and force recovery for rejected pushes', async () => {
    let rejected = true;
    const bridge = setup((command) => {
      if (command.type === 'sync' && command.payload.action === 'push' && rejected) throw new BridgeError({ code: 'PUSH_REJECTED', message: '[rejected] non-fast-forward', recoverable: true, command: null, exitCode: null, stderr: null });
      return undefined;
    });
    await useAppStore.getState().sync('repo', 'push');
    const notification = useAppStore.getState().notifications.find((item) => item.type === 'error')!;
    expect(notification.actions).toEqual([{ type: 'recoverPush', label: 'Rebase & Push', repoId: 'repo', strategy: 'rebase' }, { type: 'recoverPush', label: 'Force Push', repoId: 'repo', strategy: 'force' }]);
    rejected = false;
    await useAppStore.getState().performNotificationAction(notification.id, 0);
    const syncActions = bridge.calls.filter((command) => command.type === 'sync').map((command) => command.payload.action);
    expect(syncActions).toEqual(['push', 'pullRebase', 'push']);
  });

  it('prunes only selected gone branches and uses non-force deletion', async () => {
    const refs = [branch('main', true), branch('gone', false, false, 'origin/gone'), branch('keep', false, false, 'origin/keep'), branch('origin/keep', false, true)];
    const bridge = setup((command) => command.type === 'branches' ? refs : undefined);
    await useAppStore.getState().sync('repo', 'fetch');
    const notification = useAppStore.getState().notifications.find((item) => item.title === 'Prune Branches')!;
    const pending = useAppStore.getState().performNotificationAction(notification.id, 0);
    currentDialog()?.resolve(['gone', 'keep']);
    await pending;
    const deletions = bridge.calls.filter((command) => command.type === 'branchOperation');
    expect(deletions).toHaveLength(1);
    expect(deletions[0]).toEqual({ type: 'branchOperation', payload: { workspace_id: 'workspace', repo_id: 'repo', operation: { type: 'delete', name: 'gone', force: false } } });
  });
});
