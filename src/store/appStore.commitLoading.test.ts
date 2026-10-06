import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapData, CommitBranches, CommitDetail, CommitNode, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import { commitKey } from '../history/commitDetails';
import { useAppStore } from './appStore';

const initial = useAppStore.getState();
const repo: RepositoryStatus = { meta: { id: 'repo', name: 'Repo', rootPath: '/tmp/test', kind: 'git', color: '#888', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'first', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null };
const snapshot: WorkspaceSnapshot = { workspace: { id: 'workspace', name: 'Workspace', paths: ['/tmp/test'], available: true, lastOpenedAt: '' }, repositories: [repo], tools: { git: true, svn: true, svnadmin: true }, generation: 1 };
const bootstrap: BootstrapData = { applicationSessionId: 'test', state: { recentWorkspaces: [], activeTab: 'changes', panelSizes: { commit: 360, branches: 220, detail: 360 }, fileViewMode: 'tree', lastWorkspaceId: null }, tools: snapshot.tools, capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, submodule: false, compare: false, remoteManagement: false } };
const commit = (hash: string): CommitNode => ({ repoId: 'repo', hash, shortHash: hash, parents: [], author: 'Ada', email: '', authorDate: '2026-10-06T00:00:00Z', committerDate: '2026-10-06T00:00:00Z', message: hash, refs: [] });
const detail = (node: CommitNode, path = 'app.ts'): CommitDetail => ({ commit: node, fullMessage: node.message, files: [{ path, status: 'M', added: 1, removed: 0 }], branches: { local: [], remote: [], tags: [] }, branchesPending: true, mergeParentChanges: [] });
const branches: CommitBranches = { local: ['main', 'release'], remote: ['origin/main'], tags: ['v1'], isHead: true };
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function setup(bridge: MockBridge) { useAppStore.setState({ ...initial, bridge, bootstrap, snapshot, allRepositories: [repo], selectedRepoId: 'repo', activeTabId: 'workspace', tabs: [snapshot.workspace] }, true); }
afterEach(() => { useAppStore.getState().dispose(); useAppStore.setState(initial, true); });

describe('first visible commit loading', () => {
  it('shows selected files before refs, topology and containing branches finish', async () => {
    const refs = gate<[]>(), topology = gate<[]>(), metadata = gate<CommitBranches>();
    const node = commit('first');
    const bridge = new MockBridge(command => {
      if (command.type === 'history') return { commits: [node], hasMore: false };
      if (command.type === 'branches' || command.type === 'tags') return refs.promise;
      if (command.type === 'historyTopology') return topology.promise;
      if (command.type === 'commitDetail') return detail(node);
      if (command.type === 'commitBranches') return metadata.promise;
      return [];
    });
    setup(bridge);
    const opening = useAppStore.getState().selectRepo('repo', true);
    try {
      await vi.waitFor(() => expect(useAppStore.getState().selectedCommit?.files[0].path).toBe('app.ts'));
      expect(useAppStore.getState().branchesLoading).toBe(true);
      expect(useAppStore.getState().historyTopologyLoading).toBe(true);
      expect(useAppStore.getState().selectedCommitLoading).toEqual({});
      expect(useAppStore.getState().selectedCommit?.branchesPending).toBe(true);
      metadata.resolve(branches);
      await vi.waitFor(() => expect(useAppStore.getState().selectedCommit?.branches.local).toContain('release'));
      expect(useAppStore.getState().selectedCommit?.files[0].path).toBe('app.ts');
      expect(useAppStore.getState().selectedCommit?.branchesPending).toBe(false);
    } finally { refs.resolve([]); topology.resolve([]); metadata.resolve(branches); await opening; }
  });

  it('keeps a manual selection when startup topology and the first detail complete later', async () => {
    const topology = gate<[]>(), firstDetail = gate<CommitDetail>();
    const first = commit('first'), second = commit('second');
    const bridge = new MockBridge(command => {
      if (command.type === 'history') return { commits: [first, second], hasMore: false };
      if (command.type === 'historyTopology') return topology.promise;
      if (command.type === 'commitDetail') return command.payload.revision === 'first' ? firstDetail.promise : detail(second, 'second.ts');
      if (command.type === 'commitBranches') return branches;
      return [];
    });
    setup(bridge);
    const loading = useAppStore.getState().loadHistory(true);
    try {
      await vi.waitFor(() => expect(useAppStore.getState().selectedCommits[0]?.hash).toBe('first'));
      await useAppStore.getState().selectCommit(second);
      firstDetail.resolve(detail(first));
      topology.resolve([]);
      await loading;
      expect(useAppStore.getState().selectedPrimaryKey).toBe(commitKey('repo', 'second'));
      expect(useAppStore.getState().selectedCommit?.files[0].path).toBe('second.ts');
    } finally { firstDetail.resolve(detail(first)); topology.resolve([]); await loading; }
  });

  it('retains files after metadata failure and retries only metadata on the next visit', async () => {
    const node = commit('first');
    let fileCalls = 0, branchCalls = 0;
    const bridge = new MockBridge(command => {
      if (command.type === 'commitDetail') { fileCalls++; return detail(node); }
      if (command.type === 'commitBranches') { if (++branchCalls === 1) throw new Error('refs unavailable'); return branches; }
      return [];
    });
    setup(bridge);
    await useAppStore.getState().selectCommit(node);
    expect(useAppStore.getState().selectedCommit?.files[0].path).toBe('app.ts');
    expect(useAppStore.getState().selectedCommitError).toEqual({});
    expect(useAppStore.getState().notifications).toEqual([]);
    await useAppStore.getState().loadCommitDetail(node);
    await vi.waitFor(() => expect(useAppStore.getState().selectedCommit?.branchesPending).toBe(false));
    expect(fileCalls).toBe(1);
    expect(branchCalls).toBe(2);
  });

  it('rejects late metadata from a detail replaced by force reload', async () => {
    const oldRefs = gate<CommitBranches>(), newRefs = gate<CommitBranches>();
    const node = commit('first');
    let fileCalls = 0, branchCalls = 0;
    const bridge = new MockBridge(command => {
      if (command.type === 'commitDetail') return detail(node, ++fileCalls === 1 ? 'old.ts' : 'new.ts');
      if (command.type === 'commitBranches') return ++branchCalls === 1 ? oldRefs.promise : newRefs.promise;
      return [];
    });
    setup(bridge);
    await useAppStore.getState().selectCommit(node);
    await useAppStore.getState().loadCommitDetail(node, true);
    oldRefs.resolve({ ...branches, local: ['stale'] });
    newRefs.resolve(branches);
    await vi.waitFor(() => expect(useAppStore.getState().selectedCommit?.branchesPending).toBe(false));
    expect(useAppStore.getState().selectedCommit?.files[0].path).toBe('new.ts');
    expect(useAppStore.getState().selectedCommit?.branches.local).toEqual(branches.local);
  });

  it('never replaces another workspace detail with late metadata', async () => {
    const metadata = gate<CommitBranches>(), node = commit('first');
    const bridge = new MockBridge(command => command.type === 'commitDetail' ? detail(node) : command.type === 'commitBranches' ? metadata.promise : []);
    setup(bridge);
    await useAppStore.getState().selectCommit(node);
    const otherDetail = detail(node, 'other.ts');
    useAppStore.setState({ snapshot: { ...snapshot, workspace: { ...snapshot.workspace, id: 'other' } }, activeTabId: 'other', selectedCommit: otherDetail, selectedCommitDetails: { [commitKey('repo', node.hash)]: otherDetail } });
    metadata.resolve(branches);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useAppStore.getState().selectedCommit).toBe(otherDetail);
    expect(useAppStore.getState().selectedCommitDetails[commitKey('repo', node.hash)]).toBe(otherDetail);
  });
});
