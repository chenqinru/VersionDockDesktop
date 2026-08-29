import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapData, BridgeCommand, CommitDetail, CommitNode, ConflictFile, RepositoryStatus, SubtreeEntry, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge, type BridgeEvent, type RequestOptions } from '../platform/bridge';
import { interleaveHistory, isOperationActive, useAppStore, workspacePathsEqual } from './appStore';

const bootstrap: BootstrapData = {
  state: { theme: 'system', language: 'system', uiFontSize: 'standard', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null },
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

afterEach(() => {
  useAppStore.getState().dispose();
  useAppStore.setState({ bridge: undefined, bootstrap: undefined, snapshot: undefined, tabs: [], activeTabId: null, sessions: {}, selectedRepoId: undefined, history: [], historyByRepo: {}, historyTopology: [], historyTopologyByRepo: {}, historyHasMoreByRepo: {}, historyLoading: false, branchesLoading: false, historyScope: { repoIds: null, revisionsByRepo: {} }, selectedCommits: [], selectedCommitDetails: {}, selectedCommitLoading: {}, mergeCommits: {}, mergeCommitsLoading: {}, selectedCommit: undefined, changes: undefined, changesDiff: undefined, branches: [], tags: [], branchesByRepo: {}, tagsByRepo: {}, conflicts: [], merge: undefined, mergeResult: '', stashes: {}, shelves: {}, changelists: {}, worktrees: {}, worktreeDiff: undefined, subtrees: {}, remotes: {}, comparisonTarget: undefined, comparison: undefined, mode: 'history', operations: {}, ready: false, error: undefined });
});

describe('appStore async lifecycle', () => {
  it('isolates operation activity by repository and domain', () => {
    const operations = {
      fetchA: {
        operationId: 'fetchA',
        context: { generation: 1, domain: 'sync' as const, visibility: 'foreground' as const, workspaceId: 'workspace', repositoryId: 'repo-a', target: null },
        status: 'running' as const,
        phase: 'sync', message: '', startedAt: '', cancellable: true, completed: null, total: null, error: null,
      },
    };
    expect(isOperationActive(operations, { repositoryId: 'repo-a', domain: 'sync' })).toBe(true);
    expect(isOperationActive(operations, { repositoryId: 'repo-b', domain: 'sync' })).toBe(false);
    expect(isOperationActive(operations, { repositoryId: 'repo-a', domain: 'diff' })).toBe(false);
  });
  it('compares multi-root workspace paths independent of selection order', () => {
    expect(workspacePathsEqual(['/repo/admin', '/repo/api'], ['/repo/api', '/repo/admin'])).toBe(true);
    expect(workspacePathsEqual(['/repo/admin'], ['/repo/api'])).toBe(false);
  });

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

  it('preserves branch comparison while opening and closing a file diff', async () => {
    const bridge = new MockBridge((command) => command.type === 'fileDiff'
      ? { path: command.payload.relative_path, content: 'diff --git a/src/file.ts b/src/file.ts', language: 'typescript', binary: false, truncated: false, lineCount: 1 }
      : []);
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'repo' });
    useAppStore.getState().openBranchComparison('repo', 'feature/ui');
    useAppStore.setState({ comparison: { base: 'main', target: 'feature/ui', baseCommits: [], targetCommits: [], files: [] } });

    await useAppStore.getState().openDiff('repo', 'src/file.ts', false, 'abcdef');

    expect(useAppStore.getState()).toMatchObject({
      mode: 'diff',
      comparisonTarget: { repoId: 'repo', target: 'feature/ui' },
      comparison: { base: 'main', target: 'feature/ui' },
    });
    useAppStore.getState().backToHistory();
    expect(useAppStore.getState()).toMatchObject({
      mode: 'history',
      comparisonTarget: { repoId: 'repo', target: 'feature/ui' },
      comparison: { base: 'main', target: 'feature/ui' },
    });
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

  it('refreshes watcher changes silently without visible operations or resetting the active workspace mode', async () => {
    const response = deferred<WorkspaceSnapshot>();
    const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
    const bridge = new MockBridge((command, options) => {
      requests.push({ command, options });
      if (command.type === 'workspaceRefresh') return response.promise;
      if (command.type === 'conflicts') return [];
      return [];
    });
    const current = snapshot('workspace', 1);
    useAppStore.setState({ bridge, bootstrap, snapshot: current, mode: 'diff', });
    const refreshing = useAppStore.getState().refresh(true);
    response.resolve(snapshot('workspace', 2));
    await refreshing;
    expect(useAppStore.getState()).toMatchObject({ mode: 'diff', });
    expect(requests.find(({ command }) => command.type === 'workspaceRefresh')?.options?.showProgress).toBe(false);
    expect(requests.find(({ command }) => command.type === 'conflicts')?.options?.showProgress).toBe(false);
  });

  it('keeps silent history refresh out of loading state and native progress', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
    const bridge = new MockBridge((command, options) => {
      requests.push({ command, options });
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'historyTopology') return [];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'repo', historyLoading: false });

    await useAppStore.getState().loadHistory(true, true);

    expect(useAppStore.getState().historyLoading).toBe(false);
    expect(requests.filter(({ command }) => command.type === 'history' || command.type === 'historyTopology'))
      .toHaveLength(2);
    expect(requests.filter(({ command }) => command.type === 'history' || command.type === 'historyTopology')
      .every(({ options }) => options?.showProgress === false)).toBe(true);
  });

  it('keeps the active view stable when creating a stash in the running workspace', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
    const bridge = new MockBridge((command, options) => {
      requests.push({ command, options });
      if (command.type === 'workspaceRefresh') return { ...workspace, generation: 2 };
      if (command.type === 'stashes' || command.type === 'conflicts') return [];
      return true;
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, allRepositories: workspace.repositories, selectedRepoId: 'repo', mode: 'diff' });

    await useAppStore.getState().stashOperation('repo', { type: 'create', message: 'WIP', paths: ['src/file.ts'], include_untracked: true });

    expect(useAppStore.getState().mode).toBe('diff');
    expect(requests.some(({ command }) => command.type === 'workspaceRefresh')).toBe(false);
  });

  it('loads branch-to-working-tree differences without changing the commit-panel tab', async () => {
    const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'branchWorkingDiff') return { path: '/tmp/repo', baseRef: command.payload.base_ref, currentRef: 'main', files: [{ path: 'src/file.ts', status: 'M', added: 1, removed: 1 }] };
      return [];
    });
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    useAppStore.setState({ bridge, bootstrap: { ...bootstrap, state: { ...bootstrap.state, activeTab: 'stash' } }, snapshot: workspace, selectedRepoId: 'repo' });

    await useAppStore.getState().loadBranchWorkingDiff('repo', 'refs/remotes/origin/feature');

    expect(commands[0]).toEqual({ type: 'branchWorkingDiff', payload: { workspace_id: 'workspace', repo_id: 'repo', base_ref: 'refs/remotes/origin/feature' } });
    expect(useAppStore.getState().bootstrap?.state.activeTab).toBe('stash');
    expect(useAppStore.getState().worktreeDiff).toMatchObject({ repoId: 'repo', source: 'repository', currentRef: 'main' });
  });

  it('aggregates history from every repository without losing repository scope', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('a', 'Alpha'), repository('b', 'Beta')];
    const bridge = new MockBridge((command) => {
      if (command.type === 'history') return { commits: [{ repoId: command.payload.repo_id, hash: command.payload.repo_id, shortHash: command.payload.repo_id, parents: [], author: 'Ada', email: '', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: command.payload.repo_id, refs: [] }], hasMore: false };
      if (command.type === 'historyTopology') return [{ repoId: command.payload.repo_id, hash: `${command.payload.repo_id}-root`, parents: [], committerDate: '2025-01-01T00:00:00Z', refs: [] }];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'a' });
    await useAppStore.getState().loadHistory(true);
    expect(useAppStore.getState().history.map((commit) => commit.repoId).sort()).toEqual(['a', 'b']);
    expect(Object.keys(useAppStore.getState().historyByRepo)).toEqual(['a', 'b']);
    expect(useAppStore.getState().historyTopology.map((commit) => commit.repoId).sort()).toEqual(['a', 'b']);
  });

  it('applies the 100-commit page boundary after interleaving repositories', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('a', 'Alpha'), repository('b', 'Beta')];
    const make = (repoId: string, index: number): CommitNode => ({
      repoId, hash: `${repoId}-${index}`, shortHash: `${repoId}-${index}`, parents: [], author: 'Ada', email: '',
      authorDate: new Date(Date.UTC(2026, 0, 1, 0, 0, 200 - index * 2 - (repoId === 'b' ? 1 : 0))).toISOString(),
      committerDate: new Date(Date.UTC(2026, 0, 1, 0, 0, 200 - index * 2 - (repoId === 'b' ? 1 : 0))).toISOString(),
      message: `${repoId}-${index}`, refs: [],
    });
    const histories = { a: Array.from({ length: 80 }, (_, index) => make('a', index)), b: Array.from({ length: 80 }, (_, index) => make('b', index)) };
    const limits: number[] = [];
    const bridge = new MockBridge((command) => {
      if (command.type === 'history') {
        limits.push(command.payload.limit);
        const commits = histories[command.payload.repo_id as keyof typeof histories].slice(0, command.payload.limit);
        return { commits, hasMore: commits.length < histories[command.payload.repo_id as keyof typeof histories].length };
      }
      if (command.type === 'historyTopology') return [];
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'a' });
    await useAppStore.getState().loadHistory(true);
    expect(limits).toEqual([100, 100]);
    expect(useAppStore.getState().history).toHaveLength(100);
    expect(useAppStore.getState().historyHasMore).toBe(true);
    await useAppStore.getState().loadHistory(false);
    expect(limits).toEqual([100, 100, 200, 200]);
    expect(useAppStore.getState().history).toHaveLength(160);
  });

  it('selects the first history commit and loads its detail when opening a repository', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('repo', 'Repository')];
    const commit: CommitNode = { repoId: 'repo', hash: 'first', shortHash: 'first', parents: [], author: 'Ada', email: 'ada@example.test', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'first commit', refs: [] };
    const detail: CommitDetail = { commit, fullMessage: commit.message, branches: { local: ['main'], remote: [], tags: [] }, files: [{ path: 'README.md', status: 'M', added: 1, removed: 0 }] };
    const bridge = new MockBridge((command) => {
      if (command.type === 'history') return { commits: [commit], hasMore: false };
      if (command.type === 'commitDetail') return detail;
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace });

    await useAppStore.getState().selectRepo('repo', true);

    expect(useAppStore.getState().selectedCommits).toEqual([commit]);
    expect(useAppStore.getState().selectedCommit).toEqual(detail);
  });

  it('interleaves repository heads without breaking each repository order', () => {
    const make = (repoId: string, hash: string, date: string): CommitNode => ({
      repoId, hash, shortHash: hash, parents: [], author: 'Ada', email: '', authorDate: date, committerDate: date, message: hash, refs: [],
    });
    const result = interleaveHistory({
      a: [make('a', 'a-new', '2026-01-01T10:00:00Z'), make('a', 'a-old', '2026-01-01T08:00:00Z')],
      b: [make('b', 'b-new', '2026-01-01T09:00:00Z'), make('b', 'b-old', '2026-01-01T07:00:00Z')],
    });
    expect(result.map((commit) => commit.hash)).toEqual(['a-new', 'b-new', 'a-old', 'b-old']);
  });

  it('uses a stable JetBrains-compatible tie break for equal commit timestamps', () => {
    const make = (repoId: string, hash: string): CommitNode => ({
      repoId, hash, shortHash: hash, parents: [], author: 'Ada', email: '', authorDate: '2026-01-01T10:00:00Z', committerDate: '2026-01-01T10:00:00Z', message: hash, refs: [],
    });
    const historyByRepo = { a: [make('a', 'aaaaaaaa')], b: [make('b', 'bbbbbbbb')] };
    expect(interleaveHistory(historyByRepo).map((commit) => commit.hash)).toEqual(
      interleaveHistory({ b: historyByRepo.b, a: historyByRepo.a }).map((commit) => commit.hash),
    );
  });

  it('loads a branch revision from the backend so its ancestor chain stays connected', async () => {
    const workspace = snapshot('workspace', 1);
    workspace.repositories = [repository('a', 'Alpha'), repository('b', 'Beta')];
    const commands: BridgeCommand[] = [];
    const commits: CommitNode[] = [
      { repoId: 'a', hash: 'feature', shortHash: 'feature', parents: ['root'], author: 'Ada', email: '', authorDate: '2026-01-02T00:00:00Z', committerDate: '2026-01-02T00:00:00Z', message: 'feature', refs: ['refs/heads/feature/x'] },
      { repoId: 'a', hash: 'root', shortHash: 'root', parents: [], author: 'Ada', email: '', authorDate: '2026-01-01T00:00:00Z', committerDate: '2026-01-01T00:00:00Z', message: 'root', refs: [] },
    ];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'history') return { commits, hasMore: false };
      if (command.type === 'historyTopology') return commits.map(({ repoId, hash, parents, committerDate, refs }) => ({ repoId, hash, parents, committerDate, refs }));
      return [];
    });
    useAppStore.setState({ bridge, bootstrap, snapshot: workspace, selectedRepoId: 'a', historyScope: { repoIds: ['a'], revisionsByRepo: { a: 'refs/heads/feature/x' } } });
    await useAppStore.getState().loadHistory(true);
    expect(commands.find((command) => command.type === 'history')).toMatchObject({ type: 'history', payload: { repo_id: 'a', revision: 'refs/heads/feature/x' } });
    expect(commands.some((command) => command.type === 'history' && command.payload.repo_id === 'b')).toBe(false);
    expect(useAppStore.getState().history.map((commit) => commit.hash)).toEqual(['feature', 'root']);
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

  it('manages multiple workspace tabs with session state isolation, switching, and closing', async () => {
    const ws1 = snapshot('ws-1', 1);
    ws1.repositories = [repository('repo-1', 'Project 1')];
    const ws2 = snapshot('ws-2', 1);
    ws2.repositories = [repository('repo-2', 'Project 2')];

    const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'workspaceOpen') {
        return command.payload.paths[0] === '/tmp/ws-1' ? ws1 : ws2;
      }
      if (command.type === 'workspaceRefresh') {
        return command.payload.workspace_id === 'ws-1' ? ws1 : ws2;
      }
      if (command.type === 'history') return { commits: [], hasMore: false };
      if (command.type === 'branches') return [];
      if (command.type === 'tags') return [];
      if (command.type === 'conflicts') return [];
      return [];
    });

    useAppStore.setState({ bridge, bootstrap });

    // 1. 打开第一个工作区
    await useAppStore.getState().openWorkspace(['/tmp/ws-1']);
    expect(useAppStore.getState().tabs.length).toBe(1);
    expect(useAppStore.getState().activeTabId).toBe('ws-1');
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('ws-1');

    // 修改第一个工作区的状态（如历史筛选器）
    useAppStore.getState().setHistoryFilter('filter-1');
    expect(useAppStore.getState().historyFilter).toBe('filter-1');

    // 2. 打开第二个工作区
    await useAppStore.getState().openWorkspace(['/tmp/ws-2']);
    expect(useAppStore.getState().tabs.length).toBe(2);
    expect(useAppStore.getState().activeTabId).toBe('ws-2');
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('ws-2');
    expect(useAppStore.getState().historyFilter).toBe('');

    // 3. 再次尝试打开 ws-1 路径，应该直接聚焦并恢复状态而不会产生重复 Tab
    await useAppStore.getState().openWorkspace(['/tmp/ws-1']);
    expect(useAppStore.getState().tabs.length).toBe(2);
    expect(useAppStore.getState().activeTabId).toBe('ws-1');
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('ws-1');
    expect(useAppStore.getState().historyFilter).toBe('filter-1');

    // 4. 测试 reorderTabs
    useAppStore.getState().reorderTabs(0, 1);
    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(['ws-2', 'ws-1']);

    // 5. 关闭当前激活的 ws-1 标签页，应自动切换激活剩余的 ws-2
    await useAppStore.getState().closeTab('ws-1');
    expect(useAppStore.getState().tabs.length).toBe(1);
    expect(useAppStore.getState().activeTabId).toBe('ws-2');
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('ws-2');

    // 6. 关闭最后一个标签页，应清空工作区回到欢迎页
    await useAppStore.getState().closeTab('ws-2');
    expect(useAppStore.getState().tabs.length).toBe(0);
    expect(useAppStore.getState().activeTabId).toBeNull();
    expect(useAppStore.getState().snapshot).toBeUndefined();
  });

  it('opens to the welcome chooser without restoring previous workspace tabs on startup', async () => {
    const savedWorkspace = snapshot('saved', 1).workspace;
    const secondarySyncs: Array<{ paths: string[][]; activeId: string | null }> = [];
    class StartupBridge extends MockBridge {
      override async syncWindowTabs(paths: string[][], activeId: string | null): Promise<void> {
        secondarySyncs.push({ paths, activeId });
      }
    }
    const bridge = new StartupBridge(() => []);
    useAppStore.setState({
      bridge,
      bootstrap: {
        ...bootstrap,
        state: {
          ...bootstrap.state,
          recentWorkspaces: [savedWorkspace],
          openWorkspaceIds: [savedWorkspace.id],
          activeWorkspaceId: savedWorkspace.id,
        },
      },
    });

    await useAppStore.getState().restoreTabsOnStartup();

    expect(useAppStore.getState().tabs).toEqual([]);
    expect(useAppStore.getState().snapshot).toBeUndefined();
    expect(secondarySyncs).toEqual([{ paths: [], activeId: null }]);
  });

  it('can force an explicit new window to open a workspace already registered elsewhere', async () => {
    const target = snapshot('forced', 1);
    let crossWindowFocusCalls = 0;
    class ExplicitWindowBridge extends MockBridge {
      override async focusWorkspaceAcrossWindows(): Promise<boolean> {
        crossWindowFocusCalls += 1;
        return true;
      }
    }
    const bridge = new ExplicitWindowBridge((command) => command.type === 'workspaceOpen' ? target : []);
    useAppStore.setState({ bridge, bootstrap });

    const opened = await useAppStore.getState().openWorkspace(target.workspace.paths, true, { skipCrossWindowFocus: true });

    expect(opened).toBe(true);
    expect(crossWindowFocusCalls).toBe(0);
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(['forced']);
  });

  it('does not throw or set error when refreshing with no open workspace', async () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({ bridge, bootstrap, snapshot: undefined, error: undefined });

    await expect(useAppStore.getState().refresh(true)).resolves.toBeUndefined();
    await expect(useAppStore.getState().refresh(false)).resolves.toBeUndefined();

    expect(useAppStore.getState().error).toBeUndefined();
  });

  it('ignores background watcher events and cleans startup errors when no workspace is open', async () => {
    let subscriber: ((event: BridgeEvent) => void) | undefined;
    const bridge = new MockBridge((command) => {
      if (command.type === 'bootstrap') {
        return {
          ...bootstrap,
          state: {
            ...bootstrap.state,
            openWorkspaceIds: [],
            activeWorkspaceId: null,
            lastWorkspaceId: null,
          },
        };
      }
      return [];
    });
    bridge.subscribe = (handler) => {
      subscriber = handler;
      return () => undefined;
    };

    await useAppStore.getState().initialize(bridge);

    expect(useAppStore.getState().snapshot).toBeUndefined();
    expect(useAppStore.getState().error).toBeUndefined();

    // 发送其他工作区的事件，不应触发错误
    subscriber?.({
      workspaceId: 'other-workspace',
      repoId: 'repo',
      generation: 1,
      source: 'watcher',
      scopes: ['status'],
    });
    expect(useAppStore.getState().error).toBeUndefined();
  });

  it('keeps watcher status requests and their operation events in the background', async () => {
    vi.useFakeTimers();
    try {
      let subscriber: ((event: BridgeEvent) => void) | undefined;
      const requests: Array<{ command: BridgeCommand; options?: RequestOptions }> = [];
      const updated = { ...repository('repo', 'Repository'), revision: 'updated' };
      const bridge = new MockBridge((command, options) => {
        requests.push({ command, options });
        if (command.type === 'bootstrap') return { ...bootstrap, state: { ...bootstrap.state, openWorkspaceIds: [], activeWorkspaceId: null, lastWorkspaceId: null } };
        if (command.type === 'repositoryStatus') return updated;
        return [];
      });
      bridge.subscribe = (handler) => {
        subscriber = handler;
        return () => undefined;
      };
      await useAppStore.getState().initialize(bridge);
      const current = snapshot('workspace', 1);
      current.repositories = [repository('repo', 'Repository')];
      useAppStore.setState({ snapshot: current, allRepositories: current.repositories, selectedRepoId: 'repo', mode: 'diff' });

      subscriber?.({
        operationId: 'background-status',
        context: { generation: 1, domain: 'status', visibility: 'background', workspaceId: 'workspace', repositoryId: 'repo', target: null },
        status: 'running', phase: 'status', message: '', startedAt: '', cancellable: true, completed: null, total: null, result: null, error: null,
      });
      subscriber?.({ workspaceId: 'workspace', repoId: 'repo', generation: 1, source: 'watcher', scopes: ['status'] });
      await vi.advanceTimersByTimeAsync(301);

      expect(useAppStore.getState().operations).not.toHaveProperty('background-status');
      expect(useAppStore.getState().mode).toBe('diff');
      expect(useAppStore.getState().snapshot?.repositories[0].revision).toBe('updated');
      expect(requests.find(({ command }) => command.type === 'repositoryStatus')?.options?.showProgress).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes history, unpushed commits, and conflicts only for the event repository', async () => {
    vi.useFakeTimers();
    try {
      let subscriber: ((event: BridgeEvent) => void) | undefined;
      const requests: BridgeCommand[] = [];
      const commit: CommitNode = {
        repoId: 'a', hash: 'new-a', shortHash: 'new-a', parents: [], author: 'A', email: '',
        authorDate: '2026-08-30T00:00:00Z', committerDate: '2026-08-30T00:00:00Z',
        message: 'updated A', refs: [], incoming: false, unpushed: true,
      };
      const bridge = new MockBridge((command) => {
        requests.push(command);
        if (command.type === 'bootstrap') return bootstrap;
        if (command.type === 'branches' || command.type === 'tags' || command.type === 'historyTopology' || command.type === 'unpushedCommits') return [];
        if (command.type === 'history') return { commits: [commit], hasMore: false };
        if (command.type === 'conflicts') return [{ repoId: 'a', repoName: 'A', repoColor: '#000', path: 'conflict.txt', kind: 'git', binary: false, conflictType: 'text', actions: ['mine'] }];
        return [];
      });
      bridge.subscribe = (handler) => { subscriber = handler; return () => undefined; };
      await useAppStore.getState().initialize(bridge);
      const current = snapshot('workspace', 1);
      current.repositories = [repository('a', 'A'), repository('b', 'B')];
      useAppStore.setState({
        snapshot: current,
        allRepositories: current.repositories,
        selectedRepoId: 'a',
        historyByRepo: { a: [], b: [] },
        historyTopologyByRepo: { a: [], b: [] },
        historyScope: { repoIds: null, revisionsByRepo: {} },
      });
      requests.length = 0;

      subscriber?.({ workspaceId: 'workspace', repoId: 'a', generation: 1, source: 'watcher', scopes: ['refs', 'history', 'conflicts'] });
      await vi.advanceTimersByTimeAsync(301);
      await Promise.resolve();
      await Promise.resolve();

      expect(requests.filter((command) => command.type === 'history').map((command) => command.payload.repo_id)).toEqual(['a']);
      expect(requests.some((command) => command.type === 'unpushedCommits' && command.payload.repo_id === 'a')).toBe(true);
      expect(requests.some((command) => command.type === 'conflicts' && command.payload.repo_id === 'a')).toBe(true);
      expect(useAppStore.getState().historyByRepo.a?.[0]?.hash).toBe('new-a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes runtime capabilities without replacing workspace state', async () => {
    const bridge = new MockBridge((command) => command.type === 'runtimeCapabilities' ? {
      systemNotifications: { available: false, reasonCode: 'NOTIFICATION_PERMISSION_DENIED', detail: 'Denied' },
      notificationPermission: 'denied',
      secureCredentials: { status: { available: true, reasonCode: null, detail: null }, backend: 'test', passwordStdinSupported: true },
    } : []);
    const currentSnapshot = snapshot('workspace', 1);
    useAppStore.setState({ bridge, bootstrap, snapshot: currentSnapshot });

    await useAppStore.getState().refreshRuntimeCapabilities();

    expect(useAppStore.getState().snapshot).toBe(currentSnapshot);
    expect(useAppStore.getState().bootstrap?.runtime?.notificationPermission).toBe('denied');
    expect(useAppStore.getState().bootstrap?.capabilities.systemNotifications).toBe(false);
  });
});
