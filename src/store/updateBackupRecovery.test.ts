import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserDevBridge } from '../platform/browserDevBridge';
import { BridgeError } from '../platform/bridge';
import type { ShelfEntry } from '../bindings/generated';
import { useAppStore } from './appStore';
const initial = useAppStore.getState();
afterEach(() => { useAppStore.getState().dispose(); useAppStore.setState(initial, true); localStorage.clear(); vi.restoreAllMocks(); });

describe('plugin update restoration warning parity', () => {
  it('does not publish startup recovery notices for retained automatic backups', async () => {
    const bridge = new BrowserDevBridge(), original = bridge.request.bind(bridge);
    const shelf: ShelfEntry = { id: 'retained', name: 'Auto-shelved before update (10:00)', createdAt: '2026-10-02T12:00:00Z', branch: 'main', files: [{ path: 'lost.txt', status: 'added' }] };
    const request = vi.spyOn(bridge, 'request').mockImplementation((command, options) => command.type === 'shelves' ? Promise.resolve(command.payload.repo_id === 'api' ? [shelf] : []) : original(command, options));
    await useAppStore.getState().initialize(bridge); await useAppStore.getState().openWorkspace(['/browser-demo']);
    const notices = useAppStore.getState().notifications.slice();
    await useAppStore.getState().loadShelves('api'); await useAppStore.getState().loadStashes();
    expect(useAppStore.getState().notifications).toEqual(notices);
    expect(notices.some((n) => n.title === 'Local changes backup needs attention')).toBe(false);
    expect(useAppStore.getState().shelves.api).toEqual([shelf]);
    expect(request.mock.calls.some(([command]) => command.type === 'shelfOperation')).toBe(false);
  });

  it('leaves the existing operation error notification and original failure message in place', async () => {
    const bridge = new BrowserDevBridge(), original = bridge.request.bind(bridge);
    vi.spyOn(bridge, 'request').mockImplementation((command, options) => {
      if (command.type === 'sync') throw new BridgeError({ code: 'GIT_PULL_FAILED', message: 'network failed', command: null, exitCode: null, stderr: null, recoverable: true });
      return original(command, options);
    });
    await useAppStore.getState().initialize(bridge); await useAppStore.getState().openWorkspace(['/browser-demo']);
    useAppStore.setState({ notifications: [] });
    await useAppStore.getState().sync('api', 'pull');
    const failure = useAppStore.getState().notifications.find((n) => n.title === 'Sync failed');
    expect(failure?.message).toEqual({ raw: 'network failed' });
  });
  it('reports only the plugin restoration warning when the pull succeeded without conflicts', async () => {
    const bridge = new BrowserDevBridge(), original = bridge.request.bind(bridge);
    vi.spyOn(bridge, 'request').mockImplementation((command, options) => command.type === 'sync'
      ? Promise.resolve({ output: 'updated', update: null, restoreWarning: { shelf: true, backupName: 'Auto-shelved before update (10:00)', backupId: 'backup', conflicted: false, details: 'patch unavailable' } })
      : original(command, options));
    await useAppStore.getState().initialize(bridge); await useAppStore.getState().openWorkspace(['/browser-demo']);
    useAppStore.setState({ notifications: [] }); await useAppStore.getState().sync('api', 'pull');
    const notifications = useAppStore.getState().notifications;
    expect(notifications.filter((n) => n.title === 'Sync failed')).toHaveLength(0);
    const warning = notifications.find((n) => n.type === 'warning' && typeof n.message === 'object' && 'key' in n.message && n.message.key.includes('Shelve backup has been retained'))!;
    expect(warning.actions).toEqual([]);
    expect(useAppStore.getState().bootstrap?.state.layout?.activeTab).toBe('changes');
  });

  it('keeps the original pull failure separate from its stash restoration warning', async () => {
    const bridge = new BrowserDevBridge(), original = bridge.request.bind(bridge);
    vi.spyOn(bridge, 'request').mockImplementation((command, options) => {
      if (command.type === 'sync') throw new BridgeError({ code: 'GIT_PULL_FAILED', message: 'network failed', command: null, exitCode: null, stderr: null, recoverable: true,
        restoreWarning: { shelf: false, backupName: '', backupId: 'hash', conflicted: false, details: 'restore failed' } });
      return original(command, options);
    });
    await useAppStore.getState().initialize(bridge); await useAppStore.getState().openWorkspace(['/browser-demo']);
    useAppStore.setState({ notifications: [] }); await useAppStore.getState().sync('api', 'pull');
    const notifications = useAppStore.getState().notifications;
    expect(notifications.filter((n) => typeof n.message === 'object' && 'key' in n.message && n.message.key.includes('Conflicts detected while restoring stashed changes.'))).toHaveLength(1);
    expect(notifications.find((n) => n.title === 'Sync failed')?.message).toEqual({ raw: 'network failed' });
  });

  it('preserves a successful batch outcome when only recovery warned, without adding recovery actions', async () => {
    const bridge = new BrowserDevBridge(), original = bridge.request.bind(bridge);
    vi.spyOn(bridge, 'request').mockImplementation((command, options) => command.type === 'sync'
      ? Promise.resolve({ output: 'up to date', update: null, restoreWarning: command.payload.repo_id === 'api' ? { shelf: true, backupName: 'backup', backupId: 'id', conflicted: false, details: 'restore failed' } : null })
      : original(command, options));
    await useAppStore.getState().initialize(bridge); await useAppStore.getState().openWorkspace(['/browser-demo']);
    useAppStore.setState({ notifications: [] }); await useAppStore.getState().updateProject('merge');
    expect(useAppStore.getState().notifications.some((n) => typeof n.message === 'object' && 'key' in n.message && n.message.key.includes('Update failed'))).toBe(false);
    const warning = useAppStore.getState().notifications.find((n) => n.type === 'warning' && n.details === 'restore failed')!;
    expect(warning.actions).toEqual([]);
  });

  it('keeps the plugin conflict result and Resolve Conflicts action with a separate recovery warning', async () => {
    const bridge = new BrowserDevBridge(), original = bridge.request.bind(bridge);
    vi.spyOn(bridge, 'request').mockImplementation((command, options) => {
      if (command.type === 'sync' && command.payload.repo_id === 'api') throw new BridgeError({ code: 'GIT_UPDATE_CONFLICT', message: 'Update stopped with conflicts or an unfinished version-control operation.', command: null, exitCode: null, stderr: null, recoverable: true,
        restoreWarning: { shelf: true, backupName: 'backup', backupId: 'id', conflicted: true, details: 'merge conflict' } });
      return original(command, options);
    });
    await useAppStore.getState().initialize(bridge); await useAppStore.getState().openWorkspace(['/browser-demo']);
    await useAppStore.getState().updateSettings({ language: 'zhCn' });
    expect(useAppStore.getState().snapshot?.repositories.some((repo) => repo.meta.id === 'api')).toBe(true);
    expect(useAppStore.getState().allRepositories.length).toBeGreaterThan(0);
    useAppStore.setState({ notifications: [] }); await useAppStore.getState().updateProject('merge');
    const notifications = useAppStore.getState().notifications;
    expect(notifications.map((n) => ({ title: n.title, message: n.message, actions: n.actions }))).toEqual(expect.arrayContaining([expect.objectContaining({ actions: expect.arrayContaining([expect.objectContaining({ type: 'openConflicts' })]) })]));
    const recovery = notifications.find((n) => n.details === 'merge conflict')!;
    expect(recovery.actions).toEqual([]);
    expect(recovery.message).toMatchObject({ key: 'VersionDock [{0}]: Conflicts detected while restoring local changes. Shelve backup has been retained: "{1}".' });
  });

});
