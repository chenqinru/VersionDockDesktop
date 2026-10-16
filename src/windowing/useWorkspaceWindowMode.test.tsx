import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBridge, type VersionDockBridge } from '../platform/bridge';
import type { WindowViewport } from '../bindings/generated';
import { useWorkspaceWindowMode, waitForWindowPaint } from './useWorkspaceWindowMode';

function Shell({ bridge, workspace, ready = true }: { bridge: VersionDockBridge; workspace: boolean; ready?: boolean }) {
  const transitioning = useWorkspaceWindowMode(bridge, ready, workspace);
  return <output>{transitioning ? 'Resizing' : workspace ? 'Project' : 'Welcome'}</output>;
}

const viewport = { width: 1024, height: 768 };

const advance = async (ms = 160) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(viewport.width);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(viewport.height);
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(viewport.width);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(viewport.height);
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

describe('workspace window mode transition', () => {
  it.each(['windows', 'linux', 'macos'] as const)('covers both welcome/project transitions on %s until native resize and paint settle', async platform => {
    const bridge = new MockBridge(() => null);
    vi.spyOn(bridge, 'platform').mockReturnValue(platform);
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode').mockResolvedValue(viewport);
    const view = render(<Shell bridge={bridge} workspace={false} />);
    await advance();
    let complete!: () => void;
    mode.mockImplementationOnce(() => new Promise<WindowViewport>(resolve => { complete = () => resolve(viewport); }));
    view.rerender(<Shell bridge={bridge} workspace />);
    expect(screen.getByRole('status')).toHaveTextContent('Resizing');
    expect(mode).not.toHaveBeenCalledWith(true, false);
    await advance(40);
    expect(mode).toHaveBeenLastCalledWith(true, false);
    await advance(1000);
    expect(screen.getByRole('status')).toHaveTextContent('Resizing');
    await act(async () => complete());
    await advance();
    expect(screen.getByRole('status')).toHaveTextContent('Project');
    view.rerender(<Shell bridge={bridge} workspace={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Resizing');
    await advance();
    expect(mode).toHaveBeenLastCalledWith(false, false);
    expect(screen.getByRole('status')).toHaveTextContent('Welcome');
  });

  it('does not resize or mask the project again when switching between project tabs', async () => {
    const bridge = new MockBridge(() => null);
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode').mockResolvedValue(viewport);
    const view = render(<Shell bridge={bridge} workspace />);
    await advance();
    mode.mockClear();
    view.rerender(<Shell bridge={bridge} workspace />);
    await advance();
    expect(mode).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Project');
  });

  it('keeps welcome masked if the previous project resize finishes after the last tab closes', async () => {
    const bridge = new MockBridge(() => null);
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode').mockResolvedValue(viewport);
    const view = render(<Shell bridge={bridge} workspace={false} />);
    await advance();
    let oldComplete!: () => void;
    let currentComplete!: () => void;
    mode.mockImplementationOnce(() => new Promise<WindowViewport>(resolve => { oldComplete = () => resolve(viewport); }))
      .mockImplementationOnce(() => new Promise<WindowViewport>(resolve => { currentComplete = () => resolve(viewport); }));
    view.rerender(<Shell bridge={bridge} workspace />);
    await advance(40);
    view.rerender(<Shell bridge={bridge} workspace={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Resizing');
    await advance(40);
    await act(async () => oldComplete());
    await advance();
    expect(screen.getByRole('status')).toHaveTextContent('Resizing');
    await act(async () => currentComplete());
    await advance();
    expect(screen.getByRole('status')).toHaveTextContent('Welcome');
  });

  it('reveals the current page even if native layout restoration fails', async () => {
    const bridge = new MockBridge(() => null);
    const error = new Error('Window unavailable');
    vi.spyOn(bridge.window, 'setWorkspaceMode').mockRejectedValue(error);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<Shell bridge={bridge} workspace />);
    await advance();
    expect(warning).toHaveBeenCalledWith('Unable to restore window layout', error);
    expect(screen.getByRole('status')).toHaveTextContent('Project');
  });

  it('preserves immediate transfer display and native bounds under StrictMode', async () => {
    window.history.replaceState(null, '', '/?tabTransfer=1');
    const bridge = new MockBridge(() => null);
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode').mockResolvedValue(viewport);
    const view = render(<StrictMode><Shell bridge={bridge} workspace={false} ready={false} /></StrictMode>);
    view.rerender(<StrictMode><Shell bridge={bridge} workspace /></StrictMode>);
    expect(screen.getByRole('status')).toHaveTextContent('Project');
    await advance();
    expect(mode).toHaveBeenCalledWith(true, true);
    expect(mode).not.toHaveBeenCalledWith(true, false);
  });
});

describe('window paint readiness', () => {
  it('waits for the acknowledged native dimensions even after the old delay has elapsed', async () => {
    const done = vi.fn();
    void waitForWindowPaint(new AbortController().signal, { width: 1440, height: 900 }).then(done);
    await advance(800);
    expect(done).not.toHaveBeenCalled();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900);
    await advance(64);
    expect(done).not.toHaveBeenCalled();
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(900);
    await advance(32);
    expect(done).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows physical to logical rounding on fractional-DPI displays', async () => {
    const done = vi.fn();
    void waitForWindowPaint(new AbortController().signal, { width: 1024.8, height: 768.4 }).then(done);
    await advance(32);
    expect(done).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('falls back when the window manager refuses the requested dimensions', async () => {
    const done = vi.fn();
    void waitForWindowPaint(new AbortController().signal, { width: 1440, height: 900 }).then(done);
    await advance(1199);
    expect(done).not.toHaveBeenCalled();
    await advance(1);
    expect(done).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes when a window becomes hidden during confirmation', async () => {
    const done = vi.fn();
    void waitForWindowPaint(new AbortController().signal, { width: 1440, height: 900 }).then(done);
    await advance(32);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(0);
    expect(done).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets layout confirmation when a resize arrives between matching frames', async () => {
    const done = vi.fn();
    void waitForWindowPaint(new AbortController().signal, viewport).then(done);
    await advance(16);
    window.dispatchEvent(new Event('resize'));
    await advance(16);
    expect(done).not.toHaveBeenCalled();
    await advance(16);
    expect(done).toHaveBeenCalledWith(true);
  });

  it('does not hang if a hidden webview never schedules animation frames', async () => {
    vi.mocked(window.requestAnimationFrame).mockReturnValue(1);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const done = vi.fn();
    void waitForWindowPaint(new AbortController().signal, viewport).then(done);
    await advance(750);
    expect(done).toHaveBeenCalledWith(true);
  });

  it('cancels pending work and removes resize listeners on teardown', async () => {
    const controller = new AbortController();
    const done = vi.fn();
    void waitForWindowPaint(controller.signal, viewport).then(done);
    controller.abort();
    await advance();
    expect(done).toHaveBeenCalledExactlyOnceWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
