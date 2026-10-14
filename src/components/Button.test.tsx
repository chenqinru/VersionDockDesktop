import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Codicon } from './Codicon';

afterEach(cleanup);

describe('Button native behavior', () => {
  it('forwards refs and avoids accidental form submission while supporting explicit submit buttons', () => {
    const ref = createRef<HTMLButtonElement>();
    const submit = vi.fn(event => event.preventDefault());
    const click = vi.fn();
    render(<form onSubmit={submit}><Button ref={ref} onClick={click}>Cancel</Button><Button type="submit" variant="primary">Save</Button></form>);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(click).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(submit).toHaveBeenCalledOnce();
  });

  it('prevents duplicate actions while loading and retains its accessible label and content', () => {
    const click = vi.fn();
    const { rerender } = render(<Button loading onClick={click}><Codicon name="save" />Save settings</Button>);
    const button = screen.getByRole('button', { name: 'Save settings' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
    rerender(<Button onClick={click}><Codicon name="save" />Save settings</Button>);
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-busy');
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
  });

  it('keeps explicit disabled state after loading ends and preserves menu accessibility', () => {
    const { rerender } = render(<Button disabled loading aria-haspopup="menu" aria-expanded="true">More</Button>);
    rerender(<Button disabled aria-haspopup="menu" aria-expanded="true">More</Button>);
    const button = screen.getByRole('button', { name: 'More' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
  });
});
