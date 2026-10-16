import { useEffect, useState } from 'react';
import type { VersionDockBridge } from '../platform/bridge';

export function useWindowFullscreen(bridge: VersionDockBridge, enabled = true): boolean {
  const [state, setState] = useState({ bridge, fullscreen: false });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void bridge.window.onFullscreenChanged(fullscreen => {
      if (active) setState(previous => previous.bridge === bridge && previous.fullscreen === fullscreen
        ? previous : { bridge, fullscreen });
    }).then(dispose => {
      if (active) unlisten = dispose;
      else dispose();
    }).catch(error => { if (active) console.warn('Unable to observe fullscreen state', error); });
    return () => { active = false; unlisten?.(); };
  }, [bridge, enabled]);
  return enabled && state.bridge === bridge && state.fullscreen;
}
