import { useState, useMemo } from 'react';
import { Codicon } from './Codicon';
import { isOperationActive, useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { useBridge } from '../platform/context';
import { ProviderPanel } from './ProviderPanel';
import type { RemoteRepository } from '../bindings/generated';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';

export function WorkspaceChooser() {
  const recent = useAppStore((state) => state.bootstrap?.state.recentWorkspaces ?? []);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const removeRecent = useAppStore((state) => state.removeRecent);
  const openAbout = useAppStore((state) => state.openAbout);
  const cloneRepository = useAppStore((state) => state.cloneRepository);
  const initializeRepository = useAppStore((state) => state.initializeRepository);
  const initializeAvailable = useAppStore((state) => state.bootstrap?.capabilities.availability?.initializeRepository?.available ?? state.bootstrap?.tools.git ?? false);
  const cloneAvailable = useAppStore((state) => state.bootstrap?.capabilities.availability?.cloneRepository?.available ?? state.bootstrap?.tools.git ?? false);
  const busy = useAppStore((state) => isOperationActive(state.operations, { domain: 'workspace' }));
  const { t } = useI18n();
  const bridge = useBridge();
  const [filterText, setFilterText] = useState('');
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneParent, setCloneParent] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [cloneNewWindow, setCloneNewWindow] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerAccountId, setProviderAccountId] = useState<string>();
  const cloneDialog = useDialogFocusTrap(cloneOpen, () => setCloneOpen(false));

  const inferredCloneName = (value: string) => value.trim().replace(/[?#].*$/, '').replace(/\/$/, '').split(/[/:]/).pop()?.replace(/\.git$/i, '') ?? '';
  const submitClone = async () => {
    if (!cloneUrl.trim() || !cloneParent.trim() || !cloneName.trim()) return;
    if (await cloneRepository(cloneUrl.trim(), cloneParent.trim(), cloneName.trim(), cloneNewWindow, providerAccountId)) setCloneOpen(false);
  };

  const choose = async (openInNew = false) => {
    const paths = await bridge.selectWorkspaceFolders(t('Open Workspace'));
    if (paths.length) {
      if (openInNew) {
        await bridge.openInNewWindow(paths);
      } else {
        await openWorkspace(paths);
      }
    }
  };
  const initialize = async () => {
    const path = await bridge.selectDirectory(t('Initialize Repository'));
    if (!path || !await openWorkspace([path])) return;
    await initializeRepository(path);
  };

  const handleRecentClick = (event: React.MouseEvent, paths: string[]) => {
    if (event.metaKey || event.ctrlKey) {
      void bridge.openInNewWindow(paths);
    } else {
      void openWorkspace(paths);
    }
  };

  const filteredRecent = useMemo(() => {
    if (!filterText.trim()) return recent;
    const q = filterText.trim().toLowerCase();
    return recent.filter((w) => w.name.toLowerCase().includes(q) || w.paths.some((p) => p.toLowerCase().includes(q)));
  }, [recent, filterText]);

  const isMac = bridge.platform() === 'macos';

  return (
    <main className="welcome-container">
      <div className="welcome-glow" />
      <div className="welcome-card">
        {/* 左侧面板：品牌与快速动作 */}
        <section className="welcome-left">
          <div className="welcome-brand">
            <div className="welcome-logo-wrap">
              <img src="/icons/versiondock-logo-dark.png" alt="VersionDock" className="welcome-logo" />
            </div>
            <div className="welcome-brand-text">
              <div className="welcome-title-row">
                <h1>VersionDock</h1>
                <button
                  type="button"
                  className="welcome-version-badge clickable"
                  title={t('About VersionDock & Check Updates')}
                  onClick={() => openAbout('about')}
                >
                  v0.1.0
                </button>
              </div>
              <p className="welcome-tagline">{t('Unified Git & SVN Desktop Client')}</p>
            </div>
          </div>

          <div className="welcome-actions">
            <button
              type="button"
              className="welcome-action-btn primary"
              disabled={busy}
              onClick={(event) => void choose(event.metaKey || event.ctrlKey)}
            >
              <div className="welcome-action-icon">
                <Codicon name="folder-opened" />
              </div>
              <div className="welcome-action-text">
                <span className="welcome-action-title">{t('Open Local Folder')}</span>
                <span className="welcome-action-desc">{t('Open a folder to discover Git and SVN repositories.')}</span>
              </div>
              <span className="welcome-action-shortcut">{isMac ? '⌘ O' : 'Ctrl+O'}</span>
            </button>
            <button type="button" className="welcome-action-btn" disabled={busy || !initializeAvailable} onClick={() => void initialize()}>
              <div className="welcome-action-icon"><Codicon name="repo-create" /></div>
              <div className="welcome-action-text"><span className="welcome-action-title">{t('Initialize Repository')}</span><span className="welcome-action-desc">{t('Create a Git repository in a selected folder.')}</span></div>
            </button>
            <button type="button" className="welcome-action-btn" disabled={busy || !cloneAvailable} onClick={() => setCloneOpen(true)}>
              <div className="welcome-action-icon"><Codicon name="repo-clone" /></div>
              <div className="welcome-action-text"><span className="welcome-action-title">{t('Clone Repository')}</span><span className="welcome-action-desc">{t('Clone a Git repository into a local folder.')}</span></div>
            </button>
            <button
              type="button"
              className="welcome-action-btn"
              disabled={busy}
              onClick={() => void choose(true)}
            >
              <div className="welcome-action-icon">
                <Codicon name="window" />
              </div>
              <div className="welcome-action-text">
                <span className="welcome-action-title">{t('Open in New Window')}</span>
                <span className="welcome-action-desc">{t('Open a folder to discover Git and SVN repositories.')}</span>
              </div>
              <span className="welcome-action-shortcut">{isMac ? '⇧⌘ O' : 'Ctrl+Shift+O'}</span>
            </button>
          </div>

          <div className="welcome-dropzone">
            <div className="welcome-dropzone-icon">
              <Codicon name="cloud-upload" />
            </div>
            <span>{t('Drop folders anywhere in this window')}</span>
          </div>

          <div className="welcome-features">
            <div className="feature-item">
              <Codicon name="git-branch" />
              <span>Git & SVN</span>
            </div>
            <div className="feature-item">
              <Codicon name="multiple-windows" />
              <span>{t('Multi-Tabs')}</span>
            </div>
            <div className="feature-item">
              <Codicon name="diff" />
              <span>{t('Visual Diff')}</span>
            </div>
          </div>
        </section>

        {/* 右侧面板：最近项目 */}
        <section className="welcome-right">
          <div className="recent-header">
            <div className="recent-header-title">
              <h2>{t('Recent Workspaces')}</h2>
              {recent.length > 0 && <span className="recent-count">{recent.length}</span>}
            </div>
            {recent.length > 3 && (
              <div className="recent-search-wrap">
                <Codicon name="search" />
                <input
                  type="text"
                  placeholder={t('Search recent workspaces...')}
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="recent-search-input"
                />
                {filterText && (
                  <button type="button" className="recent-search-clear" onClick={() => setFilterText('')}>
                    <Codicon name="close" />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="recent-scroll-area">
            {recent.length === 0 ? (
              <div className="recent-empty">
                <div className="recent-empty-icon">
                  <Codicon name="inbox" />
                </div>
                <span>{t('No recent workspaces')}</span>
              </div>
            ) : filteredRecent.length === 0 ? (
              <div className="recent-empty">
                <div className="recent-empty-icon">
                  <Codicon name="search" />
                </div>
                <span>{t('No matches')}</span>
              </div>
            ) : (
              <div className="recent-items">
                {filteredRecent.map((workspace) => (
                  <div className={`recent-card ${workspace.available ? '' : 'unavailable'}`} key={workspace.id}>
                    <button
                      type="button"
                      className="recent-card-btn"
                      disabled={!workspace.available || busy}
                      onClick={(event) => handleRecentClick(event, workspace.paths)}
                    >
                      <div className="recent-card-icon">
                        <Codicon name={workspace.available ? 'folder' : 'warning'} />
                      </div>
                      <div className="recent-card-info">
                        <span className="recent-card-name" title={workspace.name}>{workspace.name}</span>
                        <span className="recent-card-path" title={workspace.paths.join(' · ')}>
                          {workspace.paths.join(' · ')}
                        </span>
                        {!workspace.available && <span className="recent-card-badge">{t('Path is unavailable')}</span>}
                      </div>
                    </button>
                    <div className="recent-card-actions">
                      <button
                        type="button"
                        className="recent-card-action-btn"
                        title={t('Open in New Window')}
                        aria-label={t('Open in New Window')}
                        disabled={!workspace.available || busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void bridge.openInNewWindow(workspace.paths);
                        }}
                      >
                        <Codicon name="window" />
                      </button>
                      <button
                        type="button"
                        className="recent-card-action-btn remove"
                        title={t('Remove from recent')}
                        aria-label={t('Remove from recent')}
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeRecent(workspace.id);
                        }}
                      >
                        <Codicon name="close" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      {cloneOpen && <div className="dialog-backdrop" role="presentation"><section ref={cloneDialog} className="app-dialog clone-dialog" role="dialog" aria-modal="true" aria-label={t('Clone Repository')}>
        <header><Codicon name="repo-clone" /><strong>{t('Clone Repository')}</strong></header>
        <button type="button" onClick={() => setProviderOpen(true)}><Codicon name="cloud" />{t('Browse Remote Providers')}</button>
        <label><span>{t('Git URL')}</span><input autoFocus value={cloneUrl} onChange={(event) => { const value = event.target.value; setCloneUrl(value); if (!cloneName) setCloneName(inferredCloneName(value)); }} /></label>
        <label><span>{t('Parent folder')}</span><div className="dialog-input-row"><input value={cloneParent} onChange={(event) => setCloneParent(event.target.value)} /><button type="button" onClick={async () => { const value = await bridge.selectDirectory(t('Select clone parent folder')); if (value) setCloneParent(value); }}>{t('Browse…')}</button></div></label>
        <label><span>{t('Folder name')}</span><input value={cloneName} onChange={(event) => setCloneName(event.target.value)} /></label>
        <label className="dialog-check"><input type="checkbox" checked={cloneNewWindow} onChange={(event) => setCloneNewWindow(event.target.checked)} />{t('Open in New Window')}</label>
        <footer><button type="button" onClick={() => setCloneOpen(false)}>{t('Cancel')}</button><button type="button" className="primary" disabled={busy || !cloneUrl.trim() || !cloneParent.trim() || !cloneName.trim()} onClick={() => void submitClone()}>{t('Clone')}</button></footer>
      </section></div>}
      {providerOpen && <ProviderPanel mode="browse" close={() => setProviderOpen(false)} onClone={(repository: RemoteRepository, accountId) => { setCloneUrl(repository.cloneUrl); setCloneName(repository.name); setProviderAccountId(accountId); setProviderOpen(false); }} />}
    </main>
  );
}
