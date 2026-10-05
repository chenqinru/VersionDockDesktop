import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapData, BridgeCommand, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge, type BridgeEvent } from '../platform/bridge';
import { useAppStore } from './appStore';
import { DEFAULT_SETTINGS } from '../settings/defaults';

const initial = useAppStore.getState();
const repo = (id: string): RepositoryStatus => ({
  meta: { id, name: id, rootPath: `/tmp/reference-parity/${id}`, color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
});
const workspace = (id: string): WorkspaceSnapshot => ({
  workspace: { id, name: id, paths: [`/tmp/reference-parity/${id}`], available: true, lastOpenedAt: '' },
  generation: 1, repositories: [repo(`${id}-repo`)], tools: { git: true, svn: true, svnadmin: true },
});
const bootstrap: BootstrapData = {
  applicationSessionId: 'reference-parity',
  state: { theme: 'dark', language: 'en', uiFontSize: 'standard', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null, settings: { ...DEFAULT_SETTINGS, autoRefreshInterval: 0, fetchOnStartup: false, notifyUnpushedCommits: false, notifyIncomingCommits: false } },
  tools: { git: true, svn: true, svnadmin: true },
  capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false },
};
let emit: (event: BridgeEvent) => void;
let commands: BridgeCommand[];
let resolveBranches: ((value: []) => void) | undefined;
let holdBranches = false;
const event = (wid: string, repoId = `${wid}-repo`) => emit({ workspaceId: wid, repoId, generation: 1, source: 'watcher', scopes: ['refs', 'history'] });
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

beforeEach(async () => {
  vi.useFakeTimers();
  commands = []; resolveBranches = undefined; holdBranches = false;
  const bridge = new MockBridge(command => {
    commands.push(command);
    if (command.type === 'bootstrap') return bootstrap;
    if (command.type === 'workspaceOpen') return workspace(command.payload.paths[0].split('/').at(-1)!);
    if (command.type === 'workspaceRefresh') return workspace(command.payload.workspace_id);
    if (command.type === 'repositoryStatus') return repo(command.payload.repo_id);
    if (command.type === 'branches' && command.payload.workspace_id === 'a' && holdBranches) {
      holdBranches = false;
      return new Promise<[]>((resolve) => { resolveBranches = resolve; });
    }
    if (command.type === 'history') return { commits: [], hasMore: false };
    return [];
  });
  bridge.subscribe = handler => { emit = handler ?? (() => undefined); return () => undefined; };
  await useAppStore.getState().initialize(bridge);
  await useAppStore.getState().openWorkspace(workspace('a').workspace.paths);
  await useAppStore.getState().openWorkspace(workspace('b').workspace.paths);
  await useAppStore.getState().switchTab('a');
  commands.length = 0;
});
afterEach(() => {
  useAppStore.getState().dispose();
  useAppStore.setState(initial, true);
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('workspace ownership of background reference refresh', () => {
  it('keeps a debounced old-project event pending until returning to that project', async () => {
    event('a');
    await useAppStore.getState().switchTab('b');
    event('b');
    await vi.advanceTimersByTimeAsync(310);
    const beforeReturn = commands.filter(command => command.type === 'branches' || command.type === 'tags' || command.type === 'repositoryStatus');
    expect(beforeReturn.length).toBeGreaterThan(0);
    for (const command of beforeReturn) expect(command).toMatchObject({ payload: { workspace_id: 'b', repo_id: 'b-repo' } });
    commands.length = 0;
    await useAppStore.getState().switchTab('a');
    await vi.advanceTimersByTimeAsync(310);
    expect(commands).toContainEqual({ type: 'branches', payload: { workspace_id: 'a', repo_id: 'a-repo' } });
    expect(commands).toContainEqual({ type: 'tags', payload: { workspace_id: 'a', repo_id: 'a-repo' } });
    expect(useAppStore.getState().notifications).toEqual([]);
  });

  it('does not continue old-project work or publish old results after an in-flight tab switch', async () => {
    const oldBranch = { name: 'cached-a', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0, detachedTag: null, detachedHash: null, lastCommitMessage: null, lastCommitDate: null };
    useAppStore.setState({ branchesByRepo: { 'a-repo': [oldBranch] } });
    holdBranches = true;
    event('a');
    await vi.advanceTimersByTimeAsync(310);
    expect(resolveBranches).toBeDefined();
    await useAppStore.getState().switchTab('b');
    event('b');
    await vi.advanceTimersByTimeAsync(310);
    commands.length = 0;
    resolveBranches!([]);
    await tick();
    await vi.advanceTimersByTimeAsync(310);
    expect(commands.filter(command => 'payload' in command && 'repo_id' in command.payload).length).toBeGreaterThan(0);
    for (const command of commands.filter(command => 'payload' in command && 'repo_id' in command.payload)) {
      expect(command).toMatchObject({ payload: { workspace_id: 'b', repo_id: 'b-repo' } });
    }
    expect(useAppStore.getState().sessions.a.branchesByRepo['a-repo']).toEqual([oldBranch]);
    expect(useAppStore.getState().branchesByRepo['a-repo']).toBeUndefined();
    await useAppStore.getState().switchTab('a');
    await vi.advanceTimersByTimeAsync(310);
    expect(useAppStore.getState().branchesByRepo['a-repo']).toEqual([]);
    expect(useAppStore.getState().notifications).toEqual([]);
  });

  it('skips events for removed repositories and unrelated repository ids', async () => {
    event('a');
    const current = useAppStore.getState().snapshot!;
    useAppStore.setState({ snapshot: { ...current, repositories: [] }, allRepositories: [] });
    event('a', 'b-repo');
    await vi.advanceTimersByTimeAsync(310);
    expect(commands.filter(command => 'payload' in command && 'repo_id' in command.payload)).toEqual([]);
    expect(useAppStore.getState().notifications).toEqual([]);
  });

  it('discards queued events when their project is closed', async () => {
    event('a');
    await useAppStore.getState().closeTab('a', { closeWindowIfLast: false });
    commands.length = 0;
    await vi.advanceTimersByTimeAsync(310);
    expect(commands.filter(command => 'payload' in command && 'repo_id' in command.payload)).toEqual([]);
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('b');
    expect(useAppStore.getState().notifications).toEqual([]);
  });
});
