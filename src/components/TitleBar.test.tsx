import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TitleBar } from './TitleBar';
import { BridgeContext } from '../platform/context';
import { MockBridge, type TabDragPayload, type VersionDockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';

const bridge = new MockBridge(() => []);
const workspace = {
  id: 'workspace',
  name: 'Workspace',
  paths: ['/tmp/workspace'],
  lastOpenedAt: '',
  available: true,
};

afterEach(() => {
  cleanup();
  document.body.classList.remove('is-dragging-tab', 'is-detaching-tab');
  useAppStore.setState({ bridge: undefined, tabs: [], activeTabId: null, busy: false });
});

describe('TitleBar tab dragging', () => {
  it('avoids native HTML dragging and only uses the copy cursor after the detach threshold', () => {
    Object.defineProperties(window, {
      screenX: { configurable: true, value: 100 },
      screenY: { configurable: true, value: 80 },
      outerWidth: { configurable: true, value: 1200 },
      outerHeight: { configurable: true, value: 800 },
    });
    useAppStore.setState({ tabs: [workspace], activeTabId: workspace.id, busy: false });
    render(<BridgeContext.Provider value={bridge}><TitleBar /></BridgeContext.Provider>);

    const tab = screen.getByRole('tab');
    Object.assign(tab, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    expect(tab).not.toHaveAttribute('draggable');

    fireEvent.pointerDown(tab, { button: 0, pointerId: 1, screenX: 420, screenY: 110, clientX: 320, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 1, screenX: 420, screenY: 150, clientX: 320, clientY: 70 });
    expect(document.body).toHaveClass('is-dragging-tab');
    expect(document.body).not.toHaveClass('is-detaching-tab');
    expect(document.querySelector('.titlebar-tab-drag-preview')).not.toBeInTheDocument();

    fireEvent.pointerMove(window, { pointerId: 1, screenX: 420, screenY: 180, clientX: 320, clientY: 100 });
    expect(document.body).toHaveClass('is-detaching-tab');
    expect(document.querySelector('.titlebar-tab-drag-preview')).toHaveClass('detaching');

    fireEvent.pointerCancel(window, { pointerId: 1, screenX: 420, screenY: 180, clientX: 320, clientY: 100 });
    expect(document.body).not.toHaveClass('is-dragging-tab', 'is-detaching-tab');
    expect(document.querySelector('.titlebar-tab-drag-preview')).not.toBeInTheDocument();
  });

  it('reorders tabs inside the same title bar without showing either plus affordance', () => {
    const workspaces = [
      { ...workspace, id: 'first', name: 'First', paths: ['/tmp/first'] },
      { ...workspace, id: 'second', name: 'Second', paths: ['/tmp/second'] },
      { ...workspace, id: 'third', name: 'Third', paths: ['/tmp/third'] },
    ];
    const setCursorIcon = vi.fn(async () => undefined);
    const reorderBridge = new MockBridge(() => []) as VersionDockBridge;
    reorderBridge.window = { ...reorderBridge.window, setCursorIcon };
    Object.defineProperties(window, {
      screenX: { configurable: true, value: 100 },
      screenY: { configurable: true, value: 80 },
      outerWidth: { configurable: true, value: 1200 },
      outerHeight: { configurable: true, value: 800 },
    });
    useAppStore.setState({ bridge: reorderBridge, tabs: workspaces, activeTabId: 'first', busy: false });
    render(<BridgeContext.Provider value={reorderBridge}><TitleBar /></BridgeContext.Provider>);

    const renderedTabs = screen.getAllByRole('tab');
    renderedTabs.forEach((tab, index) => {
      Object.assign(tab, {
        getBoundingClientRect: () => ({ left: index * 110, right: index * 110 + 100, top: 0, bottom: 28, width: 100, height: 28, x: index * 110, y: 0, toJSON: () => undefined }),
        setPointerCapture: vi.fn(),
        hasPointerCapture: vi.fn(() => false),
        releasePointerCapture: vi.fn(),
      });
    });
    const addButton = screen.getByRole('button', { name: 'New Tab' });

    fireEvent.pointerDown(renderedTabs[0], { button: 0, pointerId: 3, screenX: 150, screenY: 110, clientX: 50, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 3, screenX: 500, screenY: 110, clientX: 400, clientY: 30 });

    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(['first', 'second', 'third']);
    expect(addButton).toHaveClass('drag-hidden');
    expect(addButton).toHaveAttribute('aria-hidden', 'true');
    expect(document.body).toHaveClass('is-dragging-tab');
    expect(document.body).not.toHaveClass('is-detaching-tab');
    expect(setCursorIcon).not.toHaveBeenCalledWith('copy');
    expect(document.querySelector('.titlebar-tab-drag-preview')).not.toBeInTheDocument();
    expect(renderedTabs[0]).toHaveClass('local-dragging');
    expect(renderedTabs[0]).toHaveStyle({ transform: 'translate3d(220px, 0, 0) scale(1.025)' });
    expect(renderedTabs[1]).toHaveClass('reorder-shifting');
    expect(renderedTabs[1]).toHaveStyle({ transform: 'translate3d(-110px, 0, 0)' });
    expect(renderedTabs[2]).toHaveClass('reorder-shifting');
    expect(renderedTabs[2]).toHaveStyle({ transform: 'translate3d(-110px, 0, 0)' });

    fireEvent.pointerUp(window, { pointerId: 3, screenX: 500, screenY: 110, clientX: 400, clientY: 30 });

    expect(addButton).not.toHaveClass('drag-hidden');
    expect(addButton).toHaveAttribute('aria-hidden', 'false');
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(['second', 'third', 'first']);
    expect(screen.getAllByRole('tab').every((tab) => !tab.getAttribute('style'))).toBe(true);
  });

  it('uses titlebar client coordinates when native screen coordinates have a different origin', () => {
    const workspaces = [
      { ...workspace, id: 'first', name: 'First', paths: ['/tmp/first'] },
      { ...workspace, id: 'second', name: 'Second', paths: ['/tmp/second'] },
    ];
    Object.defineProperties(window, {
      screenX: { configurable: true, value: 100 },
      screenY: { configurable: true, value: 1000 },
      outerWidth: { configurable: true, value: 1200 },
      outerHeight: { configurable: true, value: 800 },
    });
    useAppStore.setState({ tabs: workspaces, activeTabId: 'first', busy: false });
    render(<BridgeContext.Provider value={bridge}><TitleBar /></BridgeContext.Provider>);

    const renderedTabs = screen.getAllByRole('tab');
    renderedTabs.forEach((tab, index) => {
      Object.assign(tab, {
        getBoundingClientRect: () => ({ left: index * 110, right: index * 110 + 100, top: 0, bottom: 28, width: 100, height: 28, x: index * 110, y: 0, toJSON: () => undefined }),
        setPointerCapture: vi.fn(),
        hasPointerCapture: vi.fn(() => false),
        releasePointerCapture: vi.fn(),
      });
    });

    fireEvent.pointerDown(renderedTabs[0], { button: 0, pointerId: 4, screenX: 150, screenY: 1010, clientX: 50, clientY: 20 });
    // Simulate WKWebView reporting a screen coordinate that does not share
    // window.screenY's origin while clientY still correctly identifies the titlebar.
    fireEvent.pointerMove(window, { pointerId: 4, screenX: 300, screenY: 110, clientX: 200, clientY: 20 });

    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(['first', 'second']);
    expect(document.body).not.toHaveClass('is-detaching-tab');

    fireEvent.pointerUp(window, { pointerId: 4, screenX: 300, screenY: 110, clientX: 200, clientY: 20 });
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(['second', 'first']);
  });

  it('shows the plus cursor when another window tab can drop into this title bar', async () => {
    let dragStateHandler: ((state: TabDragPayload | null) => void) | undefined;
    const targetBridge = new MockBridge(() => []) as VersionDockBridge;
    targetBridge.getWindowLabel = async () => 'window-target';
    targetBridge.onTabDragState = async (handler) => {
      dragStateHandler = handler;
      return () => undefined;
    };
    Object.defineProperties(window, {
      screenX: { configurable: true, value: 100 },
      screenY: { configurable: true, value: 80 },
      outerWidth: { configurable: true, value: 1200 },
      outerHeight: { configurable: true, value: 800 },
    });
    useAppStore.setState({ tabs: [workspace], activeTabId: workspace.id, busy: false });
    render(<BridgeContext.Provider value={targetBridge}><TitleBar /></BridgeContext.Provider>);
    await waitFor(() => expect(dragStateHandler).toBeDefined());

    act(() => {
      dragStateHandler?.({
        sourceWindowLabel: 'window-source',
        tabId: 'remote-tab',
        tabName: 'Remote',
        paths: ['/tmp/remote'],
        screenX: 420,
        screenY: 100,
      });
    });
    expect(document.body).toHaveClass('is-tab-drop-target');

    act(() => dragStateHandler?.(null));
    expect(document.body).not.toHaveClass('is-tab-drop-target');
  });

  it('hides the source tab immediately but keeps ownership until the destination acknowledges', async () => {
    let acceptTransfer: ((accepted: boolean) => void) | undefined;
    const transferCompleted = new Promise<boolean>((resolve) => { acceptTransfer = resolve; });
    const transferBridge = new MockBridge(() => []) as VersionDockBridge;
    transferBridge.transferTab = async () => transferCompleted;
    Object.defineProperties(window, {
      screenX: { configurable: true, value: 100 },
      screenY: { configurable: true, value: 80 },
      outerWidth: { configurable: true, value: 1200 },
      outerHeight: { configurable: true, value: 800 },
    });
    useAppStore.setState({ bridge: transferBridge, tabs: [workspace], activeTabId: workspace.id, busy: false });
    render(<BridgeContext.Provider value={transferBridge}><TitleBar /></BridgeContext.Provider>);

    const tab = screen.getByRole('tab');
    Object.assign(tab, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    fireEvent.pointerDown(tab, { button: 0, pointerId: 2, screenX: 420, screenY: 110, clientX: 320, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 2, screenX: 420, screenY: 180, clientX: 320, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 2, screenX: 420, screenY: 180, clientX: 320, clientY: 100 });

    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(useAppStore.getState().tabs).toEqual([workspace]);
    await act(async () => acceptTransfer?.(true));
    await waitFor(() => expect(useAppStore.getState().tabs).toEqual([]));
  });
});
