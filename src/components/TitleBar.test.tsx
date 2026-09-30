import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TitleBar } from './TitleBar';
import { BridgeContext } from '../platform/context';
import { MockBridge, type TabDragPayload, type VersionDockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { I18nContext, createTranslator } from '../i18n';

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
  useAppStore.setState({ bridge: undefined, tabs: [], activeTabId: null, });
});

describe('TitleBar tab dragging', () => {
  it('only synchronizes window bounds when the geometry changes', () => {
    vi.useFakeTimers();
    try {
      Object.defineProperties(window, {
        screenX: { configurable: true, value: 100 },
        screenY: { configurable: true, value: 80 },
        outerWidth: { configurable: true, value: 1200 },
        outerHeight: { configurable: true, value: 800 },
      });
      const syncWindowBounds = vi.fn(async () => undefined);
      const boundsBridge = new MockBridge(() => []) as VersionDockBridge;
      boundsBridge.syncWindowBounds = syncWindowBounds;

      render(<BridgeContext.Provider value={boundsBridge}><TitleBar /></BridgeContext.Provider>);
      expect(syncWindowBounds).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(2_400));
      expect(syncWindowBounds).toHaveBeenCalledTimes(1);

      Object.defineProperty(window, 'screenX', { configurable: true, value: 140 });
      act(() => vi.advanceTimersByTime(800));
      expect(syncWindowBounds).toHaveBeenCalledTimes(2);
      expect(syncWindowBounds).toHaveBeenLastCalledWith({ x: 140, y: 80, width: 1200, height: 800 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('avoids native HTML dragging and only uses the copy cursor after the detach threshold with multiple tabs', () => {
    Object.defineProperties(window, {
      screenX: { configurable: true, value: 100 },
      screenY: { configurable: true, value: 80 },
      outerWidth: { configurable: true, value: 1200 },
      outerHeight: { configurable: true, value: 800 },
    });
    useAppStore.setState({ tabs: [workspace, { ...workspace, id: 'other', paths: ['/tmp/other'] }], activeTabId: workspace.id, });
    render(<BridgeContext.Provider value={bridge}><TitleBar /></BridgeContext.Provider>);

    const tab = screen.getAllByRole('tab')[0];
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
    useAppStore.setState({ bridge: reorderBridge, tabs: workspaces, activeTabId: 'first', });
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
    useAppStore.setState({ tabs: workspaces, activeTabId: 'first', });
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

  it('moves the second tab into the first position at the left drag boundary', () => {
    const workspaces = [
      { ...workspace, id: 'first', name: 'First', paths: ['/tmp/first'] },
      { ...workspace, id: 'second', name: 'Second', paths: ['/tmp/second'] },
    ];
    Object.defineProperties(window, {
      screenX: { configurable: true, value: 100 },
      screenY: { configurable: true, value: 80 },
      outerWidth: { configurable: true, value: 1200 },
      outerHeight: { configurable: true, value: 800 },
    });
    useAppStore.setState({ tabs: workspaces, activeTabId: 'second', });
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

    fireEvent.pointerDown(renderedTabs[1], { button: 0, pointerId: 6, screenX: 260, screenY: 110, clientX: 160, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 6, screenX: 150, screenY: 110, clientX: 50, clientY: 30 });

    expect(renderedTabs[1]).toHaveStyle({ transform: 'translate3d(-110px, 0, 0) scale(1.025)' });
    expect(renderedTabs[0]).toHaveStyle({ transform: 'translate3d(110px, 0, 0)' });

    fireEvent.pointerUp(window, { pointerId: 6, screenX: 150, screenY: 110, clientX: 50, clientY: 30 });
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(['second', 'first']);
  });

  it('moves a wider middle tab to either end of a variable-width tab strip', () => {
    const workspaces = [
      { ...workspace, id: 'first', name: 'First', paths: ['/tmp/first'] },
      { ...workspace, id: 'middle', name: 'Middle', paths: ['/tmp/middle'] },
      { ...workspace, id: 'last', name: 'Last', paths: ['/tmp/last'] },
    ];
    Object.defineProperties(window, {
      screenX: { configurable: true, value: 100 },
      screenY: { configurable: true, value: 80 },
      outerWidth: { configurable: true, value: 1200 },
      outerHeight: { configurable: true, value: 800 },
    });
    useAppStore.setState({ tabs: workspaces, activeTabId: 'middle', });
    const { unmount } = render(<BridgeContext.Provider value={bridge}><TitleBar /></BridgeContext.Provider>);

    const rects = [
      { left: 0, width: 100 },
      { left: 110, width: 160 },
      { left: 280, width: 120 },
    ];
    const attachGeometry = () => {
      const renderedTabs = screen.getAllByRole('tab');
      renderedTabs.forEach((tab, index) => {
        const rect = rects[index];
        Object.assign(tab, {
          getBoundingClientRect: () => ({ left: rect.left, right: rect.left + rect.width, top: 0, bottom: 28, width: rect.width, height: 28, x: rect.left, y: 0, toJSON: () => undefined }),
          setPointerCapture: vi.fn(),
          hasPointerCapture: vi.fn(() => false),
          releasePointerCapture: vi.fn(),
        });
      });
      return renderedTabs;
    };

    let renderedTabs = attachGeometry();
    fireEvent.pointerDown(renderedTabs[1], { button: 0, pointerId: 8, screenX: 290, screenY: 110, clientX: 190, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 8, screenX: 180, screenY: 110, clientX: 80, clientY: 30 });
    fireEvent.pointerUp(window, { pointerId: 8, screenX: 180, screenY: 110, clientX: 80, clientY: 30 });
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(['middle', 'first', 'last']);

    unmount();
    useAppStore.setState({ tabs: workspaces, activeTabId: 'middle', });
    render(<BridgeContext.Provider value={bridge}><TitleBar /></BridgeContext.Provider>);
    renderedTabs = attachGeometry();
    fireEvent.pointerDown(renderedTabs[1], { button: 0, pointerId: 9, screenX: 290, screenY: 110, clientX: 190, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 9, screenX: 420, screenY: 110, clientX: 320, clientY: 30 });
    fireEvent.pointerUp(window, { pointerId: 9, screenX: 420, screenY: 110, clientX: 320, clientY: 30 });
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(['first', 'last', 'middle']);
  });

  it('opens and animates a reorder slot when another window tab moves across this title bar', async () => {
    let dragStateHandler: ((state: TabDragPayload | null) => void) | undefined;
    const targetBridge = new MockBridge(() => []) as VersionDockBridge;
    const setCursorIcon = vi.fn(async () => undefined);
    targetBridge.window = { ...targetBridge.window, setCursorIcon };
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
    const secondWorkspace = { ...workspace, id: 'second', name: 'Second', paths: ['/tmp/second'] };
    useAppStore.setState({ tabs: [workspace, secondWorkspace], activeTabId: workspace.id, });
    render(<BridgeContext.Provider value={targetBridge}><TitleBar /></BridgeContext.Provider>);
    await waitFor(() => expect(dragStateHandler).toBeDefined());
    const renderedTabs = screen.getAllByRole('tab');
    renderedTabs.forEach((tab, index) => {
      Object.defineProperties(tab, {
        offsetLeft: { configurable: true, value: index * 110 + 37 },
        offsetWidth: { configurable: true, value: 100 },
      });
      Object.assign(tab, {
        // Simulate a rect polluted by the previous remote transform. Native
        // insertion geometry must ignore it and use offsetLeft/offsetWidth.
        getBoundingClientRect: () => ({ left: index * 110 + 144, right: index * 110 + 244, top: 0, bottom: 28, width: 100, height: 28, x: index * 110 + 144, y: 0, toJSON: () => undefined }),
      });
    });
    const tabsElement = document.querySelector('.titlebar-tabs') as HTMLElement;
    Object.assign(tabsElement, {
      getBoundingClientRect: () => ({ left: 0, right: 220, top: 0, bottom: 38, width: 220, height: 38, x: 0, y: 0, toJSON: () => undefined }),
      scrollLeft: 37,
    });
    const addButton = screen.getByRole('button', { name: 'New Tab' });

    act(() => {
      dragStateHandler?.({
        sourceWindowLabel: 'window-source',
        tabId: 'remote-tab',
        tabName: 'Remote',
        tabWidth: 140,
        paths: ['/tmp/remote'],
        screenX: 9_999,
        screenY: 9_999,
        targetWindowLabel: 'window-target',
        targetClientX: 10,
      });
    });
    expect(document.body).toHaveClass('is-tab-drop-target');
    expect(setCursorIcon).toHaveBeenCalledWith('grabbing');
    expect(renderedTabs[0]).toHaveClass('remote-reorder-shifting');
    expect(renderedTabs[0]).toHaveStyle({ transform: 'translate3d(144px, 0, 0)' });
    expect(renderedTabs[1]).toHaveStyle({ transform: 'translate3d(144px, 0, 0)' });
    expect(document.querySelector('.titlebar-remote-drop-slot')).toHaveStyle({ left: '37px', width: '140px' });
    expect(document.querySelector('.titlebar-remote-end-spacer')).toHaveStyle({ width: '144px' });
    expect(tabsElement.scrollLeft).toBe(37);
    expect(addButton).toHaveClass('drag-hidden');

    act(() => {
      dragStateHandler?.({
        sourceWindowLabel: 'window-source',
        tabId: 'remote-tab',
        tabName: 'Remote',
        tabWidth: 140,
        paths: ['/tmp/remote'],
        screenX: 9_999,
        screenY: 9_999,
      });
    });
    expect(document.body).toHaveClass('is-tab-drop-target');
    expect(renderedTabs[0]).toHaveStyle({ transform: 'translate3d(144px, 0, 0)' });

    act(() => {
      dragStateHandler?.({
        sourceWindowLabel: 'window-source',
        tabId: 'remote-tab',
        tabName: 'Remote',
        tabWidth: 140,
        paths: ['/tmp/remote'],
        screenX: 9_999,
        screenY: 9_999,
        targetWindowLabel: 'window-target',
        targetClientX: 120,
      });
    });
    expect(renderedTabs[0]).not.toHaveClass('remote-reorder-shifting');
    expect(renderedTabs[0].style.transform).toBe('');
    expect(renderedTabs[1]).toHaveStyle({ transform: 'translate3d(144px, 0, 0)' });
    expect(document.querySelector('.titlebar-remote-drop-slot')).toHaveStyle({ left: '147px' });
    expect(tabsElement.scrollLeft).toBe(37);

    act(() => dragStateHandler?.(null));
    expect(document.body).not.toHaveClass('is-tab-drop-target');
    expect(renderedTabs[1].style.transform).toBe('');
    expect(document.querySelector('.titlebar-remote-end-spacer')).not.toBeInTheDocument();
    expect(addButton).not.toHaveClass('drag-hidden');
  });

  it('hides the source tab immediately but keeps ownership until the destination acknowledges', async () => {
    const remainingTab = { ...workspace, id: 'remaining', paths: ['/tmp/remaining'] };
    let acceptTransfer: ((accepted: boolean) => void) | undefined;
    const transferCompleted = new Promise<boolean>((resolve) => { acceptTransfer = resolve; });
    const transferBridge = new MockBridge(() => []) as VersionDockBridge;
    transferBridge.transferTab = async () => transferCompleted;
    transferBridge.broadcastTabDragState = vi.fn(async () => undefined);
    Object.defineProperties(window, {
      screenX: { configurable: true, value: 100 },
      screenY: { configurable: true, value: 80 },
      outerWidth: { configurable: true, value: 1200 },
      outerHeight: { configurable: true, value: 800 },
    });
    useAppStore.setState({ bridge: transferBridge, tabs: [workspace, remainingTab], activeTabId: remainingTab.id, });
    render(<BridgeContext.Provider value={transferBridge}><TitleBar /></BridgeContext.Provider>);

    const tab = screen.getAllByRole('tab')[0];
    Object.assign(tab, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    fireEvent.pointerDown(tab, { button: 0, pointerId: 2, screenX: 420, screenY: 110, clientX: 320, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 2, screenX: 420, screenY: 180, clientX: 320, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 2, screenX: 420, screenY: 180, clientX: 320, clientY: 100 });

    expect(tab).not.toBeInTheDocument();
    expect(useAppStore.getState().tabs).toEqual([workspace, remainingTab]);
    expect(transferBridge.broadcastTabDragState).not.toHaveBeenCalledWith(null);
    await act(async () => acceptTransfer?.(true));
    await waitFor(() => expect(useAppStore.getState().tabs).toEqual([remainingTab]));
    await waitFor(() => expect(transferBridge.broadcastTabDragState).toHaveBeenCalledWith(null));
  });

  it('does not render tabs track or plus button when no tabs are open, but renders welcome title and prevents double click', () => {
    useAppStore.setState({ bridge, tabs: [], activeTabId: null, });
    const { container } = render(
      <BridgeContext.Provider value={bridge}>
        <I18nContext.Provider value={{ language: 'zh-CN', preference: 'zhCn', t: createTranslator('zh-CN') }}>
          <TitleBar />
        </I18nContext.Provider>
      </BridgeContext.Provider>,
    );

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New Tab')).not.toBeInTheDocument();
    expect(screen.getByText('欢迎访问 VersionDock')).toBeInTheDocument();

    const header = container.querySelector('header');
    expect(header).toBeInTheDocument();
    const doubleClickEvent = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
    header?.dispatchEvent(doubleClickEvent);
    expect(doubleClickEvent.defaultPrevented).toBe(true);
  });

  it('renders JetBrains-style project initials icon in tabs and recent workspaces menu', () => {
    const customWorkspace = {
      id: 'k8s-nic-id',
      name: 'k8s-nic',
      paths: ['/tmp/k8s-nic'],
      lastOpenedAt: '',
      available: true,
    };
    useAppStore.setState({
      bridge,
      tabs: [customWorkspace],
      activeTabId: customWorkspace.id,
      bootstrap: {
        state: {
          recentWorkspaces: [
            {
              id: 'recent-1',
              name: 'Jrebel-master',
              paths: ['/tmp/Jrebel-master'],
              lastOpenedAt: '',
              available: true,
            },
          ],
        },
      } as any,
    });

    const { container } = render(
      <BridgeContext.Provider value={bridge}>
        <TitleBar />
      </BridgeContext.Provider>,
    );

    const tabIcon = container.querySelector('.titlebar-tab .project-icon');
    expect(tabIcon).toBeInTheDocument();
    expect(tabIcon).toHaveTextContent('KN');

    const addButton = screen.getByRole('button', { name: 'New Tab' });
    fireEvent.click(addButton);

    const menuIcon = container.querySelector('.workspace-menu-item .project-icon');
    expect(menuIcon).toBeInTheDocument();
    expect(menuIcon).toHaveTextContent('JM');
  });
});
