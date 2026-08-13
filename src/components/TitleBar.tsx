import { useEffect, useState } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { useBridge } from '../platform/context';

export function TitleBar() {
  const development = import.meta.env.DEV;
  const [settings, setSettings] = useState(false);
  const [workspaces, setWorkspaces] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const bridge = useBridge();
  const platform = bridge.platform();
  const snapshot = useAppStore((state) => state.snapshot);
  const refresh = useAppStore((state) => state.refresh);
  const busy = useAppStore((state) => state.busy);
  const theme = useAppStore((state) => state.bootstrap?.state.theme ?? 'system');
  const language = useAppStore((state) => state.bootstrap?.state.language ?? 'system');
  const setTheme = useAppStore((state) => state.setTheme);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const externalEditor = useAppStore((state) => state.bootstrap?.state.externalEditor);
  const setExternalEditor = useAppStore((state) => state.setExternalEditor);
  const recentWorkspaces = useAppStore((state) => state.bootstrap?.state.recentWorkspaces ?? []);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const { t } = useI18n();

  useEffect(() => { void bridge.window.isMaximized().then(setMaximized); }, [bridge]);

  const chooseWorkspace = async () => {
    const paths = await bridge.selectWorkspaceFolders(t('Open Workspace'));
    if (paths.length) {
      await openWorkspace(paths);
      setWorkspaces(false);
    }
  };

  const controls = (
    <div className={`window-controls ${platform === 'macos' ? 'mac' : 'native'}`}>
      {platform === 'macos' ? (
        <>
          <button aria-label="Close" className="traffic close" onClick={() => void bridge.window.close()} />
          <button aria-label="Minimize" className="traffic minimize" onClick={() => void bridge.window.minimize()} />
          <button aria-label="Maximize" className="traffic maximize" onClick={() => { void bridge.window.toggleMaximize().then(() => setMaximized(!maximized)); }} />
        </>
      ) : (
        <>
          <button aria-label="Minimize" onClick={() => void bridge.window.minimize()}><Codicon name="chrome-minimize" /></button>
          <button aria-label="Maximize" onClick={() => { void bridge.window.toggleMaximize().then(() => setMaximized(!maximized)); }}><Codicon name={maximized ? 'chrome-restore' : 'chrome-maximize'} /></button>
          <button aria-label="Close" className="native-close" onClick={() => void bridge.window.close()}><Codicon name="chrome-close" /></button>
        </>
      )}
    </div>
  );

  return (
    <>
      <header className="titlebar" onDoubleClick={() => void bridge.window.toggleMaximize()}>
        {platform === 'macos' && controls}
        <div className="titlebar-drag" onPointerDown={(event) => { if (event.button === 0) void bridge.window.startDragging(); }}>
          <img src="/icons/versiondock-logo-v2.png" alt="" />
          <span>VersionDock Desktop{development ? ' Dev' : ''}</span>
          {snapshot && <span className="workspace-name">— {snapshot.workspace.name}</span>}
        </div>
        <div className="titlebar-actions">
          {snapshot && <button title={t('Switch Workspace')} className={`switch-workspace-button ${workspaces ? 'selected' : ''}`} onClick={() => { setSettings(false); setWorkspaces(!workspaces); }}><Codicon name="folder-opened" /><span>{t('Switch Workspace')}</span></button>}
          {snapshot && <button title={t('Refresh')} disabled={busy} onClick={() => void refresh()}><Codicon name={busy ? 'loading codicon-modifier-spin' : 'refresh'} /></button>}
          <button title={t('Settings')} className={settings ? 'selected' : ''} onClick={() => { setWorkspaces(false); setSettings(!settings); }}><Codicon name="settings-gear" /></button>
        </div>
        {platform !== 'macos' && controls}
      </header>
      {workspaces && snapshot && (
        <aside className="workspace-switcher">
          <div className="settings-heading"><span>{t('Switch Workspace')}</span><button onClick={() => setWorkspaces(false)}><Codicon name="close" /></button></div>
          <button className="workspace-open-other" disabled={busy} onClick={() => void chooseWorkspace()}><Codicon name="folder-opened" />{t('Open Another Workspace')}</button>
          <strong>{t('Recent Workspaces')}</strong>
          <div className="workspace-switch-list">{recentWorkspaces.map((workspace) => <button key={workspace.id} className={workspace.id === snapshot.workspace.id ? 'active' : ''} disabled={!workspace.available || busy} onClick={() => { void openWorkspace(workspace.paths).then(() => setWorkspaces(false)); }}><Codicon name={workspace.available ? 'folder' : 'warning'} /><span><b>{workspace.name}</b><small>{workspace.paths.join(' · ')}</small></span>{workspace.id === snapshot.workspace.id && <Codicon name="check" />}</button>)}</div>
        </aside>
      )}
      {settings && (
        <aside className="settings-popover">
          <div className="settings-heading"><span>{t('Settings')}</span><button onClick={() => setSettings(false)}><Codicon name="close" /></button></div>
          <label>{t('Theme')}<select value={theme} onChange={(event) => void setTheme(event.target.value as typeof theme)}><option value="system">{t('System')}</option><option value="light">{t('Light')}</option><option value="dark">{t('Dark')}</option></select></label>
          <label>{t('Language')}<select value={language} onChange={(event) => void setLanguage(event.target.value as typeof language)}><option value="system">{t('System')}</option><option value="zhCn">{t('Simplified Chinese')}</option><option value="en">{t('English')}</option></select></label>
          <ExternalEditorSettings editor={externalEditor} save={setExternalEditor} />
        </aside>
      )}
    </>
  );
}

function ExternalEditorSettings({ editor, save }: { editor: import('../bindings/generated').ExternalEditor | null | undefined; save: (executable: string, args: string[]) => void }) {
  const [executable, setExecutable] = useState(editor?.executable ?? '');
  const [args, setArgs] = useState(editor?.args.join('\n') ?? '');
  const { t } = useI18n();
  return <div className="settings-editor"><strong>{t('External editor')}</strong><input value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder={t('Executable path')} /><textarea value={args} onChange={(event) => setArgs(event.target.value)} placeholder={t('One argument per line')} /><small>{t('Available placeholders: {path}, {relativePath}, {repo}')}</small><button onClick={() => save(executable, args.split('\n').filter((argument) => argument.length > 0))}>{t('Save')}</button></div>;
}
