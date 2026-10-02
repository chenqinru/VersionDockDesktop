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
});
