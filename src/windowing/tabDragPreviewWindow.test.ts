import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabDragPreviewWindow } from './tabDragPreviewWindow';

const mocks = vi.hoisted(() => ({
  instances: [] as Array<{ label: string; options: { url: string; height: number; transparent: boolean; backgroundColor: number[] }; show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; setIgnoreCursorEvents: ReturnType<typeof vi.fn> }>,
  invoke: vi.fn(),
  ready: undefined as (() => void) | undefined,
  unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_event, ready) => { mocks.ready = ready; return mocks.unlisten; }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    show = vi.fn(async () => undefined);
    hide = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    // This is precisely the unsafe Tao API on a hidden Linux window.
    setIgnoreCursorEvents = vi.fn(() => { throw new Error('Unrealized GTK surface'); });
    constructor(public label: string, public options: { url: string; height: number; transparent: boolean; backgroundColor: number[] }) { mocks.instances.push(this); }
    async once(event: string, ready: () => void) {
      if (event === 'tauri://created') queueMicrotask(ready);
    }
  },
}));

const drag = { sourceWindowLabel: 'main', tabId: 'second', tabName: 'Second', tabWidth: 140, paths: ['/tmp/second'] };

beforeEach(() => {
  mocks.instances.length = 0;
  mocks.ready = undefined;
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.unlisten.mockClear();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
});
afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('native tab preview preparation', () => {
  it.each(['light', 'dark'] as const)('keeps the %s preview compact and opaque during prewarming', async (theme) => {
    const preview = new TabDragPreviewWindow();
    const pending = preview.prepare(drag, { screenX: 300, screenY: 80 }, theme);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    const native = mocks.instances[0];
    expect(native.options.height).toBe(28);
    expect(native.options.transparent).toBe(false);
    expect(native.options.backgroundColor).toEqual(theme === 'light' ? [243, 243, 243, 255] : [37, 37, 38, 255]);
    mocks.ready?.();
    await pending;
    expect(native.show).not.toHaveBeenCalled();
    preview.hide();
  });

  it('prepares input on the backend before revealing an activated preview', async () => {
    let prepared!: () => void;
    mocks.invoke.mockImplementation(() => new Promise<void>((resolve) => { prepared = resolve; }));
    const preview = new TabDragPreviewWindow();
    const pending = preview.prepare(drag, { screenX: 300, screenY: 80 }, 'dark');
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    const window = mocks.instances[0];
    preview.activate();
    expect(window.show).not.toHaveBeenCalled();
    mocks.ready?.();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('follow_tab_drag_preview', expect.objectContaining({ label: window.label, tabId: 'second' })));
    expect(window.setIgnoreCursorEvents).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(preview.tracking).toBe(false);
    prepared();
    await pending;
    expect(window.show).toHaveBeenCalledOnce();
    expect(preview.tracking).toBe(true);
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    preview.hide();
  });

  it('closes a failed native preview without exposing it or leaving tracking active', async () => {
    mocks.invoke.mockRejectedValue(new Error('Unable to realize GTK surface'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const preview = new TabDragPreviewWindow();
    const pending = preview.prepare(drag, { screenX: 300, screenY: 80 }, 'light');
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    preview.activate();
    mocks.ready?.();
    await pending;
    expect(mocks.instances[0].close).toHaveBeenCalledOnce();
    expect(mocks.instances[0].show).not.toHaveBeenCalled();
    expect(preview.tracking).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('does not prepare a preview that was cancelled before page readiness', async () => {
    const preview = new TabDragPreviewWindow();
    const pending = preview.prepare(drag, { screenX: 300, screenY: 80 }, 'dark');
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    preview.hide();
    mocks.ready?.();
    await pending;
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.instances[0].show).not.toHaveBeenCalled();
    expect(preview.tracking).toBe(false);
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it('does not reveal a preview cancelled while native preparation is pending', async () => {
    let prepared!: () => void;
    mocks.invoke.mockImplementation(() => new Promise<void>((resolve) => { prepared = resolve; }));
    const preview = new TabDragPreviewWindow();
    const pending = preview.prepare(drag, { screenX: 300, screenY: 80 }, 'dark');
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    preview.activate();
    mocks.ready?.();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    preview.hide();
    prepared();
    await pending;
    expect(mocks.instances[0].close).toHaveBeenCalled();
    expect(mocks.instances[0].show).not.toHaveBeenCalled();
    expect(preview.tracking).toBe(false);
  });
});
