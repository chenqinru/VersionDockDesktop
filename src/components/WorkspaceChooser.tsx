import { SearchInput } from './SearchInput';
import { IconButton } from './IconButton';
import { useState, useMemo } from 'react';
import { Codicon } from './Codicon';
import { WorkspaceItem } from './WorkspaceItem';
import { OpenWorkspaceAction } from './OpenWorkspaceAction';
import { isWorkspaceOpening, useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { useBridge } from '../platform/context';
import { RepositoryCheckoutDialog, type RepositoryCheckoutKind } from './RepositoryCheckoutDialog';
import { workspaceOpenPaths } from '../workspaces/openPaths';
import { selectWorkspacePaths } from '../workspaces/selectWorkspace';
import { WelcomeUpdateButton } from './WelcomeUpdateButton';
import { filterWorkspaces } from '../workspaces/filterWorkspaces';

export function WorkspaceChooser() {
  const recent = useAppStore((state) => state.bootstrap?.state.recentWorkspaces ?? []);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const removeRecent = useAppStore((state) => state.removeRecent);
  const cloneAvailable = useAppStore((state) => state.bootstrap?.capabilities?.availability?.cloneRepository?.available ?? state.bootstrap?.tools?.git ?? false);
  const svnAvailable = useAppStore((state) => state.bootstrap?.tools?.svn ?? false);
  const busy = useAppStore((state) => isWorkspaceOpening(state.operations));
  const { t } = useI18n();
  const bridge = useBridge();
  const [filterText, setFilterText] = useState('');
  const [checkoutKind, setCheckoutKind] = useState<RepositoryCheckoutKind>();

  const choose = async (openInNew = false) => {
    const paths = await selectWorkspacePaths(bridge, t);
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

  const filteredRecent = useMemo(() => filterWorkspaces(recent, filterText), [recent, filterText]);

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
                <WelcomeUpdateButton />
              </div>
              <p className="welcome-tagline">{t('Unified Git & SVN Desktop Client')}</p>
            </div>
          </div>

          <div className="welcome-actions">
            <OpenWorkspaceAction size="welcome" disabled={busy} title={busy ? t('Loading workspace…') : undefined} onClick={event => void choose(event.metaKey || event.ctrlKey)} />
            <button type="button" className="welcome-action-btn" disabled={busy || !cloneAvailable} onClick={() => setCheckoutKind('git')}>
              <div className="welcome-action-icon"><Codicon name="repo-clone" /></div>
              <div className="welcome-action-text"><span className="welcome-action-title">{t('Clone Repository')}</span><span className="welcome-action-desc">{t('Clone a Git repository into a local folder.')}</span></div>
            </button>
            <button type="button" className="welcome-action-btn" disabled={busy || !svnAvailable} title={!svnAvailable ? t('SVN command-line client was not detected. Install SVN and restart the app.') : undefined} onClick={() => setCheckoutKind('svn')}>
              <div className="welcome-action-icon"><Codicon name="cloud-download" /></div>
              <div className="welcome-action-text"><span className="welcome-action-title">{t('Checkout SVN Repository')}</span><span className="welcome-action-desc">{t('Check out an SVN repository into a local folder.')}</span></div>
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
              <SearchInput
                containerClassName="recent-search-wrap"
                placeholder={t('Search recent workspaces...')}
                aria-label={t('Search recent workspaces...')}
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                clearLabel={t('Clear')}
                onClear={() => setFilterText('')}
              />
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
                  <WorkspaceItem
                    key={workspace.id}
                    workspace={workspace}
                    size="welcome"
                    disabled={busy}
                    disabledReason={busy ? t('Loading workspace…') : undefined}
                    onOpen={event => handleRecentClick(event, workspaceOpenPaths(workspace))}
                    actions={<>
                      <IconButton className="workspace-item-action" title={t('Open in New Window')} disabled={busy}
                        onClick={() => void bridge.openInNewWindow(workspaceOpenPaths(workspace))}><Codicon name="window" /></IconButton>
                      <IconButton className="workspace-item-action" title={t('Remove from recent')} disabled={busy}
                        onClick={() => void removeRecent(workspace.id)}><Codicon name="close" /></IconButton>
                    </>}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      {checkoutKind && <RepositoryCheckoutDialog kind={checkoutKind} close={() => setCheckoutKind(undefined)} />}
    </main>
  );
}
