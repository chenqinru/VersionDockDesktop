import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useVirtualScrollMargin } from './useVirtualScrollMargin';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('tracks sibling layout changes, borders, hidden tabs and observer cleanup', () => {
  const callbacks = new Set<() => void>();
  const observed = new Set<Element>();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { callbacks.add(callback); }
    observe(element: Element) { observed.add(element); }
    disconnect() { callbacks.delete(this.callback); }
  });
  const scroll = document.createElement('div');
  const preceding = document.createElement('section');
  const group = document.createElement('section');
  const list = document.createElement('div');
  scroll.append(preceding, group);
  group.append(list);
  let visible = true;
  let origin = 1400;
  Object.defineProperty(scroll, 'offsetHeight', { get: () => visible ? 500 : 0 });
  Object.defineProperty(scroll, 'clientTop', { value: 1 });
  Object.defineProperty(list, 'offsetTop', { value: 28 });
  scroll.scrollTop = 1500;
  vi.spyOn(scroll, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, visible ? 100 : 0, 400, visible ? 500 : 0));
  vi.spyOn(list, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, visible ? 101 + origin - scroll.scrollTop : 0, 400, 1320));
  const resize = () => act(() => [...callbacks].forEach(callback => callback()));
  const { result, rerender, unmount } = renderHook(() => useVirtualScrollMargin(list, scroll, true));
  expect(result.current).toBe(1400);
  expect(observed.has(preceding)).toBe(true);
  origin = 56; // The preceding repository collapsed without rerendering this one.
  resize();
  expect(result.current).toBe(56);
  visible = false;
  rerender(); resize();
  expect(result.current).toBe(56);
  visible = true;
  origin = 80;
  resize();
  expect(result.current).toBe(80);
  unmount();
  expect(callbacks.size).toBe(0);
});
