import { useCallback } from 'react';

export function useResizable(current: number, min: number, max: number, onChange: (value: number) => void, direction: 1 | -1 = 1) {
  return useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const start = event.clientX;
    const initial = current;
    const move = (next: PointerEvent) => onChange(Math.min(max, Math.max(min, initial + (next.clientX - start) * direction)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-resizing');
    };
    document.body.classList.add('is-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [current, min, max, onChange, direction]);
}
