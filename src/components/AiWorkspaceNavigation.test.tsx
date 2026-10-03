import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AiCodeReviewWorkspace } from './AiCodeReviewWorkspace';
import { AiComposerWorkspace } from './AiComposerWorkspace';
import * as ai from '../ai/aiStore';
import { useAppStore } from '../store/appStore';
import { MockBridge } from '../platform/bridge';
import type { WorkspaceSnapshot } from '../bindings/generated';

const initialize = () => useAppStore.setState({
  bridge: new MockBridge(() => new Promise(() => {})),
  snapshot: {
    workspace: { id: 'w', name: 'w', paths: ['/tmp/ai'], lastOpenedAt: '', available: true },
    repositories: [], generation: 1, tools: { git: true, svn: true, svnadmin: true },
  } as WorkspaceSnapshot,
  mode: 'changes',
});
afterEach(() => {
  cleanup();
  ai.aiWorkspaceChanged(undefined);
  useAppStore.setState({ bridge: undefined, snapshot: undefined, mode: 'history' });
  vi.restoreAllMocks();
});

it('returns from the review header to its origin and cancels the active review', () => {
  initialize();
  ai.useAiStore.getState().openReview([{ repoId: 'r', paths: ['f'], stagedOnly: false }]);
  render(<AiCodeReviewWorkspace />);
  expect(ai.useAiStore.getState().runs.review.running).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(useAppStore.getState().mode).toBe('changes');
  expect(ai.useAiStore.getState().view).toBeUndefined();
  expect(ai.useAiStore.getState().runs.review.running).toBe(false);
});

it('returns from composer preparation without waiting for the source', () => {
  initialize();
  ai.useAiStore.getState().openComposer({ repoId: 'r', paths: ['f'], stagedOnly: false, hashes: [] });
  render(<AiComposerWorkspace />);
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(useAppStore.getState().mode).toBe('changes');
  expect(ai.useAiStore.getState().source).toBeUndefined();
  expect(ai.useAiStore.getState().view).toBeUndefined();
});

it('blocks return while applying and restores the same header on completion', () => {
  initialize();
  useAppStore.setState({ mode: 'commit-detail' });
  ai.useAiStore.getState().openComposer({ repoId: 'r', paths: [], stagedOnly: false, hashes: ['a'] });
  let receive!: Parameters<typeof ai.listenAiView>[0];
  vi.spyOn(ai, 'listenAiView').mockImplementation(listener => {
    receive = listener;
    return () => {};
  });
  render(<AiComposerWorkspace />);
  act(() => receive({ type: 'COMPOSER_PHASE', phase: 'applying' }));
  const back = screen.getByRole('button', { name: 'Back' });
  expect(back).toBeDisabled();
  fireEvent.click(back);
  expect(useAppStore.getState().mode).toBe('ai-composer');
  act(() => receive({ type: 'COMPOSER_APPLY_RESULT', result: {
    commitCount: 2, commitHashes: ['a', 'b'], recoveryCommand: null, backupRef: null, completedGroups: 2,
  } }));
  expect(screen.getByText('Commit composition completed')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(useAppStore.getState().mode).toBe('commit-detail');
});
