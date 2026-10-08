import { useRef } from 'react';

/** Keep a trigger press stable if outside-click or blur closes the popover before click. */
export function usePopoverToggleState(open: boolean) {
  const pressedOpen = useRef<boolean>();
  const clear = () => { pressedOpen.current = undefined; };
  return {
    onPointerDown: (event: { button: number }) => {
      pressedOpen.current = event.button > 0 ? undefined : open;
    },
    onPointerCancel: clear,
    onKeyDown: (event: { key: string }) => {
      if (event.key === 'Enter' || event.key === ' ') clear();
    },
    clear,
    consume: () => {
      const wasOpen = pressedOpen.current ?? open;
      clear();
      return wasOpen;
    },
  };
}
