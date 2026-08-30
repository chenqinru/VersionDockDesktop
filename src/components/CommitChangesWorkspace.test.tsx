import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommitChangesWorkspace } from './CommitChangesWorkspace';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';

const repository: RepositoryStatus = { meta: { id: 'repo', name: 'Repository', rootPath: '/tmp/repo', color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc', ahead: 0, behind: 0, conflicts: 0, operation: null, files: [{ path: 'both.txt', status: 'modified', staged: true, unstaged: true, conflicted: false }, { path: 'new.txt', status: 'untracked', staged: false, unstaged: true, conflicted: false }] };
const snapshot: WorkspaceSnapshot = { workspace: { id: 'workspace', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true }, generation: 1, tools: { git: true, svn: true, svnadmin: true }, repositories: [repository] };

afterEach(() => { cleanup(); useAppStore.setState({ bridge: undefined, snapshot: undefined, changes: undefined, changesDiff: undefined, mode: 'history' }); });

describe('working tree changes workspace', () => {
  it('groups staged, unstaged, and untracked entries and requests the correct diff side', async () => {
    const requests: boolean[] = [];
    const bridge = new MockBridge((command) => {
      if (command.type === 'fileDiff') { requests.push(command.payload.staged); return { path: command.payload.relative_path, content: 'diff', language: 'text', binary: false, truncated: false, lineCount: 1 }; }
      return true;
    });
    useAppStore.setState({ bridge, snapshot, allRepositories: [repository], selectedRepoId: 'repo' });
    useAppStore.getState().openWorkingChanges('repo');
    render(<CommitChangesWorkspace />);
    expect(screen.getByText('Staged Changes')).toBeInTheDocument();
    expect(screen.getByText('Unstaged Changes')).toBeInTheDocument();
    expect(screen.getByText('Untracked Files')).toBeInTheDocument();
    await waitFor(() => expect(requests[0]).toBe(true));
    fireEvent.click(screen.getAllByText('both.txt')[1]);
    await waitFor(() => expect(requests).toContain(false));
  });
});
