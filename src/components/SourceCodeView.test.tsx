import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceCodeView } from './SourceCodeView';

vi.mock('./UnifiedDiffView', () => ({ highlightDiffLines: vi.fn(async () => [[], []]) }));
afterEach(cleanup);
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
