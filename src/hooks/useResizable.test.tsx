import { act, renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useResizable } from './useResizable';

function pointerStart(target: HTMLElement, clientX = 100): ReactPointerEvent {
  return {
    preventDefault: vi.fn(),
    clientX,
    clientY: 0,
    pointerId: 1,
    currentTarget: target,
  } as unknown as ReactPointerEvent;
}

afterEach(() => {
  document.body.classList.remove('is-resizing');
});

describe('useResizable', () => {
  it('cleans global drag state when the owner unmounts', () => {
    const onChange = vi.fn();
    const target = document.createElement('div');
    const { result, unmount } = renderHook(() => useResizable(220, 120, 400, onChange));

    act(() => result.current(pointerStart(target)));
    expect(document.body).toHaveClass('is-resizing');
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 150 })));
    expect(onChange).toHaveBeenLastCalledWith(270);

    unmount();
    expect(document.body).not.toHaveClass('is-resizing');
    onChange.mockClear();
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 180 })));
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(['pointercancel', 'blur'])('cleans drag state on %s', (eventName) => {
    const target = document.createElement('div');
    const { result } = renderHook(() => useResizable(220, 120, 400, vi.fn()));

    act(() => result.current(pointerStart(target)));
    act(() => window.dispatchEvent(new Event(eventName)));

    expect(document.body).not.toHaveClass('is-resizing');
  });
});
