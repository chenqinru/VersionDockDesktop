import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMouseBackNavigation } from './useMouseBackNavigation';
import { WorkspaceHeader } from '../components/WorkspaceHeader';

function Example({ back = vi.fn(), disabled = false }: { back?: () => void; disabled?: boolean }) {
  useMouseBackNavigation();
  return <div className="workspace-slot"><WorkspaceHeader backLabel="Back" onBack={back} backDisabled={disabled}><span>Page</span></WorkspaceHeader><textarea aria-label="Code" /></div>;
}
function sideClick(target: Element = document.body, button = 3) {
  const events = ['mousedown', 'mouseup', 'auxclick'].map(type => new MouseEvent(type, { button, bubbles: true, cancelable: true }));
  events.forEach(event => fireEvent(target, event));
  return events;
}
afterEach(cleanup);

it('invokes the same return action once and cancels native history on every mouse phase', () => {
  const back = vi.fn();
  render(<Example back={back} />);
  const events = sideClick(screen.getByLabelText('Code'));
  expect(back).toHaveBeenCalledOnce();
  expect(events.every(event => event.defaultPrevented)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(back).toHaveBeenCalledTimes(2);
});

it('leaves primary, middle, secondary and forward buttons alone', () => {
  const back = vi.fn();
  render(<Example back={back} />);
  for (const button of [0, 1, 2, 4]) expect(sideClick(document.body, button).every(event => !event.defaultPrevented)).toBe(true);
  expect(back).not.toHaveBeenCalled();
});

it('respects disabled return actions', () => {
  const back = vi.fn();
  render(<Example back={back} disabled />);
  sideClick();
  expect(back).not.toHaveBeenCalled();
});

it.each(['dialog', 'menu', 'listbox'])('does not navigate behind an open %s', role => {
  const back = vi.fn();
  render(<><Example back={back} /><div role={role} aria-modal={role === 'dialog' ? true : undefined}>Overlay</div></>);
  sideClick();
  expect(back).not.toHaveBeenCalled();
});

it('ignores hidden return actions and prefers the main page over a side panel', () => {
  const back = vi.fn(), side = vi.fn(), hidden = vi.fn();
  render(<><Example back={back} /><button data-navigation-back="" onClick={side}>Side</button><div style={{ display: 'none' }}><button data-navigation-back="" onClick={hidden}>Hidden</button></div></>);
  sideClick();
  expect(back).toHaveBeenCalledOnce();
  expect(side).not.toHaveBeenCalled();
  expect(hidden).not.toHaveBeenCalled();
});

it('cancels native history with no return action and removes listeners on unmount', () => {
  function Empty() { useMouseBackNavigation(); return <span>Home</span>; }
  const view = render(<Empty />);
  expect(sideClick().every(event => event.defaultPrevented)).toBe(true);
  view.unmount();
  expect(sideClick().every(event => !event.defaultPrevented)).toBe(true);
});
