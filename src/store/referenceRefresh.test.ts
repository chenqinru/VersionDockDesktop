import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapData, BranchInfo, BridgeCommand, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
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
let resolveBranches: ((value: BranchInfo[]) => void) | undefined;
let holdBranches = false;
let freshBranches: BranchInfo[];
let freshStatus: RepositoryStatus;
const branch = (ahead: number, upstream: string | null = 'origin/main'): BranchInfo => ({ name: 'main', current: true, remote: false, upstream, ahead, behind: 0 });
const event = (wid: string, repoId = `${wid}-repo`) => emit({ workspaceId: wid, repoId, generation: 1, source: 'watcher', scopes: ['refs', 'history'] });
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

beforeEach(async () => {
  vi.useFakeTimers();
  commands = []; resolveBranches = undefined; holdBranches = false;
  freshBranches = [];
  freshStatus = repo('a-repo');
  const bridge = new MockBridge(command => {
    commands.push(command);
    if (command.type === 'bootstrap') return bootstrap;
    if (command.type === 'workspaceOpen') return workspace(command.payload.paths[0].split('/').at(-1)!);
    if (command.type === 'workspaceRefresh') return { ...workspace(command.payload.workspace_id), repositories: command.payload.workspace_id === 'a' ? [freshStatus] : workspace(command.payload.workspace_id).repositories };
    if (command.type === 'repositoryStatus') return command.payload.repo_id === 'a-repo' ? freshStatus : repo(command.payload.repo_id);
    if (command.type === 'branches' && command.payload.workspace_id === 'a' && holdBranches) {
      holdBranches = false;
      return new Promise<BranchInfo[]>((resolve) => { resolveBranches = resolve; });
    }
    if (command.type === 'branches') return freshBranches;
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
  it('prevents a slow initial branch read from overwriting newer watcher metadata', async () => {
    holdBranches = true;
    const oldRead = useAppStore.getState().selectRepo('a-repo', true);
    await tick();
    expect(resolveBranches).toBeDefined();
    freshBranches = [branch(1)];
    event('a');
    await vi.advanceTimersByTimeAsync(310);
    expect(useAppStore.getState().branchesByRepo['a-repo']).toEqual(freshBranches);
    resolveBranches!([branch(99)]);
    await oldRead;
    expect(useAppStore.getState().branchesByRepo['a-repo']).toEqual(freshBranches);
    expect(useAppStore.getState().branches).toEqual(freshBranches);
  });

  it('invalidates pre-operation metadata immediately before the debounced refresh starts', async () => {
    const cached = [branch(0)];
    useAppStore.setState({ branchesByRepo: { 'a-repo': cached }, branches: cached });
    holdBranches = true;
    const oldRead = useAppStore.getState().selectRepo('a-repo', true);
    await tick();
    freshBranches = [branch(2, null)];
    event('a');
    resolveBranches!([branch(99)]);
    await oldRead;
    expect(useAppStore.getState().branchesByRepo['a-repo']).toEqual(cached);
    await vi.advanceTimersByTimeAsync(310);
    expect(useAppStore.getState().branchesByRepo['a-repo']).toEqual(freshBranches);
  });

  it('does not let a slow watcher read roll back a newer manual branch refresh', async () => {
    holdBranches = true;
    event('a');
    await vi.advanceTimersByTimeAsync(310);
    expect(resolveBranches).toBeDefined();
    freshBranches = [branch(0)];
    await useAppStore.getState().selectRepo('a-repo', true);
    resolveBranches!([branch(99)]);
    await tick();
    expect(useAppStore.getState().branchesByRepo['a-repo']).toEqual(freshBranches);
  });

  it.each([['merge', 'new-head', 1, true], ['push', 'abc', 0, false]] as const)('refreshes branch metadata after a silent %s status change', async (operation, revision, ahead, historyChanges) => {
    if (operation === 'push') {
      const previous = { ...repo('a-repo'), ahead: 1 };
      useAppStore.setState({ allRepositories: [previous], snapshot: { ...workspace('a'), repositories: [previous] } });
    }
    freshStatus = { ...repo('a-repo'), revision, ahead };
    freshBranches = [branch(ahead)];
    await useAppStore.getState().refresh(true);
    await vi.advanceTimersByTimeAsync(310);
    expect(commands).toContainEqual({ type: 'branches', payload: { workspace_id: 'a', repo_id: 'a-repo' } });
    expect(useAppStore.getState().branchesByRepo['a-repo']).toEqual(freshBranches);
    expect(commands.some(command => command.type === 'history')).toBe(historyChanges);
  });

  it('refreshes branch counts when a status-only event reports a fetch without moving HEAD', async () => {
    freshStatus = { ...repo('a-repo'), behind: 1 };
    freshBranches = [{ ...branch(0), behind: 1 }];
    emit({ workspaceId: 'a', repoId: 'a-repo', generation: 1, source: 'watcher', scopes: ['status'] });
    await vi.advanceTimersByTimeAsync(650);
    expect(useAppStore.getState().branchesByRepo['a-repo']).toEqual(freshBranches);
    expect(commands.filter(command => command.type === 'history')).toEqual([]);
  });

  it('does not reload branch metadata for unchanged status or working-file edits', async () => {
    await useAppStore.getState().refresh(true);
    freshStatus = { ...freshStatus, files: [{ path: 'file.txt', status: 'modified', staged: false, unstaged: true, conflicted: false }] };
    await useAppStore.getState().refresh(true);
    await vi.advanceTimersByTimeAsync(310);
    expect(commands.filter(command => command.type === 'branches' || command.type === 'history')).toEqual([]);
  });

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
