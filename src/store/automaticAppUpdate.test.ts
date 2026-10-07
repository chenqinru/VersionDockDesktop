import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapData } from '../bindings/generated';
import * as updater from '../services/updater';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import { useAppStore } from './appStore';

beforeEach(() => {
  const bootstrap: BootstrapData = {
    applicationSessionId: 'updates',
    state: { lastWorkspaceId: null, recentWorkspaces: [], settings: { ...DEFAULT_SETTINGS, autoCheckUpdates: true } },
    tools: { git: true, svn: false, svnadmin: false },
    capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false },
  };
  useAppStore.setState({ bootstrap, updateChecking: false, updateAvailableInfo: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({ bootstrap: undefined, updateChecking: false, updateAvailableInfo: null });
});

describe('automatic update state', () => {
  it('retains failed checks for the status bar and clears the error after recovery', async () => {
    vi.spyOn(updater, 'checkAppUpdate').mockResolvedValueOnce({ available: false, currentVersion: '0.1.4', error: 'network unavailable' })
      .mockResolvedValueOnce({ available: false, currentVersion: '0.1.4' });
    await useAppStore.getState().checkUpdateSilently();
    expect(useAppStore.getState().updateAvailableInfo?.error).toBe('network unavailable');
    await useAppStore.getState().checkUpdateSilently();
    expect(useAppStore.getState().updateAvailableInfo?.error).toBeUndefined();
    expect(useAppStore.getState().updateChecking).toBe(false);
  });

  it('coalesces overlapping automatic checks while retaining progress', async () => {
    let finish!: (value: updater.AppUpdateCheckResult) => void;
    const check = vi.spyOn(updater, 'checkAppUpdate').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = useAppStore.getState().checkUpdateSilently();
    await useAppStore.getState().checkUpdateSilently();
    expect(check).toHaveBeenCalledOnce();
    expect(useAppStore.getState().updateChecking).toBe(true);
    finish({ available: true, currentVersion: '0.1.4', latestVersion: '0.1.5' }); await pending;
    expect(useAppStore.getState().updateAvailableInfo?.latestVersion).toBe('0.1.5');
    expect(useAppStore.getState().updateChecking).toBe(false);
  });

  it('respects disabled checks and skipped versions', async () => {
    const check = vi.spyOn(updater, 'checkAppUpdate').mockResolvedValue({ available: true, currentVersion: '0.1.4', latestVersion: '0.1.5' });
    const bootstrap = useAppStore.getState().bootstrap!;
    useAppStore.setState({ bootstrap: { ...bootstrap, state: { ...bootstrap.state, settings: { ...DEFAULT_SETTINGS, autoCheckUpdates: false } } } });
    await useAppStore.getState().checkUpdateSilently(); expect(check).not.toHaveBeenCalled();
    useAppStore.setState({ bootstrap: { ...bootstrap, state: { ...bootstrap.state, settings: { ...DEFAULT_SETTINGS, skippedUpdateVersion: '0.1.5' } } } });
    await useAppStore.getState().checkUpdateSilently(); expect(useAppStore.getState().updateAvailableInfo).toBeNull();
  });
});
