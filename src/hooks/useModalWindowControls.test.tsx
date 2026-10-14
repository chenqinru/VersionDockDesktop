import { cleanup, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { MockBridge } from '../platform/bridge';
import { BridgeContext } from '../platform/context';
import { useModalWindowControls } from './useModalWindowControls';

afterEach(cleanup);

function Modal({ open = true }: { open?: boolean }) {
  useModalWindowControls(open);
  return null;
}

function macBridge() {
  const bridge = new MockBridge(() => true);
  bridge.platform = () => 'macos';
  const visible = vi.spyOn(bridge.window, 'setControlsVisible').mockResolvedValue(undefined);
  return { bridge, visible };
}

it('restores native controls only after the last modal closes', async () => {
  const { bridge, visible } = macBridge();
  const view = render(<BridgeContext.Provider value={bridge}><Modal /><Modal /></BridgeContext.Provider>);
  await waitFor(() => expect(visible).toHaveBeenCalledExactlyOnceWith(false));
  view.rerender(<BridgeContext.Provider value={bridge}><Modal /></BridgeContext.Provider>);
  await Promise.resolve();
  expect(visible).toHaveBeenCalledExactlyOnceWith(false);
  view.unmount();
  await waitFor(() => expect(visible.mock.calls).toEqual([[false], [true]]));
});

it('serializes an unfinished hide with a rapid close and reopen', async () => {
  const { bridge, visible } = macBridge();
  let finishHide!: () => void;
  visible.mockImplementationOnce(() => new Promise<void>(resolve => { finishHide = resolve; }));
  const view = render(<BridgeContext.Provider value={bridge}><Modal /></BridgeContext.Provider>);
  await waitFor(() => expect(visible).toHaveBeenCalledExactlyOnceWith(false));
  view.rerender(<BridgeContext.Provider value={bridge}><Modal open={false} /></BridgeContext.Provider>);
  view.rerender(<BridgeContext.Provider value={bridge}><Modal /></BridgeContext.Provider>);
  finishHide();
  await Promise.resolve();
  await Promise.resolve();
  expect(visible).toHaveBeenCalledExactlyOnceWith(false);
  view.rerender(<BridgeContext.Provider value={bridge}><Modal open={false} /></BridgeContext.Provider>);
  await waitFor(() => expect(visible.mock.calls).toEqual([[false], [true]]));
});

it('coalesces StrictMode setup and cleanup without showing controls over a modal', async () => {
  const { bridge, visible } = macBridge();
  const view = render(<StrictMode><BridgeContext.Provider value={bridge}><Modal /></BridgeContext.Provider></StrictMode>);
  await waitFor(() => expect(visible).toHaveBeenCalledExactlyOnceWith(false));
  view.unmount();
  await waitFor(() => expect(visible.mock.calls).toEqual([[false], [true]]));
});

it('keeps each window independent', async () => {
  const first = macBridge(), second = macBridge();
  const a = render(<BridgeContext.Provider value={first.bridge}><Modal /></BridgeContext.Provider>);
  const b = render(<BridgeContext.Provider value={second.bridge}><Modal /></BridgeContext.Provider>);
  await waitFor(() => expect(first.visible).toHaveBeenCalledExactlyOnceWith(false));
  await waitFor(() => expect(second.visible).toHaveBeenCalledExactlyOnceWith(false));
  a.unmount();
  await waitFor(() => expect(first.visible.mock.calls).toEqual([[false], [true]]));
  expect(second.visible).toHaveBeenCalledExactlyOnceWith(false);
  b.unmount();
  await waitFor(() => expect(second.visible.mock.calls).toEqual([[false], [true]]));
});

it.each(['windows', 'linux'] as const)('leaves %s controls to the webview overlay', async platform => {
  const { bridge, visible } = macBridge();
  bridge.platform = () => platform;
  const view = render(<BridgeContext.Provider value={bridge}><Modal /></BridgeContext.Provider>);
  await Promise.resolve();
  view.unmount();
  await Promise.resolve();
  expect(visible).not.toHaveBeenCalled();
});

it('recovers after a native failure without an unhandled rejection', async () => {
  const { bridge, visible } = macBridge();
  visible.mockRejectedValueOnce(new Error('Window unavailable'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const view = render(<BridgeContext.Provider value={bridge}><Modal /></BridgeContext.Provider>);
    await waitFor(() => expect(warning).toHaveBeenCalledOnce());
    view.rerender(<BridgeContext.Provider value={bridge}><Modal /><Modal /></BridgeContext.Provider>);
    await waitFor(() => expect(visible.mock.calls).toEqual([[false], [false]]));
    view.unmount();
    await waitFor(() => expect(visible.mock.calls).toEqual([[false], [false], [true]]));
  } finally {
    warning.mockRestore();
  }
});
