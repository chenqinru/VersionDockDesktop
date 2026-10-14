import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  const shell = useStartupWindowReveal(bridge, initialized, transferred);
  useLayoutEffect(() => applyTheme(theme), [theme]);
  return <div data-testid="startup-shell" ref={shell} tabIndex={-1}>{initialized ? 'Welcome' : 'Loading'}<div className="titlebar-actions"><button>Toolbar action</button></div></div>;
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
  it('clears the initial toolbar focus once and preserves keyboard focus on later updates', () => {
    const bridge = mockBridge('macos');
    const view = render(<Shell bridge={bridge} initialized={false} />);
    const toolbar = screen.getByRole('button', { name: 'Toolbar action' });
    toolbar.focus();
    vi.mocked(bridge.window.show).mockImplementation(async () => {
      expect(screen.getByTestId('startup-shell')).toHaveFocus();
    });
    view.rerender(<Shell bridge={bridge} initialized />);
    expect(screen.getByTestId('startup-shell')).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    toolbar.focus();
    view.rerender(<Shell bridge={bridge} initialized theme="light2026" />);
    expect(toolbar).toHaveFocus();
  });

  it('ignores native toolbar autofocus before input and keeps deliberate keyboard focus', async () => {
    render(<Shell bridge={mockBridge('macos')} initialized />);
    const button = screen.getByRole('button');
    button.focus();
    expect(screen.getByTestId('startup-shell')).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    button.focus();
    expect(button).toHaveFocus();
  });

  it('clears the native first-button focus after the window finishes showing', async () => {
    const bridge = mockBridge('macos');
    let finish!: () => void;
    vi.mocked(bridge.window.show).mockImplementation(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
    render(<StrictMode><Shell bridge={bridge} initialized /></StrictMode>);
    screen.getByRole('button').focus();
    await act(async () => { finish(); });
    expect(screen.getByTestId('startup-shell')).toHaveFocus();
  });

  it.each(['keyboard', 'pointer'] as const)('preserves %s focus selected while native reveal is pending', async interaction => {
    const bridge = mockBridge('macos');
    let finish!: () => void;
    vi.mocked(bridge.window.show).mockImplementation(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
    render(<StrictMode><Shell bridge={bridge} initialized /></StrictMode>);
    const button = screen.getByRole('button');
    if (interaction === 'keyboard') fireEvent.keyDown(window, { key: 'Tab' });
    else fireEvent.pointerDown(button);
    button.focus();
    await act(async () => { finish(); });
    expect(button).toHaveFocus();
  });

  it('preserves a modal opened before native reveal finishes', async () => {
    const bridge = mockBridge('macos');
    let finish!: () => void;
    vi.mocked(bridge.window.show).mockImplementation(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
    render(<Shell bridge={bridge} initialized />);
    render(<div role="dialog" aria-modal="true"><input aria-label="Modal input" /></div>);
    const input = screen.getByRole('textbox');
    input.focus();
    await act(async () => { finish(); });
    expect(input).toHaveFocus();
  });

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
