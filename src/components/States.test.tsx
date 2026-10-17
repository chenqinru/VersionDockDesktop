import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ErrorNotice } from './ErrorNotice';
import { EmptyState } from './EmptyState';
import { LoadingState } from './LoadingState';

afterEach(() => { cleanup(); vi.useRealTimers(); });
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

it('only announces loading after the requested delay and disappears as soon as work completes', () => {
  vi.useFakeTimers();
  const view = render(<LoadingState active delayMs={150}>Loading diff</LoadingState>);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(149));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('status')).toHaveTextContent('Loading diff');
  view.rerender(<LoadingState active={false} delayMs={150}>Loading diff</LoadingState>);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(<LoadingState active delayMs={150}>Loading diff</LoadingState>);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(150));
  expect(screen.getByRole('status')).toBeInTheDocument();
});

it('restarts the loading delay for a new request and cancels obsolete timers', () => {
  vi.useFakeTimers();
  const view = render(<LoadingState active delayMs={150} resetKey="first" />);
  act(() => vi.advanceTimersByTime(100));
  view.rerender(<LoadingState active delayMs={150} resetKey="second" />);
  act(() => vi.advanceTimersByTime(50));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(100));
  expect(screen.getByRole('status')).toBeInTheDocument();
  view.rerender(<LoadingState active delayMs={150} resetKey="third" />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
