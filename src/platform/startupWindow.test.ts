import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriBridge } from './bridge';

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  platform: vi.fn(() => 'windows'),
  setBackgroundColor: vi.fn(),
  setWebviewBackgroundColor: vi.fn(),
  show: vi.fn(),
  setFocus: vi.fn(),
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
});
afterEach(() => {
  document.documentElement.style.removeProperty('--versiondock-bg');
  vi.restoreAllMocks();
});

describe('native startup window', () => {
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
