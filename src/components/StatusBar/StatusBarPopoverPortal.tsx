import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Escape the footer's stacking context so popovers stay above workspace panels. */
export function StatusBarPopoverPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
