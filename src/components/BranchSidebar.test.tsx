import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchInfo, RepositoryStatus } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { BranchSidebar } from './BranchSidebar';
import * as dialogs from './dialogService';

const original = useAppStore.getState();
const repo = (id: string, kind: 'git' | 'svn' = 'git'): RepositoryStatus => ({
  meta: { id, name: id, kind, rootPath: `/tmp/${id}`, color: '#4ec9b0', depth: 0, parentRepoId: null, isSubmodule: false, isWorktree: false },
  branch: 'main', revision: 'abc', ahead: 0, behind: 0, conflicts: 0, files: [], operation: null,
});
const branch = (name: string, current = false, remote = false): BranchInfo => ({ name, current, remote, upstream: null, ahead: 0, behind: 0 });
const renderSidebar = (props: Partial<Parameters<typeof BranchSidebar>[0]> = {}) => render(<BranchSidebar
  repoFilter={new Set()} refFilter={new Set()} onRepoFilter={vi.fn()} onRefFilter={vi.fn()} onCompare={vi.fn()} onCollapse={vi.fn()} {...props}
/>);

beforeEach(() => {
  useAppStore.setState({
    bootstrap: undefined, snapshot: { workspace: { id: 'test', name: 'test', paths: ['/tmp'], lastOpenedAt: '', available: true }, generation: 1, tools: { git: true, svn: true, svnadmin: true }, repositories: [repo('a'), repo('b')] },
    branchesByRepo: { a: [branch('main', true), branch('topic')], b: [branch('main', true), branch('topic')] },
    tagsByRepo: {}, branchesLoading: false, remotes: { a: [{ name: 'origin', fetchUrl: '/tmp/remote', pushUrl: '/tmp/remote' }] },
    branchOperation: vi.fn().mockResolvedValue({ completed: true, conflicted: false }), tagOperation: vi.fn().mockResolvedValue(true),
    sync: vi.fn().mockResolvedValue(undefined), loadRemotes: vi.fn().mockResolvedValue(undefined), loadBranchWorkingDiff: vi.fn().mockResolvedValue(undefined),
    setBranchSidebarState: vi.fn(),
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); useAppStore.setState(original, true); });

describe('plugin sidebar interaction parity', () => {
  it('keeps the tag section visible when empty and creates through the shared workflow', () => {
    const runTagWorkflow = vi.fn().mockResolvedValue({ outcome: 'cancelled', targets: [] });
    useAppStore.setState({ runTagWorkflow, tagBusy: false, selectedRepoId: 'b' });
    renderSidebar();
    expect(screen.getByText('No tags yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New Tag...' }));
    expect(runTagWorkflow).toHaveBeenCalledWith({ action: 'create', repoIds: ['a', 'b'], preferredRepoId: 'b' });
    expect(screen.getByRole('button', { name: 'Tags 0' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles tags from the header whitespace, count and keyboard-activated button', () => {
    renderSidebar();
    const toggle = screen.getByRole('button', { name: 'Tags 0' });
    const header = toggle.closest('.branch-section-title')!;
    fireEvent.click(header);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(header.querySelector('.branch-section-count')!);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle, { detail: 0 });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows tag type metadata and blocks all tag actions while another entry point is busy', () => {
    useAppStore.setState({ tagBusy: true, tagsByRepo: { a: [{ name: 'v1', hash: 'abc', date: '', tagType: 'annotated' }] } });
    renderSidebar();
    const tag = screen.getByText('v1').closest('.tag-row')!;
    expect(tag).toHaveAttribute('title', expect.stringContaining('a: Annotated tag'));
    expect(screen.getByRole('button', { name: 'New Tag...' })).toBeDisabled();
    fireEvent.contextMenu(tag);
    for (const item of screen.getAllByRole('menuitem')) expect(item).toBeDisabled();
  });

  it('shows filtered empty tags and disables merging into detached HEAD', () => {
    useAppStore.setState({ tagBusy: false, branchesByRepo: { a: [{ ...branch('HEAD', true), detachedHash: 'abc' }] }, tagsByRepo: { a: [{ name: 'v1', hash: 'abc', date: '' }] } });
    renderSidebar();
    fireEvent.contextMenu(screen.getByText('v1'));
    expect(screen.getByRole('menuitem', { name: 'Merge into current' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.change(screen.getByLabelText('Filter branches and tags'), { target: { value: 'absent' } });
    expect(screen.getByText('No matching tags')).toBeInTheDocument();
  });

  it('highlights the context target and dismisses on Escape without filtering', () => {
    const onRefFilter = vi.fn();
    renderSidebar({ onRefFilter });
    const row = screen.getByText('topic').closest('.branch-ref-row')!;
    fireEvent.contextMenu(row);
    expect(row).toHaveClass('context-active');
    expect(onRefFilter).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(row).not.toHaveClass('context-active');
  });

  it('compares a shared branch only after selecting a repository, and cancels cleanly', async () => {
    const choose = vi.spyOn(dialogs, 'choiceDialog').mockResolvedValueOnce(null).mockResolvedValueOnce('b');
    const onCompare = vi.fn();
    renderSidebar({ onCompare });
    const compare = () => { fireEvent.contextMenu(screen.getByText('topic')); fireEvent.click(screen.getByText('Compare with Current')); };
    compare();
    await waitFor(() => expect(choose).toHaveBeenCalledTimes(1));
    expect(onCompare).not.toHaveBeenCalled();
    compare();
    await waitFor(() => expect(onCompare).toHaveBeenCalledWith('b', 'refs/heads/topic'));
  });

  it('merges into the primary instance without a repository chooser', async () => {
    const choose = vi.spyOn(dialogs, 'choiceDialog');
    renderSidebar();
    fireEvent.contextMenu(screen.getByText('topic'));
    fireEvent.click(screen.getByText('Merge into current'));
    await waitFor(() => expect(useAppStore.getState().branchOperation).toHaveBeenCalledWith({ type: 'merge', name: 'refs/heads/topic' }, 'a'));
    expect(choose).not.toHaveBeenCalled();
  });

  it('pushes the primary repository current branch even from a noncurrent branch row', async () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByText('topic'));
    fireEvent.click(screen.getByText('Push...'));
    await waitFor(() => expect(useAppStore.getState().sync).toHaveBeenCalledWith('a', 'push', true, { remote: 'origin' }));
  });

  it('checks out every associated repository', async () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByText('topic'));
    fireEvent.click(screen.getByText("Checkout 'topic'"));
    await waitFor(() => expect(useAppStore.getState().branchOperation).toHaveBeenCalledTimes(2));
    expect(useAppStore.getState().branchOperation).toHaveBeenCalledWith({ type: 'checkout', name: 'topic' }, 'b');
  });

  it('uses full refs for merge and rebase when a branch shares a tag name', async () => {
    useAppStore.setState({ tagsByRepo: { a: [{ name: 'topic', hash: 'abc', date: '' }] } });
    renderSidebar();
    fireEvent.contextMenu(document.querySelector('.branch-ref-row:not(.tag-row):not(.head)')!);
    fireEvent.click(screen.getByText("Rebase onto 'topic'"));
    await waitFor(() => expect(useAppStore.getState().branchOperation).toHaveBeenCalledWith({ type: 'rebase', name: 'refs/heads/topic' }, 'a'));
  });

  it('does not filter history when a tag is double clicked or activated by keyboard', () => {
    useAppStore.setState({ tagsByRepo: { a: [{ name: 'v1', hash: 'abc', date: '' }] } });
    const onRefFilter = vi.fn();
    renderSidebar({ onRefFilter });
    const tag = screen.getByText('v1').closest('.tag-row')!;
    fireEvent.doubleClick(tag);
    fireEvent.keyDown(tag, { key: 'Enter' });
    expect(tag).toHaveClass('active');
    expect(onRefFilter).not.toHaveBeenCalled();
  });

  it('hides tag deletion if any associated repository is detached on that tag', () => {
    useAppStore.setState({ branchesByRepo: { a: [{ ...branch('HEAD', true), detachedTag: 'v1' }], b: [branch('main', true)] }, tagsByRepo: { a: [{ name: 'v1', hash: 'abc', date: '' }], b: [{ name: 'v1', hash: 'abc', date: '' }] } });
    renderSidebar();
    fireEvent.contextMenu(screen.getByText('v1'));
    expect(screen.queryByText('Delete tag')).not.toBeInTheDocument();
    expect(screen.getByText('Merge into current')).toBeInTheDocument();
  });

  it('keeps SVN actions free of Git-only operations and targets the switched branch', async () => {
    useAppStore.setState({ snapshot: { ...useAppStore.getState().snapshot!, repositories: [repo('a', 'svn')] }, branchesByRepo: { a: [branch('trunk', true), branch('release')] } });
    renderSidebar();
    fireEvent.contextMenu(screen.getByText('trunk'));
    expect(screen.queryByText('Push...')).not.toBeInTheDocument();
    expect(screen.queryByText('Compare with Current')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Update'));
    await waitFor(() => expect(useAppStore.getState().sync).toHaveBeenCalledWith('a', 'update', true, { branch: 'trunk' }));
  });

  it('auto folds tags arriving asynchronously and honors a manual expansion', () => {
    const view = renderSidebar();
    const tags = Array.from({ length: 26 }, (_, i) => ({ name: `v${i}`, hash: 'abc', date: '' }));
    useAppStore.setState({ tagsByRepo: { a: tags } });
    view.rerender(<BranchSidebar repoFilter={new Set()} refFilter={new Set()} onRepoFilter={vi.fn()} onRefFilter={vi.fn()} onCompare={vi.fn()} onCollapse={vi.fn()} />);
    const header = screen.getByRole('button', { name: /Tags\s*26/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    fireEvent.change(screen.getByLabelText('Filter branches and tags'), { target: { value: 'v' } });
    expect(screen.getByText('v25')).toBeInTheDocument();
  });

  it('requires the same repository scope to highlight an aggregated branch filter', () => {
    renderSidebar({ refFilter: new Set(['refs/heads/main']), refRepoIds: ['a'] });
    expect(screen.getByText('main').closest('.branch-ref-row')).not.toHaveClass('filtered');
  });
});
