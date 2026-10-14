import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';

afterEach(cleanup);

describe('IconButton native contract', () => {
  it('forwards the native ref and runs the action without submitting its surrounding form', () => {
    const ref = createRef<HTMLButtonElement>();
    const submit = vi.fn((event) => event.preventDefault());
    const click = vi.fn();
    render(<form onSubmit={submit}>
      <IconButton ref={ref} title="Open details" onClick={click}><Codicon name="open-preview" /></IconButton>
    </form>);
    const button = screen.getByRole('button', { name: 'Open details' });
    expect(ref.current).toBe(button);
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it('preserves disabled behavior, explicit accessible labels, and pressed state', () => {
    const click = vi.fn();
    render(<IconButton disabled title="Previous change" aria-label="Previous" aria-pressed="true" onClick={click}>
      <Codicon name="arrow-up" />
    </IconButton>);
    const button = screen.getByRole('button', { name: 'Previous' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
  });

  it('preserves caller layout and exposes semantic colors to the shared interaction styles', () => {
    const { rerender } = render(<IconButton title="Remove worktree" style={{ color: 'var(--versiondock-danger)', width: 28, padding: 4 }}><Codicon name="trash" /></IconButton>);
    const button = screen.getByRole('button', { name: 'Remove worktree' });
    expect(button.style.getPropertyValue('--versiondock-icon-foreground')).toBe('var(--versiondock-danger)');
    expect(button.style.width).toBe('28px');
    expect(button.style.padding).toBe('4px');
    rerender(<IconButton title="Remove worktree" style={{ width: 28 }}><Codicon name="trash" /></IconButton>);
    expect(button.style.getPropertyValue('--versiondock-icon-foreground')).toBe('');
  });
});
