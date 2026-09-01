import { useCallback, useEffect, useRef } from 'react';

export function useResizable(
  current: number,
  min: number,
  max: number,
  onChange: (value: number) => void,
  direction: 1 | -1 = 1,
  axis: 'x' | 'y' = 'x',
) {
  const cleanupRef = useRef<(() => void) | null>(null);

  const cleanup = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  return useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    cleanup();
    const start = axis === 'x' ? event.clientX : event.clientY;
    const initial = current;
    const target = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    const move = (next: PointerEvent) => {
      const currentPos = axis === 'x' ? next.clientX : next.clientY;
      onChange(Math.min(max, Math.max(min, initial + (currentPos - start) * direction)));
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      target.removeEventListener('lostpointercapture', finish);
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      document.body.classList.remove('is-resizing');
      if (cleanupRef.current === finish) cleanupRef.current = null;
    };
    cleanupRef.current = finish;
    document.body.classList.add('is-resizing');
    target.setPointerCapture?.(pointerId);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    target.addEventListener('lostpointercapture', finish);
  }, [axis, cleanup, current, direction, max, min, onChange]);
}
