import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MergeWorkspace } from './MergeWorkspace';
import { useAppStore } from '../store/appStore';

afterEach(() => { cleanup(); useAppStore.setState({ merge: undefined, mergeResult: '', selectedFile: undefined, operations: {} }); });

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
});
