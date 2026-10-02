import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand, CommitNode, RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { CommitChangesWorkspace } from './CommitChangesWorkspace';
import { buildCommitFileTargets, commitKey } from '../history/commitDetails';

const original = useAppStore.getState();
const repo: RepositoryStatus = { meta: { id: 'repo', name: 'Repo', rootPath: '/tmp/repo', color: '#999', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'a', ahead: 0, behind: 0, conflicts: 0, operation: null, files: [{ path: 'both.txt', status: 'modified', staged: true, unstaged: true, conflicted: false }] };
const snapshot: WorkspaceSnapshot = { workspace: { id: 'qa', name: 'QA', paths: ['/tmp/repo'], lastOpenedAt: '', available: true }, generation: 1, tools: { git: true, svn: true, svnadmin: true }, repositories: [repo] };
const commit = (hash: string, parents: string[] = []): CommitNode => ({ repoId: 'repo', hash, parents, shortHash: hash, message: hash, author: 'QA', email: '', authorDate: '', committerDate: '', refs: [] });
const diff = { path: 'both.txt', content: '@@ -7 +8 @@\n-index source\n+working source', language: 'text', truncated: false, binary: false, lineCount: 8 };
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); useAppStore.setState(original, true); });

describe('changes page parity', () => {
  it.each(['staged', 'unstaged', 'svn'] as const)('maps %s selection history through the correct mutable version', async (section) => {
    const commands: BridgeCommand[] = []; const history = vi.fn();
    const bridge = new MockBridge((command) => {
      commands.push(command);
      if (command.type === 'diffLineHistoryTarget') return { path: 'both.txt', revision: 'committed-version', lineRange: { start: 5, end: 5 } };
      return diff;
    });
    const repository = section === 'svn' ? { ...repo, meta: { ...repo.meta, kind: 'svn' as const } } : repo;
    useAppStore.setState({ bridge, snapshot: { ...snapshot, repositories: [repository] }, changesDiffLoading: false, changesDiffTarget: undefined, changesDiffError: undefined, openHistoryForLineRange: history });
    useAppStore.getState().openWorkingChanges('repo', section === 'staged' ? 'staged' : 'unstaged');
    const { container } = render(<BridgeContext.Provider value={bridge}><CommitChangesWorkspace /></BridgeContext.Provider>);
    await waitFor(() => expect(container.querySelector('.diff-code-cell')).not.toBeNull());
    const code = container.querySelector(section === 'staged' ? '.diff-code-cell.new code' : '.diff-code-cell.old code')!;
    fireEvent.contextMenu(code); fireEvent.click(screen.getByRole('menuitem', { name: 'Show Selection History' }));
    await waitFor(() => expect(commands).toContainEqual({ type: 'diffLineHistoryTarget', payload: { workspace_id: 'qa', repo_id: 'repo', relative_path: 'both.txt', source_revision: section === 'svn' ? 'BASE' : 'INDEX', line_range: { start: section === 'staged' ? 8 : 7, end: section === 'staged' ? 8 : 7 } } }));
    expect(history).toHaveBeenCalledWith('repo', 'both.txt', expect.objectContaining({ start: 5, end: 5 }), 'committed-version');
  });
  it('renders a repeated aggregate file once with one selection and the shared range', async () => {
    const commits = [commit('new', ['old']), commit('old', ['base'])];
    const details = Object.fromEntries(commits.map((c) => [commitKey('repo', c.hash), { commit: c, fullMessage: c.message, branches: { local: [], remote: [], tags: [] }, files: [{ path: 'same.txt', status: 'M', added: 1, removed: 1 }] }]));
    const files = buildCommitFileTargets(commits, details, [repo]); const commands: BridgeCommand[] = [];
    const bridge = new MockBridge((command) => { commands.push(command); return { ...diff, path: 'same.txt' }; });
    useAppStore.setState({ bridge, snapshot, changes: { kind: 'commits', commits, files }, changesDiff: undefined, changesDiffTarget: undefined, changesDiffLoading: false, changesDiffError: undefined });
    const { container } = render(<CommitChangesWorkspace />);
    expect(container.querySelectorAll('.changes-file-row')).toHaveLength(1); expect(container.querySelectorAll('.changes-file-row.selected')).toHaveLength(1);
    expect(screen.getByText('Aggregated commit selection')).toBeInTheDocument();
    await waitFor(() => expect(commands).toContainEqual({ type: 'fileDiff', payload: { workspace_id: 'qa', repo_id: 'repo', relative_path: 'same.txt', staged: false, revision: null, from_revision: 'base', to_revision: 'new' } }));
  });
  it('retains the active history file filter when opening selected changes', () => {
    const c = commit('one'); const detail = { commit: c, fullMessage: c.message, branches: { local: [], remote: [], tags: [] }, files: [{ path: 'filtered.txt', status: 'M', added: 1, removed: 1 }, { path: 'unrelated.txt', status: 'M', added: 1, removed: 1 }] };
    useAppStore.setState({ snapshot, selectedCommits: [c], selectedCommitDetails: { [commitKey('repo', 'one')]: detail }, selectedCommitLoading: {}, selectedCommitError: {}, historyQuery: { ...original.historyQuery, text: '', path: 'filtered.txt' } });
    useAppStore.getState().openCommitChanges(); expect(useAppStore.getState().changes?.files.map((file) => file.path)).toEqual(['filtered.txt']);
  });
  it('ignores loading-row clicks and deduplicates direct requests without cancelling the active request', async () => {
    const signals: AbortSignal[] = []; let resolve: (value: unknown) => void = () => undefined;
    const bridge = new MockBridge((_command, options) => { signals.push(options!.signal!); return new Promise((done) => { resolve = done; }); });
    useAppStore.setState({ bridge, snapshot }); useAppStore.getState().openWorkingChanges('repo'); render(<CommitChangesWorkspace />);
    await waitFor(() => expect(signals).toHaveLength(1)); fireEvent.click(screen.getAllByRole('button', { name: 'both.txt' })[0]);
    await useAppStore.getState().loadChangesDiff(useAppStore.getState().changes!.files[0]); expect(signals).toHaveLength(1); expect(signals[0].aborted).toBe(false);
    await act(async () => resolve(diff)); expect(screen.queryByText('Loading diff...')).toBeNull();
  });
  it('provides full file path tooltips and a preview title with the file icon', () => {
    const c = commit('one'); const file = { repoId: 'repo', commitHash: 'one', path: 'very/long/path/with/an/ambiguous/file.ts', status: 'M', added: 1, removed: 1 };
    useAppStore.setState({ snapshot, changes: { kind: 'commits', commits: [c], files: [file] }, changesDiff: undefined, changesDiffLoading: false, loadChangesDiff: vi.fn() });
    const { container } = render(<CommitChangesWorkspace />);
    expect(container.querySelector('.changes-file-name')).toHaveAttribute('title', file.path);
    expect(container.querySelector('.changes-preview-header')).toHaveTextContent(file.path);
    expect(container.querySelector('.changes-preview-header .file-type-icon')).not.toBeNull();
  });
});
