import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserDevBridge } from '../platform/browserDevBridge';
import { BridgeError } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { resetTaskProgress, useTaskProgressStore } from './taskProgressStore';

beforeEach(() => { localStorage.clear(); resetTaskProgress(); });
afterEach(() => { useAppStore.getState().dispose(); resetTaskProgress(); vi.restoreAllMocks(); });
async function setup() {
  const bridge = new BrowserDevBridge();
  await useAppStore.getState().initialize(bridge);
  await useAppStore.getState().openWorkspace(['/browser-demo']);
  return bridge;
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('batch progress and native completion', () => {
  it('tracks manual fetch without adding loading notifications or capturing background fetch', async () => {
    const bridge = await setup(), original = bridge.request.bind(bridge);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.spyOn(bridge, 'request').mockImplementation(async (command, options) => {
      if (command.type === 'sync') {
        const native = original(command, options);
        await pending;
        return native;
      }
      return original(command, options);
    });
    const fetching = useAppStore.getState().sync('api', 'fetch'); await tick();
    expect(request.mock.calls.find(([command]) => command.type === 'sync')?.[1]).toMatchObject({ showProgress: false });
    const tasks = Object.values(useTaskProgressStore.getState().tasks);
    expect(tasks.some((task) => task.title === 'Fetch' && task.total === null)).toBe(true);
    expect(useAppStore.getState().notifications.some((item) => item.progress)).toBe(false);
    release(); await fetching;
    resetTaskProgress(); await useAppStore.getState().sync('api', 'fetch', false);
    expect(useTaskProgressStore.getState().tasks).toEqual({});
  });
  it('groups an update across repositories and does not consume notification progress', async () => {
    const bridge = await setup();
    const original = bridge.request.bind(bridge);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const sync = vi.spyOn(bridge, 'request').mockImplementation(async (command, options) => {
      if (command.type === 'sync') await pending;
      return original(command, options);
    });
    const updating = useAppStore.getState().updateProject('merge');
    await tick();
    const task = Object.values(useTaskProgressStore.getState().tasks).find((item) => item.title === 'Update Project')!;
    expect(task).toMatchObject({ completed: 0, total: 5, status: 'running' });
    expect(useAppStore.getState().notifications.some((item) => item.title === 'Updating Project' && item.progress)).toBe(true);
    release(); await updating;
    expect(useTaskProgressStore.getState().tasks[task.id]).toMatchObject({ completed: 5, total: 5, status: 'succeeded' });
    expect(sync.mock.calls.filter(([command]) => command.type === 'sync')).toHaveLength(5);
    expect(useAppStore.getState().notifications.some((item) => item.title === 'Updating Project')).toBe(false);
  });

  it('cancel stops launching further repositories while retaining the in-flight task', async () => {
    const bridge = await setup(), original = bridge.request.bind(bridge);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const sync = vi.spyOn(bridge, 'request').mockImplementation(async (command, options) => {
      if (command.type === 'sync') { await pending; throw new BridgeError({ code: 'REQUEST_CANCELLED', message: 'Operation cancelled', recoverable: true, command: null, exitCode: null, stderr: null }); }
      return original(command, options);
    });
    const updating = useAppStore.getState().updateProject('merge'); await tick();
    const task = Object.values(useTaskProgressStore.getState().tasks).find((item) => item.title === 'Update Project')!;
    await useTaskProgressStore.getState().cancel(task.id);
    expect(useTaskProgressStore.getState().tasks[task.id].status).toBe('cancelling');
    release(); await updating;
    expect(useTaskProgressStore.getState().tasks[task.id]).toMatchObject({ status: 'cancelled', completed: 1, total: 5 });
    expect(sync.mock.calls.filter(([command]) => command.type === 'sync')).toHaveLength(1);
    expect(useTaskProgressStore.getState().tasks[task.id].children.slice(1).every((child) => child.status === 'skipped')).toBe(true);
  });

  it('reports partial fetch failures while retaining existing error notifications', async () => {
    const bridge = await setup(), original = bridge.request.bind(bridge);
    vi.spyOn(bridge, 'request').mockImplementation(async (command, options) => {
      if (command.type === 'sync' && command.payload.repo_id === 'api') throw new Error('offline');
      return original(command, options);
    });
    await useAppStore.getState().fetchRepositories(['admin', 'api']);
    const task = Object.values(useTaskProgressStore.getState().tasks).find((item) => item.title === 'Fetch All')!;
    expect(task).toMatchObject({ completed: 2, total: 2, status: 'partial', error: 'offline' });
    expect(useAppStore.getState().notifications.some((item) => item.title === 'Sync failed')).toBe(true);
  });
});
