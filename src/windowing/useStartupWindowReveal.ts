import { useEffect, useRef, type RefObject } from 'react';
import type { VersionDockBridge } from '../platform/bridge';

export function useStartupWindowReveal(bridge: VersionDockBridge, initialized: boolean, transferred: boolean): RefObject<HTMLDivElement> {
  const revealed = useRef(false);
  const shell = useRef<HTMLDivElement>(null);
  const userInteracted = useRef(false);

  useEffect(() => {
    const markInteraction = () => { userInteracted.current = true; };
    const clearInitialToolbarFocus = (event: FocusEvent) => {
      if (revealed.current && !userInteracted.current
        && event.target instanceof Element && event.target.matches('.titlebar-actions button')
        && !document.querySelector('[aria-modal="true"]')) {
        shell.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener('pointerdown', markInteraction, { capture: true, once: true });
    window.addEventListener('keydown', markInteraction, { capture: true, once: true });
    window.addEventListener('click', markInteraction, { capture: true, once: true });
    window.addEventListener('focusin', clearInitialToolbarFocus, true);
    return () => {
      window.removeEventListener('pointerdown', markInteraction, true);
      window.removeEventListener('keydown', markInteraction, true);
      window.removeEventListener('click', markInteraction, true);
      window.removeEventListener('focusin', clearInitialToolbarFocus, true);
    };
  }, []);

  useEffect(() => {
    if (revealed.current || (!transferred && !initialized)) return;
    // React has committed the shell and applied its theme in layout effects.
    // Do not wait on animation frames: hidden webviews may throttle them.
    revealed.current = true;
    // Give the webview a neutral initial focus instead of its first toolbar button.
    // This runs only once so later updates and dialog dismissal keep user focus.
    const focusShell = () => {
      if (!userInteracted.current && !document.querySelector('[aria-modal="true"]')) {
        shell.current?.focus({ preventScroll: true });
      }
    };
    focusShell();
    // AppKit can focus the first DOM control while making WKWebView the responder.
    void bridge.window.show().then(focusShell)
      .catch((error) => console.warn('Unable to show startup window', error));
  }, [bridge, initialized, transferred]);
  return shell;
}
