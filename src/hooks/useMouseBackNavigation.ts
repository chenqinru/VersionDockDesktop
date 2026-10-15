import { useEffect } from 'react';

function visible(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

/** Mouse button 3 is the browser back button. Reuse the current page's action. */
export function useMouseBackNavigation() {
  useEffect(() => {
    const handle = (event: MouseEvent) => {
      if (event.button !== 3 || event.defaultPrevented) return;
      // Cancel native webview history on every phase; invoke once on release.
      event.preventDefault();
      if (event.type !== 'mouseup') return;
      const overlays = document.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"]');
      if ([...overlays].some(visible)) return;
      const actions = [...document.querySelectorAll<HTMLButtonElement>('button[data-navigation-back]')].filter(visible);
      // The main page takes precedence over a side-panel comparison.
      const action = actions.filter(button => button.closest('.workspace-slot')).at(-1) ?? actions.at(-1);
      if (action && !action.matches(':disabled') && action.getAttribute('aria-disabled') !== 'true') action.click();
    };
    window.addEventListener('mousedown', handle, true);
    window.addEventListener('mouseup', handle, true);
    window.addEventListener('auxclick', handle, true);
    return () => {
      window.removeEventListener('mousedown', handle, true);
      window.removeEventListener('mouseup', handle, true);
      window.removeEventListener('auxclick', handle, true);
    };
  }, []);
}
