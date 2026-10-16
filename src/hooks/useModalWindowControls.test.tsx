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

function macBridge(platform: 'macos' | 'windows' = 'macos') {
  const bridge = new MockBridge(() => true);
  bridge.platform = () => platform;
  const visible = vi.spyOn(bridge.window, 'setControlsVisible').mockResolvedValue(undefined);
  return { bridge, visible };
}

it.each(['macos', 'windows'] as const)('restores %s controls only after the last modal closes', async platform => {
  const { bridge, visible } = macBridge(platform);
  const view = render(<BridgeContext.Provider value={bridge}><Modal /><Modal /></BridgeContext.Provider>);
  await waitFor(() => expect(visible).toHaveBeenCalledExactlyOnceWith(false));
  if (platform === 'windows') expect(document.documentElement).toHaveAttribute('data-window-controls-blocked', 'true');
  view.rerender(<BridgeContext.Provider value={bridge}><Modal /></BridgeContext.Provider>);
  await Promise.resolve();
  expect(visible).toHaveBeenCalledExactlyOnceWith(false);
  view.unmount();
  await waitFor(() => expect(visible.mock.calls).toEqual([[false], [true]]));
  expect(document.documentElement).not.toHaveAttribute('data-window-controls-blocked');
});

it.each(['macos', 'windows'] as const)('serializes %s hiding with a rapid close and reopen', async platform => {
  const { bridge, visible } = macBridge(platform);
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

it.each(['macos', 'windows'] as const)('coalesces %s StrictMode setup and cleanup without showing controls over a modal', async platform => {
  const { bridge, visible } = macBridge(platform);
  const view = render(<StrictMode><BridgeContext.Provider value={bridge}><Modal /></BridgeContext.Provider></StrictMode>);
  await waitFor(() => expect(visible).toHaveBeenCalledExactlyOnceWith(false));
  view.unmount();
  await waitFor(() => expect(visible.mock.calls).toEqual([[false], [true]]));
});

it('hides a Windows native snap surface injected after the modal opens', async () => {
  const { bridge, visible } = macBridge('windows');
  const view = render(<BridgeContext.Provider value={bridge}><Modal /></BridgeContext.Provider>);
  await waitFor(() => expect(visible).toHaveBeenCalledExactlyOnceWith(false));
  const caption = document.createElement('div');
  caption.id = 'tbo-controls';
  document.body.append(caption);
  try {
    await waitFor(() => expect(visible.mock.calls).toEqual([[false], [false]]));
    expect(caption.inert).toBe(true);
    view.unmount();
    await waitFor(() => expect(visible.mock.calls).toEqual([[false], [false], [true]]));
    expect(caption.inert).toBe(false);
  } finally { caption.remove(); }
});

it('keeps existing Windows captions inert until the last nested modal closes', async () => {
  const caption = document.createElement('div');
  caption.id = 'tbo-controls';
  document.body.append(caption);
  const { bridge } = macBridge('windows');
  const view = render(<BridgeContext.Provider value={bridge}><Modal /><Modal /></BridgeContext.Provider>);
  try {
    expect(caption.inert).toBe(true);
    view.rerender(<BridgeContext.Provider value={bridge}><Modal /></BridgeContext.Provider>);
    expect(caption.inert).toBe(true);
    view.unmount();
    expect(caption.inert).toBe(false);
  } finally { caption.remove(); }
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

it.each(['linux'] as const)('leaves %s controls to the webview overlay', async platform => {
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
