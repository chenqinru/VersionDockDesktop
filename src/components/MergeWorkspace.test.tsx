import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MergeWorkspace } from './MergeWorkspace';
import { useAppStore } from '../store/appStore';

const originalAcceptConflict = useAppStore.getState().acceptConflict;

afterEach(() => { cleanup(); useAppStore.setState({ merge: undefined, mergeResult: '', selectedFile: undefined, operations: {}, acceptConflict: originalAcceptConflict }); });

describe('advanced merge workspace', () => {
  it('requires every conflict to be resolved and supports a custom result', async () => {
    useAppStore.setState({
      merge: { path: 'file.txt', base: 'base', ours: 'ours', theirs: 'theirs', working: '', markerContent: '<<<<<<< HEAD\nours\n||||||| BASE\nbase\n=======\ntheirs\n>>>>>>> feature', conflicts: [{ index: 0, oursLabel: 'HEAD', theirsLabel: 'feature', oursLines: ['ours'], baseLines: ['base'], theirsLines: ['theirs'], startLine: 0, endLine: 6 }], oursLabel: 'HEAD', theirsLabel: 'feature', language: 'text', fingerprint: 'fingerprint', binary: false },
      selectedFile: { repoId: 'repo', path: 'file.txt', staged: false }, operations: {},
    });
    render(<MergeWorkspace />);
    expect(screen.getByRole('button', { name: 'Save resolution' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Ours' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save resolution' })).toBeEnabled());
    await waitFor(() => expect(useAppStore.getState().mergeResult).toBe('ours'));
    fireEvent.change(screen.getByLabelText('Conflict 1'), { target: { value: 'custom' } });
    await waitFor(() => expect(useAppStore.getState().mergeResult).toBe('custom'));
  });

  it('accepts a binary side directly without an extra confirmation dialog', async () => {
    const acceptConflict = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      merge: { path: 'image.png', base: '', ours: '', theirs: '', working: '', markerContent: '', conflicts: [], oursLabel: 'HEAD', theirsLabel: 'feature', language: 'binary', fingerprint: 'binary', binary: true },
      selectedFile: { repoId: 'repo', path: 'image.png', staged: false },
      acceptConflict,
      operations: {},
    });
    render(<MergeWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(acceptConflict).toHaveBeenCalledWith('mine'));
  });
});
