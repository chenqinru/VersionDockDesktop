import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand, CommitNode, RepositoryStatus, RepositoryUpdateResult, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import { resetTaskProgress, useTaskProgressStore } from '../progress/taskProgressStore';
import { useAppStore } from './appStore';

const initial = useAppStore.getState();
afterEach(() => { useAppStore.getState().dispose(); useAppStore.setState(initial, true); resetTaskProgress(); vi.restoreAllMocks(); });

function setup(ids: string[], handler?: (command: Extract<BridgeCommand, { type: 'sync' }>) => unknown, showNotification = true) {
  const repos: RepositoryStatus[] = ids.map(id => ({
    meta: { id, name: id.toUpperCase(), rootPath: `/tmp/${id}`, color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
    branch: 'main', revision: 'local', ahead: 1, behind: 1, files: [], conflicts: 0, operation: null,
  }));
  const snapshot: WorkspaceSnapshot = { workspace: { id: 'origin', name: 'Origin', paths: ['/tmp/origin'], lastOpenedAt: '', available: true }, generation: 1, tools: { git: true, svn: true, svnadmin: true }, repositories: repos };
  const updates: RepositoryUpdateResult[] = ids.map(repoId => ({
    repoId, beforeRevision: 'before', afterRevision: 'after', beforeStatus: '', afterStatus: '', summaryError: null,
    summary: { kind: 'updated', commitCount: 1, fileCount: 1, containsMerge: false, detail: { commits: [{ repoId, hash: `incoming-${repoId}`, shortHash: 'incoming', parents: [], author: 'Teammate', email: '', authorDate: '', committerDate: '', message: 'incoming update', refs: [] } satisfies CommitNode], files: [] } },
  }));
  const requests: Array<Extract<BridgeCommand, { type: 'sync' }>> = [];
  const bridge = new MockBridge(command => {
    if (command.type !== 'sync') return [];
    requests.push(command);
    return handler ? handler(command) : { output: '', update: command.payload.action === 'push' ? null : updates.find(update => update.repoId === command.payload.repo_id) };
  });
  const incoming = vi.fn().mockResolvedValue(undefined);
  const outgoing = vi.fn().mockResolvedValue(undefined);
  const pushSuccess = vi.fn(async () => { useAppStore.getState().addNotification({ type: 'success', title: 'Branch Pushed', message: 'pushed', workspaceId: 'origin' }); });
  useAppStore.setState({
    bridge, snapshot, allRepositories: repos, sessions: { origin: { snapshot, allRepositories: repos } as never }, tabs: [snapshot.workspace],
    bootstrap: { state: { settings: { updateProjectShowNotification: showNotification } } } as never,
    notifications: [], toastNotificationIds: [], operations: {},
    sync: initial.sync, updateRepositories: initial.updateRepositories, pushRepositories: initial.pushRepositories, synchronizeRepositories: initial.synchronizeRepositories,
    refresh: vi.fn().mockResolvedValue(undefined), loadIncomingCommits: incoming, loadUnpushedCommits: outgoing, notifyPushSuccess: pushSuccess,
  });
  return { requests, updates, repos, incoming, outgoing, pushSuccess };
}

describe('synchronize completion notifications', () => {
  it.each([1, 3])('publishes update details only after all %s repositories finish pushing and refreshing', async count => {
    const ids = ['a', 'b', 'c'].slice(0, count);
    let finishPush!: () => void;
    const lastPush = new Promise<void>(resolve => { finishPush = resolve; });
    const fixture = setup(ids, async command => {
      if (command.payload.action === 'push') {
        if (command.payload.repo_id === ids.at(-1)) await lastPush;
        return { output: '', update: null };
      }
      return { output: '', update: fixture.updates.find(update => update.repoId === command.payload.repo_id) };
    });
    const pending = useAppStore.getState().synchronizeRepositories({ pullRepoIds: ids, pushRepoIds: ids, strategy: 'rebase' });
    await vi.waitFor(() => expect(fixture.requests.filter(command => command.payload.action === 'push')).toHaveLength(count));
    expect(useAppStore.getState().notifications.some(notification => notification.actions.some(action => action.type === 'viewUpdateResults'))).toBe(false);
    finishPush(); await pending;
    expect(fixture.requests.map(command => command.payload.action)).toEqual([...ids.map(() => 'pullRebase'), ...ids.map(() => 'push')]);
    const notifications = useAppStore.getState().notifications;
    expect(notifications.filter(notification => notification.progress)).toEqual([]);
    expect(notifications[0]?.actions).toEqual([{ type: 'viewUpdateResults', label: 'View update details', results: fixture.updates }]);
    expect(fixture.pushSuccess).toHaveBeenCalledTimes(count === 1 ? 1 : 0);
    if (count > 1) expect(notifications).toHaveLength(1);
    expect(fixture.incoming).toHaveBeenLastCalledWith(undefined, 'origin');
    expect(fixture.outgoing).toHaveBeenLastCalledWith(undefined, 'origin');
    expect(useAppStore.getState().operations).toEqual({});
  });

  it.each(['pull failure', 'push failure', 'restoration conflict', 'summary failure', 'no changes', 'hidden'] as const)('retains the final pull outcome for %s', async scenario => {
    const fixture = setup(['a', 'b'], command => {
      const { action, repo_id: id } = command.payload;
      if (scenario === 'pull failure' && id === 'b' && action !== 'push') throw new Error('update failed');
      if (scenario === 'push failure' && id === 'b' && action === 'push') throw new Error('push failed');
      if (action === 'push') return { output: '', update: null };
      const update = fixture.updates.find(update => update.repoId === id)!;
      if (scenario === 'summary failure' && id === 'b') return { output: '', update: { ...update, summaryError: 'details failed', summary: null } };
      if (scenario === 'no changes') return { output: '', update: { ...update, summary: { ...update.summary!, kind: 'noChanges', commitCount: 0, fileCount: 0, detail: { commits: [], files: [] } } } };
      return { output: '', update, restoreWarning: scenario === 'restoration conflict' && id === 'b' ? { shelf: false, backupName: 'backup', backupId: 'backup', conflicted: true, details: 'conflicted' } : null };
    }, scenario !== 'hidden');
    await useAppStore.getState().synchronizeRepositories({ pullRepoIds: ['a', 'b'], pushRepoIds: ['a', 'b'], strategy: 'merge' });
    const pushed = fixture.requests.filter(command => command.payload.action === 'push').map(command => command.payload.repo_id);
    expect(pushed).toEqual(scenario === 'pull failure' || scenario === 'restoration conflict' ? ['a'] : ['a', 'b']);
    const final = useAppStore.getState().notifications[0];
    if (scenario === 'hidden') { expect(final).toBeUndefined(); return; }
    expect(final?.progress).toBeFalsy();
    if (scenario === 'no changes') {
      expect(final?.message).toBe('VersionDock: Already up to date. No files updated.');
      expect(final?.actions).toEqual([]);
    } else expect(final?.actions.some(action => action.type === 'viewUpdateResults')).toBe(true);
    if (scenario === 'restoration conflict') expect(final?.actions.some(action => action.type === 'openConflicts')).toBe(true);
    if (scenario === 'push failure') expect(useAppStore.getState().notifications.some(notification => notification.title === 'Push failed')).toBe(true);
  });

  it.each(['switch', 'close', 'cancel'] as const)('keeps writes and notifications in the original workspace on %s', async scenario => {
    const fixture = setup(['a', 'b'], async command => {
      if (command.payload.repo_id === 'a' && command.payload.action !== 'push') {
        if (scenario === 'cancel') {
          const task = Object.values(useTaskProgressStore.getState().tasks).find(task => task.title === 'Update Project')!;
          await useTaskProgressStore.getState().cancel(task.id);
        } else {
          useAppStore.setState({ snapshot: { ...useAppStore.getState().snapshot!, workspace: { ...useAppStore.getState().snapshot!.workspace, id: 'other' } }, ...(scenario === 'close' ? { tabs: [], sessions: {} } : {}) });
        }
      }
      return { output: '', update: command.payload.action === 'push' ? null : fixture.updates.find(update => update.repoId === command.payload.repo_id) };
    });
    await useAppStore.getState().synchronizeRepositories({ pullRepoIds: ['a', 'b'], pushRepoIds: ['a', 'b'], strategy: 'merge' }, 'origin');
    expect(fixture.requests.every(command => command.payload.workspace_id === 'origin')).toBe(true);
    if (scenario === 'switch') {
      expect(fixture.requests).toHaveLength(4);
      expect(useAppStore.getState().notifications.every(notification => notification.workspaceId === 'origin')).toBe(true);
    } else {
      expect(fixture.requests.filter(command => command.payload.action === 'push')).toEqual([]);
      expect(useAppStore.getState().notifications).toEqual([]);
    }
  });

  it('preserves incoming-only and outgoing-only selections without expanding either into a full sync', async () => {
    const fixture = setup(['a', 'b']);
    await useAppStore.getState().synchronizeRepositories({ pullRepoIds: ['a'], pushRepoIds: ['b'], strategy: 'merge' });
    expect(fixture.requests.map(command => [command.payload.repo_id, command.payload.action])).toEqual([['a', 'pull'], ['b', 'push']]);
    expect(useAppStore.getState().notifications[0].actions).toEqual([{ type: 'viewUpdateResults', label: 'View update details', results: [fixture.updates[0]] }]);
  });

  it('uses the original workspace capability when another tab contains the same repository id', async () => {
    const fixture = setup(['a']);
    useAppStore.setState({ snapshot: { ...useAppStore.getState().snapshot!, workspace: { ...useAppStore.getState().snapshot!.workspace, id: 'other' }, repositories: [{ ...fixture.repos[0], capabilities: { syncPush: false } as never }] } });
    await useAppStore.getState().synchronizeRepositories({ pullRepoIds: ['a'], pushRepoIds: ['a'], strategy: 'merge' }, 'origin');
    expect(fixture.requests.map(command => command.payload.action)).toEqual(['pull', 'push']);
    expect(useAppStore.getState().notifications.every(notification => notification.workspaceId === 'origin')).toBe(true);
  });
});
