import { useEffect, useRef } from 'react';
import type { VersionDockBridge } from '../platform/bridge';

// Let the destination page paint before resizing its native window. Content
// stays visible throughout; native code handles viewport fitting and confirmation.
export function waitForWindowPaint(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let frame = 0;
    let painted = false;
    const finish = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
      document.removeEventListener('visibilitychange', visibilityChanged);
      signal.removeEventListener('abort', finish);
      resolve(!signal.aborted);
    };
    const paint = () => {
      if (painted) { finish(); return; }
      painted = true;
      frame = window.requestAnimationFrame(paint);
    };
    const visibilityChanged = () => { if (document.hidden) finish(); };
    const fallback = window.setTimeout(finish, document.hidden ? 0 : 120);
    signal.addEventListener('abort', finish, { once: true });
    document.addEventListener('visibilitychange', visibilityChanged);
    frame = window.requestAnimationFrame(paint);
  });
}

export function useWorkspaceWindowMode(bridge: VersionDockBridge, ready: boolean, workspace: boolean): void {
  const transfer = useRef(new URLSearchParams(window.location.search).has('tabTransfer'));

  useEffect(() => {
    if (!ready || (transfer.current && !workspace)) return;
    const preserve = transfer.current && workspace;
    const controller = new AbortController();
    void (async () => {
      // Page changes never wait for an old resize, a native reply or a mask.
      if (!preserve && !await waitForWindowPaint(controller.signal)) return;
      try {
        await bridge.window.setWorkspaceMode(workspace, preserve);
      } catch (error) {
        if (!controller.signal.aborted) console.warn('Unable to restore window layout', error);
      }
      if (!controller.signal.aborted) transfer.current = false;
    })();
    return () => controller.abort();
  }, [bridge, ready, workspace]);
}
