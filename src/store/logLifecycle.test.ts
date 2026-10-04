import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapData, LogEntry } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import { isLogEntryInWorkspace, useAppStore } from './appStore';
const bootstrap: BootstrapData = {
  applicationSessionId: 'log-test',
  state: { theme: 'system', language: 'system', uiFontSize: 'standard', lastWorkspaceId: null, recentWorkspaces: [], panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null },
  tools: { git: true, svn: true, svnadmin: true },
  capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false },
};
const log = (id: string): LogEntry => ({ id, timestamp: new Date().toISOString(), level: 'error', channel: 'git', message: id, details: null, durationMs: null, exitCode: 1, cwd: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
let bridge: MockBridge;
beforeEach(() => {
  bridge = new MockBridge((command) => command.type === 'bootstrap' ? bootstrap : []);
  useAppStore.setState({ bridge, logEntries: [], logError: null, logStorageError: null, unreadErrorCount: 0, lastReadLogTimestamps: {}, logPanelOpen: false, tabs: [], snapshot: undefined, activeTabId: null });
});
afterEach(() => { useAppStore.getState().dispose(); vi.useRealTimers(); });
describe('log lifecycle', () => {
  it('does not overwrite live records with an initial snapshot or count duplicates twice', async () => {
    const pending = deferred<LogEntry[]>();
    bridge.getLogs = () => pending.promise;
    const load = useAppStore.getState().loadLogs();
    useAppStore.getState().addLogEntry(log('live'));
    pending.resolve([log('old'), log('live')]);
    await load;
    expect(useAppStore.getState().logEntries).toHaveLength(2);
    expect(useAppStore.getState().unreadErrorCount).toBe(2);
    useAppStore.getState().addLogEntry(log('live'));
    expect(useAppStore.getState().unreadErrorCount).toBe(2);
  });
  it.each(['current', null])('does not recount viewed errors for workspace %s', (activeTabId) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00Z'));
    useAppStore.setState({ activeTabId, logPanelOpen: true });
    useAppStore.getState().addLogEntry(log('viewed'));
    useAppStore.getState().setLogPanelOpen(false);
    vi.advanceTimersByTime(1);
    useAppStore.getState().addLogEntry({ ...log('later-debug'), level: 'debug' });
    expect(useAppStore.getState().unreadErrorCount).toBe(0);
    useAppStore.getState().addLogEntry(log('new-error'));
    expect(useAppStore.getState().unreadErrorCount).toBe(1);
  });
  it('does not resurrect cleared records when an earlier load resolves', async () => {
    const pending = deferred<LogEntry[]>();
    bridge.getLogs = () => pending.promise;
    const load = useAppStore.getState().loadLogs();
    await useAppStore.getState().clearLogs();
    useAppStore.getState().addLogEntry(log('after-clear'));
    pending.resolve([log('before-clear')]);
    await load;
    expect(useAppStore.getState().logEntries.map((entry) => entry.id)).toEqual(['after-clear']);
  });
  it('preserves records received during clear and restores old records if clear fails', async () => {
    const pending = deferred<void>();
    bridge.clearLogs = () => pending.promise;
    useAppStore.getState().addLogEntry(log('before'));
    const clearing = useAppStore.getState().clearLogs();
    useAppStore.getState().addLogEntry(log('during'));
    pending.reject(new Error('storage unavailable'));
    await expect(clearing).rejects.toThrow();
    expect(useAppStore.getState().logEntries.map((entry) => entry.id).sort()).toEqual(['before', 'during']);
    expect(useAppStore.getState().logError).toBe('Unable to clear logs.');
  });
  it('installs the listener before retrieval and batches the native log stream', async () => {
    vi.useFakeTimers();
    const subscription = deferred<() => void>();
    let listener!: (entry: LogEntry) => void;
    bridge.onLogEntry = (handler) => { listener = handler; return subscription.promise; };
    const getLogs = vi.spyOn(bridge, 'getLogs');
    await useAppStore.getState().initialize(bridge);
    expect(getLogs).not.toHaveBeenCalled();
    subscription.resolve(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(getLogs).toHaveBeenCalledOnce();
    listener(log('a')); listener(log('b'));
    expect(useAppStore.getState().logEntries).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(40);
    expect(useAppStore.getState().logEntries).toHaveLength(2);
    useAppStore.getState().dispose();
    listener(log('disposed'));
    await vi.advanceTimersByTimeAsync(40);
    expect(useAppStore.getState().logEntries).toHaveLength(2);
  });
  it('disposes a subscription that finishes after the store is disposed', async () => {
    const pending = deferred<() => void>();
    bridge.onLogEntry = () => pending.promise;
    const getLogs = vi.spyOn(bridge, 'getLogs');
    await useAppStore.getState().initialize(bridge);
    useAppStore.getState().dispose();
    const dispose = vi.fn();
    pending.resolve(dispose);
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(getLogs).not.toHaveBeenCalled();
  });
  it('ignores stale retrieval after disposal and scopes metadata ahead of cwd', async () => {
    const pending = deferred<LogEntry[]>();
    bridge.getLogs = () => pending.promise;
    const load = useAppStore.getState().loadLogs();
    useAppStore.getState().dispose();
    pending.resolve([log('stale')]);
    await load;
    expect(useAppStore.getState().logEntries).toHaveLength(0);
    const entry = { ...log('worker'), cwd: '/shared', context: { workspaceId: 'b', repositoryId: 'r', operationId: 'op', workspaceName: null, repositoryName: null } };
    expect(isLogEntryInWorkspace(entry, ['/shared'], 'a')).toBe(false);
    expect(isLogEntryInWorkspace(entry, ['/shared'], 'b')).toBe(true);
  });
});
