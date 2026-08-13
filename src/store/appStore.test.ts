import { afterEach, describe, expect, it } from 'vitest';
import type { BootstrapData, BridgeCommand, ConflictFile, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from './appStore';

const bootstrap: BootstrapData = {
  state: { theme: 'system', language: 'system', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null },
  tools: { git: true, svn: true, svnadmin: true },
  capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false },
};

const snapshot = (id: string, generation: number): WorkspaceSnapshot => ({
  workspace: { id, name: id, paths: [`/tmp/${id}`], lastOpenedAt: '', available: true },
  generation,
  tools: bootstrap.tools,
  repositories: [],
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => useAppStore.setState({ bridge: undefined, bootstrap: undefined, snapshot: undefined, selectedRepoId: undefined, conflicts: [], merge: undefined, mergeResult: '', mode: 'history', busy: false, error: undefined }));

describe('appStore async lifecycle', () => {
  it('does not let an older workspace response replace the newest workspace', async () => {
    const first = deferred<WorkspaceSnapshot>();
    const second = deferred<WorkspaceSnapshot>();
    const bridge = new MockBridge((command) => {
      if (command.type === 'workspaceOpen') return command.payload.paths[0] === '/tmp/first' ? first.promise : second.promise;
      if (command.type === 'conflicts') return [];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap });
    const firstOpen = useAppStore.getState().openWorkspace(['/tmp/first']);
    const secondOpen = useAppStore.getState().openWorkspace(['/tmp/second']);
    second.resolve(snapshot('second', 2));
    await secondOpen;
    first.resolve(snapshot('first', 1));
    await firstOpen;
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('second');
  });

  it('waits for conflict versions before opening the merge workspace', async () => {
    const versions = deferred<{ path: string; base: string; ours: string; theirs: string; working: string; language: string; fingerprint: string; binary: boolean }>();
    const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'conflictVersions') return versions.promise;
      return [];
    });
    const conflict: ConflictFile = { repoId: 'repo', repoName: 'Repo', repoColor: '#000', path: 'conflict.txt', kind: 'git', binary: false };
    useAppStore.setState({ bridge, bootstrap, snapshot: snapshot('workspace', 1) });
    const opening = useAppStore.getState().openMerge(conflict);
    expect(useAppStore.getState().mode).toBe('history');
    versions.resolve({ path: conflict.path, base: 'base', ours: 'ours', theirs: 'theirs', working: 'working', language: 'text', fingerprint: 'fingerprint', binary: false });
    await opening;
    expect(commands[0]).toEqual({ type: 'conflictVersions', payload: { workspace_id: 'workspace', repo_id: 'repo', relative_path: 'conflict.txt' } });
    expect(useAppStore.getState()).toMatchObject({ mode: 'merge', mergeResult: 'working' });
  });

  it('refreshes watcher changes silently without resetting the active workspace mode', async () => {
    const response = deferred<WorkspaceSnapshot>();
    const bridge = new MockBridge((command) => {
      if (command.type === 'workspaceRefresh') return response.promise;
      if (command.type === 'conflicts') return [];
      return [];
    });
    const current = snapshot('workspace', 1);
    useAppStore.setState({ bridge, bootstrap, snapshot: current, mode: 'diff', busy: false });
    const refreshing = useAppStore.getState().refresh(true);
    expect(useAppStore.getState().busy).toBe(false);
    response.resolve(snapshot('workspace', 2));
    await refreshing;
    expect(useAppStore.getState()).toMatchObject({ mode: 'diff', busy: false });
  });
});
