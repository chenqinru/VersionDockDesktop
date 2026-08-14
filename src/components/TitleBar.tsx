import { useEffect, useState } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { useBridge } from '../platform/context';

export function TitleBar() {
  const [workspaces, setWorkspaces] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const bridge = useBridge();
  const platform = bridge.platform();
  const snapshot = useAppStore((state) => state.snapshot);
  const busy = useAppStore((state) => state.busy);
  const recentWorkspaces = useAppStore((state) => state.bootstrap?.state.recentWorkspaces ?? []);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const { t } = useI18n();
  const workspaceName = snapshot?.workspace.name ?? t('No workspace');

  useEffect(() => {
    if (platform !== 'linux') return;
    void bridge.window.isMaximized().then(setMaximized);
  }, [bridge, platform]);

  const chooseWorkspace = async () => {
    const paths = await bridge.selectWorkspaceFolders(t('Open Workspace'));
    if (paths.length) {
      setWorkspaces(false);
      await openWorkspace(paths);
    }
  };

  const switchWorkspace = async (paths: string[]) => {
    setWorkspaces(false);
    await openWorkspace(paths);
  };

  return (
    <>
      <header className={`titlebar ${platform}`}>
        <div className="titlebar-drag" onPointerDown={(event) => { if (event.button === 0) void bridge.window.startDragging(); }} onDoubleClick={() => void bridge.window.toggleMaximize()} />
        <div className="titlebar-workspace">
            <button
              type="button"
              className={`workspace-trigger ${workspaces ? 'selected' : ''}`}
              disabled={!snapshot}
              aria-expanded={workspaces}
              aria-haspopup="menu"
              aria-label={`${t('Workspace')}: ${workspaceName}`}
              title={workspaceName}
              onClick={() => setWorkspaces(!workspaces)}
            >
              <Codicon name="folder-opened" />
              <span className="workspace-trigger-label">{t('Workspace')}</span>
              <span className="workspace-trigger-divider">·</span>
              <span className="workspace-trigger-name">{workspaceName}</span>
              <Codicon name="chevron-down" className="workspace-trigger-chevron" />
            </button>
        </div>
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
      {workspaces && snapshot && (
        <aside className="workspace-switcher" role="menu">
          <button className="workspace-open-other" role="menuitem" disabled={busy} onClick={() => void chooseWorkspace()}><Codicon name="folder-opened" /><span>{t('Open Another Workspace')}</span><Codicon name="chevron-right" /></button>
          <div className="workspace-menu-section"><span>{t('Recent Workspaces')}</span></div>
          <div className="workspace-switch-list">{recentWorkspaces.map((workspace) => <button key={workspace.id} role="menuitem" className={workspace.id === snapshot.workspace.id ? 'active' : ''} disabled={!workspace.available || busy} onClick={() => { void switchWorkspace(workspace.paths); }}><Codicon name={workspace.available ? 'history' : 'warning'} /><span><b>{workspace.name}</b><small>{workspace.paths.join(' · ')}</small></span>{workspace.id === snapshot.workspace.id && <Codicon name="check" />}</button>)}</div>
        </aside>
      )}
    </>
  );
}
