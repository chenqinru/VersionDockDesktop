import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { AiResult, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import { aiWorkspaceChanged, useAiStore } from '../ai/aiStore';
import { useAppStore } from '../store/appStore';
import { AiCommitGenerator } from './AiCommitActions';

afterEach(() => {
  cleanup();
  aiWorkspaceChanged();
  useAppStore.setState({ snapshot: undefined, bridge: undefined, commitMessage: '' });
});

it('cancels generation when selected repository or paths change and keeps the new draft', async () => {
  for (const next of [
    [{ repoId: 'other', paths: ['first.ts'], stagedOnly: false }],
    [{ repoId: 'repo', paths: ['second.ts'], stagedOnly: false }],
  ]) {
    let finish!: (result: AiResult) => void;
    const pending = new Promise<AiResult>(resolve => { finish = resolve; });
    const bridge = new MockBridge(() => pending);
    useAppStore.setState({ bridge, snapshot: { workspace: { id: 'workspace' } } as WorkspaceSnapshot, commitMessage: 'original draft' });
    const { rerender, unmount } = render(<AiCommitGenerator busy={false} candidates={[{ repoId: 'repo', paths: ['first.ts'], stagedOnly: false }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate commit message with AI' }));
    await waitFor(() => expect(useAiStore.getState().runs['commit-message']?.running).toBe(true));
    rerender(<AiCommitGenerator busy={false} candidates={next} />);
    useAppStore.getState().setCommitMessage('new selection draft');
    finish({ text: 'late result' } as AiResult);
    await waitFor(() => expect(useAiStore.getState().runs['commit-message']?.phase).toBe('cancelled'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useAppStore.getState().commitMessage).toBe('new selection draft');
    unmount();
  }
});
