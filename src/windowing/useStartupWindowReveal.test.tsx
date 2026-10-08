import { cleanup, render } from '@testing-library/react';
import { StrictMode, useLayoutEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockBridge, type VersionDockBridge } from '../platform/bridge';
import { applyTheme, type EffectiveTheme } from '../theme';
import { useStartupWindowReveal } from './useStartupWindowReveal';

function Shell({ bridge, initialized, transferred = false, theme = 'dark2026' }: {
  bridge: VersionDockBridge;
  initialized: boolean;
  transferred?: boolean;
  theme?: EffectiveTheme;
}) {
  useStartupWindowReveal(bridge, initialized, transferred);
  useLayoutEffect(() => applyTheme(theme), [theme]);
  return <div data-testid="startup-shell">{initialized ? 'Welcome' : 'Loading'}</div>;
}

function mockBridge(platform: ReturnType<VersionDockBridge['platform']> = 'windows') {
  const bridge = new MockBridge(() => null);
  vi.spyOn(bridge, 'platform').mockReturnValue(platform);
  vi.spyOn(bridge.window, 'show').mockResolvedValue(undefined);
  return bridge;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  applyTheme('dark2026');
});

describe('startup window reveal', () => {
  it.each([
    ['macos', 'light2026'], ['macos', 'dark2026'], ['macos', 'dracula'],
    ['windows', 'light2026'], ['windows', 'dark2026'], ['windows', 'dracula'],
    ['linux', 'light2026'], ['linux', 'dark2026'], ['linux', 'dracula'],
  ] as const)('reveals %s only after the shell and saved %s theme are committed', (platform, theme) => {
    const bridge = mockBridge(platform);
    vi.mocked(bridge.window.show).mockImplementation(async () => {
      expect(document.querySelector('[data-testid="startup-shell"]')).toHaveTextContent('Welcome');
      expect(document.documentElement.dataset.theme).toBe(theme);
    });
    const view = render(<StrictMode><Shell bridge={bridge} initialized={false} /></StrictMode>);
    expect(bridge.window.show).not.toHaveBeenCalled();
    view.rerender(<StrictMode><Shell bridge={bridge} initialized theme={theme} /></StrictMode>);
    expect(bridge.window.show).toHaveBeenCalledTimes(1);
    // Subsequent settings/repository updates must not steal focus again.
    view.rerender(<StrictMode><Shell bridge={bridge} initialized theme="nord" /></StrictMode>);
    expect(bridge.window.show).toHaveBeenCalledTimes(1);
  });

  it.each(['macos', 'windows', 'linux'] as const)('shows a transferred tab immediately on %s without waiting for bootstrap', (platform) => {
    const bridge = mockBridge(platform);
    render(<StrictMode><Shell bridge={bridge} initialized={false} transferred /></StrictMode>);
    expect(bridge.window.show).toHaveBeenCalledTimes(1);
  });

  it('reports native reveal failures without an unhandled rejection', async () => {
    const bridge = mockBridge();
    const error = new Error('Window unavailable');
    vi.mocked(bridge.window.show).mockRejectedValue(error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<Shell bridge={bridge} initialized />);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('Unable to show startup window', error));
  });
});
