import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ThemedToken } from 'shiki/types';
import { cachedDiffLines, highlightParsedDiffSide, parseUnifiedDiff, UnifiedDiffView } from './UnifiedDiffView';
import { cachedSyntaxTokens, highlightSyntax } from '../utils/syntaxHighlighting';

vi.mock('../utils/syntaxHighlighting', () => ({ cachedSyntaxTokens: vi.fn(), highlightSyntax: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const patch = '@@ -1 +1 @@\n-old\n+first\n@@ -20 +20 @@\n-old\n+second';
const result = (code: string, color = '#ff0000'): ThemedToken[][] => [[{ content: code, color, offset: 0 }]];

describe('incremental diff highlighting', () => {
  it('waits for both visible sides before revealing code instead of flashing plain text', async () => {
    const completions: { code: string; resolve: (value: ThemedToken[][]) => void }[] = [];
    vi.mocked(highlightSyntax).mockImplementation(code => new Promise(resolve => completions.push({ code, resolve })));
    const view = render(<UnifiedDiffView content={'@@ -1 +1 @@\n-old\n+new'} path="file.rs" language="rust" />);
    expect(view.container.querySelector('.unified-diff-virtual')).not.toBeVisible();
    expect(screen.getByRole('status')).toBeInTheDocument();
    await act(async () => completions[0].resolve(result('old')));
    expect(view.container.querySelector('.unified-diff-virtual')).not.toBeVisible();
    await act(async () => completions[1].resolve(result('new')));
    await waitFor(() => expect(view.container.querySelector('.unified-diff-virtual')).toBeVisible());
    expect(view.container.querySelectorAll('code span[style]')).toHaveLength(2);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders cached colors immediately without a loading state', () => {
    vi.mocked(cachedSyntaxTokens).mockImplementation(code => result(code));
    vi.mocked(highlightSyntax).mockImplementation(async code => result(code));
    const view = render(<UnifiedDiffView content={'@@ -1 +1 @@\n-old\n+new'} path="file.rs" language="rust" />);
    expect(view.container.querySelector('.unified-diff-virtual')).toBeVisible();
    expect(view.container.querySelector('code span')).toHaveStyle({ color: '#ff0000' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('releases the loading state on failure and keeps the diff readable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(highlightSyntax).mockRejectedValue(new Error('worker failed'));
    const view = render(<UnifiedDiffView content={'@@ -1 +1 @@\n-old\n+new'} path="file.rs" language="rust" />);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(view.container.querySelector('.unified-diff-virtual')).toBeVisible();
    expect(screen.getByText('new')).toBeVisible();
  });

  it('keeps good hunks colored when a different hunk fails', async () => {
    vi.mocked(highlightSyntax).mockImplementation(async (code) => {
      if (code === 'second') throw new Error('bad grammar');
      return result(code);
    });
    const parsed = parseUnifiedDiff(patch);
    const onError = vi.fn();
    const tokens = await highlightParsedDiffSide(parsed, 'new', 'rust', 'file.rs', 'dark-plus', { onError });
    const pairs = parsed.rows.filter((row) => row.kind === 'pair');
    expect(tokens.get(pairs[0].newCell)?.[0].color).toBe('#ff0000');
    expect(tokens.get(pairs[1].newCell)).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('publishes each completed hunk without waiting for the whole diff', async () => {
    let resolve!: (value: ThemedToken[][]) => void;
    vi.mocked(highlightSyntax).mockImplementation((code) => code === 'second'
      ? new Promise((done) => { resolve = done; }) : Promise.resolve(result(code)));
    const onGroup = vi.fn();
    const pending = highlightParsedDiffSide(parseUnifiedDiff(patch), 'new', 'rust', 'file.rs', 'dark-plus', { onGroup });
    await waitFor(() => expect(onGroup).toHaveBeenCalledOnce());
    expect(onGroup.mock.calls[0][1][0][0].content).toBe('first');
    resolve(result('second')); await pending;
    expect(onGroup).toHaveBeenCalledTimes(2);
  });

  it('does not publish old colors after switching files while requests are pending', async () => {
    const completions: { code: string; resolve: (value: ThemedToken[][]) => void }[] = [];
    vi.mocked(highlightSyntax).mockImplementation((code) => new Promise((resolve) => { completions.push({ code, resolve }); }));
    const firstPatch = '@@ -1 +1 @@\n-firstOld\n+firstNew';
    const secondPatch = '@@ -1 +1 @@\n-secondOld\n+secondNew';
    const view = render(<UnifiedDiffView content={firstPatch} path="first.rs" language="rust" />);
    await waitFor(() => expect(completions).toHaveLength(2));
    view.rerender(<UnifiedDiffView content={secondPatch} path="second.rs" language="rust" />);
    await waitFor(() => expect(completions).toHaveLength(4));
    await act(async () => { completions.slice(2).forEach((task) => task.resolve(result(task.code, '#00ff00'))); });
    await waitFor(() => expect(view.container.querySelector('code span')?.getAttribute('style')).toContain('rgb(0, 255, 0)'));
    await act(async () => { completions.slice(0, 2).forEach((task) => task.resolve(result(task.code, '#ff0000'))); });
    expect(view.container.querySelector('code span')?.getAttribute('style')).toContain('rgb(0, 255, 0)');
    expect(view.container.querySelector('code')?.textContent).toContain('second');
  });

  it('does not enqueue tokenization past the existing large-diff limits', () => {
    render(<UnifiedDiffView content={'x'.repeat(1_000_001)} path="large.rs" language="rust" />);
    expect(highlightSyntax).not.toHaveBeenCalled();
    expect(cachedDiffLines(['plain'], 'text', 'unknown.txt', 'dark-plus')).toBeUndefined();
  });
});
