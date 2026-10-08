import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffWorkspace } from './DiffWorkspace';
import { useAppStore } from '../store/appStore';
import type { DiffDocument } from '../bindings/generated';

const originalBackToHistory = useAppStore.getState().backToHistory;

const dummyDiff: DiffDocument = {
  path: 'src/example.ts',
  content: 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new',
  language: 'typescript',
  binary: false,
  truncated: false,
  lineCount: 5,
};

afterEach(() => {
  cleanup();
  useAppStore.setState({
    diff: undefined,
    diffReturnMode: undefined,
    comparisonTarget: undefined,
    selectedFile: undefined,
    mode: 'history',
    backToHistory: originalBackToHistory,
  });
});

describe('DiffWorkspace back navigation', () => {
  it('returns from a file diff to the update details view', () => {
    useAppStore.setState({ diff: dummyDiff, diffReturnMode: 'update-details', backToHistory: originalBackToHistory });
    render(<DiffWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to update details' }));
    expect(useAppStore.getState().mode).toBe('update-details');
  });
  it('renders "Back to commit details" when opened from commit-detail mode and invokes backToHistory on click', () => {
    const backToHistory = vi.fn();
    useAppStore.setState({
      diff: dummyDiff,
      selectedFile: { repoId: 'repo-1', path: 'src/example.ts', staged: false },
      diffReturnMode: 'commit-detail',
      backToHistory,
    });

    render(<DiffWorkspace />);

    const backButton = screen.getByRole('button', { name: /Back to commit details/i });
    expect(backButton).toBeInTheDocument();

    fireEvent.click(backButton);
    expect(backToHistory).toHaveBeenCalledTimes(1);
  });

  it('renders "Back to changes" when opened from changes mode', () => {
    useAppStore.setState({
      diff: dummyDiff,
      selectedFile: { repoId: 'repo-1', path: 'src/example.ts', staged: false },
      diffReturnMode: 'changes',
    });

    render(<DiffWorkspace />);

    expect(screen.getByRole('button', { name: /Back to changes/i })).toBeInTheDocument();
  });

  it('prioritizes "Back to compare" when comparisonTarget is active', () => {
    useAppStore.setState({
      diff: dummyDiff,
      selectedFile: { repoId: 'repo-1', path: 'src/example.ts', staged: false },
      comparisonTarget: { repoId: 'repo-1', target: 'feature/branch' },
      diffReturnMode: 'commit-detail',
    });

    render(<DiffWorkspace />);

    expect(screen.getByRole('button', { name: /Back to compare/i })).toBeInTheDocument();
  });

  it('defaults to "Back to history" when no return mode is specified', () => {
    useAppStore.setState({
      diff: dummyDiff,
      selectedFile: { repoId: 'repo-1', path: 'src/example.ts', staged: false },
      diffReturnMode: undefined,
      comparisonTarget: undefined,
    });

    render(<DiffWorkspace />);

    expect(screen.getByRole('button', { name: /Back to history/i })).toBeInTheDocument();
  });
});
