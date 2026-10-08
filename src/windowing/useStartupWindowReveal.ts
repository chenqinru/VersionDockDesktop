import { useEffect, useRef } from 'react';
import type { VersionDockBridge } from '../platform/bridge';

export function useStartupWindowReveal(bridge: VersionDockBridge, initialized: boolean, transferred: boolean): void {
  const revealed = useRef(false);

  useEffect(() => {
    if (revealed.current || (!transferred && !initialized)) return;
    // React has committed the shell and applied its theme in layout effects.
    // Do not wait on animation frames: hidden webviews may throttle them.
    revealed.current = true;
    void bridge.window.show().catch((error) => console.warn('Unable to show startup window', error));
  }, [bridge, initialized, transferred]);
}
