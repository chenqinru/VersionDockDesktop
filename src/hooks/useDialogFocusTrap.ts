import { useEffect, useLayoutEffect, useRef } from 'react';
import { useModalWindowControls } from './useModalWindowControls';

export function useDialogFocusTrap(open: boolean, close: () => void, returnFocus?: HTMLElement | null) {
  useModalWindowControls(open);
  const dialog = useRef<HTMLElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const closeRef = useRef(close);
  useLayoutEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    if (!open) return;
    previous.current = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]') ?? [])]
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled, input[type="hidden"]') && !element.closest('[hidden], [aria-hidden="true"]'));
    queueMicrotask(() => {
      if (dialog.current?.contains(document.activeElement)) return;
      focusable()[0]?.focus();
    });
    const topmostModal = () => {
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
      return modals.at(-1);
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[role="menu"]')) return;
      if (topmostModal() !== dialog.current) return;
      if (event.key === 'Escape' && dialog.current?.querySelector('[role="search"], [role="listbox"]')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const values = focusable();
      if (!values.length) return;
      const first = values[0], last = values.at(-1)!;
      // Options use programmatic focus; Tab continues from their owning selection control.
      const active = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest('.vd-select')?.querySelector('[role="combobox"]') ?? document.activeElement
        : document.activeElement;
      if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      queueMicrotask(() => {
        const target = previous.current;
        if (!target?.isConnected) return;
        // A following workflow step may already have opened another modal.
        // Restore into a remaining parent, but never steal focus from the new dialog.
        const remaining = topmostModal();
        if (!remaining || remaining.contains(target)) target.focus();
      });
    };
  }, [open, returnFocus]);
  return dialog;
}
