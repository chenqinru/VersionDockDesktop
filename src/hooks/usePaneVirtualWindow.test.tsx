import { useRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePaneVirtualWindow } from './usePaneVirtualWindow';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function TextBlock({ lines }: { lines: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [start, end] = usePaneVirtualWindow(ref, lines);
  return <div className="versiondock-merge-pane"><div ref={ref} data-lines={lines} data-start={start} data-end={end} style={{ paddingTop: start * 21, paddingBottom: (lines - end) * 21 }}>{Array.from({ length: lines }, (_, index) => index).slice(start, end).map(index => <p key={index}>line {index}</p>)}</div></div>;
}

it('keeps text visible when a deeply scrolled block shrinks or grows across the virtualization threshold', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const resizeCallbacks = new Set<() => void>();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { resizeCallbacks.add(callback); }
    observe() {}
    disconnect() { resizeCallbacks.delete(this.callback); }
  });
  let paneHeight = 400;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('versiondock-merge-pane')) return new DOMRect(0, 100, 400, paneHeight);
    const pane = this.closest('.versiondock-merge-pane');
    return new DOMRect(0, 100 - (pane?.scrollTop ?? 0), 400, Number(this.dataset.lines) * 21);
  });
  const flushFrames = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
  const view = render(<TextBlock lines={1000} />);
  const pane = view.container.firstElementChild!;
  const block = pane.firstElementChild as HTMLElement;
  flushFrames();
  fireEvent.scroll(pane, { target: { scrollTop: 15000 } });
  flushFrames();
  expect(Number(block.dataset.start)).toBeGreaterThan(600);

  view.rerender(<TextBlock lines={60} />);
  expect(block).toHaveTextContent('line 59');
  expect(block.style.paddingBottom).toBe('0px');
  expect(Number(block.dataset.start)).toBeLessThan(60);
  // Simulate the browser clamping its scroll offset to the shortened content.
  fireEvent.scroll(pane, { target: { scrollTop: 860 } });
  flushFrames();
  expect(Number(block.dataset.end)).toBe(60);

  view.rerender(<TextBlock lines={0} />);
  view.rerender(<TextBlock lines={200} />);
  expect(block.querySelectorAll('p').length).toBeGreaterThan(0);
  fireEvent.scroll(pane, { target: { scrollTop: 0 } });
  flushFrames();
  const beforeResize = Number(block.dataset.end);
  paneHeight = 1000;
  act(() => [...resizeCallbacks].forEach(callback => callback()));
  flushFrames();
  expect(Number(block.dataset.end)).toBeGreaterThan(beforeResize);
  act(() => [...resizeCallbacks].forEach(callback => callback()));
  view.unmount();
  expect(resizeCallbacks.size).toBe(0);
  expect(frames.size).toBe(0);
});
