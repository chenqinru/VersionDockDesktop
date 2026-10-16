import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBridge, type VersionDockBridge } from '../platform/bridge';
import type { WindowViewport } from '../bindings/generated';
import { useWorkspaceWindowMode, waitForWindowPaint } from './useWorkspaceWindowMode';

function Shell({ bridge, workspace, ready = true }: { bridge: VersionDockBridge; workspace: boolean; ready?: boolean }) {
  useWorkspaceWindowMode(bridge, ready, workspace);
  return null;
}

const viewport = { width: 1024, height: 768 };
const advance = async (ms = 160) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(performance.now()), 16));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => window.clearTimeout(id));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('workspace window mode', () => {
  it.each(['windows', 'linux', 'macos'] as const)('paints the destination before requesting either native resize on %s', async platform => {
    const bridge = new MockBridge(() => null);
    vi.spyOn(bridge, 'platform').mockReturnValue(platform);
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode').mockResolvedValue(viewport);
    const view = render(<Shell bridge={bridge} workspace={false} />);
    await advance();
    mode.mockClear();
    view.rerender(<Shell bridge={bridge} workspace />);
    expect(mode).not.toHaveBeenCalled();
    await advance(16);
    expect(mode).not.toHaveBeenCalled();
    await advance(16);
    expect(mode).toHaveBeenCalledExactlyOnceWith(true, false);
    mode.mockClear();
    view.rerender(<Shell bridge={bridge} workspace={false} />);
    await advance(32);
    expect(mode).toHaveBeenCalledExactlyOnceWith(false, false);
    // Native code owns final viewport confirmation; no second frontend wait.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resize the project again when switching between project tabs', async () => {
    const bridge = new MockBridge(() => null);
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode').mockResolvedValue(viewport);
    const view = render(<Shell bridge={bridge} workspace />);
    await advance();
    mode.mockClear();
    view.rerender(<Shell bridge={bridge} workspace />);
    await advance();
    expect(mode).not.toHaveBeenCalled();
  });

  it('cancels obsolete resizes before they reach the native bridge', async () => {
    const bridge = new MockBridge(() => null);
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode').mockResolvedValue(viewport);
    const view = render(<Shell bridge={bridge} workspace={false} />);
    await advance();
    mode.mockClear();
    view.rerender(<Shell bridge={bridge} workspace />);
    await advance(16);
    view.rerender(<Shell bridge={bridge} workspace={false} />);
    await advance();
    expect(mode).toHaveBeenCalledExactlyOnceWith(false, false);
  });

  it('requests the latest mode without waiting for an old native reply', async () => {
    const bridge = new MockBridge(() => null);
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode').mockResolvedValue(viewport);
    const view = render(<Shell bridge={bridge} workspace={false} />);
    await advance();
    let oldComplete!: () => void;
    mode.mockClear().mockImplementationOnce(() => new Promise<WindowViewport>(resolve => { oldComplete = () => resolve(viewport); }));
    view.rerender(<Shell bridge={bridge} workspace />);
    await advance(32);
    view.rerender(<Shell bridge={bridge} workspace={false} />);
    await advance(32);
    expect(mode.mock.calls).toEqual([[true, false], [false, false]]);
    await act(async () => oldComplete());
    await advance();
    expect(mode).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers after a native layout restoration fails', async () => {
    const bridge = new MockBridge(() => null);
    const error = new Error('Window unavailable');
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode').mockRejectedValueOnce(error).mockResolvedValue(viewport);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const view = render(<Shell bridge={bridge} workspace />);
    await advance();
    expect(warning).toHaveBeenCalledExactlyOnceWith('Unable to restore window layout', error);
    view.rerender(<Shell bridge={bridge} workspace={false} />);
    await advance();
    expect(mode).toHaveBeenLastCalledWith(false, false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves transferred bounds under StrictMode without waiting for a paint', async () => {
    window.history.replaceState(null, '', '/?tabTransfer=1');
    const bridge = new MockBridge(() => null);
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode').mockResolvedValue(viewport);
    const view = render(<StrictMode><Shell bridge={bridge} workspace={false} ready={false} /></StrictMode>);
    view.rerender(<StrictMode><Shell bridge={bridge} workspace /></StrictMode>);
    expect(mode).toHaveBeenCalledWith(true, true);
    await advance();
    expect(mode).not.toHaveBeenCalledWith(true, false);
    view.rerender(<StrictMode><Shell bridge={bridge} workspace={false} /></StrictMode>);
    await advance();
    expect(mode).toHaveBeenLastCalledWith(false, false);
  });

  it('does not resize before startup is ready or after unmounting', async () => {
    const bridge = new MockBridge(() => null);
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode');
    const view = render(<Shell bridge={bridge} workspace ready={false} />);
    await advance();
    expect(mode).not.toHaveBeenCalled();
    view.rerender(<Shell bridge={bridge} workspace />);
    view.unmount();
    await advance();
    expect(mode).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('destination page paint', () => {
  it('waits one paint opportunity even while window dimensions are changing', async () => {
    const done = vi.fn();
    void waitForWindowPaint(new AbortController().signal).then(done);
    await advance(16);
    expect(done).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('resize'));
    await advance(16);
    expect(done).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the delay when the renderer does not schedule animation frames', async () => {
    vi.mocked(window.requestAnimationFrame).mockReturnValue(1);
    const done = vi.fn();
    void waitForWindowPaint(new AbortController().signal).then(done);
    await advance(119);
    expect(done).not.toHaveBeenCalled();
    await advance(1);
    expect(done).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('finishes when the window becomes hidden', async () => {
    const done = vi.fn();
    void waitForWindowPaint(new AbortController().signal).then(done);
    await advance(16);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(0);
    expect(done).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wait for a hidden webview to schedule animation frames', async () => {
    vi.mocked(window.requestAnimationFrame).mockReturnValue(1);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const done = vi.fn();
    void waitForWindowPaint(new AbortController().signal).then(done);
    await advance(0);
    expect(done).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('cancels scheduled frames and listeners on teardown', async () => {
    const controller = new AbortController();
    const done = vi.fn();
    void waitForWindowPaint(controller.signal).then(done);
    controller.abort();
    await advance();
    expect(done).toHaveBeenCalledExactlyOnceWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
