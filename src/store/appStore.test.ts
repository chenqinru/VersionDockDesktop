import { afterEach, describe, expect, it } from 'vitest';
import type { BootstrapData, BridgeCommand, CommitDetail, CommitNode, ConflictFile, RepositoryStatus, SubtreeEntry, WorkspaceSnapshot } from '../bindings/generated';
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

const repository = (id: string, name: string): RepositoryStatus => ({
  meta: { id, name, rootPath: `/tmp/${id}`, color: id === 'a' ? '#4ec9b0' : '#61afef', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => useAppStore.setState({ bridge: undefined, bootstrap: undefined, snapshot: undefined, selectedRepoId: undefined, history: [], historyByRepo: {}, historyHasMoreByRepo: {}, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, selectedCommit: undefined, changes: undefined, changesDiff: undefined, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], merge: undefined, mergeResult: '', stashes: {}, shelves: {}, changelists: {}, worktrees: {}, subtrees: {}, remotes: {}, mode: 'history', busy: false, error: undefined }));

describe('appStore async lifecycle', () => {
  it('supports single, toggle, and range commit selection with aggregated revision diffs', async () => {
    const commits: CommitNode[] = [
      { repoId: 'a', hash: 'a'.repeat(40), shortHash: 'aaaaaaaa', parents: ['b'.repeat(40)], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-03T00:00:00Z', committerDate: '2026-01-03T00:00:00Z', message: 'third', refs: [] },
      { repoId: 'a', hash: 'b'.repeat(40), shortHash: 'bbbbbbbb', parents: ['c'.repeat(40)], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-02T00:00:00Z', committerDate: '2026-01-02T00:00:00Z', message: 'second', refs: [] },
      { repoId: 'a', hash: 'c'.repeat(40), shortHash: 'cccccccc', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'first', refs: [] },
    ];
    const detail = (commit: CommitNode): CommitDetail => ({ commit, fullMessage: commit.message, branches: { local: ['main'], remote: ['origin/main'], tags: [] }, files: [{ path: `src/${commit.shortHash}.ts`, status: 'M', added: 2, removed: 1 }] });
    const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'commitDetail') return detail(commits.find((commit) => commit.hash === command.payload.revision)!);
      if (command.type === 'fileDiff') return { path: command.payload.relative_path, content: 'diff', language: 'text', binary: false, truncated: false, lineCount: 1 };
      return [];
    });
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('a', 'Alpha')];
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'a', history: commits });

    await useAppStore.getState().selectCommit(commits[1]);
    await useAppStore.getState().selectCommit(commits[0], 'range', commits);
    expect(useAppStore.getState().selectedCommits.map((commit) => commit.hash)).toEqual([commits[0].hash, commits[1].hash]);
    useAppStore.getState().openCommitChanges();
    expect(useAppStore.getState().mode).toBe('changes');
    const target = useAppStore.getState().changes!.files[0];
    await useAppStore.getState().loadChangesDiff(target);
    const rangeCommand = commands.find((command) => command.type === 'fileDiff' && command.payload.from_revision);
    expect(rangeCommand).toMatchObject({ type: 'fileDiff', payload: { from_revision: 'c'.repeat(40), to_revision: 'a'.repeat(40) } });
    expect(useAppStore.getState().changesDiff?.content).toBe('diff');
    await useAppStore.getState().selectCommit(commits[2], 'toggle', commits);
    expect(useAppStore.getState().selectedCommits.map((commit) => commit.hash)).toEqual([commits[0].hash, commits[1].hash, commits[2].hash]);
  });

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

  it('aggregates history from every repository without losing repository scope', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('a', 'Alpha'), repository('b', 'Beta')];
    const bridge = new MockBridge((command) => {
      if (command.type === 'history') return { commits: [{ repoId: command.payload.repo_id, hash: command.payload.repo_id, shortHash: command.payload.repo_id, parents: [], author: 'Ada', email: '', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: command.payload.repo_id, refs: [] }], hasMore: false };
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'a' });
    await useAppStore.getState().loadHistory(true);
    expect(useAppStore.getState().history.map((commit) => commit.repoId)).toEqual(['a', 'b']);
    expect(Object.keys(useAppStore.getState().historyByRepo)).toEqual(['a', 'b']);
  });

  it('loads branch and tag refs for SVN repositories as well as Git', async () => {
    const svn = { ...repository('svn', 'SVN'), meta: { ...repository('svn', 'SVN').meta, kind: 'svn' as const } };
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [svn];
    const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'branches') return [{ name: 'trunk', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 }];
      if (command.type === 'tags') return [{ name: 'v1.0.0', hash: 'r4', date: '' }];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'svn' });
    await useAppStore.getState().selectRepo('svn', true);
    expect(commands.some((command) => command.type === 'branches' && command.payload.repo_id === 'svn')).toBe(true);
    expect(commands.some((command) => command.type === 'tags' && command.payload.repo_id === 'svn')).toBe(true);
    expect(useAppStore.getState().branchesByRepo.svn[0].name).toBe('trunk');
    expect(useAppStore.getState().tagsByRepo.svn[0].hash).toBe('r4');
  });

  it('uses a repository-scoped subtree command without cwd and refreshes registered entries', async () => {
    const commands: BridgeCommand[] = [];
    const entries: SubtreeEntry[] = [{ id: 'entry', prefix: 'vendor/api', remote: 'origin', branch: 'main', squash: true, state: 'active' }];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'subtrees') return entries;
      if (command.type === 'workspaceRefresh') return snapshot('workspace', 2);
      if (command.type === 'conflicts') return [];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: snapshot('workspace', 1), selectedRepoId: 'repo' });
    await useAppStore.getState().subtreeOperation('repo', { type: 'pull', subtree_id: 'entry' });
    expect(commands[0]).toEqual({ type: 'subtreeOperation', payload: { workspace_id: 'workspace', repo_id: 'repo', operation: { type: 'pull', subtree_id: 'entry' } } });
    expect(commands[0]).not.toHaveProperty('cwd');
    expect(useAppStore.getState().subtrees.repo).toEqual(entries);
  });
});
