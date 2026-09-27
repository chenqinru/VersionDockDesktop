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
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept Current' })[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save resolution' })).toBeEnabled());
    await waitFor(() => expect(useAppStore.getState().mergeResult).toBe('ours'));
    fireEvent.change(screen.getByLabelText('Conflict 1'), { target: { value: 'custom' } });
    await waitFor(() => expect(useAppStore.getState().mergeResult).toBe('custom'));
  });

  it('accepts a binary side directly without an extra confirmation dialog', async () => {
    const acceptConflict = vi.fn().mockResolvedValue(true);
    const openConflicts = vi.fn();
    useAppStore.setState({
      merge: { path: 'image.png', base: '', ours: '', theirs: '', working: '', markerContent: '', conflicts: [], oursLabel: 'HEAD', theirsLabel: 'feature', language: 'binary', fingerprint: 'binary', binary: true },
      selectedFile: { repoId: 'repo', path: 'image.png', staged: false },
      acceptConflict,
      openConflicts,
      operations: {},
    });
    render(<MergeWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(acceptConflict).toHaveBeenCalledWith('mine'));
    await waitFor(() => expect(openConflicts).toHaveBeenCalled());
  });

  it('allows returning to conflicts list via back button', () => {
    const openConflicts = vi.fn();
    useAppStore.setState({
      merge: { path: 'file.txt', base: 'base', ours: 'ours', theirs: 'theirs', working: '', markerContent: '', conflicts: [], oursLabel: 'HEAD', theirsLabel: 'feature', language: 'text', fingerprint: 'fingerprint', binary: false },
      selectedFile: { repoId: 'repo', path: 'file.txt', staged: false },
      openConflicts,
      operations: {},
    });
    render(<MergeWorkspace />);
    const backBtn = screen.getByRole('button', { name: 'Back to conflicts' });
    fireEvent.click(backBtn);
    expect(openConflicts).toHaveBeenCalled();
  });

  it('does not exit editor when save fails', async () => {
    const saveMerge = vi.fn().mockResolvedValue(false);
    const openConflicts = vi.fn();
    useAppStore.setState({
      merge: { path: 'file.txt', base: 'base', ours: 'ours', theirs: 'theirs', working: '', markerContent: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature', conflicts: [{ index: 0, oursLabel: 'HEAD', theirsLabel: 'feature', oursLines: ['ours'], baseLines: ['base'], theirsLines: ['theirs'], startLine: 0, endLine: 4 }], oursLabel: 'HEAD', theirsLabel: 'feature', language: 'text', fingerprint: 'fingerprint', binary: false },
      selectedFile: { repoId: 'repo', path: 'file.txt', staged: false },
      saveMerge,
      openConflicts,
      operations: {},
    });
    render(<MergeWorkspace />);
    // 解决冲突以启用保存按钮
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept Current' })[0]);
    const saveBtn = await screen.findByRole('button', { name: 'Save resolution' });
    fireEvent.click(saveBtn);
    await waitFor(() => expect(saveMerge).toHaveBeenCalled());
    expect(openConflicts).not.toHaveBeenCalled();
  });

  it('passes deleteFile true when conflict resolution is to delete file', async () => {
    const saveMerge = vi.fn().mockResolvedValue(true);
    const openConflicts = vi.fn();
    useAppStore.setState({
      merge: {
        path: 'deleted-by-ours.txt',
        base: 'base content\nline 2',
        ours: '',
        theirs: 'incoming change\nline 2',
        working: '',
        markerContent: '<<<<<<< HEAD\n=======\nincoming change\nline 2\n>>>>>>> feature',
        conflicts: [{ index: 0, oursLabel: 'HEAD', theirsLabel: 'feature', oursLines: [], baseLines: ['base content'], theirsLines: ['incoming change'], startLine: 0, endLine: 4 }],
        oursLabel: 'HEAD',
        theirsLabel: 'feature',
        language: 'text',
        fingerprint: 'fp-del',
        binary: false,
        oursStatus: 'deleted',
        theirsStatus: 'modified',
      },
      selectedFile: { repoId: 'repo', path: 'deleted-by-ours.txt', staged: false },
      saveMerge,
      openConflicts,
      operations: {},
    });
    render(<MergeWorkspace />);
    // 接受当前（已删除侧）
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept Current' })[0]);
    const saveBtn = await screen.findByRole('button', { name: 'Save resolution' });
    fireEvent.click(saveBtn);
    await waitFor(() => expect(saveMerge).toHaveBeenCalledWith({ deleteFile: true }));
    expect(openConflicts).toHaveBeenCalled();
  });
});
