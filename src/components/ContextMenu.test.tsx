import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContextMenu } from './ContextMenu';
import { scrollbarOwners } from '../scrollbars/ownership';

const items = [{ id: 'fetch', label: 'Fetch All', icon: 'cloud-download' }];
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(160);
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(700);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps a footer menu above its button instead of merely clamping it to the viewport', () => {
  const anchorRect = { left: 400, right: 430, top: 650, bottom: 680 };
  render(<ContextMenu x={400} y={650} anchorRect={anchorRect} placement="above" items={items} onSelect={vi.fn()} onClose={vi.fn()} />);
  const menu = screen.getByRole('menu');
  expect(Number.parseFloat(menu.style.top) + 160).toBeLessThan(anchorRect.top);
  expect(menu.style.left).toBe('210px');
});

it('scrolls an oversized menu in the available space without covering its anchor', () => {
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(200);
  const anchorRect = { left: 400, right: 430, top: 100, bottom: 130 };
  render(<ContextMenu x={400} y={100} anchorRect={anchorRect} placement="above" items={items} onSelect={vi.fn()} onClose={vi.fn()} />);
  const menu = screen.getByRole('menu');
  expect(menu.style.top).toBe('6px');
  expect(menu.style.maxHeight).toBe('90px');
  expect(menu.style.overflowY).toBe('auto');
});

it('uses the space below when there is no room above the anchor', () => {
  const anchorRect = { left: 400, right: 430, top: 10, bottom: 40 };
  render(<ContextMenu x={400} y={10} anchorRect={anchorRect} placement="above" items={items} onSelect={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole('menu').style.top).toBe('44px');
});

it('allows the trigger to toggle the menu and still closes on an outside click', () => {
  const close = vi.fn();
  render(<ContextMenu x={400} y={650} anchorRect={{ left: 400, right: 430, top: 650, bottom: 680 }} placement="above" items={items} onSelect={vi.fn()} onClose={close} />);
  fireEvent.mouseDown(document.body, { clientX: 415, clientY: 660 });
  expect(close).not.toHaveBeenCalled();
  fireEvent.mouseDown(document.body, { clientX: 40, clientY: 40 });
  expect(close).toHaveBeenCalledOnce();
});

it('preserves the viewport positioning of ordinary pointer context menus', () => {
  render(<ContextMenu x={760} y={650} items={items} onSelect={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole('menu').style.left).toBe('574px');
  expect(screen.getByRole('menu').style.top).toBe('534px');
});

it('dismisses an anchored menu when a resize invalidates the button position', () => {
  const close = vi.fn();
  render(<ContextMenu x={400} y={650} anchorRect={{ left: 400, right: 430, top: 650, bottom: 680 }} placement="above" items={items} onSelect={vi.fn()} onClose={close} />);
  fireEvent(window, new Event('resize'));
  expect(close).toHaveBeenCalledOnce();
});

it('keeps the menu open while using its portalled scrollbar', () => {
  const close = vi.fn();
  render(<ContextMenu x={20} y={20} items={items} onSelect={vi.fn()} onClose={close} />);
  const menu = screen.getByRole('menu');
  const viewport = document.createElement('div'); viewport.dataset.versiondockScrollbarViewport = '';
  const thumb = document.createElement('div'); viewport.append(thumb); document.body.append(viewport);
  scrollbarOwners.set(viewport, menu);
  fireEvent.mouseDown(thumb);
  expect(close).not.toHaveBeenCalled();
  thumb.addEventListener('keydown', event => event.preventDefault());
  thumb.focus();
  const item = screen.getByRole('menuitem'); item.blur();
  fireEvent.keyDown(thumb, { key: 'ArrowDown' });
  expect(item).not.toHaveFocus();
  viewport.remove(); scrollbarOwners.delete(viewport);
});
