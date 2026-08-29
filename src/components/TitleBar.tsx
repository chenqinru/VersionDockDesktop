import { Fragment, useEffect, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { isOperationActive, useAppStore } from '../store/appStore';
import { useBridge } from '../platform/context';
import type { TabDragPayload } from '../platform/bridge';
import type { WindowTabTransfer, WorkspaceDescriptor } from '../bindings/generated';
import { dragPoint, shouldDetachTab, tabSnapInsertionIndex, type ScreenPoint, type WindowBounds } from '../windowing/tabDrag';
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
}

interface TabDragPreview {
  tabName: string;
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

export function TitleBar() {
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const addAnchorRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const snapInsertionIndexRef = useRef<number | null>(null);
  const transferringTabsRef = useRef(new Set<string>());
  const windowLabelRef = useRef('');
  const activeTabDragRef = useRef<ActiveTabDrag | null>(null);
  const remoteDragTabIdRef = useRef<string | null>(null);
  const nativeRemoteTrackingTabIdRef = useRef<string | null>(null);
  const importingRemoteTabIdRef = useRef<string | null>(null);
  const remoteTabRectsRef = useRef<Array<{ left: number; right: number; width: number }> | null>(null);
  const remoteDropTargetRef = useRef(false);
  const suppressClickRef = useRef<string | null>(null);
  const bridge = useBridge();
  const platform = bridge.platform();
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const busy = useAppStore((state) => isOperationActive(state.operations, { domain: 'workspace' }));
  const recentWorkspaces = useAppStore((state) => state.bootstrap?.state.recentWorkspaces ?? []);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const switchTab = useAppStore((state) => state.switchTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const { t } = useI18n();
  const [tabDragPreviewWindow] = useState(() => new TabDragPreviewWindow());

  useEffect(() => {
    if (platform !== 'linux') return;
    void bridge.window.isMaximized().then(setMaximized);
  }, [bridge, platform]);

  useEffect(() => () => tabDragPreviewWindow.hide(), [tabDragPreviewWindow]);

  useEffect(() => {
    if (!newTabMenuOpen) return;
    const handleOutsideInteraction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (addAnchorRef.current?.contains(target) || addMenuRef.current?.contains(target)) return;
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

  useEffect(() => {
    if (!contextMenu?.visible) return;
    const handleCloseMenu = () => setContextMenu(null);
    const handleEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setContextMenu(null); };
    document.addEventListener('pointerdown', handleCloseMenu);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleCloseMenu);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu?.visible]);

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

    void bridge.onImportTab(({ transfer }) => {
      void (async () => {
        const insertionIndex = snapInsertionIndexRef.current ?? useAppStore.getState().tabs.length;
        importingRemoteTabIdRef.current = transfer.tabId;
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
        const accepted = await openWorkspace(transfer.paths, true, {
          skipCrossWindowFocus: true,
          insertionIndex,
        });
        const targetWindowLabel = windowLabelRef.current || await bridge.getWindowLabel();
        await bridge.completeTabTransfer(transfer, targetWindowLabel, accepted);
      })();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenImport = unlisten;
    });

    void bridge.onTabDragState((state) => {
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
      document.body.classList.toggle('is-tab-drop-target', isDropTarget);
      if (remoteDropTargetRef.current !== isDropTarget) {
        remoteDropTargetRef.current = isDropTarget;
        void bridge.window.setCursorIcon(isDropTarget ? 'grabbing' : 'default');
      }
    }).then((unlisten) => {
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
  }, [bridge, openWorkspace]);

  const completeTransfer = async (
    tab: WorkspaceDescriptor,
    point: ScreenPoint,
    sourceBounds: WindowBounds,
    attachToExisting = true,
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
      return await bridge.transferTab(transfer, point, {
        x: point.screenX - 140,
        y: point.screenY - 18,
        width: sourceBounds.width,
        height: sourceBounds.height,
      }, attachToExisting);
    } catch (error) {
      useAppStore.setState({ error: error instanceof Error ? error.message : String(error) });
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
  ) => {
    setPendingTransferTabIds((current) => new Set(current).add(tab.id));
    const isLastTab = useAppStore.getState().tabs.length <= 1;
    try {
      const accepted = await completeTransfer(tab, point, sourceBounds, attachToExisting);
      if (!accepted) return;
      await closeTab(tab.id);
      if (isLastTab && useAppStore.getState().tabs.length === 0) await bridge.window.close();
    } finally {
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
    if (event.button !== 0 || transferringTabsRef.current.has(tab.id) || (event.target instanceof Element && event.target.closest('button'))) return;
    const element = event.currentTarget;
    const tabRect = element.getBoundingClientRect();
    const tabWidth = tabRect.width;
    const tabRects = Array.from(tabsRef.current?.querySelectorAll<HTMLElement>('.titlebar-tab') ?? [])
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, width: rect.width };
      });
    const originalIndex = useAppStore.getState().tabs.findIndex((item) => item.id === tab.id);
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
    };
    activeTabDragRef.current = drag;
    element.setPointerCapture(event.pointerId);

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
      const firstRect = drag.tabRects[0];
      const lastRect = drag.tabRects[drag.tabRects.length - 1];
      const minDeltaX = firstRect.left - originalRect.left;
      const maxDeltaX = lastRect.left + lastRect.width - originalRect.left - tabWidth;
      const deltaX = Math.max(minDeltaX, Math.min(pointer.clientX - drag.startClientX, maxDeltaX));
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
      const travelledDistance = Math.hypot(
        pointer.clientX - drag.startClientX,
        pointer.clientY - drag.startClientY,
      );
      if (!drag.started && travelledDistance < 4) return;
      if (!drag.started) {
        drag.started = true;
        setDraggingTabId(tab.id);
        document.body.classList.add('is-dragging-tab');
        void bridge.window.setCursorIcon('grabbing');
        publishDrag(point);
      }
      pointer.preventDefault();
      const detaching = !isInSourceTitleBar(pointer)
        && shouldDetachTab(point, drag.sourceBounds, travelledDistance);
      if (!detaching) {
        updateReorderTarget(pointer);
        setTabDragPreview(null);
      } else {
        setLocalTabDragLayout(null);
      }
      if (detaching && !drag.previewPrepared) {
        drag.previewPrepared = true;
        void tabDragPreviewWindow.prepare(
          {
            sourceWindowLabel: windowLabelRef.current,
            tabId: tab.id,
            tabName: tab.name,
            tabWidth,
            paths: tab.paths,
          },
          point,
          document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
        );
        tabDragPreviewWindow.activate();
      } else if (!detaching && drag.previewPrepared) {
        drag.previewPrepared = false;
        tabDragPreviewWindow.hide();
      }
      document.body.classList.toggle('is-detaching-tab', detaching);
      if (drag.detaching !== detaching) {
        drag.detaching = detaching;
        void bridge.window.setCursorIcon(detaching ? 'copy' : 'grabbing');
      }
      const usesNativeDetachPreview = '__TAURI_INTERNALS__' in window;
      if (detaching) setTabDragPreview(usesNativeDetachPreview ? null : {
        tabName: tab.name,
        screenX: point.screenX,
        screenY: point.screenY,
        width: tabWidth,
        detaching,
      });
      const now = performance.now();
      const nativePreviewOwnsTracking = '__TAURI_INTERNALS__' in window && drag.previewPrepared;
      if (!nativePreviewOwnsTracking && now - drag.lastBroadcastAt >= 32) {
        drag.lastBroadcastAt = now;
        publishDrag(point);
      }
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', cancel, true);
      if (element.hasPointerCapture(drag.pointerId)) element.releasePointerCapture(drag.pointerId);
      if (activeTabDragRef.current === drag) activeTabDragRef.current = null;
      setDraggingTabId(null);
      setLocalTabDragLayout(null);
      setTabDragPreview(null);
      tabDragPreviewWindow.hide();
      document.body.classList.remove('is-dragging-tab', 'is-detaching-tab');
      void bridge.window.setCursorIcon('default');
    };

    const end = (pointer: PointerEvent, cancelled: boolean) => {
      if (pointer.pointerId !== drag.pointerId || activeTabDragRef.current !== drag) return;
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
        if (currentIndex !== -1 && currentIndex !== drag.targetIndex) {
          reorderTabs(currentIndex, drag.targetIndex);
        }
      }
      const started = drag.started;
      cleanup();
      if (!started) return;
      suppressClickRef.current = tab.id;
      setTimeout(() => {
        if (suppressClickRef.current === tab.id) suppressClickRef.current = null;
      });
      if (!detaching) {
        void bridge.broadcastTabDragState(null);
        return;
      }

      void transferTabWithImmediateVisualRemoval(tab, point, drag.sourceBounds, true)
        .finally(() => { void bridge.broadcastTabDragState(null); });
    };

    function finish(pointer: PointerEvent) { end(pointer, false); }
    function cancel(pointer: PointerEvent) { end(pointer, true); }

    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', cancel, true);
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
                        setContextMenu({
                          visible: true,
                          x: event.clientX,
                          y: event.clientY,
                          tabId: tab.id,
                        });
                      }}
                      onAuxClick={(event) => {
                        if (event.button === 1) {
                          event.preventDefault();
                          void closeTab(tab.id);
                        }
                      }}
                      title={tab.paths.join(' · ')}
                    >
                      <Codicon name={tab.available ? 'folder-opened' : 'warning'} className="titlebar-tab-icon" />
                      <span className="titlebar-tab-title">{tab.name}</span>
                      <button
                        type="button"
                        className="titlebar-tab-close"
                        aria-label={t('Close Tab')}
                        title={t('Close Tab')}
                        onClick={(event) => {
                          event.stopPropagation();
                          void closeTab(tab.id);
                        }}
                      >
                        <Codicon name="close" />
                      </button>
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
            <button
              ref={addAnchorRef}
              type="button"
              className={`titlebar-tab-add ${newTabMenuOpen ? 'active' : ''} ${draggingTabId !== null || remoteInsertionActive ? 'drag-hidden' : ''}`}
              aria-label={t('New Tab')}
              aria-hidden={draggingTabId !== null || remoteInsertionActive}
              title={t('Open Another Workspace')}
              disabled={busy}
              tabIndex={draggingTabId !== null || remoteInsertionActive ? -1 : undefined}
              onClick={toggleNewTabMenu}
            >
              <Codicon name="plus" />
            </button>
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
          <Codicon name="folder-opened" className="titlebar-tab-icon" />
          <span className="titlebar-tab-title">{tabDragPreview.tabName}</span>
          <span className="titlebar-tab-ghost-close"><Codicon name="close" /></span>
        </div>
      )}

      {contextMenu?.visible && (
        <div
          className="tab-context-menu"
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 1000,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {(() => {
            const targetTab = tabs.find((t) => t.id === contextMenu.tabId);
            return (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (targetTab) {
                      void moveTabToNewWindow(targetTab);
                    }
                    setContextMenu(null);
                  }}
                >
                  <Codicon name="window" />
                  <span>{t('Open in New Window')}</span>
                </button>
                <div className="tab-context-menu-divider" />
                <button
                  type="button"
                  onClick={() => {
                    void closeTab(contextMenu.tabId);
                    setContextMenu(null);
                  }}
                >
                  <Codicon name="close" />
                  <span>{t('Close Tab')}</span>
                </button>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      void closeOtherTabs(contextMenu.tabId);
                      setContextMenu(null);
                    }}
                  >
                    <Codicon name="close-all" />
                    <span>{t('Close Other Tabs')}</span>
                  </button>
                )}
              </>
            );
          })()}
        </div>
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
                        <div className="workspace-menu-item-icon">
                          <Codicon name={workspace.available ? 'folder' : 'warning'} />
                        </div>
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
                      <button
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
                      </button>
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
