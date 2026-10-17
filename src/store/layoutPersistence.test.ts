import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockBridge } from '../platform/bridge';
import { DEFAULT_LAYOUT, DEFAULT_SETTINGS } from '../settings/defaults';
import { mergeLayout } from '../services/layoutWriter';
import { useAppStore } from './appStore';
import type { BootstrapData, BridgeCommand } from '../bindings/generated';

const original = useAppStore.getState();
afterEach(() => { useAppStore.getState().dispose(); useAppStore.setState(original, true); localStorage.clear(); vi.restoreAllMocks(); });
async function initialize() {
  const bootstrap: BootstrapData = {
    applicationSessionId: 'layout-test', state: { settings: { ...DEFAULT_SETTINGS, fetchOnStartup: false, autoFetchIntervalMinutes: 0 }, layout: structuredClone(DEFAULT_LAYOUT), recentWorkspaces: [], lastWorkspaceId: null },
    tools: { git: true, svn: true, svnadmin: true }, capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false },
  };
  const commands: BridgeCommand[] = [];
  const bridge = new MockBridge(command => {
    commands.push(command);
    if (command.type === 'bootstrap') return structuredClone(bootstrap);
    if (command.type === 'updateLayout') return command.payload.layout;
    return [];
  });
  useAppStore.setState({ bootstrap: undefined, snapshot: undefined, tabs: [], activeTabId: null, sessions: {} });
  await useAppStore.getState().initialize(bridge);
  return { bridge, commands };
}
describe('layout persistence across windows', () => {
  it('publishes one update per layout change and ignores unchanged dimensions', async () => {
    await initialize();
    let updates = 0;
    const unsubscribe = useAppStore.subscribe((next, previous) => { if (next.bootstrap !== previous.bootstrap) updates++; });
    try {
      useAppStore.getState().setPanelSize('commit', 510);
      expect(updates).toBe(1);
      useAppStore.getState().setPanelSize('commit', 510);
      expect(updates).toBe(1);
    } finally { unsubscribe(); }
  });
  it('normalizes older bootstrap data when selecting the default tab without saving unchanged values', async () => {
    const { commands } = await initialize();
    const bootstrap = useAppStore.getState().bootstrap!;
    useAppStore.setState({ bootstrap: { ...bootstrap, state: { ...bootstrap.state, layout: undefined } } });
    useAppStore.getState().setActiveTab('changes');
    expect(useAppStore.getState().bootstrap?.state.layout).toEqual(DEFAULT_LAYOUT);
    window.dispatchEvent(new Event('pointerup'));
    await Promise.resolve();
    expect(commands.some(command => command.type === 'updateLayout')).toBe(false);
  });
  it('merges remote geometric changes without switching the local operation tab or losing a pending drag', async () => {
    const { bridge, commands } = await initialize();
    useAppStore.getState().setPanelSize('commit', 510);
    bridge.emit({ type: 'layout-changed', sourceWindowLabel: 'another-window', update: {
      layout: mergeLayout(DEFAULT_LAYOUT, { panelSizes: { branches: 310 }, activeTab: 'sync' }), revision: 2, reset: false,
    } });
    const layout = useAppStore.getState().bootstrap!.state.layout!;
    expect(layout.panelSizes).toMatchObject({ commit: 510, branches: 310 });
    expect(layout.activeTab).toBe(DEFAULT_LAYOUT.activeTab);
    window.dispatchEvent(new Event('pointerup'));
    await vi.waitFor(() => expect(commands.some(command => command.type === 'updateLayout')).toBe(true));
    const save = commands.find(command => command.type === 'updateLayout');
    expect(save?.type === 'updateLayout' && save.payload.changed_fields).toEqual(['panelSizes.commit']);
  });
  it('propagates a reset and rejects stale broadcasts without rewriting pending old dimensions', async () => {
    const { bridge, commands } = await initialize();
    useAppStore.getState().setDetailInfoHeight(450);
    localStorage.setItem('versiondock:commit-message-textarea-height', '300');
    localStorage.setItem('versiondock:logPanelHeight', '400');
    const beforeReset = useAppStore.getState().layoutResetVersion;
    bridge.emit({ type: 'layout-changed', sourceWindowLabel: 'another-window', update: { layout: DEFAULT_LAYOUT, revision: 5, reset: true } });
    bridge.emit({ type: 'layout-changed', sourceWindowLabel: 'another-window', update: { layout: mergeLayout(DEFAULT_LAYOUT, { detailInfoHeight: 450 }), revision: 4, reset: false } });
    window.dispatchEvent(new Event('pointerup'));
    await Promise.resolve();
    expect(useAppStore.getState().bootstrap?.state.layout?.detailInfoHeight).toBeNull();
    expect(useAppStore.getState().layoutResetVersion).toBe(beforeReset + 1);
    expect(localStorage.getItem('versiondock:commit-message-textarea-height')).toBeNull();
    expect(localStorage.getItem('versiondock:logPanelHeight')).toBeNull();
    expect(commands.some(command => command.type === 'updateLayout')).toBe(false);
  });
});
