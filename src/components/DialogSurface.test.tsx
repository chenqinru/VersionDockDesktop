import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { DialogSurface } from './DialogSurface';

afterEach(cleanup);

it('closes only the topmost nested modal and returns focus to the parent', async () => {
  function Example() {
    const [parent, setParent] = useState(false);
    const [child, setChild] = useState(false);
    return <><button onClick={() => setParent(true)}>Open parent</button>{parent && <DialogSurface aria-label="Parent" onClose={() => setParent(false)}>
      <button onClick={() => setChild(true)}>Open child</button><button>Parent action</button>
      {child && <DialogSurface aria-label="Child" onClose={() => setChild(false)}><button>Close child</button><input aria-label="Child input" autoFocus /><button>Child action</button></DialogSurface>}
    </DialogSurface>}</>;
  }
  render(<Example />);
  screen.getByText('Open parent').focus();
  fireEvent.click(screen.getByText('Open parent'));
  await waitFor(() => expect(screen.getByText('Open child')).toHaveFocus());
  fireEvent.click(screen.getByText('Open child'));
  const child = screen.getByRole('dialog', { name: 'Child' });
  await waitFor(() => expect(screen.getByLabelText('Child input')).toHaveFocus());
  const last = within(child).getByText('Child action'); last.focus();
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(within(child).getByText('Close child')).toHaveFocus();
  fireEvent.keyDown(child, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Child' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Parent' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('Open child')).toHaveFocus());
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(screen.getByText('Open parent')).toHaveFocus());
});

it('blocks escape and backdrop dismissal during an operation', () => {
  const close = vi.fn();
  const view = render(<DialogSurface aria-label="Saving" onClose={close} closeDisabled><button>Cancel</button></DialogSurface>);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('presentation'));
  expect(close).not.toHaveBeenCalled();
  view.rerender(<DialogSurface aria-label="Saving" onClose={close}><button>Cancel</button></DialogSurface>);
  fireEvent.click(screen.getByRole('presentation'));
  expect(close).toHaveBeenCalledOnce();
});
