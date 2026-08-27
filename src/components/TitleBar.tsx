import { useEffect, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { useBridge } from '../platform/context';

export function TitleBar() {
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const addAnchorRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLElement>(null);
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
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    tabId: string;
  } | null>(null);

  const closeOtherTabs = useAppStore((state) => state.closeOtherTabs);

  useEffect(() => {
    if (!contextMenu?.visible) return;
    const handleCloseMenu = () => setContextMenu(null);
    document.addEventListener('pointerdown', handleCloseMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setContextMenu(null); });
    return () => {
      document.removeEventListener('pointerdown', handleCloseMenu);
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

  const handleTabDragEnd = (event: React.DragEvent, tabId: string, paths: string[]) => {
    setDraggingTabId(null);
    const { clientX, clientY, screenX, screenY } = event;
    const isOutOfWindow =
      clientX < -20 ||
      clientX > window.innerWidth + 20 ||
      clientY < -20 ||
      clientY > window.innerHeight + 20 ||
      clientY > 80;

    if (isOutOfWindow) {
      void bridge.openInNewWindow(paths, {
        x: Math.max(0, screenX - 120),
        y: Math.max(0, screenY - 20),
      });
      void closeTab(tabId);
    }
  };

  return (
    <>
      <header className={`titlebar ${platform}`} data-tauri-drag-region>
        {platform === 'macos' && <div className="titlebar-macos-spacer" data-tauri-drag-region />}
        <div className="titlebar-tabs-track">
          <div className="titlebar-tabs" role="tablist">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const isDragging = tab.id === draggingTabId;
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={isActive}
                  draggable={true}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/plain', tab.id);
                    event.dataTransfer.effectAllowed = 'move';
                    setDraggingTabId(tab.id);
                  }}
                  onDragEnd={(event) => handleTabDragEnd(event, tab.id, tab.paths)}
                  className={`titlebar-tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
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
              );
            })}
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
          onDoubleClick={() => void bridge.window.toggleMaximize()}
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
                      void bridge.openInNewWindow(targetTab.paths);
                      void closeTab(targetTab.id);
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
                          void bridge.focusWorkspaceAcrossWindows(workspace.paths).then((focused) => {
                            if (!focused) {
                              void bridge.openInNewWindow(workspace.paths);
                            }
                          });
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
