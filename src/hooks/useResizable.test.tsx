import { act, cleanup, renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResizable } from './useResizable';

let frames: Map<number, FrameRequestCallback>;
let sequence = 0;
const flush = () => act(() => {
  const batch = [...frames.values()];
  frames.clear();
  batch.forEach(frame => frame(0));
});
function pointerStart(target: HTMLElement, clientX = 100): ReactPointerEvent {
  return { preventDefault: vi.fn(), clientX, clientY: 0, pointerId: 1, currentTarget: target } as unknown as ReactPointerEvent;
}
function move(clientX: number, pointerId = 1, clientY = 0) {
  const event = new MouseEvent('pointermove', { clientX, clientY });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  act(() => window.dispatchEvent(event));
}
beforeEach(() => {
  frames = new Map();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++sequence, callback); return sequence; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
});
afterEach(() => {
  cleanup();
  document.body.classList.remove('is-resizing');
  vi.restoreAllMocks();
});

describe('useResizable', () => {
  it('merges pointer bursts into one frame and commits an unpainted final position on release', () => {
    const onChange = vi.fn();
    const target = document.createElement('div');
    const { result } = renderHook(() => useResizable(220, 120, 400, onChange));
    act(() => result.current(pointerStart(target)));
    for (let x = 101; x <= 200; x++) move(x);
    expect(onChange).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    flush();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(320);
    move(210);
    act(() => window.dispatchEvent(new Event('pointerup')));
    expect(onChange).toHaveBeenLastCalledWith(330);
    expect(frames.size).toBe(0);
    expect(document.body).not.toHaveClass('is-resizing');
  });

  it('previews locally and commits before pointerup persistence listeners run', () => {
    const onChange = vi.fn();
    const preview = vi.fn();
    const saved = vi.fn(() => expect(onChange).toHaveBeenCalledExactlyOnceWith(270));
    // Layout persistence is subscribed before a user starts dragging.
    window.addEventListener('pointerup', saved);
    try {
      const target = document.createElement('div');
      const { result } = renderHook(() => useResizable(220, 120, 400, onChange, 1, 'x', preview));
      act(() => result.current(pointerStart(target)));
      move(150); flush();
      expect(preview).toHaveBeenCalledExactlyOnceWith(270);
      expect(target).toHaveAttribute('aria-valuenow', '270');
      expect(onChange).not.toHaveBeenCalled();
      act(() => window.dispatchEvent(new Event('pointerup')));
      expect(saved).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledExactlyOnceWith(270);
    } finally { window.removeEventListener('pointerup', saved); }
  });

  it('clamps reverse vertical drags and ignores another pointer', () => {
    const onChange = vi.fn();
    const preview = vi.fn();
    const target = document.createElement('div');
    const { result } = renderHook(() => useResizable(220, 120, 400, onChange, -1, 'y', preview));
    act(() => result.current(pointerStart(target)));
    move(100, 2, 90); flush();
    expect(preview).not.toHaveBeenCalled();
    move(100, 1, -500); flush();
    expect(preview).toHaveBeenLastCalledWith(400);
    act(() => window.dispatchEvent(new Event('pointerup')));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(400);
  });

  it('restores an uncommitted preview and cancels frames when the owner unmounts', () => {
    const onChange = vi.fn();
    const preview = vi.fn();
    const target = document.createElement('div');
    const { result, unmount } = renderHook(() => useResizable(220, 120, 400, onChange, 1, 'x', preview));
    act(() => result.current(pointerStart(target)));
    move(150); flush();
    move(180);
    unmount();
    expect(preview).toHaveBeenLastCalledWith(220);
    expect(onChange).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(document.body).not.toHaveClass('is-resizing');
    move(190); flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('restores the original size without saving when a drag returns to its start', () => {
    const onChange = vi.fn();
    const preview = vi.fn();
    const target = document.createElement('div');
    const { result } = renderHook(() => useResizable(220, 120, 400, onChange, 1, 'x', preview));
    act(() => result.current(pointerStart(target)));
    move(600); flush();
    expect(preview).toHaveBeenLastCalledWith(400);
    move(100);
    act(() => window.dispatchEvent(new Event('pointerup')));
    expect(preview).toHaveBeenLastCalledWith(220);
    expect(onChange).not.toHaveBeenCalled();
    expect(target).toHaveAttribute('aria-valuenow', '220');
  });

  it.each(['size', 'reset', 'workspace'])('discards a stale preview after an external %s change', change => {
    const onChange = vi.fn();
    const preview = vi.fn();
    const target = document.createElement('div');
    const initialProps = { size: 220, reset: 0, workspace: 'first' };
    const { result, rerender } = renderHook(({ size, reset, workspace }) => useResizable(size, 120, 400, onChange, 1, 'x', preview, `${workspace}:${reset}`), { initialProps });
    act(() => result.current(pointerStart(target)));
    move(150); flush();
    move(180);
    const next = { ...initialProps, ...(change === 'size' ? { size: 310 } : change === 'reset' ? { reset: 1 } : { workspace: 'second' }) };
    rerender(next);
    expect(preview).toHaveBeenLastCalledWith(next.size);
    expect(frames.size).toBe(0);
    act(() => window.dispatchEvent(new Event('pointerup')));
    expect(onChange).not.toHaveBeenCalled();
    expect(document.body).not.toHaveClass('is-resizing');
  });

  it('uses the final pointerup position even before the next animation frame', () => {
    const onChange = vi.fn();
    const target = document.createElement('div');
    const { result } = renderHook(() => useResizable(220, 120, 400, onChange, 1, 'x', vi.fn()));
    act(() => result.current(pointerStart(target)));
    const release = new MouseEvent('pointerup', { clientX: 180 });
    Object.defineProperty(release, 'pointerId', { value: 1 });
    act(() => window.dispatchEvent(release));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(300);
    expect(frames.size).toBe(0);
  });

  it.each(['pointercancel', 'blur', 'lostpointercapture'])('commits the last position and cleans drag state on %s', eventName => {
    const target = document.createElement('div');
    const onChange = vi.fn();
    const { result } = renderHook(() => useResizable(220, 120, 400, onChange, 1, 'x', vi.fn()));
    act(() => result.current(pointerStart(target)));
    move(150);
    act(() => (eventName === 'lostpointercapture' ? target : window).dispatchEvent(new Event(eventName)));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(270);
    expect(frames.size).toBe(0);
    expect(document.body).not.toHaveClass('is-resizing');
  });
});
