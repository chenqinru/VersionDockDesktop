import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ThemedToken } from 'shiki/types';
import { cachedDiffLines, highlightParsedDiffSide, parseUnifiedDiff, UnifiedDiffView } from './UnifiedDiffView';
import { cachedSyntaxTokens, highlightSyntax } from '../utils/syntaxHighlighting';

vi.mock('../utils/syntaxHighlighting', () => ({ cachedSyntaxTokens: vi.fn(), highlightSyntax: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });
const patch = '@@ -1 +1 @@\n-old\n+first\n@@ -20 +20 @@\n-old\n+second';
const result = (code: string, color = '#ff0000'): ThemedToken[][] => [[{ content: code, color, offset: 0 }]];

describe('incremental diff highlighting', () => {
  it('waits for both visible sides before revealing code instead of flashing plain text', async () => {
    const completions: { code: string; resolve: (value: ThemedToken[][]) => void }[] = [];
    vi.mocked(highlightSyntax).mockImplementation(code => new Promise(resolve => completions.push({ code, resolve })));
    const view = render(<UnifiedDiffView content={'@@ -1 +1 @@\n-old\n+new'} path="file.rs" language="rust" />);
    expect(view.container.querySelector('.unified-diff-virtual')).not.toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(view.container.querySelector('.unified-diff-scroll')).toHaveAttribute('aria-busy', 'true');
    await act(async () => completions[0].resolve(result('old')));
    expect(view.container.querySelector('.unified-diff-virtual')).not.toBeVisible();
    await act(async () => completions[1].resolve(result('new')));
    await waitFor(() => expect(view.container.querySelector('.unified-diff-virtual')).toBeVisible());
    expect(view.container.querySelectorAll('code span[style]')).toHaveLength(2);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a slow highlight after 150ms while keeping plain code hidden, and resets for the next file', async () => {
    vi.useFakeTimers();
    const completions: { code: string; resolve: (value: ThemedToken[][]) => void }[] = [];
    vi.mocked(highlightSyntax).mockImplementation(code => new Promise(resolve => completions.push({ code, resolve })));
    const view = render(<UnifiedDiffView content={'@@ -1 +1 @@\n-old\n+new'} path="file.rs" language="rust" />);
    act(() => vi.advanceTimersByTime(149));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(view.container.querySelector('.unified-diff-virtual')).not.toBeVisible();
    view.rerender(<UnifiedDiffView content={'@@ -1 +1 @@\n-nextOld\n+nextNew'} path="next.rs" language="rust" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => { completions.slice(2).forEach(task => task.resolve(result(task.code))); });
    expect(view.container.querySelector('.unified-diff-virtual')).toBeVisible();
    act(() => vi.advanceTimersByTime(150));
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

  it('reveals colored visible rows before a large hunk finishes highlighting', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('unified-diff-scroll') ? 800 : 20;
    });
    const tasks: { code: string; onChunk: NonNullable<Parameters<typeof highlightSyntax>[4]>['onChunk']; resolve: (value: ThemedToken[][]) => void }[] = [];
    vi.mocked(highlightSyntax).mockImplementation((code, _language, _theme, _signal, options) => new Promise(resolve => { tasks.push({ code, onChunk: options?.onChunk, resolve }); }));
    const lines = Array.from({ length: 160 }, (_, index) => `-old${index}\n+new${index}`).join('\n');
    const view = render(<UnifiedDiffView content={'@@ -1,160 +1,160 @@\n' + lines} path="file.rs" language="rust" />);
    expect(view.container.querySelector('.unified-diff-virtual')).not.toBeVisible();
    await act(async () => {
      tasks.forEach(task => task.onChunk?.(task.code.split('\n').slice(0, 80).map(line => result(line)[0]), 0));
    });
    await waitFor(() => expect(view.container.querySelector('.unified-diff-virtual')).toBeVisible());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(view.container.querySelector('code span')).toHaveStyle({ color: '#ff0000' });
    await act(async () => {
      tasks.forEach(task => { const tokens = task.code.split('\n').map(line => result(line)[0]); task.onChunk?.(tokens.slice(80), 80); task.resolve(tokens); });
    });
    expect(view.container.querySelector('.unified-diff-virtual')).toBeVisible();
  });

  it('keeps completed chunks colored if a later chunk of the same hunk fails', async () => {
    vi.mocked(highlightSyntax).mockImplementation(async (_code, _language, _theme, _signal, options) => {
      options?.onChunk?.(result('first'), 0);
      throw new Error('later chunk failed');
    });
    const parsed = parseUnifiedDiff('@@ -1,2 +1,2 @@\n-old\n-old2\n+first\n+second');
    const onError = vi.fn();
    const tokens = await highlightParsedDiffSide(parsed, 'new', 'rust', 'file.rs', 'dark-plus', { onError });
    const pairs = parsed.rows.filter(row => row.kind === 'pair');
    expect(tokens.get(pairs[0].newCell)?.[0].color).toBe('#ff0000');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), [pairs[1].newCell]);
  });

  it('releases the loading state on failure and keeps the diff readable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(highlightSyntax).mockRejectedValue(new Error('worker failed'));
    const view = render(<UnifiedDiffView content={'@@ -1 +1 @@\n-old\n+new'} path="file.rs" language="rust" />);
    await waitFor(() => expect(view.container.querySelector('.unified-diff-virtual')).toBeVisible());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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
