import { useContext, useLayoutEffect } from 'react';
import type { VersionDockBridge } from '../platform/bridge';
import { BridgeContext } from '../platform/context';

interface WindowControlsState {
  dialogs: number;
  visible: boolean;
  pending: Promise<void>;
}

const windows = new WeakMap<VersionDockBridge, WindowControlsState>();

/** Native macOS controls sit above the webview, so modal backdrops cannot cover them. */
export function useModalWindowControls(open: boolean) {
  const bridge = useContext(BridgeContext);
  useLayoutEffect(() => {
    if (!open || !bridge || bridge.platform() !== 'macos') return;
    let state = windows.get(bridge);
    if (!state) {
      state = { dialogs: 0, visible: true, pending: Promise.resolve() };
      windows.set(bridge, state);
    }
    const controls = state;
    const sync = () => {
      // Serialize native calls and read the latest count, including rapid close/reopen.
      controls.pending = controls.pending.then(async () => {
        const visible = controls.dialogs === 0;
        if (visible === controls.visible) return;
        await bridge.window.setControlsVisible(visible);
        controls.visible = visible;
      }).catch(error => console.warn('Unable to update native window controls', error));
    };
    controls.dialogs += 1;
    sync();
    return () => {
      controls.dialogs -= 1;
      sync();
    };
  }, [open, bridge]);
}
