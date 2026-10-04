import { useCallback, useEffect, useRef, useState } from 'react';

/** Pointer presses dismiss hover help before focus/click can open a menu. */
export function useStatusTooltip(menuOpen: boolean) {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const suppressed = useRef(false);
  const cancelTimer = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const dismiss = useCallback(() => {
    suppressed.current = true;
    cancelTimer();
    setShown(false);
  }, [cancelTimer]);
  const schedule = () => {
    if (menuOpen || suppressed.current) return;
    cancelTimer();
    setShown(false);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (!suppressed.current) setShown(true);
    }, 500);
  };
  useEffect(() => {
    if (menuOpen) cancelTimer();
    return cancelTimer;
  }, [menuOpen, cancelTimer]);
  return {
    visible: shown && !menuOpen,
    dismiss,
    onPointerDown: dismiss,
    onBlur: () => { cancelTimer(); setShown(false); },
    onKeyDown: (event: { key: string }) => { if (event.key === 'Enter' || event.key === ' ') dismiss(); },
    onFocus: schedule,
    onMouseEnter: () => { suppressed.current = false; schedule(); },
    onLeave: () => { dismiss(); suppressed.current = false; },
  };
}
