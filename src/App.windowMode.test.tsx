import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { MockBridge } from './platform/bridge';
import { BridgeContext } from './platform/context';
import { useAppStore } from './store/appStore';
import { DEFAULT_SETTINGS } from './settings/defaults';
import type { WindowViewport, WorkspaceSnapshot } from './bindings/generated';

const original = useAppStore.getState();
const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'workspace', name: 'Project', paths: ['/tmp/project'], available: true, lastOpenedAt: '' },
  repositories: [], generation: 1, tools: { git: true, svn: true, svnadmin: true },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({}) }));
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(performance.now()), 16));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => window.clearTimeout(id));
  useAppStore.setState({ ...original, ready: true, snapshot: undefined, tabs: [], activeTabId: null,
    bootstrap: { applicationSessionId: 'test-session', tools: snapshot.tools,
      capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false },
      state: { recentWorkspaces: [], lastWorkspaceId: null, settings: { ...DEFAULT_SETTINGS, language: 'en', autoCheckUpdates: false } },
    },
  });
});

afterEach(() => {
  cleanup();
  useAppStore.setState(original, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('visible content during native mode changes', () => {
  it.each(['windows', 'linux', 'macos'] as const)('keeps the destination visible while native resizing is pending on %s', async platform => {
    const bridge = new MockBridge(() => null);
    vi.spyOn(bridge, 'platform').mockReturnValue(platform);
    const mode = vi.spyOn(bridge.window, 'setWorkspaceMode').mockResolvedValue({ width: 880, height: 540 });
    render(<BridgeContext.Provider value={bridge}><App /></BridgeContext.Provider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(160); });
    let finish!: (viewport: WindowViewport) => void;
    mode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));

    act(() => useAppStore.setState({ snapshot, tabs: [snapshot.workspace], activeTabId: snapshot.workspace.id }));
    const project = screen.getByText('No repositories found', { selector: 'strong' });
    expect(project).toBeVisible();
    expect(document.querySelector('.app-shell')).not.toHaveAttribute('aria-busy');
    expect(document.querySelector('.window-mode-transition')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(project).toBeVisible();
    expect(mode).toHaveBeenLastCalledWith(true, false);

    // Closing the last tab must reveal welcome immediately, including when
    // the preceding project resize has not returned yet.
    act(() => useAppStore.setState({ snapshot: undefined, tabs: [], activeTabId: null }));
    expect(screen.getByRole('heading', { name: 'VersionDock' })).toBeVisible();
    expect(screen.queryByText('No repositories found', { selector: 'strong' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(mode).toHaveBeenLastCalledWith(false, false);
    await act(async () => finish({ width: 1440, height: 900 }));
    expect(screen.getByRole('heading', { name: 'VersionDock' })).toBeVisible();
    expect(document.querySelector('[data-window-transition]')).toBeNull();
  });
});
