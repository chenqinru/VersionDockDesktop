import { useEffect, useMemo, useRef, useState } from 'react';
import type { VersionDockBridge } from '../platform/bridge';
import type { WindowViewport } from '../bindings/generated';

// Confirm the web viewport has caught up to the native content bounds and stayed
// unchanged across layout opportunities. RAF is not an OS compositor fence.
export function waitForWindowPaint(signal: AbortSignal, viewport?: WindowViewport): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let frame = 0;
    let previous = '';
    const finish = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
      window.removeEventListener('resize', resized);
      document.removeEventListener('visibilitychange', visibilityChanged);
      signal.removeEventListener('abort', finish);
      resolve(!signal.aborted);
    };
    const paint = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      // Reading client dimensions flushes pending document layout. Allow one CSS
      // pixel for native physical/logical rounding on fractional-scale displays.
      const layoutWidth = document.documentElement.clientWidth;
      const layoutHeight = document.documentElement.clientHeight;
      const matches = !viewport || (typeof viewport.width === 'number' && typeof viewport.height === 'number'
        && Math.abs(width - viewport.width) <= 1 && Math.abs(height - viewport.height) <= 1);
      const laidOut = layoutWidth > 0 && layoutHeight > 0
        && Math.abs(layoutWidth - width) <= 1 && Math.abs(layoutHeight - height) <= 1;
      const sample = `${width}:${height}:${layoutWidth}:${layoutHeight}`;
      if (matches && laidOut && previous === sample) { finish(); return; }
      previous = matches && laidOut ? sample : '';
      frame = window.requestAnimationFrame(paint);
    };
    const resized = () => {
      previous = '';
    };
    const visibilityChanged = () => { if (document.hidden) finish(); };
    const fallback = window.setTimeout(finish, document.hidden ? 0 : viewport ? 1200 : 120);
    signal.addEventListener('abort', finish, { once: true });
    window.addEventListener('resize', resized);
    document.addEventListener('visibilitychange', visibilityChanged);
    frame = window.requestAnimationFrame(paint);
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
      let viewport: WindowViewport | undefined;
      try {
        viewport = await bridge.window.setWorkspaceMode(workspace, preserve);
      } catch (error) {
        console.warn('Unable to restore window layout', error);
      }
      if (!preserve && !await waitForWindowPaint(controller.signal, viewport)) return;
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
