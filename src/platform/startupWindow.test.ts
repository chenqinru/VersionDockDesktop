import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriBridge } from './bridge';

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  platform: vi.fn(() => 'windows'),
  setBackgroundColor: vi.fn(),
  setWebviewBackgroundColor: vi.fn(),
  show: vi.fn(),
  setFocus: vi.fn(),
  isFullscreen: vi.fn(),
  onResized: vi.fn(),
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-os', () => ({ platform: native.platform }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ setBackgroundColor: native.setWebviewBackgroundColor }) }));

beforeEach(() => {
  vi.clearAllMocks();
  native.platform.mockReturnValue('windows');
  native.invoke.mockResolvedValue({ result: true, error: null });
  native.setBackgroundColor.mockResolvedValue(undefined);
  native.setWebviewBackgroundColor.mockResolvedValue(undefined);
  native.show.mockResolvedValue(undefined);
  native.setFocus.mockResolvedValue(undefined);
  native.isFullscreen.mockResolvedValue(false);
  native.onResized.mockResolvedValue(() => undefined);
  native.listen.mockResolvedValue(() => undefined);
});
afterEach(() => {
  document.documentElement.style.removeProperty('--versiondock-bg');
  vi.restoreAllMocks();
});

describe('native startup window', () => {
  it('restores the titlebar inset on native fullscreen exit before stale resize queries finish', async () => {
    let event!: (event: { payload: boolean }) => void;
    let resized!: () => void;
    let resolve!: (fullscreen: boolean) => void;
    const unlisten = vi.fn();
    native.listen.mockImplementation(async (_name, callback) => { event = callback; return unlisten; });
    native.onResized.mockImplementation(async callback => { resized = callback; return () => undefined; });
    native.isFullscreen.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const change = vi.fn();
    const dispose = await new TauriBridge().window.onFullscreenChanged(change);
    event({ payload: false });
    resolve(true);
    await Promise.resolve();
    resized();
    expect(change).toHaveBeenCalledExactlyOnceWith(false);
    event({ payload: true });
    expect(change).toHaveBeenLastCalledWith(true);
    dispose();
    event({ payload: false });
    expect(change).toHaveBeenLastCalledWith(true);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('removes the native listener when resize subscription fails', async () => {
    const unlisten = vi.fn();
    native.listen.mockResolvedValue(unlisten);
    native.onResized.mockRejectedValueOnce(new Error('closed'));
    await expect(new TauriBridge().window.onFullscreenChanged(vi.fn())).rejects.toThrow('closed');
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('delivers initial fullscreen state and refreshes it after native resize, then unsubscribes', async () => {
    let resize!: () => void;
    const unlisten = vi.fn();
    native.onResized.mockImplementation(async callback => { resize = callback; return unlisten; });
    native.isFullscreen.mockResolvedValue(true);
    const change = vi.fn();
    const dispose = await new TauriBridge().window.onFullscreenChanged(change);
    await vi.waitFor(() => expect(change).toHaveBeenLastCalledWith(true));
    native.isFullscreen.mockResolvedValue(false);
    resize();
    await vi.waitFor(() => expect(change).toHaveBeenLastCalledWith(false));
    dispose();
    const count = native.isFullscreen.mock.calls.length;
    resize();
    expect(native.isFullscreen).toHaveBeenCalledTimes(count);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('ignores old fullscreen queries after a newer resize or teardown', async () => {
    let resize!: () => void;
    let resolve!: (fullscreen: boolean) => void;
    native.onResized.mockImplementation(async callback => { resize = callback; return () => undefined; });
    native.isFullscreen.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const change = vi.fn();
    const dispose = await new TauriBridge().window.onFullscreenChanged(change);
    resize();
    await vi.waitFor(() => expect(change).toHaveBeenCalledExactlyOnceWith(false));
    resolve(true);
    await Promise.resolve();
    expect(change).toHaveBeenCalledExactlyOnceWith(false);
    native.isFullscreen.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    resize();
    dispose();
    resolve(true);
    await Promise.resolve();
    expect(change).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('returns the native content size and serializes overlapping mode requests', async () => {
    const bridge = new TauriBridge();
    let complete!: (response: unknown) => void;
    native.invoke.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
      .mockResolvedValueOnce({ result: { width: 880, height: 540 }, error: null });
    const project = bridge.window.setWorkspaceMode(true);
    const welcome = bridge.window.setWorkspaceMode(false);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledOnce());
    complete({ result: { width: 1440, height: 900 }, error: null });
    await expect(project).resolves.toEqual({ width: 1440, height: 900 });
    await expect(welcome).resolves.toEqual({ width: 880, height: 540 });
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it('continues mode restoration after a previous request fails', async () => {
    const bridge = new TauriBridge();
    native.invoke.mockRejectedValueOnce(new Error('Resize failed'))
      .mockResolvedValueOnce({ result: { width: 880, height: 540 }, error: null });
    await expect(bridge.window.setWorkspaceMode(true)).rejects.toThrow('Resize failed');
    await expect(bridge.window.setWorkspaceMode(false)).resolves.toEqual({ width: 880, height: 540 });
  });

  it.each(['macos', 'windows'])('routes %s caption visibility through the native bridge', async platform => {
    native.platform.mockReturnValue(platform);
    const bridge = new TauriBridge();
    await bridge.window.setControlsVisible(false);
    expect(native.invoke).toHaveBeenCalledWith('window_set_controls_visible', { visible: false });
  });
  it.each(['windows', 'linux', 'macos'])('refreshes the %s native background before both window mode changes', async platform => {
    native.platform.mockReturnValue(platform);
    const bridge = new TauriBridge();
    const setter = platform === 'macos' ? native.setBackgroundColor : native.setWebviewBackgroundColor;
    for (const [workspace, background] of [[true, '#121314'], [false, '#FFFFFF']] as const) {
      document.documentElement.style.setProperty('--versiondock-bg', background);
      setter.mockClear();
      native.invoke.mockImplementation(async () => {
        expect(setter).toHaveBeenCalledWith(background);
        return { result: true, error: null };
      });
      await bridge.window.setWorkspaceMode(workspace);
      expect(native.invoke).toHaveBeenLastCalledWith('bridge_request', { envelope: expect.objectContaining({ command: { type: 'windowSetWorkspaceMode', payload: { workspace, preserve_bounds: false } } }) });
    }
  });

  it('leaves a window hidden when the native close policy rejects startup reveal', async () => {
    native.invoke.mockResolvedValue({ result: false, error: null });
    await new TauriBridge().window.show();
    expect(native.show).not.toHaveBeenCalled();
    expect(native.setFocus).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledOnce();
  });

  it.each([
    ['windows', '#121314'], ['windows', '#FFFFFF'], ['windows', '#282a36'],
    ['linux', '#121314'], ['linux', '#FFFFFF'], ['linux', '#282a36'],
  ])('sets the %s theme background %s before requesting the guarded native reveal', async (platform, color) => {
    native.platform.mockReturnValue(platform);
    document.documentElement.style.setProperty('--versiondock-bg', color);
    native.setWebviewBackgroundColor.mockImplementation(async () => {
      expect(native.invoke).not.toHaveBeenCalled();
    });

    await new TauriBridge().window.show();
    expect(native.setWebviewBackgroundColor).toHaveBeenCalledWith(color);
    expect(native.setBackgroundColor).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledWith('bridge_request', { envelope: expect.objectContaining({ command: { type: 'windowReveal' } }) });
    expect(native.show).not.toHaveBeenCalled();
    expect(native.setFocus).not.toHaveBeenCalled();
  });

  it.each(['windows', 'linux', 'macos'])('still reveals the %s window if setting its background fails', async (platform) => {
    native.platform.mockReturnValue(platform);
    document.documentElement.style.setProperty('--versiondock-bg', '#121314');
    const error = new Error('Native background failed');
    native.setBackgroundColor.mockRejectedValue(error);
    native.setWebviewBackgroundColor.mockRejectedValue(error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await new TauriBridge().window.show();
    expect(warn).toHaveBeenCalledWith('Unable to set startup background', error);
    expect(native.invoke).toHaveBeenCalledWith('bridge_request', { envelope: expect.objectContaining({ command: { type: 'windowReveal' } }) });
  });

  it.each(['#121314', '#FFFFFF', '#282a36'])('sets macOS window background %s without calling the unsupported WKWebView setter', async (color) => {
    native.platform.mockReturnValue('macos');
    document.documentElement.style.setProperty('--versiondock-bg', color);
    native.setBackgroundColor.mockImplementation(async () => expect(native.invoke).not.toHaveBeenCalled());
    await new TauriBridge().window.show();
    expect(native.setBackgroundColor).toHaveBeenCalledWith(color);
    expect(native.setWebviewBackgroundColor).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledWith('bridge_request', { envelope: expect.objectContaining({ command: { type: 'windowReveal' } }) });
  });
});
