import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

export function useResizable(
  current: number,
  min: number,
  max: number,
  onChange: (value: number) => void,
  direction: 1 | -1 = 1,
  axis: 'x' | 'y' = 'x',
  preview?: (value: number) => void,
  resetKey?: unknown,
) {
  const cleanupRef = useRef<((restore?: number) => void) | null>(null);
  const cleanup = useCallback((restore?: number) => {
    cleanupRef.current?.(restore);
    cleanupRef.current = null;
  }, []);
  useEffect(() => cleanup, [cleanup]);
  const hasPreview = Boolean(preview);
  // A reset, workspace switch or external size change supersedes an active
  // local preview. Restoring the latest value prevents stale pointerup writes.
  useLayoutEffect(() => {
    if (hasPreview) cleanup(current);
  }, [cleanup, current, hasPreview, max, min, resetKey]);

  return useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    cleanup();
    const start = axis === 'x' ? event.clientX : event.clientY;
    const initial = current;
    const target = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    let value = initial;
    let displayed = initial;
    let frame: number | undefined;
    let active = true;
    const matches = (next: Event) => !('pointerId' in next) || next.pointerId === pointerId;
    const read = (next: PointerEvent) => {
      const position = axis === 'x' ? next.clientX : next.clientY;
      value = Math.min(max, Math.max(min, initial + (position - start) * direction));
    };
    const paint = () => {
      frame = undefined;
      if (displayed === value) return;
      displayed = value;
      (preview ?? onChange)(value);
      target.setAttribute('aria-valuenow', String(Math.round(value)));
    };
    const move = (next: PointerEvent) => {
      if (!matches(next)) return;
      read(next);
      if (frame === undefined) frame = requestAnimationFrame(paint);
    };
    const finish = (commit: boolean, restore = initial) => {
      if (!active) return;
      active = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (commit) {
        paint();
        if (preview && value !== initial) onChange(value);
      } else if (preview && displayed !== restore) {
        preview(restore);
        target.setAttribute('aria-valuenow', String(Math.round(restore)));
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', released, true);
      window.removeEventListener('pointercancel', stopped, true);
      window.removeEventListener('blur', stopped);
      target.removeEventListener('lostpointercapture', stopped);
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      document.body.classList.remove('is-resizing');
      if (cleanupRef.current === cancel) cleanupRef.current = null;
    };
    const released = (next: PointerEvent) => {
      if (!matches(next)) return;
      if ('clientX' in next) read(next);
      finish(true);
    };
    const stopped = (next: Event) => { if (matches(next)) finish(true); };
    const cancel = (restore?: number) => finish(false, restore);
    cleanupRef.current = cancel;
    document.body.classList.add('is-resizing');
    target.setPointerCapture?.(pointerId);
    window.addEventListener('pointermove', move);
    // Commit before the store's pointerup persistence listener flushes layout.
    window.addEventListener('pointerup', released, true);
    window.addEventListener('pointercancel', stopped, true);
    window.addEventListener('blur', stopped);
    target.addEventListener('lostpointercapture', stopped);
  }, [axis, cleanup, current, direction, max, min, onChange, preview]);
}
