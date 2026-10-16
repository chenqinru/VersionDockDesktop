import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockBridge, type VersionDockBridge } from '../platform/bridge';
import { useWindowFullscreen } from './useWindowFullscreen';

function State({ bridge, enabled = true }: { bridge: VersionDockBridge; enabled?: boolean }) {
  return <output>{useWindowFullscreen(bridge, enabled) ? 'Fullscreen' : 'Windowed'}</output>;
}
afterEach(cleanup);

describe('window fullscreen subscription', () => {
  it('tracks entering and exiting native fullscreen', async () => {
    const bridge = new MockBridge(() => null);
    let change!: (fullscreen: boolean) => void;
    const dispose = vi.fn();
    vi.spyOn(bridge.window, 'onFullscreenChanged').mockImplementation(async handler => { change = handler; handler(true); return dispose; });
    const view = render(<State bridge={bridge} />);
    expect(screen.getByRole('status')).toHaveTextContent('Fullscreen');
    act(() => change(false));
    expect(screen.getByRole('status')).toHaveTextContent('Windowed');
    await act(async () => {});
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not query native state when disabled', () => {
    const bridge = new MockBridge(() => null);
    const subscribe = vi.spyOn(bridge.window, 'onFullscreenChanged');
    render(<State bridge={bridge} enabled={false} />);
    expect(subscribe).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Windowed');
  });

  it('disposes subscriptions that resolve after unmount', async () => {
    const bridge = new MockBridge(() => null);
    const dispose = vi.fn();
    let resolve!: (dispose: () => void) => void;
    vi.spyOn(bridge.window, 'onFullscreenChanged').mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = render(<State bridge={bridge} />);
    view.unmount();
    await act(async () => resolve(dispose));
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('ignores old window callbacks after switching bridges', async () => {
    const old = new MockBridge(() => null);
    const current = new MockBridge(() => null);
    let stale!: (fullscreen: boolean) => void;
    const dispose = vi.fn();
    vi.spyOn(old.window, 'onFullscreenChanged').mockImplementation(async handler => { stale = handler; handler(true); return dispose; });
    const view = render(<State bridge={old} />);
    await act(async () => {});
    view.rerender(<State bridge={current} />);
    act(() => stale(true));
    expect(screen.getByRole('status')).toHaveTextContent('Windowed');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps the safe windowed layout if subscribing fails', async () => {
    const bridge = new MockBridge(() => null);
    const error = new Error('No native window');
    vi.spyOn(bridge.window, 'onFullscreenChanged').mockRejectedValue(error);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      render(<State bridge={bridge} />);
      await act(async () => {});
      expect(screen.getByRole('status')).toHaveTextContent('Windowed');
      expect(warning).toHaveBeenCalledWith('Unable to observe fullscreen state', error);
    } finally { warning.mockRestore(); }
  });
});
