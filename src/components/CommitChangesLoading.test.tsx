import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ThemedToken } from 'shiki/types';
import type { DiffDocument, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { highlightSyntax } from '../utils/syntaxHighlighting';
import { CommitChangesWorkspace } from './CommitChangesWorkspace';

vi.mock('../utils/syntaxHighlighting', () => ({ cachedSyntaxTokens: vi.fn(), highlightSyntax: vi.fn() }));
const initial = useAppStore.getState();
afterEach(() => { cleanup(); useAppStore.getState().dispose(); useAppStore.setState(initial, true); vi.resetAllMocks(); vi.useRealTimers(); });

const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'workspace', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true },
  generation: 1, tools: { git: true, svn: true, svnadmin: true },
  repositories: [{
    meta: { id: 'repo', name: 'Repository', rootPath: '/tmp/repo', color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
    branch: 'main', revision: 'abc', ahead: 0, behind: 0, conflicts: 0, operation: null,
    files: ['first.ts', 'second.ts'].map(path => ({ path, status: 'modified', staged: false, unstaged: true, conflicted: false })),
  }],
};
const document = (path: string): DiffDocument => ({ path, content: '@@ -1 +1 @@\n-' + path + 'Old\n+' + path + 'New', language: 'typescript', binary: false, truncated: false, lineCount: 2 });

function setup() {
  vi.useFakeTimers();
  const reads = new Map<string, (value: DiffDocument) => void>();
  const highlights: { code: string; resolve: (tokens: ThemedToken[][]) => void }[] = [];
  const bridge = new MockBridge(command => command.type === 'fileDiff'
    ? new Promise<DiffDocument>(resolve => reads.set(command.payload.relative_path, resolve)) : true);
  vi.mocked(highlightSyntax).mockImplementation(code => new Promise(resolve => highlights.push({ code, resolve })));
  useAppStore.setState({ bridge, snapshot, allRepositories: snapshot.repositories });
  useAppStore.getState().openWorkingChanges('repo');
  const view = render(<CommitChangesWorkspace />);
  return { ...view, reads, finishHighlight: async () => {
    await act(async () => { highlights.splice(0).forEach(task => task.resolve([[{ content: task.code, color: '#ff0000', offset: 0 }]])); });
  } };
}

it('counts one 150ms interval across file reading and first-screen highlighting', async () => {
  const view = setup();
  act(() => vi.advanceTimersByTime(100));
  await act(async () => view.reads.get('first.ts')!(document('first.ts')));
  expect(view.container.querySelector('.unified-diff-virtual')).not.toBeVisible();
  act(() => vi.advanceTimersByTime(49));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getAllByRole('status')).toHaveLength(1);
  await view.finishHighlight();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(view.container.querySelector('.unified-diff-virtual')).toBeVisible();
  expect(view.container.querySelector('.changes-preview')).toHaveAttribute('aria-busy', 'false');
});

it('keeps an already visible indicator mounted while reading hands over to highlighting', async () => {
  const view = setup();
  act(() => vi.advanceTimersByTime(200));
  const indicator = screen.getByRole('status');
  await act(async () => view.reads.get('first.ts')!(document('first.ts')));
  expect(screen.getByRole('status')).toBe(indicator);
  expect(view.container.querySelector('.unified-diff-virtual')).not.toBeVisible();
  await view.finishHighlight();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('does not flash loading for fast files or let the previous file timer affect a new selection', async () => {
  const view = setup();
  act(() => vi.advanceTimersByTime(40));
  await act(async () => view.reads.get('first.ts')!(document('first.ts')));
  act(() => vi.advanceTimersByTime(50));
  await view.finishHighlight();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(view.container.querySelector('.unified-diff-virtual')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'second.ts' }));
  expect(view.container.querySelector('.unified-diff-virtual')).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(60));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  await act(async () => view.reads.get('second.ts')!(document('second.ts')));
  await view.finishHighlight();
  act(() => vi.advanceTimersByTime(500));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(view.container.querySelector('code')).toHaveTextContent('second.ts');
});
