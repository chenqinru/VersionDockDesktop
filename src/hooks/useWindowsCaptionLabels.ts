import { useEffect } from 'react';
import type { VersionDockBridge } from '../platform/bridge';

/** The injected caption runtime may arrive late or reset labels on native resize. */
export function useWindowsCaptionLabels(bridge: VersionDockBridge, t: (message: string) => string) {
  useEffect(() => {
    if (bridge.platform() !== 'windows') return;
    const update = () => {
      const controls = document.getElementById('tbo-controls');
      if (!controls) return;
      for (const [selector, action] of [['.tbo-min', 'Minimize'], ['.tbo-max', 'Maximize'], ['.tbo-close', 'Close']]) {
        const button = controls.querySelector<HTMLButtonElement>(selector);
        if (!button) continue;
        let key = action;
        if (action === 'Maximize') {
          const nativeLabel = button.getAttribute('aria-label');
          if (nativeLabel === 'Restore' || nativeLabel === 'Maximize') button.dataset.captionAction = nativeLabel;
          key = button.dataset.captionAction ?? action;
        }
        const label = t(key);
        if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
        if (button.title !== label) button.title = label;
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
    return () => observer.disconnect();
  }, [bridge, t]);
}
