import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { useBridge } from '../platform/context';

export function WorkspaceChooser() {
  const recent = useAppStore((state) => state.bootstrap?.state.recentWorkspaces ?? []);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const removeRecent = useAppStore((state) => state.removeRecent);
  const busy = useAppStore((state) => state.busy);
  const { t } = useI18n();
  const bridge = useBridge();
  const choose = async () => { const paths = await bridge.selectWorkspaceFolders(t('Open Workspace')); if (paths.length) await openWorkspace(paths); };

  return (
    <main className="welcome">
      <section className="welcome-primary">
        <img src="/icons/versiondock-logo-v2.png" alt="VersionDock" />
        <h1>VersionDock Desktop</h1>
        <p>{t('Open a folder to discover Git and SVN repositories.')}</p>
        <button className="primary" disabled={busy} onClick={() => void choose()}><Codicon name="folder-opened" />{t('Open Workspace')}</button>
        <span className="drop-hint"><Codicon name="cloud-upload" />{t('Drop folders anywhere in this window')}</span>
      </section>
      {recent.length > 0 && (
        <section className="recent-list">
          <h2>{t('Recent Workspaces')}</h2>
          {recent.map((workspace) => (
            <div className={`recent-row ${workspace.available ? '' : 'unavailable'}`} key={workspace.id}>
              <button className="recent-open" disabled={!workspace.available || busy} onClick={() => void openWorkspace(workspace.paths)}>
                <Codicon name={workspace.available ? 'folder' : 'warning'} />
                <span><strong>{workspace.name}</strong><small>{workspace.paths.join(' · ')}</small></span>
                {!workspace.available && <em>{t('Path is unavailable')}</em>}
              </button>
              <button title={t('Remove from recent')} onClick={() => void removeRecent(workspace.id)}><Codicon name="close" /></button>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
