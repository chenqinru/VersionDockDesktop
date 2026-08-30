import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import type { RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { I18nContext, createTranslator } from '../i18n';
import { MockBridge } from '../platform/bridge';
import { BridgeContext } from '../platform/context';
import { useAppStore } from '../store/appStore';
import { FileHistoryPanel } from './FileHistoryPanel';
import { IdentityPanel } from './IdentityPanel';

const gitRepo: RepositoryStatus = {
  meta: { id: 'git', name: 'Git Repo', rootPath: '/tmp/git', color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch: 'main', revision: 'abcdef0', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
};
const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'workspace', name: 'Workspace', paths: ['/tmp'], lastOpenedAt: '', available: true },
  repositories: [gitRepo], generation: 1, tools: { git: true, svn: true, svnadmin: true },
};

const provider = (bridge: MockBridge, children: ReactNode) => <BridgeContext.Provider value={bridge}><I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}>{children}</I18nContext.Provider></BridgeContext.Provider>;

afterEach(() => {
  cleanup();
  useAppStore.setState({ snapshot: undefined, fileHistoryTarget: undefined });
});

describe('V3 identity and file history', () => {
  it('loads paged file history and revision content through the Bridge', async () => {
    const commands: string[] = [];
    const bridge = new MockBridge((command) => {
      commands.push(command.type);
      if (command.type === 'fileHistory') return { entries: [{ revision: 'abcdef012345', previousRevision: null, path: 'src/main.ts', previousPath: null, author: 'Tester', date: '2026-08-23', message: 'initial', status: 'A' }], nextCursor: null };
      if (command.type === 'fileRevisionContent') return { revision: command.payload.revision, path: command.payload.relative_path, content: 'export const value = 1;', binary: false, truncated: false };
      return { path: 'src/main.ts', content: '', language: 'typescript', binary: false, truncated: false, lineCount: 0 };
    });
    useAppStore.setState({ bridge, snapshot, fileHistoryTarget: { repoId: 'git', path: 'src/main.ts' } });
    render(provider(bridge, <FileHistoryPanel />));
    expect(await screen.findByText('initial')).toBeInTheDocument();
    expect(await screen.findByText('export const value = 1;')).toBeInTheDocument();
    expect(commands).toEqual(expect.arrayContaining(['fileHistory', 'fileRevisionContent']));
  });

  it('shows an explicit file-history state for binary revisions instead of an empty panel', async () => {
    const bridge = new MockBridge((command) => {
      if (command.type === 'fileHistory') return { entries: [{ revision: 'abcdef012345', previousRevision: null, path: 'assets/logo.png', previousPath: null, author: 'Tester', date: '2026-08-23', message: 'add logo', status: 'A' }], nextCursor: null };
      if (command.type === 'fileRevisionContent') return { revision: command.payload.revision, path: command.payload.relative_path, content: '', binary: true, truncated: false };
      return true;
    });
    useAppStore.setState({ bridge, snapshot, fileHistoryTarget: { repoId: 'git', path: 'assets/logo.png' } });

    render(provider(bridge, <FileHistoryPanel />));

    expect(await screen.findByText('Binary diff cannot be displayed')).toBeInTheDocument();
    expect(screen.getAllByText('assets/logo.png').length).toBeGreaterThan(0);
  });

  it('cancels load-more and rejects its stale page when the panel closes and changes context', async () => {
    let loadMoreSignal: AbortSignal | undefined;
    let resolveLoadMore: ((page: { entries: Array<Record<string, unknown>>; nextCursor: null }) => void) | undefined;
    const pendingLoadMore = new Promise<{ entries: Array<Record<string, unknown>>; nextCursor: null }>((resolve) => { resolveLoadMore = resolve; });
    const entry = (path: string, revision: string, message: string) => ({ revision, previousRevision: null, path, previousPath: null, author: 'Tester', date: '2026-08-23', message, status: 'M' });
    const bridge = new MockBridge((command, options) => {
      if (command.type === 'fileHistory') {
        if (command.payload.cursor) {
          loadMoreSignal = options?.signal;
          return pendingLoadMore;
        }
        return command.payload.relative_path === 'src/second.ts'
          ? { entries: [entry('src/second.ts', 'second000000', 'second context')], nextCursor: null }
          : { entries: [entry('src/first.ts', 'first0000000', 'first context')], nextCursor: 'next-page' };
      }
      if (command.type === 'fileRevisionContent') return { revision: command.payload.revision, path: command.payload.relative_path, content: command.payload.relative_path, binary: false, truncated: false };
      return { path: '', content: '', language: 'typescript', binary: false, truncated: false, lineCount: 0 };
    });
    useAppStore.setState({ bridge, snapshot, fileHistoryTarget: { repoId: 'git', path: 'src/first.ts' } });
    render(provider(bridge, <FileHistoryPanel />));
    await screen.findByText('first context');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(loadMoreSignal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(loadMoreSignal?.aborted).toBe(true);

    act(() => useAppStore.setState({ fileHistoryTarget: { repoId: 'git', path: 'src/second.ts' } }));
    await screen.findByText('second context');
    await act(async () => resolveLoadMore?.({ entries: [entry('src/first.ts', 'stale0000000', 'stale page')], nextCursor: null }));
    expect(screen.queryByText('stale page')).not.toBeInTheDocument();
  });

  it('shows the effective Git identity and persists profile selection through the Bridge', async () => {
    const commands: string[] = [];
    const identity = { profiles: [{ id: 'release', label: 'Release', userName: 'Release Bot', email: 'release@example.test' }], selectedProfileId: null, local: { userName: 'Local User', email: 'local@example.test', source: 'local' as const, profileId: null, valid: true }, global: null, effective: { userName: 'Local User', email: 'local@example.test', source: 'local' as const, profileId: null, valid: true } };
    const bridge = new MockBridge((command) => {
      commands.push(command.type);
      if (command.type === 'gitIdentity' || command.type === 'gitProfileOperation') return identity;
      return true;
    });
    useAppStore.setState({ bridge, snapshot });
    render(provider(bridge, <IdentityPanel repoId="git" close={() => undefined} />));
    expect(await screen.findByText('Local User <local@example.test>')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Profile' }), { target: { value: 'release' } });
    await waitFor(() => expect(commands).toContain('gitProfileOperation'));
  });
});
