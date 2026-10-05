import { scrollbarContains } from '../scrollbars/ownership';
import { isLightTheme } from '../theme';
import { getEffectiveTheme } from '../theme/useEffectiveTheme';
import { IconButton } from './IconButton';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { ProjectIcon } from './ProjectIcon';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { useI18n } from '../i18n';
import { isOperationActive, useAppStore } from '../store/appStore';
import { useBridge } from '../platform/context';
import type { TabDragPayload, WindowDragGeometry } from '../platform/bridge';
import type { WindowTabTransfer, WorkspaceDescriptor } from '../bindings/generated';
import { dragPoint, shouldDetachTab, tabSnapInsertionIndex, type ScreenPoint, type WindowBounds } from '../windowing/tabDrag';
import { TabStripAutoScroller } from '../windowing/tabStripAutoScroller';
import { TabDragPreviewWindow } from '../windowing/tabDragPreviewWindow';

interface ActiveTabDrag {
  tab: WorkspaceDescriptor;
  originalIndex: number;
  targetIndex: number;
  pointerId: number;
  startPoint: ScreenPoint;
  startClientX: number;
  startClientY: number;
  lastPoint: ScreenPoint;
  sourceBounds: WindowBounds;
  lastBroadcastAt: number;
  previewPrepared: boolean;
  detaching: boolean;
  started: boolean;
  tabRects: Array<{ left: number; width: number }>;
  tabGap: number;
  tabIds: string[];
  startScrollLeft: number;
}

interface TabDragPreview {
  tabName: string;
  seed?: string;
  screenX: number;
  screenY: number;
  width: number;
  detaching: boolean;
}

interface LocalTabDragLayout {
  tabId: string;
  originalIndex: number;
  targetIndex: number;
  deltaX: number;
  shiftX: number;
}

function transferId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function TitleBar({ startupTab }: { startupTab?: WorkspaceDescriptor } = {}) {
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const addAnchorRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const snapInsertionIndexRef = useRef<number | null>(null);
  const transferringTabsRef = useRef(new Set<string>());
  const windowLabelRef = useRef('');
  const activeTabDragRef = useRef<ActiveTabDrag | null>(null);
  const cancelActiveDragRef = useRef<(() => void) | null>(null);
  const restoringDragRef = useRef(false);
  const remoteDragTabIdRef = useRef<string | null>(null);
  const nativeRemoteTrackingTabIdRef = useRef<string | null>(null);
  const importingRemoteTabIdRef = useRef<string | null>(null);
  const remoteTabRectsRef = useRef<Array<{ left: number; right: number; width: number }> | null>(null);
  const remoteDropTargetRef = useRef(false);
  const suppressClickRef = useRef<string | null>(null);
  const bridge = useBridge();
  const platform = bridge.platform();
  const loadedTabs = useAppStore((state) => state.tabs);
  const transferringTabIds = useAppStore((state) => state.transferringTabIds);
  const tabs = loadedTabs.length === 0 && startupTab ? [startupTab] : loadedTabs;
  const activeTabId = useAppStore((state) => state.activeTabId) ?? startupTab?.id;
  const busy = useAppStore((state) => isOperationActive(state.operations, { domain: 'workspace' }));
  const recentWorkspaces = useAppStore((state) => state.bootstrap?.state.recentWorkspaces ?? []);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const switchTab = useAppStore((state) => state.switchTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const { t } = useI18n();
  const [tabDragPreviewWindow] = useState(() => new TabDragPreviewWindow());
  const [tabAutoScroller] = useState(() => new TabStripAutoScroller());

  useEffect(() => {
    if (platform !== 'linux') return;
    void bridge.window.isMaximized().then(setMaximized);
  }, [bridge, platform]);

  useEffect(() => () => { cancelActiveDragRef.current?.(); tabDragPreviewWindow.hide(); tabAutoScroller.stop(); }, [tabDragPreviewWindow, tabAutoScroller]);

  useEffect(() => {
    if (!newTabMenuOpen) return;
    const handleOutsideInteraction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (scrollbarContains(addAnchorRef.current, target) || scrollbarContains(addMenuRef.current, target)) return;
      setNewTabMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setNewTabMenuOpen(false);
    };
    document.addEventListener('pointerdown', handleOutsideInteraction, true);
    document.addEventListener('focusin', handleOutsideInteraction, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutsideInteraction, true);
      document.removeEventListener('focusin', handleOutsideInteraction, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [newTabMenuOpen]);

  const chooseWorkspace = async () => {
    setNewTabMenuOpen(false);
    const paths = await bridge.selectWorkspaceFolders(t('Open Workspace'));
    if (paths.length) {
      await openWorkspace(paths);
    }
  };

  const handleOpenRecent = async (paths: string[]) => {
    setNewTabMenuOpen(false);
    await openWorkspace(paths);
  };

  const [menuPos, setMenuPos] = useState({ left: platform === 'macos' ? 84 : 12, top: 38 });
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [localTabDragLayout, setLocalTabDragLayout] = useState<LocalTabDragLayout | null>(null);
  const [pendingTransferTabIds, setPendingTransferTabIds] = useState<Set<string>>(() => new Set());
  const [tabDragPreview, setTabDragPreview] = useState<TabDragPreview | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    tabId: string;
  } | null>(null);

  const closeOtherTabs = useAppStore((state) => state.closeOtherTabs);
  const reorderTabs = useAppStore((state) => state.reorderTabs);

  const toggleNewTabMenu = () => {
    if (!newTabMenuOpen && addAnchorRef.current) {
      const rect = addAnchorRef.current.getBoundingClientRect();
      const left = Math.max(12, Math.min(window.innerWidth - 370, rect.left - 8));
      setMenuPos({ left, top: rect.bottom + 4 });
    }
    setNewTabMenuOpen((prev) => !prev);
  };

  const [windowLabel, setWindowLabel] = useState<string>('');
  const [remoteDragState, setRemoteDragState] = useState<TabDragPayload | null>(null);
  const [snapInsertionIndex, setSnapInsertionIndex] = useState<number | null>(null);
  const [remoteDropSlotLeft, setRemoteDropSlotLeft] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let lastReportedBounds = '';
    void bridge.getWindowLabel().then((label) => {
      if (disposed) return;
      windowLabelRef.current = label;
      setWindowLabel(label);
    });

    const reportBounds = () => {
      const bounds = {
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight,
      };
      const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      if (key === lastReportedBounds) return;
      lastReportedBounds = key;
      void bridge.syncWindowBounds(bounds);
    };
    reportBounds();
    const interval = setInterval(reportBounds, 800);
    window.addEventListener('resize', reportBounds);

    let unlistenState: (() => void) | undefined;
    let unlistenImport: (() => void) | undefined;

    void bridge.onImportTab(({ transfer, targetClientX }) => {
      void (async () => {
        const currentTabs = useAppStore.getState().tabs;
        const visibleTabs = Array.from(tabsRef.current?.querySelectorAll<HTMLElement>('.titlebar-tab') ?? []);
        const strip = tabsRef.current;
        const stripLeft = strip?.getBoundingClientRect().left ?? 0;
        const slotIndex = targetClientX === null || targetClientX === undefined ? snapInsertionIndexRef.current : (() => {
          const index = visibleTabs.findIndex((element) => {
            const rect = element.getBoundingClientRect();
            const midpoint = element.offsetWidth > 0 ? stripLeft + element.offsetLeft - (strip?.scrollLeft ?? 0) + element.offsetWidth / 2 : rect.left + rect.width / 2;
            return targetClientX < midpoint;
          });
          return index < 0 ? visibleTabs.length : index;
        })();
        const nextTabId = slotIndex === null ? undefined : visibleTabs[slotIndex]?.dataset.tabId;
        const nextTabIndex = currentTabs.findIndex((tab) => tab.id === nextTabId);
        const insertionIndex = nextTabIndex < 0 ? currentTabs.length : nextTabIndex;
        importingRemoteTabIdRef.current = transfer.tabId;
        tabAutoScroller.stop();
        snapInsertionIndexRef.current = null;
        remoteDragTabIdRef.current = null;
        remoteTabRectsRef.current = null;
        setSnapInsertionIndex(null);
        setRemoteDropSlotLeft(null);
        setRemoteDragState(null);
        document.body.classList.remove('is-tab-drop-target');
        if (remoteDropTargetRef.current) {
          remoteDropTargetRef.current = false;
          void bridge.window.setCursorIcon('default');
        }
        let accepted = false;
        try {
          accepted = await useAppStore.getState().importTab(transfer, insertionIndex);
        } catch (error) {
          useAppStore.getState().addNotification({ type: 'error', title: 'Workspace operation failed', message: { raw: error instanceof Error ? error.message : String(error) }, workspaceId: transfer.tabId });
        }
        const targetWindowLabel = windowLabelRef.current || await bridge.getWindowLabel();
        await bridge.completeTabTransfer(transfer, targetWindowLabel, accepted);
      })().catch((error) => {
        useAppStore.getState().addNotification({ type: 'error', title: 'Workspace operation failed', message: { raw: error instanceof Error ? error.message : String(error) }, workspaceId: transfer.tabId });
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenImport = unlisten;
    });

    const handleDragState = (state: TabDragPayload | null) => {
      if (state && importingRemoteTabIdRef.current === state.tabId) return;
      if (!state) importingRemoteTabIdRef.current = null;
      const nativeTargetSpecified = state?.targetWindowLabel !== undefined;
      if (state && nativeTargetSpecified) {
        nativeRemoteTrackingTabIdRef.current = state.tabId;
      } else if (state && nativeRemoteTrackingTabIdRef.current === state.tabId) {
        return;
      }
      setRemoteDragState(state);
      const targetsThisWindow = !nativeTargetSpecified
        || state?.targetWindowLabel === windowLabelRef.current;
      if (!state || state.sourceWindowLabel === windowLabelRef.current || !targetsThisWindow) {
        if (!activeTabDragRef.current) tabAutoScroller.stop();
        remoteDragTabIdRef.current = null;
        if (!state) nativeRemoteTrackingTabIdRef.current = null;
        remoteTabRectsRef.current = null;
        snapInsertionIndexRef.current = null;
        setSnapInsertionIndex(null);
        setRemoteDropSlotLeft(null);
        document.body.classList.remove('is-tab-drop-target');
        if (remoteDropTargetRef.current) {
          remoteDropTargetRef.current = false;
          void bridge.window.setCursorIcon('default');
        }
        return;
      }
      if (remoteDragTabIdRef.current !== state.tabId || !remoteTabRectsRef.current) {
        remoteDragTabIdRef.current = state.tabId;
        const tabsElement = tabsRef.current;
        const tabsRect = tabsElement?.getBoundingClientRect();
        remoteTabRectsRef.current = Array.from(tabsElement?.querySelectorAll<HTMLElement>('.titlebar-tab') ?? [])
          .map((element) => {
            if (element.offsetWidth > 0) {
              return {
                left: element.offsetLeft,
                right: element.offsetLeft + element.offsetWidth,
                width: element.offsetWidth,
              };
            }
            // JSDOM and a few non-layout hosts do not expose offset metrics.
            // Rects are only a fallback; native Tauri always uses the
            // transform-independent offset coordinates above.
            const rect = element.getBoundingClientRect();
            const left = rect.left - (tabsRect?.left ?? 0) + (tabsElement?.scrollLeft ?? 0);
            return { left, right: left + rect.width, width: rect.width };
          });
      }
      const remoteTabRects = remoteTabRectsRef.current;
      const tabsRect = tabsRef.current?.getBoundingClientRect();
      const scrollLeft = tabsRef.current?.scrollLeft ?? 0;
      const tabMidpoints = remoteTabRects.map((rect) => (tabsRect?.left ?? 0) + rect.left - scrollLeft + rect.width / 2);
      const insertionIndex = nativeTargetSpecified && state.targetClientX !== null && state.targetClientX !== undefined
        ? (() => {
            const index = tabMidpoints.findIndex((midpoint) => state.targetClientX! < midpoint);
            return index === -1 ? tabMidpoints.length : index;
          })()
        : tabSnapInsertionIndex(
            { screenX: state.screenX, screenY: state.screenY },
            { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight },
            tabMidpoints,
          );
      snapInsertionIndexRef.current = insertionIndex;
      setSnapInsertionIndex(insertionIndex);
      if (insertionIndex === null || !tabsRef.current) {
        setRemoteDropSlotLeft(null);
      } else {
        const contentLeft = insertionIndex < remoteTabRects.length
          ? remoteTabRects[insertionIndex].left
          : (remoteTabRects.at(-1)?.right ?? 0) + (remoteTabRects.length > 0 ? 4 : 0);
        setRemoteDropSlotLeft(contentLeft);
      }
      const isDropTarget = insertionIndex !== null;
      if (!activeTabDragRef.current) {
        if (isDropTarget) tabAutoScroller.update(tabsRef.current,
          state.targetClientX ?? state.screenX - window.screenX, () => handleDragState(state));
        else tabAutoScroller.stop();
      }
      document.body.classList.toggle('is-tab-drop-target', isDropTarget);
      if (remoteDropTargetRef.current !== isDropTarget) {
        remoteDropTargetRef.current = isDropTarget;
        void bridge.window.setCursorIcon(isDropTarget ? 'grabbing' : 'default');
      }
    };
    void bridge.onTabDragState(handleDragState).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenState = unlisten;
    });

    return () => {
      disposed = true;
      clearInterval(interval);
      window.removeEventListener('resize', reportBounds);
      unlistenImport?.();
      unlistenState?.();
      document.body.classList.remove('is-tab-drop-target');
      if (remoteDropTargetRef.current) {
        remoteDropTargetRef.current = false;
        void bridge.window.setCursorIcon('default');
      }
    };
  }, [bridge, openWorkspace, tabAutoScroller]);

  const completeTransfer = async (
    tab: WorkspaceDescriptor,
    point: ScreenPoint,
    sourceBounds: WindowBounds,
    attachToExisting = true,
    createIfUnattached = true,
  ): Promise<boolean> => {
    if (transferringTabsRef.current.has(tab.id)) return false;
    transferringTabsRef.current.add(tab.id);
    try {
      const sourceWindowLabel = windowLabelRef.current || await bridge.getWindowLabel();
      const transfer: WindowTabTransfer = {
        transferId: transferId(),
        sourceWindowLabel,
        tabId: tab.id,
        tabName: tab.name,
        paths: tab.paths,
      };
      const session = useAppStore.getState().exportTabSession(tab.id);
      if (session) await bridge.request({ type: 'windowStoreTabSession', payload: { transfer, session } }, { showProgress: false });
      try {
        return await bridge.transferTab(transfer, point, {
          x: point.screenX - 140,
          y: point.screenY - 18,
          width: sourceBounds.width,
          height: sourceBounds.height,
        }, attachToExisting, createIfUnattached);
      } finally {
        if (session) await bridge.request({ type: 'windowDiscardTabSession', payload: { transfer_id: transfer.transferId } }, { showProgress: false }).catch((error) => console.warn('Unable to release tab transfer session', error));
      }
    } catch (error) {
      useAppStore.getState().addNotification({ type: 'error', title: 'Workspace operation failed', message: { raw: error instanceof Error ? error.message : String(error) }, workspaceId: useAppStore.getState().snapshot?.workspace.id });
      return false;
    } finally {
      transferringTabsRef.current.delete(tab.id);
    }
  };

  const transferTabWithImmediateVisualRemoval = async (
    tab: WorkspaceDescriptor,
    point: ScreenPoint,
    sourceBounds: WindowBounds,
    attachToExisting: boolean,
    createIfUnattached = true,
    geometry?: Promise<WindowDragGeometry | null>,
  ) => {
    if (!useAppStore.getState().beginTabTransfer(tab.id)) return false;
    if (createIfUnattached) setPendingTransferTabIds((current) => new Set(current).add(tab.id));
    try {
      const dropGeometry = geometry ? await geometry : null;
      const accepted = await completeTransfer(tab, dropGeometry?.point ?? point, sourceBounds, attachToExisting, createIfUnattached);
      if (!accepted) return false;
      const remainingTabs = useAppStore.getState().tabs;
      if (remainingTabs.length === 1 && remainingTabs[0].id === tab.id) {
        // Close the native window before clearing its last tab, so it cannot
        // briefly render and resize into the welcome screen.
        await bridge.window.close();
      }
      useAppStore.getState().endTabTransfer(tab.id);
      await closeTab(tab.id, { closeWindowIfLast: false });
      return true;
    } finally {
      useAppStore.getState().endTabTransfer(tab.id);
      setPendingTransferTabIds((current) => {
        const next = new Set(current);
        next.delete(tab.id);
        return next;
      });
    }
  };

  const moveTabToNewWindow = async (tab: WorkspaceDescriptor) => {
    const sourceBounds = {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
    };
    await transferTabWithImmediateVisualRemoval(tab, {
      screenX: sourceBounds.x + 172,
      screenY: sourceBounds.y + 50,
    }, sourceBounds, false);
  };

  const beginTabPointerDrag = (event: React.PointerEvent<HTMLDivElement>, tab: WorkspaceDescriptor) => {
    if (activeTabDragRef.current || restoringDragRef.current) return;
    if (useAppStore.getState().transferringTabIds[tab.id]) return;
    if (startupTab?.id === tab.id) return;
    if (event.button !== 0 || transferringTabsRef.current.has(tab.id) || (event.target instanceof Element && event.target.closest('button'))) return;
    const element = event.currentTarget;
    const tabRect = element.getBoundingClientRect();
    const tabWidth = tabRect.width;
    const tabElements = Array.from(tabsRef.current?.querySelectorAll<HTMLElement>('.titlebar-tab') ?? []);
    const tabIds = tabElements.map((node) => node.dataset.tabId ?? '');
    const tabRects = tabElements
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, width: rect.width };
      });
    const originalIndex = tabIds.indexOf(tab.id);
    if (originalIndex < 0) return;
    const previousRect = tabRects[Math.max(0, originalIndex - 1)];
    const tabGap = originalIndex > 0 && previousRect
      ? Math.max(0, tabRects[originalIndex].left - previousRect.left - previousRect.width)
      : tabRects.length > 1
        ? Math.max(0, tabRects[1].left - tabRects[0].left - tabRects[0].width)
        : 4;
    const startPoint = dragPoint(event);
    const drag: ActiveTabDrag = {
      tab,
      originalIndex,
      targetIndex: originalIndex,
      pointerId: event.pointerId,
      startPoint,
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastPoint: startPoint,
      sourceBounds: {
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth > 0 ? window.outerWidth : window.innerWidth,
        height: window.outerHeight > 0 ? window.outerHeight : window.innerHeight,
      },
      lastBroadcastAt: 0,
      previewPrepared: false,
      detaching: false,
      started: false,
      tabRects,
      tabGap,
      tabIds,
      startScrollLeft: tabsRef.current?.scrollLeft ?? 0,
    };
    activeTabDragRef.current = drag;
    element.setPointerCapture(event.pointerId);

    const singleTabWindow = useAppStore.getState().tabs.length === 1;
    let movesWindow: boolean | null = singleTabWindow ? null : false;
    let latestPointer: PointerEvent | undefined;
    let awaitingRelease = false;
    let previewWarmed = false;
    const warmPreview = () => {
      if (previewWarmed || activeTabDragRef.current !== drag) return;
      previewWarmed = true;
      void tabDragPreviewWindow.prepare({
        sourceWindowLabel: windowLabelRef.current,
        tabId: tab.id,
        tabName: tab.name,
        tabWidth,
        paths: tab.paths,
      }, drag.lastPoint, isLightTheme(getEffectiveTheme()) ? 'light' : 'dark');
    };
    // No drag mode is selected until enumeration finishes, even for a fast gesture.
    const modeReady = singleTabWindow
      ? bridge.window.hasOtherWorkspaceWindows().catch((error) => {
        console.warn('Unable to enumerate workspace windows', error);
        return false;
      }).then((hasOtherWindows) => {
        movesWindow = !hasOtherWindows;
        if (!movesWindow) warmPreview();
        if (latestPointer && activeTabDragRef.current === drag) move(latestPointer);
      })
      : Promise.resolve();
    const nativeGeometry = singleTabWindow ? bridge.window.dragGeometry().catch(() => null) : Promise.resolve(null);
    let pendingWindowPoint: ScreenPoint | null = null;
    let movingWindow: Promise<void> | undefined;
    let moveFrame: number | undefined;
    const moveWindow = async (point: ScreenPoint) => {
      const geometry = await nativeGeometry;
      const origin = geometry?.sourceBounds ?? drag.sourceBounds;
      await bridge.window.setPosition(
        origin.x + point.screenX - drag.startPoint.screenX,
        origin.y + point.screenY - drag.startPoint.screenY,
      );
    };
    const scheduleWindowMove = () => {
      if (moveFrame !== undefined || movingWindow || !pendingWindowPoint) return;
      moveFrame = requestAnimationFrame(() => {
        moveFrame = undefined;
        const point = pendingWindowPoint;
        pendingWindowPoint = null;
        if (!point) return;
        movingWindow = moveWindow(point)
          .catch((error) => console.warn('Unable to move tab window', error))
          .finally(() => {
            movingWindow = undefined;
            scheduleWindowMove();
          });
      });
    };

    const publishDrag = (point: ScreenPoint) => {
      void bridge.broadcastTabDragState({
        sourceWindowLabel: windowLabelRef.current,
        tabId: tab.id,
        tabName: tab.name,
        tabWidth,
        paths: tab.paths,
        ...point,
      });
    };

    const isInSourceTitleBar = (pointer: PointerEvent) => pointer.clientX >= 0
      && pointer.clientX <= window.innerWidth
      && pointer.clientY >= -8
      && pointer.clientY <= 50;

    const updateReorderTarget = (pointer: PointerEvent) => {
      // Same-window ordering is a DOM interaction. Using global screen
      // coordinates here is unreliable in macOS titlebar overlays and on
      // mixed-DPI displays, where window.screenY and PointerEvent.screenY can
      // use different origins/scales.
      if (!isInSourceTitleBar(pointer)) return;
      if (drag.originalIndex === -1 || drag.tabRects.length === 0) return;
      const originalRect = drag.tabRects[drag.originalIndex];
      if (!originalRect) return;
      const firstRect = drag.tabRects[0];
      const lastRect = drag.tabRects[drag.tabRects.length - 1];
      const minDeltaX = firstRect.left - originalRect.left;
      const maxDeltaX = lastRect.left + lastRect.width - originalRect.left - tabWidth;
      const deltaX = Math.max(minDeltaX, Math.min(pointer.clientX - drag.startClientX + (tabsRef.current?.scrollLeft ?? 0) - drag.startScrollLeft, maxDeltaX));
      const draggedCenter = originalRect.left + deltaX + tabWidth / 2;
      const midpoints = drag.tabRects.map((rect) => rect.left + rect.width / 2);
      const reachedLeftBoundary = deltaX < 0 && deltaX <= minDeltaX + 0.5;
      const reachedRightBoundary = deltaX > 0 && deltaX >= maxDeltaX - 0.5;
      if (reachedLeftBoundary) {
        drag.targetIndex = 0;
      } else if (reachedRightBoundary) {
        drag.targetIndex = drag.tabRects.length - 1;
      } else {
        let insertionIndex = midpoints.findIndex((midpoint) => (
          deltaX < 0 ? draggedCenter <= midpoint : draggedCenter < midpoint
        ));
        if (insertionIndex === -1) insertionIndex = drag.tabRects.length;
        let targetIndex = insertionIndex;
        if (drag.originalIndex < targetIndex) targetIndex -= 1;
        drag.targetIndex = Math.max(0, Math.min(targetIndex, drag.tabRects.length - 1));
      }
      setLocalTabDragLayout({
        tabId: tab.id,
        originalIndex: drag.originalIndex,
        targetIndex: drag.targetIndex,
        deltaX,
        shiftX: tabWidth + drag.tabGap,
      });
    };

    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== drag.pointerId || activeTabDragRef.current !== drag) return;
      const point = dragPoint(pointer, drag.lastPoint);
      drag.lastPoint = point;
      latestPointer = pointer;
      if (movesWindow === null) return;
      const travelledDistance = movesWindow ? Math.hypot(
        point.screenX - drag.startPoint.screenX,
        point.screenY - drag.startPoint.screenY,
      ) : Math.hypot(
        pointer.clientX - drag.startClientX,
        pointer.clientY - drag.startClientY,
      );
      if (!drag.started && travelledDistance < 4) return;
      if (!drag.started) {
        drag.started = true;
        if (!movesWindow) setDraggingTabId(tab.id);
        document.body.classList.add('is-dragging-tab');
        void bridge.window.setCursorIcon('grabbing');
        publishDrag(point);
      }
      pointer.preventDefault();
      if (movesWindow) {
        pendingWindowPoint = point;
        scheduleWindowMove();
        const now = performance.now();
        if (now - drag.lastBroadcastAt >= 32) {
          drag.lastBroadcastAt = now;
          publishDrag(point);
        }
        return;
      }
      const detaching = !isInSourceTitleBar(pointer)
        && shouldDetachTab(point, drag.sourceBounds, travelledDistance);
      if (!detaching) {
        updateReorderTarget(pointer);
        if (isInSourceTitleBar(pointer)) tabAutoScroller.update(tabsRef.current, pointer.clientX, () => updateReorderTarget(latestPointer ?? pointer));
        else tabAutoScroller.stop();
        setTabDragPreview(null);
      } else {
        tabAutoScroller.stop();
        setLocalTabDragLayout(null);
      }
      if (detaching && !drag.previewPrepared) {
        drag.previewPrepared = true;
        warmPreview();
        tabDragPreviewWindow.activate();
      } else if (!detaching && drag.previewPrepared) {
        drag.previewPrepared = false;
        void tabDragPreviewWindow.deactivate().then(() => {
          if (!tabDragPreviewWindow.tracking) return bridge.broadcastTabDragState(null);
        });
      }
      document.body.classList.toggle('is-detaching-tab', detaching);
      if (drag.detaching !== detaching) {
        drag.detaching = detaching;
        void bridge.window.setCursorIcon(detaching ? 'copy' : 'grabbing');
      }
      const usesNativeDetachPreview = '__TAURI_INTERNALS__' in window;
      if (detaching) setTabDragPreview(usesNativeDetachPreview ? null : {
        tabName: tab.name,
        seed: tab.paths[0] || tab.name,
        screenX: point.screenX,
        screenY: point.screenY,
        width: tabWidth,
        detaching,
      });
      const now = performance.now();
      const nativePreviewOwnsTracking = '__TAURI_INTERNALS__' in window && tabDragPreviewWindow.tracking;
      if (!nativePreviewOwnsTracking && now - drag.lastBroadcastAt >= 32) {
        drag.lastBroadcastAt = now;
        publishDrag(point);
      }
    };

    const cleanup = () => {
      tabAutoScroller.stop();
      pendingWindowPoint = null;
      if (moveFrame !== undefined) cancelAnimationFrame(moveFrame);
      moveFrame = undefined;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', handleDragKeyDown, true);
      element.removeEventListener('lostpointercapture', handleLostCapture);
      cancelActiveDragRef.current = null;
      if (element.hasPointerCapture(drag.pointerId)) element.releasePointerCapture(drag.pointerId);
      if (activeTabDragRef.current === drag) activeTabDragRef.current = null;
      setDraggingTabId(null);
      setLocalTabDragLayout(null);
      setTabDragPreview(null);
      tabDragPreviewWindow.hide();
      document.body.classList.remove('is-dragging-tab', 'is-detaching-tab');
      void bridge.window.setCursorIcon('default');
    };

    const abortDrag = () => {
      if (activeTabDragRef.current !== drag) return;
      const started = drag.started;
      cleanup();
      restoringDragRef.current = Boolean(movesWindow && started);
      suppressClickRef.current = started ? tab.id : null;
      setTimeout(() => { if (suppressClickRef.current === tab.id) suppressClickRef.current = null; });
      void (async () => {
        // Let an in-flight native move settle before restoring the original position.
        await movingWindow;
        if (movesWindow && started && useAppStore.getState().tabs.some((item) => item.id === tab.id)) {
          const geometry = await nativeGeometry;
          const origin = geometry?.sourceBounds ?? drag.sourceBounds;
          await bridge.window.setPosition(origin.x, origin.y);
        }
      })().catch((error) => console.warn('Unable to restore cancelled tab drag', error))
        .finally(() => {
          restoringDragRef.current = false;
          if (!activeTabDragRef.current) void bridge.broadcastTabDragState(null);
        });
    };

    const end = (pointer: PointerEvent, cancelled: boolean) => {
      if (pointer.pointerId !== drag.pointerId || activeTabDragRef.current !== drag) return;
      if (cancelled) { abortDrag(); return; }
      if (awaitingRelease) return;
      if (movesWindow === null) {
        awaitingRelease = true;
        void modeReady.then(() => {
          awaitingRelease = false;
          end(pointer, cancelled);
        });
        return;
      }
      const point = dragPoint(pointer, drag.lastPoint);
      const travelledDistance = Math.hypot(
        pointer.clientX - drag.startClientX,
        pointer.clientY - drag.startClientY,
      );
      const detaching = drag.started
        && !cancelled
        && !isInSourceTitleBar(pointer)
        && shouldDetachTab(point, drag.sourceBounds, travelledDistance);
      const releasedInSourceTabBar = isInSourceTitleBar(pointer);
      if (drag.started && !cancelled && !detaching && releasedInSourceTabBar) {
        updateReorderTarget(pointer);
        const currentTabs = useAppStore.getState().tabs;
        const currentIndex = currentTabs.findIndex((item) => item.id === tab.id);
        const targetIndex = currentTabs.findIndex((item) => item.id === drag.tabIds[drag.targetIndex]);
        if (currentIndex !== -1 && targetIndex !== -1 && currentIndex !== targetIndex) {
          reorderTabs(currentIndex, targetIndex);
        }
      }
      const started = drag.started;
      cleanup();
      if (!started) return;
      suppressClickRef.current = tab.id;
      setTimeout(() => {
        if (suppressClickRef.current === tab.id) suppressClickRef.current = null;
      });
      if (movesWindow) {
        void (async () => {
          await movingWindow;
          if (cancelled) return;
          await moveWindow(point);
          const dropGeometry = await bridge.window.dragGeometry().catch(() => null);
          await transferTabWithImmediateVisualRemoval(tab, dropGeometry?.point ?? point, drag.sourceBounds, true, false);
        })().catch((error) => {
          useAppStore.getState().addNotification({ type: 'error', title: 'Workspace operation failed', message: { raw: error instanceof Error ? error.message : String(error) }, workspaceId: tab.id });
        }).finally(() => { void bridge.broadcastTabDragState(null); });
        return;
      }
      if (!detaching) {
        void bridge.broadcastTabDragState(null);
        return;
      }

      void (async () => {
        const accepted = await transferTabWithImmediateVisualRemoval(tab, point, drag.sourceBounds, true, !singleTabWindow,
          bridge.window.dragGeometry().catch(() => null));
        // The last tab already has a window: an unattached drop repositions it.
        if (singleTabWindow && !accepted) await moveWindow(point);
      })().catch((error) => {
        useAppStore.getState().addNotification({ type: 'error', title: 'Workspace operation failed', message: { raw: error instanceof Error ? error.message : String(error) }, workspaceId: tab.id });
      }).finally(() => { void bridge.broadcastTabDragState(null); });
    };

    function finish(pointer: PointerEvent) { end(pointer, false); }
    function cancel(pointer: PointerEvent) { end(pointer, true); }
    function handleDragKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      abortDrag();
    }
    function handleLostCapture(pointer: PointerEvent) {
      if (pointer.pointerId !== drag.pointerId) return;
      // pointerup releases capture automatically, even while window enumeration
      // is pending. Keep that release queued; only unexpected capture loss cancels.
      if (!awaitingRelease) abortDrag();
    }

    cancelActiveDragRef.current = abortDrag;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', handleDragKeyDown, true);
    element.addEventListener('lostpointercapture', handleLostCapture);
    if (!singleTabWindow) warmPreview();
  };

  const remoteInsertionActive = snapInsertionIndex !== null
    && remoteDragState !== null
    && remoteDragState.sourceWindowLabel !== windowLabel;
  const remoteTabWidth = remoteDragState
    ? Math.max(110, Math.min(remoteDragState.tabWidth, 220))
    : 0;
  const remoteTabShiftX = remoteInsertionActive ? remoteTabWidth + 4 : 0;

  return (
    <>
      <header
        className={`titlebar ${platform} ${tabs.length === 0 ? 'welcome-mode' : ''}`}
        data-tauri-drag-region
        onDoubleClick={(event) => {
          if (tabs.length === 0) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {platform === 'macos' && <div className="titlebar-macos-spacer" data-tauri-drag-region />}
        {tabs.length > 0 && (
          <div className={`titlebar-tabs-track ${snapInsertionIndex !== null ? 'tab-snap-active' : ''}`}>
            <div ref={tabsRef} className="titlebar-tabs" role="tablist">
              {tabs.filter((tab) => !pendingTransferTabIds.has(tab.id)).map((tab, index) => {
                const isActive = tab.id === activeTabId;
                const isDragging = tab.id === draggingTabId;
                const isLocalDragging = localTabDragLayout?.tabId === tab.id;
                const isRemoteShifting = !localTabDragLayout
                  && remoteInsertionActive
                  && index >= snapInsertionIndex;
                let dragTranslateX = 0;
                if (localTabDragLayout) {
                  if (isLocalDragging) {
                    dragTranslateX = localTabDragLayout.deltaX;
                  } else if (
                    localTabDragLayout.originalIndex < localTabDragLayout.targetIndex
                    && index > localTabDragLayout.originalIndex
                    && index <= localTabDragLayout.targetIndex
                  ) {
                    dragTranslateX = -localTabDragLayout.shiftX;
                  } else if (
                    localTabDragLayout.targetIndex < localTabDragLayout.originalIndex
                    && index >= localTabDragLayout.targetIndex
                    && index < localTabDragLayout.originalIndex
                  ) {
                    dragTranslateX = localTabDragLayout.shiftX;
                  }
                } else if (isRemoteShifting) {
                  dragTranslateX = remoteTabShiftX;
                }
                return (
                  <Fragment key={tab.id}>
                    <div
                      key={tab.id}
                      data-tab-id={tab.id}
                      role="tab"
                      aria-selected={isActive}
                      onPointerDown={(event) => beginTabPointerDrag(event, tab)}
                      className={`titlebar-tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isLocalDragging ? 'local-dragging' : ''} ${dragTranslateX !== 0 && !isLocalDragging ? 'reorder-shifting' : ''} ${isRemoteShifting ? 'remote-reorder-shifting' : ''}`}
                      style={localTabDragLayout || isRemoteShifting ? {
                        transform: `translate3d(${dragTranslateX}px, 0, 0)${isLocalDragging ? ' scale(1.025)' : ''}`,
                      } : undefined}
                      onClick={(event) => {
                        if (startupTab?.id === tab.id) return;
                        if (suppressClickRef.current === tab.id) {
                          suppressClickRef.current = null;
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        void switchTab(tab.id);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        if (startupTab?.id === tab.id) return;
                        setContextMenu({
                          visible: true,
                          x: event.clientX,
                          y: event.clientY,
                          tabId: tab.id,
                        });
                      }}
                      onAuxClick={(event) => {
                        if (startupTab?.id === tab.id) return;
                        if (event.button === 1) {
                          event.preventDefault();
                          void closeTab(tab.id);
                        }
                      }}
                      title={tab.paths.join(' · ')}
                    >
                      <ProjectIcon
                        name={tab.name}
                        seed={tab.paths[0] || tab.id || tab.name}
                        size="small"
                        available={tab.available}
                        className="titlebar-tab-icon"
                      />
                      <span className="titlebar-tab-title">{tab.name}</span>
                      <IconButton
                        type="button"
                        className="titlebar-tab-close"
                        disabled={startupTab?.id === tab.id || Boolean(transferringTabIds[tab.id])}
                        aria-label={t('Close Tab')}
                        title={t('Close Tab')}
                        onClick={(event) => {
                          event.stopPropagation();
                          void closeTab(tab.id);
                        }}
                      >
                        <Codicon name="close" />
                      </IconButton>
                    </div>
                  </Fragment>
                );
              })}

              {remoteInsertionActive && remoteDropSlotLeft !== null && (
                <div
                  className="titlebar-remote-drop-slot"
                  style={{ left: remoteDropSlotLeft, width: remoteTabWidth }}
                  aria-hidden="true"
                />
              )}
              {remoteInsertionActive && (
                <div
                  className="titlebar-remote-end-spacer"
                  style={{ width: remoteTabShiftX }}
                  aria-hidden="true"
                />
              )}
            </div>
            <IconButton
              ref={addAnchorRef}
              type="button"
              className={`titlebar-tab-add ${newTabMenuOpen ? 'active' : ''} ${draggingTabId !== null || remoteInsertionActive ? 'drag-hidden' : ''}`}
              aria-label={t('New Tab')}
              aria-hidden={draggingTabId !== null || remoteInsertionActive}
              title={t('Open Another Workspace')}
              disabled={busy || Boolean(startupTab)}
              tabIndex={draggingTabId !== null || remoteInsertionActive ? -1 : undefined}
              onClick={toggleNewTabMenu}
            >
              <Codicon name="plus" />
            </IconButton>
          </div>
        )}
        {tabs.length === 0 && (
          <div className="titlebar-welcome-title" data-tauri-drag-region>
            <span className="titlebar-welcome-app-name">{t('Welcome to VersionDock')}</span>
          </div>
        )}
        <div
          className="titlebar-drag"
          data-tauri-drag-region
          onPointerDown={(event) => { if (event.button === 0) void bridge.window.startDragging(); }}
        />
        {platform === 'linux' && (
          <div className="window-controls linux" onPointerDown={(event) => event.stopPropagation()}>
            <button type="button" aria-label={t('Minimize')} title={t('Minimize')} onClick={() => void bridge.window.minimize()}>
              <Codicon name="chrome-minimize" />
            </button>
            <button type="button" aria-label={maximized ? t('Restore') : t('Maximize')} title={maximized ? t('Restore') : t('Maximize')} disabled={tabs.length === 0} onClick={() => { if (tabs.length > 0) void bridge.window.toggleMaximize().then(() => setMaximized((value) => !value)); }}>
              <Codicon name={maximized ? 'chrome-restore' : 'chrome-maximize'} />
            </button>
            <button type="button" className="close" aria-label={t('Close')} title={t('Close')} onClick={() => void bridge.window.close()}>
              <Codicon name="chrome-close" />
            </button>
          </div>
        )}
      </header>

      {tabDragPreview && (
        <div
          className={`titlebar-tab-drag-preview ${tabDragPreview.detaching ? 'detaching' : ''}`}
          style={{
            left: tabDragPreview.screenX - window.screenX + 14,
            top: tabDragPreview.screenY - window.screenY + 14,
            width: tabDragPreview.width,
          }}
          aria-hidden="true"
        >
          <ProjectIcon
            name={tabDragPreview.tabName}
            seed={tabDragPreview.seed || tabDragPreview.tabName}
            size="small"
            available={true}
            className="titlebar-tab-icon"
          />
          <span className="titlebar-tab-title">{tabDragPreview.tabName}</span>
          <span className="titlebar-tab-ghost-close"><Codicon name="close" /></span>
        </div>
      )}

      {contextMenu?.visible && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            { id: 'new-window', label: t('Open in New Window'), icon: 'window', disabled: Boolean(transferringTabIds[contextMenu.tabId]) },
            { separator: true },
            { id: 'close', label: t('Close Tab'), icon: 'close', disabled: Boolean(transferringTabIds[contextMenu.tabId]) },
            ...(tabs.length > 1 ? [{ id: 'close-others', label: t('Close Other Tabs'), icon: 'close-all', disabled: Object.keys(transferringTabIds).some((id) => id !== contextMenu.tabId) } as ContextMenuEntry] : []),
          ]}
          onSelect={(id) => {
            const targetTab = tabs.find((t) => t.id === contextMenu.tabId);
            if (id === 'new-window' && targetTab) void moveTabToNewWindow(targetTab);
            else if (id === 'close') void closeTab(contextMenu.tabId);
            else if (id === 'close-others') void closeOtherTabs(contextMenu.tabId);
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {newTabMenuOpen && (
        <aside
          ref={addMenuRef}
          className="workspace-switcher titlebar-tab-menu"
          role="menu"
          style={{
            position: 'fixed',
            top: menuPos.top,
            left: menuPos.left,
            transform: 'none',
          }}
        >
          <div className="workspace-menu-primary-wrap">
            <button
              type="button"
              className="workspace-menu-primary-btn"
              role="menuitem"
              disabled={busy}
              onClick={() => void chooseWorkspace()}
            >
              <div className="workspace-menu-btn-icon">
                <Codicon name="folder-opened" />
              </div>
              <div className="workspace-menu-btn-content">
                <span className="workspace-menu-btn-title">{t('Open Another Workspace')}</span>
                <span className="workspace-menu-btn-desc">{t('Open a folder to discover Git and SVN repositories.')}</span>
              </div>
              <Codicon name="chevron-right" className="workspace-menu-btn-arrow" />
            </button>
          </div>

          {recentWorkspaces.length > 0 && (
            <>
              <div className="workspace-menu-header">
                <span>{t('Recent Workspaces')}</span>
                <span className="workspace-menu-count">{recentWorkspaces.length}</span>
              </div>
              <div className="workspace-menu-scroll">
                {recentWorkspaces.map((workspace) => {
                  const isOpened = tabs.some((t) => t.id === workspace.id);
                  const isCurrentActive = workspace.id === activeTabId;
                  return (
                    <div
                      key={workspace.id}
                      className={`workspace-menu-item-row-wrap ${isCurrentActive ? 'active' : ''}`}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className={`workspace-menu-item ${isCurrentActive ? 'active' : ''} ${isOpened ? 'opened' : ''} ${workspace.available ? '' : 'unavailable'}`}
                        disabled={!workspace.available || busy}
                        onClick={(event) => {
                          if (event.metaKey || event.ctrlKey) {
                            void bridge.openInNewWindow(workspace.paths);
                            setNewTabMenuOpen(false);
                          } else {
                            void handleOpenRecent(workspace.paths);
                          }
                        }}
                      >
                        <ProjectIcon
                          name={workspace.name}
                          seed={workspace.paths[0] || workspace.id || workspace.name}
                          size="medium"
                          available={workspace.available}
                          className="workspace-menu-item-icon"
                        />
                        <div className="workspace-menu-item-info">
                          <div className="workspace-menu-item-row">
                            <span className="workspace-menu-item-name">{workspace.name}</span>
                            {isOpened && <span className="workspace-menu-tag">{t('Open')}</span>}
                          </div>
                          <span className="workspace-menu-item-path" title={workspace.paths.join(' · ')}>
                            {workspace.paths.join(' · ')}
                          </span>
                        </div>
                        {isCurrentActive && (
                          <div className="workspace-menu-item-check">
                            <Codicon name="check" />
                          </div>
                        )}
                      </button>
                      <IconButton
                        type="button"
                        className="workspace-menu-item-open-window"
                        aria-label={t('Open in New Window')}
                        title={t('Open in New Window')}
                        disabled={!workspace.available || busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          void bridge.openInNewWindow(workspace.paths);
                          setNewTabMenuOpen(false);
                        }}
                      >
                        <Codicon name="window" />
                      </IconButton>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}
