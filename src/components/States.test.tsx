import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ErrorNotice } from './ErrorNotice';
import { EmptyState } from './EmptyState';
import { LoadingState } from './LoadingState';

afterEach(cleanup);
it('preserves error details, retry events and disables duplicate retries while pending', () => {
  const retry = vi.fn(event => event.stopPropagation());
  const { rerender } = render(<ErrorNotice onRetry={retry}>Detailed failure</ErrorNotice>);
  expect(screen.getByRole('alert')).toHaveTextContent('Detailed failure');
  fireEvent.click(screen.getByRole('button', { name: /Retry|重试/ }));
  expect(retry).toHaveBeenCalledOnce();
  rerender(<ErrorNotice onRetry={retry} retrying>Detailed failure</ErrorNotice>);
  fireEvent.click(screen.getByRole('button', { name: /Retry|重试/ }));
  expect(retry).toHaveBeenCalledOnce();
});
it('announces loading and empty results while retaining caller-provided actions', () => {
  const { rerender } = render(<LoadingState>Loading history</LoadingState>);
  expect(screen.getByRole('status')).toHaveTextContent('Loading history');
  rerender(<EmptyState icon="history" description="Try another branch" actions={<button>Change branch</button>}>No history</EmptyState>);
  expect(screen.getByRole('status')).toHaveTextContent('No history');
  expect(screen.getByText('Try another branch')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Change branch' })).toBeInTheDocument();
});
