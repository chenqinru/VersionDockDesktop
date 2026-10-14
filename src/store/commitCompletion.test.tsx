import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryOperationResult, RepositoryStatus, SyncResult, WorkspaceSnapshot } from '../bindings/generated';
import { CommitPanel } from '../components/CommitPanel';
import { BranchStatusBarItem } from '../components/StatusBar/BranchStatusBarItem';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from './appStore';

const initial = useAppStore.getState();
const repo = (id: string, kind: 'git' | 'svn' = 'git'): RepositoryStatus => ({
  meta: { id, name: id, kind, rootPath: `/tmp/${id}`, color: '#888', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch: 'main', revision: 'before', ahead: 0, behind: 0, conflicts: 0, operation: null,
  files: [{ path: `${id}.ts`, status: 'modified', staged: false, unstaged: true, conflicted: false }],
});
const workspace = (id: string, repositories: RepositoryStatus[]): WorkspaceSnapshot => ({
  workspace: { id, name: id, paths: [`/tmp/${id}`], lastOpenedAt: '', available: true }, repositories,
  generation: 1, tools: { git: true, svn: true, svnadmin: true },
});
const target = (r: RepositoryStatus) => ({ repoId: r.meta.id, paths: r.files.map(f => f.path), unstagePaths: [], amend: false });
const result = (r: RepositoryStatus, committed = true): RepositoryOperationResult => ({
  repoId: r.meta.id, commitAttempted: true, committed, revision: committed ? 'after' : null,
  pushAttempted: false, pushed: false, failedStage: committed ? null : 'commit', recoveryHint: null, error: null,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
function setup(bridge: MockBridge, repositories: RepositoryStatus[]) {
  useAppStore.setState({ ...initial, bridge, snapshot: workspace('ws', repositories), allRepositories: repositories,
    selectedRepoId: repositories[0].meta.id, commitSelections: Object.fromEntries(repositories.map(r => [r.meta.id, r.files.map(f => f.path)])) }, true);
}
afterEach(() => { cleanup(); useAppStore.getState().dispose(); useAppStore.setState(initial, true); });

describe('commit completion parity', () => {
  it.each(['fetch', 'push'] as const)('spins throughout manual %s and stays scoped to its workspace', async action => {
    const first = repo('first');
    const gate = deferred<SyncResult>();
    const bridge = new MockBridge(command => command.type === 'sync' ? gate.promise : []);
    setup(bridge, [first]);
    const { container } = render(<BranchStatusBarItem />);
    let pending!: ReturnType<typeof initial.sync>;
    act(() => { pending = useAppStore.getState().sync('first', action, true); });
    expect(container.querySelector('.branch-status-item .codicon-loading')).toBeInTheDocument();
    act(() => useAppStore.setState({ snapshot: workspace('other', [first]) }));
    expect(container.querySelector('.branch-status-item .codicon-loading')).not.toBeInTheDocument();
    act(() => useAppStore.setState({ snapshot: workspace('ws', [first]) }));
    expect(container.querySelector('.branch-status-item .codicon-loading')).toBeInTheDocument();
    await act(async () => { gate.resolve({ output: '', update: null }); await pending; });
    expect(container.querySelector('.branch-status-item .codicon-loading')).not.toBeInTheDocument();
  });

  it('keeps automatic fetch quiet while a concurrent manual fetch still spins', async () => {
    const first = repo('first');
    const automatic = deferred<SyncResult>(), manual = deferred<SyncResult>();
    let calls = 0;
    const bridge = new MockBridge(command => command.type === 'sync' ? (++calls === 1 ? automatic.promise : manual.promise) : []);
    setup(bridge, [first]);
    const { container } = render(<BranchStatusBarItem />);
    let background!: ReturnType<typeof initial.sync>, foreground!: ReturnType<typeof initial.sync>;
    act(() => { background = useAppStore.getState().sync('first', 'fetch', false); });
    expect(container.querySelector('.branch-status-item .codicon-loading')).not.toBeInTheDocument();
    act(() => { foreground = useAppStore.getState().sync('first', 'fetch', true); });
    expect(container.querySelector('.branch-status-item .codicon-loading')).toBeInTheDocument();
    await act(async () => { automatic.resolve({ output: '', update: null }); await background; });
    expect(container.querySelector('.branch-status-item .codicon-loading')).toBeInTheDocument();
    await act(async () => { manual.resolve({ output: '', update: null }); await foreground; });
    expect(container.querySelector('.branch-status-item .codicon-loading')).not.toBeInTheDocument();
  });

  it.each([false, true])('settles sync loading after failure (cancelled=%s)', async cancelled => {
    const gate = deferred<SyncResult>();
    const bridge = new MockBridge(command => command.type === 'sync' ? gate.promise : []);
    setup(bridge, [repo('first')]);
    const { container } = render(<BranchStatusBarItem />);
    let pending!: ReturnType<typeof initial.sync>;
    act(() => { pending = useAppStore.getState().sync('first', 'push'); });
    expect(container.querySelector('.branch-status-item .codicon-loading')).toBeInTheDocument();
    await act(async () => { gate.reject(cancelled ? new DOMException('Cancelled', 'AbortError') : new Error('Network failed')); await pending; });
    expect(container.querySelector('.branch-status-item .codicon-loading')).not.toBeInTheDocument();
  });

  it.each(['git', 'svn'] as const)('keeps %s files checked until refreshed files are published and spins throughout a batch', async kind => {
    const first = repo('first', kind), second = repo('second', kind);
    const commit = deferred<RepositoryOperationResult[]>(), status = deferred<RepositoryStatus>();
    const bridge = new MockBridge(command => {
      if (command.type === 'batchCommit') return commit.promise;
      if (command.type === 'repositoryStatus') return command.payload.repo_id === 'first' ? status.promise : { ...second, files: [] };
      return [];
    });
    setup(bridge, [first, second]);
    const { container } = render(<BridgeContext.Provider value={bridge}><CommitPanel /><BranchStatusBarItem /></BridgeContext.Provider>);
    let pending!: ReturnType<typeof initial.commitMany>;
    act(() => { pending = useAppStore.getState().commitMany([target(first), target(second)], 'message', false); });
    expect(container.querySelector('.branch-status-item .codicon-loading')).toBeInTheDocument();
    expect(screen.getByLabelText('first.ts')).toBeChecked();
    await act(async () => { commit.resolve([result(first), result(second)]); });
    expect(screen.getByLabelText('first.ts')).toBeChecked();
    expect(container.querySelector('.branch-status-item .codicon-loading')).toBeInTheDocument();
    await act(async () => { status.resolve({ ...first, files: [], revision: 'after' }); await pending; });
    expect(screen.queryByLabelText('first.ts')).not.toBeInTheDocument();
    expect(useAppStore.getState().commitSelections).toEqual({});
    expect(container.querySelector('.branch-status-item .codicon-loading')).not.toBeInTheDocument();
  });

  it('preserves selected remaining changes and failed repositories after partial success', async () => {
    const first = repo('first'), second = repo('second');
    const bridge = new MockBridge(command => command.type === 'batchCommit' ? [result(first), result(second, false)] : command.type === 'repositoryStatus' ? { ...first, revision: 'after' } : []);
    setup(bridge, [first, second]);
    await useAppStore.getState().commitMany([target(first), target(second)], 'message', false);
    expect(useAppStore.getState().commitSelections).toEqual({ first: ['first.ts'], second: ['second.ts'] });
    expect(useAppStore.getState().snapshot?.repositories[0].revision).toBe('after');
    expect(useAppStore.getState().snapshot?.repositories[1]).toBe(second);
  });

  it.each(['active', 'background', 'edited', 'partial', 'failed'] as const)('handles commit success separately from push failure (%s)', async scenario => {
    const first = { ...repo('first'), ahead: 2 }, second = { ...repo('second'), ahead: 2 };
    const gate = deferred<RepositoryOperationResult[]>();
    const bridge = new MockBridge(command => {
      if (command.type === 'batchCommit') return gate.promise;
      if (command.type === 'repositoryStatus') return { ...first, revision: 'after' };
      return [];
    });
    setup(bridge, scenario === 'partial' ? [first, second] : [first]);
    useAppStore.setState({ commitMessage: 'submitted', amendRepoIds: scenario === 'partial' ? ['first', 'second'] : ['first'] });
    render(<BridgeContext.Provider value={bridge}><CommitPanel /></BridgeContext.Provider>);
    fireEvent.click(screen.getByTitle('Commit options'));
    fireEvent.click(screen.getByRole('button', { name: 'Commit & Push' }));
    await waitFor(() => expect(Object.values(useAppStore.getState().operations).some(op => op.context.domain === 'commit')).toBe(true));
    if (scenario === 'background') {
      const source = { ...useAppStore.getState(), snapshot: workspace('ws', [first]) };
      act(() => useAppStore.setState({ snapshot: workspace('other', [second]), allRepositories: [second], commitSelections: { second: ['second.ts'] }, commitMessage: 'other draft', amendRepoIds: ['second'], sessions: { ws: source } }));
    } else if (scenario === 'edited') {
      fireEvent.change(screen.getByPlaceholderText(/Commit message/), { target: { value: 'new draft' } });
    }
    const pushFailure: RepositoryOperationResult = { ...result(first), pushAttempted: true, failedStage: 'push', error: { code: 'PUSH_FAILED', message: 'Remote rejected', command: null, exitCode: 1, stderr: null, recoverable: true } };
    await act(async () => { gate.resolve(scenario === 'failed' ? [result(first, false)] : scenario === 'partial' ? [pushFailure, result(second, false)] : [pushFailure]); });
    await waitFor(() => expect(useAppStore.getState().operations).toEqual({}));
    const state = useAppStore.getState();
    const source = scenario === 'background' ? state.sessions.ws : state;
    expect(source.commitMessage).toBe(scenario === 'edited' ? 'new draft' : scenario === 'failed' ? 'submitted' : '');
    expect(source.amendRepoIds).toEqual(scenario === 'partial' ? ['second'] : scenario === 'failed' ? ['first'] : []);
    expect(source.batchCommitReport).toBeDefined();
    if (scenario === 'background') {
      expect(state.commitMessage).toBe('other draft');
      expect(state.amendRepoIds).toEqual(['second']);
    }
  });

  it('publishes to the origin session after switching workspaces during status refresh', async () => {
    const first = repo('first'), other = repo('other');
    const status = deferred<RepositoryStatus>();
    const bridge = new MockBridge(command => command.type === 'batchCommit' ? [result(first)] : command.type === 'repositoryStatus' ? status.promise : []);
    setup(bridge, [first]);
    const pending = useAppStore.getState().commitMany([target(first)], 'message', false);
    await vi.waitFor(() => expect(useAppStore.getState().batchCommitReport).toBeDefined());
    const source = { ...useAppStore.getState(), snapshot: workspace('ws', [first]) };
    useAppStore.setState({ snapshot: workspace('other', [other]), allRepositories: [other], commitSelections: { other: ['other.ts'] }, sessions: { ws: source } });
    status.resolve({ ...first, files: [] }); await pending;
    expect(useAppStore.getState().commitSelections).toEqual({ other: ['other.ts'] });
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('other');
    expect(useAppStore.getState().sessions.ws.commitSelections).toEqual({});
    expect(useAppStore.getState().sessions.ws.snapshot.repositories[0].files).toEqual([]);
  });

  it.each(['commit', 'status'] as const)('preserves files and selection and settles loading when %s fails', async failure => {
    const first = repo('first');
    const bridge = new MockBridge(command => {
      if (command.type === (failure === 'commit' ? 'batchCommit' : 'repositoryStatus')) throw new Error('Failed');
      return command.type === 'batchCommit' ? [result(first)] : [];
    });
    setup(bridge, [first]);
    await useAppStore.getState().commitMany([target(first)], 'message', false);
    expect(useAppStore.getState().snapshot?.repositories[0]).toBe(first);
    expect(useAppStore.getState().commitSelections).toEqual({ first: ['first.ts'] });
    expect(useAppStore.getState().operations).toEqual({});
  });
});
