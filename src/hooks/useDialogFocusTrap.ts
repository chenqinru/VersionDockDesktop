import { useEffect, useLayoutEffect, useRef } from 'react';

export function useDialogFocusTrap(open: boolean, close: () => void, returnFocus?: HTMLElement | null) {
  const dialog = useRef<HTMLElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const closeRef = useRef(close);
  useLayoutEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    if (!open) return;
    previous.current = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    queueMicrotask(() => {
      if (dialog.current?.contains(document.activeElement)) return;
      dialog.current?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus();
    });
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[role="menu"]')) return;
      const modals = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter(element => getComputedStyle(element).display !== 'none');
      const layer = (element: HTMLElement) => {
        let value = 0;
        for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
          const z = Number.parseInt(getComputedStyle(parent).zIndex, 10);
          if (Number.isFinite(z)) value = Math.max(value, z);
        }
        return value;
      };
      modals.sort((a, b) => layer(a) - layer(b));
      if (modals.at(-1) !== dialog.current) return;
      if (event.key === 'Escape' && dialog.current?.querySelector('[role="search"]')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const values = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (!values.length) return;
      const first = values[0], last = values.at(-1)!;
      if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); queueMicrotask(() => previous.current?.focus()); };
  }, [open, returnFocus]);
  return dialog;
}
