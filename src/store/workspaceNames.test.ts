import { afterEach, expect, it, vi } from 'vitest';
import { BrowserDevBridge } from '../platform/browserDevBridge';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from './appStore';

const initial = useAppStore.getState();
afterEach(() => { useAppStore.getState().dispose(); useAppStore.setState(initial, true); vi.restoreAllMocks(); });

it('keeps custom names across refresh and close/reopen with the real store and browser bridge', async () => {
  const bridge = new BrowserDevBridge();
  await useAppStore.getState().initialize(bridge);
  await useAppStore.getState().openWorkspace(['/browser-demo']);
  const id = useAppStore.getState().snapshot!.workspace.id;
  await useAppStore.getState().renameWorkspace(id, '我的团队');
  expect(useAppStore.getState().tabs.find(tab => tab.id === id)?.name).toBe('我的团队');
  expect(useAppStore.getState().bootstrap!.state.recentWorkspaces.find(item => item.id === id)?.customName).toBe('我的团队');
  await useAppStore.getState().refresh();
  expect(useAppStore.getState().snapshot!.workspace.name).toBe('我的团队');
  await useAppStore.getState().closeTab(id, { closeWindowIfLast: false });
  await useAppStore.getState().openWorkspace(['/browser-demo']);
  expect(useAppStore.getState().snapshot!.workspace.name).toBe('我的团队');
});

it('updates a background workspace name without replacing the active workspace or repositories', async () => {
  const descriptor = { id: 'background', name: '2 roots', paths: ['/a', '/b'], lastOpenedAt: '', available: true };
  const current = { workspace: { ...descriptor, id: 'active', name: 'Active' }, repositories: [], tools: { git: true, svn: false, svnadmin: false }, generation: 1 };
  const background = { ...current, workspace: descriptor };
  const request = vi.fn(() => ({ ...descriptor, name: 'Team', customName: 'Team' }));
  useAppStore.setState({ bridge: new MockBridge(request), snapshot: current, tabs: [current.workspace, descriptor], sessions: { background: { snapshot: background } as never }, bootstrap: { state: { recentWorkspaces: [descriptor] } } as never });
  await useAppStore.getState().renameWorkspace('background', 'Team');
  expect(request).toHaveBeenCalledWith({ type: 'workspaceRename', payload: { workspace_id: 'background', name: 'Team' } }, expect.objectContaining({ showProgress: false }));
  expect(useAppStore.getState().snapshot).toBe(current);
  expect(useAppStore.getState().sessions.background.snapshot!.workspace.name).toBe('Team');
});
