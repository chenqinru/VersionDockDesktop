import { useContext, useLayoutEffect } from 'react';
import type { VersionDockBridge } from '../platform/bridge';
import { BridgeContext } from '../platform/context';

interface WindowControlsState {
  dialogs: number;
  visible: boolean;
  pending: Promise<void>;
}

const windows = new WeakMap<VersionDockBridge, WindowControlsState>();

/** macOS native controls and the Windows snap hit surface sit above webview modals. */
export function useModalWindowControls(open: boolean) {
  const bridge = useContext(BridgeContext);
  useLayoutEffect(() => {
    if (!open || !bridge || bridge.platform() === 'linux') return;
    let state = windows.get(bridge);
    if (!state) {
      state = { dialogs: 0, visible: true, pending: Promise.resolve() };
      windows.set(bridge, state);
    }
    const controls = state;
    const sync = (force = false) => {
      // Serialize native calls and read the latest count, including rapid close/reopen.
      controls.pending = controls.pending.then(async () => {
        const visible = controls.dialogs === 0;
        if (visible === controls.visible && !force) return;
        await bridge.window.setControlsVisible(visible);
        controls.visible = visible;
      }).catch(error => console.warn('Unable to update native window controls', error));
    };
    const blockCaption = (blocked: boolean) => {
      if (bridge.platform() !== 'windows') return;
      // Leave DOM captions visible beneath the same backdrop as Linux, while
      // excluding them from keyboard focus and pointer interaction.
      const caption = document.getElementById('tbo-controls');
      if (caption) caption.inert = blocked;
      if (blocked) document.documentElement.dataset.windowControlsBlocked = 'true';
      else delete document.documentElement.dataset.windowControlsBlocked;
    };
    controls.dialogs += 1;
    blockCaption(true);
    sync();
    // A caption runtime can arrive after the first modal (for example startup
    // diagnostics). Reapply native hiding when its controls are first injected.
    let caption = document.getElementById('tbo-controls');
    const observer = bridge.platform() === 'windows' ? new MutationObserver(() => {
      const current = document.getElementById('tbo-controls');
      if (current && current !== caption) { caption = current; blockCaption(controls.dialogs > 0); sync(true); }
    }) : undefined;
    observer?.observe(document.body, { childList: true });
    return () => {
      observer?.disconnect();
      controls.dialogs -= 1;
      if (controls.dialogs === 0) blockCaption(false);
      sync();
    };
  }, [open, bridge]);
}
