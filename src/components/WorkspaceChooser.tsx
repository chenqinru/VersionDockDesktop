import { useState, useMemo } from 'react';
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
  const [filterText, setFilterText] = useState('');

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
                <span className="welcome-version-badge">Desktop</span>
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
              <span>Multi-Tabs</span>
            </div>
            <div className="feature-item">
              <Codicon name="diff" />
              <span>Visual Diff</span>
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
    </main>
  );
}
