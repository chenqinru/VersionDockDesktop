import { useEffect, useMemo, useRef, useState } from 'react';
import type { VersionDockBridge } from '../platform/bridge';

// Wait for committed pixels, and after a native resize let viewport events settle.
// Hidden/minimized webviews must not get stuck waiting for animation frames.
export function waitForWindowPaint(signal: AbortSignal, resizing = false): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let frame = 0;
    let quiet = 0;
    const finish = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(quiet);
      window.clearTimeout(fallback);
      window.removeEventListener('resize', resized);
      signal.removeEventListener('abort', finish);
      resolve(!signal.aborted);
    };
    const paint = () => {
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(finish);
      });
    };
    const resized = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(quiet);
      quiet = window.setTimeout(paint, 64);
    };
    const fallback = window.setTimeout(finish, document.hidden ? 0 : resizing ? 750 : 120);
    signal.addEventListener('abort', finish, { once: true });
    if (resizing) {
      window.addEventListener('resize', resized);
      resized();
    } else paint();
  });
}

export function useWorkspaceWindowMode(bridge: VersionDockBridge, ready: boolean, workspace: boolean): boolean {
  const [transferring, setTransferring] = useState(() => new URLSearchParams(window.location.search).has('tabTransfer'));
  const transfer = useRef(transferring);
  // Identity distinguishes returning to welcome from a previous welcome frame
  // while an obsolete workspace resize may still be queued in the native bridge.
  const target = useMemo(() => ({ bridge, workspace }), [bridge, workspace]);
  const [settled, setSettled] = useState<typeof target | null>(() => workspace && !transferring ? null : target);
  const transitioning = ready && !transferring && settled !== target;

  useEffect(() => {
    if (!ready || (transfer.current && !workspace)) return;
    const preserve = transfer.current && workspace;
    const controller = new AbortController();
    void (async () => {
      // The mask must paint before changing native bounds in either direction.
      if (!preserve && !await waitForWindowPaint(controller.signal)) return;
      try {
        await bridge.window.setWorkspaceMode(workspace, preserve);
      } catch (error) {
        console.warn('Unable to restore window layout', error);
      }
      if (!preserve && !await waitForWindowPaint(controller.signal, true)) return;
      if (!controller.signal.aborted) {
        transfer.current = false;
        setTransferring(false);
        setSettled(target);
      }
    })();
    return () => controller.abort();
  }, [bridge, ready, workspace, target]);

  return transitioning;
}
