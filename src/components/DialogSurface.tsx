import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';

type Props = HTMLAttributes<HTMLElement> & {
  onClose: () => void;
  closeDisabled?: boolean;
  backdropClassName?: string;
  preserveStyle?: boolean;
  size?: 'small' | 'medium' | 'large';
  style?: CSSProperties;
};

/** Shared modal sizing and behavior; tool windows can retain their own layout. */
export const DialogSurface = forwardRef<HTMLElement, Props>(function DialogSurface({
  onClose, closeDisabled = false, backdropClassName = '', preserveStyle = false, size, className = '', children, ...props
}, forwardedRef) {
  const closeRef = useRef(onClose);
  const disabledRef = useRef(closeDisabled);
  useLayoutEffect(() => { closeRef.current = onClose; disabledRef.current = closeDisabled; }, [onClose, closeDisabled]);
  const [trigger] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const dialog = useDialogFocusTrap(true, () => { if (!disabledRef.current) closeRef.current(); }, trigger);
  const [layer, setLayer] = useState(10000);
  useImperativeHandle(forwardedRef, () => dialog.current!, [dialog]);
  useLayoutEffect(() => {
    let highest = 9999;
    for (const other of document.querySelectorAll<HTMLElement>('[aria-modal="true"]')) {
      if (other === dialog.current || getComputedStyle(other).display === 'none') continue;
      for (let parent: HTMLElement | null = other; parent; parent = parent.parentElement) {
        const z = Number.parseInt(getComputedStyle(parent).zIndex, 10);
        if (Number.isFinite(z)) highest = Math.max(highest, z);
      }
    }
    setLayer(highest + 1);
  }, [dialog]);
  return createPortal(<div className={`vd-dialog-backdrop ${backdropClassName}`} style={{ zIndex: layer }} role="presentation"
    onClick={event => { if (event.target === event.currentTarget && !disabledRef.current) closeRef.current(); }}>
    <section {...props} ref={dialog} data-dialog-size={size} className={`${preserveStyle ? '' : 'vd-dialog'} ${className}`.trim()} role="dialog" aria-modal="true">{children}</section>
  </div>, document.body);
});
