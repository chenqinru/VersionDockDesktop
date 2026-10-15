import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceCodeView } from './SourceCodeView';
import { highlightDiffLines } from './UnifiedDiffView';

vi.mock('./UnifiedDiffView', () => ({ cachedDiffLines: vi.fn(), highlightDiffLines: vi.fn(async () => [[], []]), resolveDiffHighlightLanguage: vi.fn((language) => language === 'rust' ? 'rust' : null) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('reveals code only after its colors are ready', async () => {
  let finish!: (tokens: Awaited<ReturnType<typeof highlightDiffLines>>) => void;
  vi.mocked(highlightDiffLines).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { container } = render(<SourceCodeView path="file.rs" language="rust" content="fn main() {}" />);
  expect(container.querySelector('pre')).not.toBeVisible();
  expect(screen.getByRole('status')).toBeInTheDocument();
  await act(async () => finish([[{ content: 'fn main() {}', color: '#ff0000', offset: 0 }]]));
  expect(container.querySelector('pre')).toBeVisible();
  expect(container.querySelector('code span span')).toHaveStyle({ color: '#ff0000' });
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('keeps plain text visible when syntax highlighting returns no tokens', async () => {
  const { container } = render(<SourceCodeView path="plain.txt" content={'plain text\nsecond plain text'} />);
  await waitFor(() => expect(container.querySelector('code')).toHaveTextContent('second plain text'));
  await Promise.resolve();
  expect(screen.getByText('plain text')).toBeInTheDocument(); expect(screen.getByText('second plain text')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Find in file' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Find in file' }), { target: { value: 'plain text' } });
  expect(screen.getByText('1/2')).toBeInTheDocument(); expect(container.querySelectorAll('mark')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Next match' })); expect(screen.getByText('2/2')).toBeInTheDocument();
});
