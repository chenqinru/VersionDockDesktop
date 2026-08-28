import { Fragment, useEffect, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { useBridge } from '../platform/context';
import type { TabDragPayload } from '../platform/bridge';
import type { WindowTabTransfer, WorkspaceDescriptor } from '../bindings/generated';
import { tabSnapInsertionIndex, type ScreenPoint, type WindowBounds } from '../windowing/tabDrag';

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
  const lastDragPointRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const dragStartPointRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const lastBroadcastRef = useRef<number>(0);
  const bridge = useBridge();
  const platform = bridge.platform();
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const busy = useAppStore((state) => state.busy);
  const recentWorkspaces = useAppStore((state) => state.bootstrap?.state.recentWorkspaces ?? []);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const switchTab = useAppStore((state) => state.switchTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const { t } = useI18n();

  useEffect(() => {
    if (platform !== 'linux') return;
    void bridge.window.isMaximized().then(setMaximized);
  }, [bridge, platform]);

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
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
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

  useEffect(() => {
    let disposed = false;
    void bridge.getWindowLabel().then((label) => {
      if (disposed) return;
      windowLabelRef.current = label;
      setWindowLabel(label);
    });

    const reportBounds = () => {
      void bridge.syncWindowBounds({
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight,
      });
    };
    reportBounds();
    const interval = setInterval(reportBounds, 800);
    window.addEventListener('resize', reportBounds);

    let unlistenState: (() => void) | undefined;
    let unlistenImport: (() => void) | undefined;

    void bridge.onImportTab(({ transfer }) => {
      void (async () => {
        const insertionIndex = snapInsertionIndexRef.current ?? useAppStore.getState().tabs.length;
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
      setRemoteDragState(state);
      if (!state || state.sourceWindowLabel === windowLabelRef.current) {
        snapInsertionIndexRef.current = null;
        setSnapInsertionIndex(null);
        return;
      }
      const midpoints = Array.from(tabsRef.current?.querySelectorAll<HTMLElement>('.titlebar-tab') ?? [])
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left + rect.width / 2;
        });
      let insertionIndex = tabSnapInsertionIndex(
        { screenX: state.screenX, screenY: state.screenY },
        { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight },
        midpoints,
      );
      if (insertionIndex === null) {
        const winX = window.screenX;
        const winY = window.screenY;
        const winW = window.outerWidth;
        const winH = window.outerHeight;
        if (
          state.screenX >= winX - 25 &&
          state.screenX <= winX + winW + 25 &&
          state.screenY >= winY - 25 &&
          state.screenY <= winY + Math.max(winH, 200)
        ) {
          insertionIndex = useAppStore.getState().tabs.length;
        }
      }
      snapInsertionIndexRef.current = insertionIndex;
      setSnapInsertionIndex(insertionIndex);
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
    };
  }, [bridge, openWorkspace]);

  useEffect(() => {
    if (snapInsertionIndex === null) return;
    const frame = requestAnimationFrame(() => {
      tabsRef.current?.querySelector<HTMLElement>('.titlebar-tab-snap-placeholder')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [snapInsertionIndex]);

  const completeTransfer = async (
    tab: WorkspaceDescriptor,
    point: ScreenPoint,
    sourceBounds: WindowBounds,
    attachToExisting = true,
  ) => {
    if (transferringTabsRef.current.has(tab.id)) return;
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
      await bridge.transferTab(transfer, point, {
        x: point.screenX - 140,
        y: point.screenY - 18,
        width: sourceBounds.width,
        height: sourceBounds.height,
      }, attachToExisting);
    } catch (error) {
      useAppStore.setState({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      transferringTabsRef.current.delete(tab.id);
    }
  };

  const moveTabToNewWindow = async (tab: WorkspaceDescriptor) => {
    const sourceBounds = {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
    };
    const isLastTab = useAppStore.getState().tabs.length <= 1;
    await closeTab(tab.id);
    await completeTransfer(tab, {
      screenX: sourceBounds.x + 172,
      screenY: sourceBounds.y + 50,
    }, sourceBounds, false);
    if (isLastTab) {
      await bridge.window.close();
    }
  };

  const handleTabDragEnd = (event: React.DragEvent, tab: WorkspaceDescriptor) => {
    setDraggingTabId(null);
    setDragOverTabId(null);
    void bridge.broadcastTabDragState(null);

    const hasValidEventCoords = (event.screenX > 10 || event.screenY > 10);
    const lastPoint = lastDragPointRef.current;
    const hasValidLastCoords = lastPoint !== null && (lastPoint.screenX > 10 || lastPoint.screenY > 10);

    const point = hasValidEventCoords
      ? { screenX: event.screenX, screenY: event.screenY }
      : (hasValidLastCoords ? lastPoint : null);

    const startPoint = dragStartPointRef.current;

    // 若无有效坐标或无有效起始点，说明根本未发生有效拖拽，直接取消，绝对不关闭 Tab
    if (!point || !startPoint || (startPoint.screenX <= 10 && startPoint.screenY <= 10)) {
      return;
    }

    const distance = Math.hypot(point.screenX - startPoint.screenX, point.screenY - startPoint.screenY);
    // 1. 如果移动距离过小（微调、误触或轻微晃动，小于 35px），视为取消脱离，原 Tab 保持原样
    if (distance < 35) {
      return;
    }

    const localX = point.screenX - window.screenX;
    const localY = point.screenY - window.screenY;
    const winWidth = window.outerWidth > 0 ? window.outerWidth : window.innerWidth;

    // 2. 如果松开时鼠标落在当前源窗口的 Tab 栏安全区域内（例如拖出去后又放回了原 Tab 栏），视为取消脱离
    const releasedInSourceTabBar =
      localX >= -20 &&
      localX <= winWidth + 20 &&
      localY >= -30 &&
      localY <= 50;

    if (releasedInSourceTabBar) {
      return;
    }

    // 3. 确实脱离了当前 Tab 栏或当前窗口，立即执行 0 延迟脱离成窗与跨窗口吸附合并
    const isLastTab = useAppStore.getState().tabs.length <= 1;
    void closeTab(tab.id);
    void (async () => {
      try {
        await completeTransfer(tab, point, {
          x: point.screenX - 140,
          y: point.screenY - 18,
          width: winWidth,
          height: window.outerHeight > 0 ? window.outerHeight : window.innerHeight,
        }, true);
      } finally {
        if (isLastTab) {
          await bridge.window.close();
        }
      }
    })();
  };

  const handleDragOverTab = (event: React.DragEvent, tabId: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (draggingTabId && draggingTabId !== tabId && dragOverTabId !== tabId) {
      setDragOverTabId(tabId);
    }
  };

  const handleDropOnTab = (event: React.DragEvent, targetTabId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const sourceTabId = draggingTabId || event.dataTransfer.getData('text/plain');
    if (sourceTabId && sourceTabId !== targetTabId) {
      const fromIndex = tabs.findIndex((t) => t.id === sourceTabId);
      const toIndex = tabs.findIndex((t) => t.id === targetTabId);
      if (fromIndex !== -1 && toIndex !== -1) {
        reorderTabs(fromIndex, toIndex);
      }
    }
    setDraggingTabId(null);
    setDragOverTabId(null);
  };

  return (
    <>
      <header className={`titlebar ${platform}`} data-tauri-drag-region>
        {platform === 'macos' && <div className="titlebar-macos-spacer" data-tauri-drag-region />}
        <div className={`titlebar-tabs-track ${snapInsertionIndex !== null ? 'tab-snap-active' : ''}`}>
          <div ref={tabsRef} className="titlebar-tabs" role="tablist">
            {tabs.map((tab, index) => {
              const isActive = tab.id === activeTabId;
              const isDragging = tab.id === draggingTabId;
              const isDragOver = tab.id === dragOverTabId && draggingTabId !== tab.id;
              return (
                <Fragment key={tab.id}>
                  {snapInsertionIndex === index && remoteDragState && remoteDragState.sourceWindowLabel !== windowLabel && (
                    <div className="titlebar-tab-snap-placeholder" aria-hidden="true">
                      <Codicon name="folder-opened" className="titlebar-tab-icon" />
                      <span className="titlebar-tab-title">{remoteDragState.tabName}</span>
                      <span className="titlebar-tab-ghost-close"><Codicon name="close" /></span>
                    </div>
                  )}
                  <div
                    key={tab.id}
                    data-tab-id={tab.id}
                    role="tab"
                    aria-selected={isActive}
                    draggable={true}
                    onDragStart={(event) => {
                      const payload = JSON.stringify({
                        type: 'versiondock-tab',
                        tabId: tab.id,
                        paths: tab.paths,
                        tabName: tab.name,
                        sourceWindowLabel: windowLabelRef.current,
                      });
                      event.dataTransfer.setData('application/versiondock-tab', payload);
                      event.dataTransfer.setData('text/plain', tab.id);
                      event.dataTransfer.effectAllowed = 'move';
                      setDraggingTabId(tab.id);
                      const startPoint = { screenX: event.screenX, screenY: event.screenY };
                      dragStartPointRef.current = startPoint;
                      lastDragPointRef.current = startPoint;
                      void bridge.broadcastTabDragState({
                        sourceWindowLabel: windowLabelRef.current,
                        tabId: tab.id,
                        tabName: tab.name,
                        paths: tab.paths,
                        screenX: event.screenX,
                        screenY: event.screenY,
                      });
                    }}
                    onDrag={(event) => {
                      if (event.screenX === 0 && event.screenY === 0) return;
                      lastDragPointRef.current = { screenX: event.screenX, screenY: event.screenY };
                      const now = performance.now();
                      if (now - lastBroadcastRef.current >= 32) {
                        lastBroadcastRef.current = now;
                        void bridge.broadcastTabDragState({
                          sourceWindowLabel: windowLabelRef.current,
                          tabId: tab.id,
                          tabName: tab.name,
                          paths: tab.paths,
                          screenX: event.screenX,
                          screenY: event.screenY,
                        });
                      }
                    }}
                    onDragOver={(event) => handleDragOverTab(event, tab.id)}
                    onDragLeave={() => {
                      if (dragOverTabId === tab.id) setDragOverTabId(null);
                    }}
                    onDrop={(event) => handleDropOnTab(event, tab.id)}
                    onDragEnd={(event) => handleTabDragEnd(event, tab)}
                    className={`titlebar-tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
                    onClick={() => { void switchTab(tab.id); }}
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
                    <Codicon name="folder-opened" className="titlebar-tab-icon" />
                    <span className="titlebar-tab-title">{tab.name}</span>
                    <button
                      type="button"
                      className="titlebar-tab-close"
                      aria-label={t('Close')}
                      title={t('Close')}
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

            {snapInsertionIndex === tabs.length && remoteDragState && remoteDragState.sourceWindowLabel !== windowLabel && (
              <div className="titlebar-tab-snap-placeholder" aria-hidden="true">
                <Codicon name="folder-opened" className="titlebar-tab-icon" />
                <span className="titlebar-tab-title">{remoteDragState.tabName}</span>
                <span className="titlebar-tab-ghost-close"><Codicon name="close" /></span>
              </div>
            )}
          </div>
          <button
            ref={addAnchorRef}
            type="button"
            className={`titlebar-tab-add ${newTabMenuOpen ? 'active' : ''}`}
            aria-label={t('New Tab')}
            title={t('Open Another Workspace')}
            disabled={busy}
            onClick={toggleNewTabMenu}
          >
            <Codicon name="plus" />
          </button>
        </div>
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
            <button type="button" aria-label={maximized ? t('Restore') : t('Maximize')} title={maximized ? t('Restore') : t('Maximize')} onClick={() => { void bridge.window.toggleMaximize().then(() => setMaximized((value) => !value)); }}>
              <Codicon name={maximized ? 'chrome-restore' : 'chrome-maximize'} />
            </button>
            <button type="button" className="close" aria-label={t('Close')} title={t('Close')} onClick={() => void bridge.window.close()}>
              <Codicon name="chrome-close" />
            </button>
          </div>
        )}
      </header>

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
