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
  it('avoids native HTML dragging and only shows the plus after the detach threshold', () => {
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
    expect(document.querySelector('.titlebar-tab-drag-preview')).toHaveTextContent('Workspace');
    expect(document.querySelector('.titlebar-tab-drag-preview')).not.toHaveClass('detaching');

    fireEvent.pointerMove(window, { pointerId: 1, screenX: 420, screenY: 180, clientX: 320, clientY: 100 });
    expect(document.body).toHaveClass('is-detaching-tab');
    expect(document.querySelector('.titlebar-tab-drag-preview')).toHaveClass('detaching');

    fireEvent.pointerCancel(window, { pointerId: 1, screenX: 420, screenY: 180, clientX: 320, clientY: 100 });
    expect(document.body).not.toHaveClass('is-dragging-tab', 'is-detaching-tab');
    expect(document.querySelector('.titlebar-tab-drag-preview')).not.toBeInTheDocument();
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
