import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckpointHistoryToolbar } from './CheckpointHistoryToolbar';

afterEach(cleanup);
function Example({ change = () => {} }: { change?: (value: string) => void }) {
  const [query, setQuery] = useState('');
  const [repository, setRepository] = useState('');
  return <CheckpointHistoryToolbar count="3/12" query={query} onQueryChange={setQuery} repository={repository} repositories={[{ value: '/project/api', label: 'api' }]} onRepositoryChange={value => { setRepository(value); change(value); }} onlyChanges onOnlyChangesChange={() => {}} disabled={false} />;
}
it('keeps search collapsed until requested, focuses input and handles Escape without closing its parent', () => {
  const escaped = vi.fn();
  render(<div onKeyDown={escaped}><Example /></div>);
  const button = screen.getByRole('button', { name: 'Search checkpoints' });
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(button);
  const input = screen.getByRole('textbox', { name: 'Search checkpoints' });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: 'message' } });
  fireEvent.click(button);
  expect(input).toHaveValue('message');
  expect(input).toHaveFocus();
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
  expect(input).toHaveValue('message');
  escaped.mockClear();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(input).toHaveValue('');
  expect(input).toHaveFocus();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(button).toHaveFocus();
  expect(escaped).not.toHaveBeenCalled();
});
it('opens repository choices on demand, marks the selected filter and supports clearing it', () => {
  const change = vi.fn();
  render(<Example change={change} />);
  const filter = screen.getByRole('button', { name: 'Filter checkpoint repository' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(filter).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(filter);
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem', { name: 'api' }));
  expect(change).toHaveBeenLastCalledWith('/project/api');
  expect(filter).toHaveAttribute('aria-pressed', 'true');
  expect(filter).toHaveAttribute('title', 'Filtered repository: api');
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.click(filter);
  fireEvent.click(screen.getByRole('menuitem', { name: 'All repositories' }));
  expect(change).toHaveBeenLastCalledWith('');
  expect(filter).toHaveAttribute('aria-pressed', 'false');
});
