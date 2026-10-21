import { Button } from './Button';
import { DialogSurface } from './DialogSurface';
import { confirmDialog } from './dialogService';
import { IconButton } from './IconButton';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { useAppUpdateStore } from '../store/appUpdateStore';
import { APP_CURRENT_VERSION } from '../version';
import releaseHistory from '../release-notes.json';
import {
  AUTHOR_GITHUB_URL,
  AUTHOR_NAME,
  GITHUB_ISSUES_URL,
  GITHUB_RELEASES_URL,
  GITHUB_REPO_URL,
  LICENSE_NAME,
  SPONSOR_URL,
  checkAppUpdate,
  diagnosticToolStatus,
  generateDiagnosticReport,
  openExternalLink,
  skipSimulatedUpdate,
  UPDATE_SIMULATION_ENABLED,
} from '../services/updater';

const UpdateSimulationPanel = import.meta.env.DEV && import.meta.env.VITE_UPDATE_SIMULATION === '1'
  ? lazy(() => import('../dev/UpdateSimulationPanel')) : null;

interface AboutDialogProps {
  onClose: () => void;
  initialTab?: 'about' | 'changelog';
}

export function AboutDialog({ onClose, initialTab = 'about' }: AboutDialogProps) {
  const { t, language } = useI18n();
  const snapshot = useAppStore((state) => state.snapshot);
  const bootstrapTools = useAppStore((state) => state.bootstrap?.tools);
  const tools = bootstrapTools ?? snapshot?.tools;
  const settings = useAppStore((state) => state.bootstrap?.state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);

  const [activeTab, setActiveTab] = useState<'about' | 'changelog'>(initialTab);
  const [checking, setChecking] = useState(false);
  const checkResult = useAppStore(state => state.updateAvailableInfo);
  const setCheckResult = useAppStore(state => state.setUpdateAvailableInfo);
  const checkGeneration = useRef(0);
  useEffect(() => () => { checkGeneration.current += 1; }, []);
  const { phase, progress: downloadProgress, install, restart } = useAppUpdateStore();
  const downloading = phase === 'downloading';
  const readyToRestart = phase === 'ready' || phase === 'restarting';
  const [copiedDiag, setCopiedDiag] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const handleCheckUpdate = async () => {
    const owner = ++checkGeneration.current;
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await checkAppUpdate();
      if (owner !== checkGeneration.current) return;
      setCheckResult(result);
    } catch (error) {
      if (owner !== checkGeneration.current || (error instanceof DOMException && error.name === 'AbortError')) return;
      setCheckResult({
        available: false,
        currentVersion: APP_CURRENT_VERSION,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (owner === checkGeneration.current) setChecking(false);
    }
  };

  const handleDownloadAndInstall = async () => {
    try {
      if (!checkResult?.canInstall) {
        throw new Error('No update package available to install.');
      }
      await install(checkResult.latestVersion || checkResult.currentVersion);
    } catch (error) {
      void confirmDialog({ title: t('Software Update'), message: t('Update download failed: {0}', error instanceof Error ? error.message : String(error)) });
    }
  };

  const handleSkipVersion = (version: string) => {
    if (UPDATE_SIMULATION_ENABLED) void skipSimulatedUpdate(version);
    else void updateSettings({ skippedUpdateVersion: version });
    setCheckResult(null);
  };

  const handleCopyDiagnostics = async () => {
    const report = generateDiagnosticReport(snapshot, settings, tools);
    try {
      await navigator.clipboard.writeText(report);
      setCopiedDiag(true);
      setTimeout(() => setCopiedDiag(false), 2500);
    } catch {
      // 忽略复制异常
    }
  };

  return (
    <DialogSurface size="medium" className="about-modal" onClose={onClose} aria-labelledby="about-dialog-title">
        <header className="about-header">
          <div className="about-brand-header">
            <img src="/icons/versiondock-logo-dark.png" alt={t('VersionDock Logo')} className="about-brand-logo" />
            <div className="about-brand-text">
              <h2 id="about-dialog-title">VersionDock Desktop</h2>
              <div className="about-brand-meta">
                <span className="about-version-badge">v{APP_CURRENT_VERSION}</span>
                <span className="about-tagline">{t('Independent Git & SVN Workbench')}</span>
              </div>
            </div>
          </div>
          <IconButton
            ref={closeButtonRef}
            type="button"
            className="about-close-btn"
            aria-label={t('Close')}
            title={t('Close')}
            onClick={onClose}
          >
            <Codicon name="close" />
          </IconButton>
        </header>

        <nav className="about-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'about'}
            className="about-tab-btn"
            onClick={() => setActiveTab('about')}
          >
            <Codicon name="info" />
            <span>{t('About & Updates')}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'changelog'}
            className="about-tab-btn"
            onClick={() => setActiveTab('changelog')}
          >
            <Codicon name="history" />
            <span>{t('Release Notes')}</span>
          </button>
        </nav>

        <div className="about-body">
          {activeTab === 'about' && (
            <div className="about-content-scroll">
              {UpdateSimulationPanel && <Suspense fallback={null}><UpdateSimulationPanel onReset={() => void handleCheckUpdate()} /></Suspense>}
              {/* 更新状态区块 */}
              <section className="about-card update-card">
                <div className="about-card-header">
                  <div className="about-card-title">
                    <Codicon name="cloud-download" />
                    <strong>{t('Software Update')}</strong>
                  </div>
                  {!checking && !downloading && !readyToRestart && (
                    <Button variant="link" size="xs"
                      type="button"
                      onClick={() => void handleCheckUpdate()}
                    >
                      <Codicon name="refresh" />
                      <span>{t('Check for Updates')}</span>
                    </Button>
                  )}
                </div>

                <div className="about-card-content">
                  {checking && (
                    <div className="update-status-row checking">
                      <Codicon name="loading codicon-modifier-spin" />
                      <span>{t('Checking for updates…')}</span>
                    </div>
                  )}

                  {!checking && !checkResult && (
                    <div className="update-status-row">
                      <Codicon name="check" />
                      <span>
                        {t('You are running VersionDock Desktop v{0}', APP_CURRENT_VERSION)}
                      </span>
                    </div>
                  )}

                  {!checking && checkResult && !checkResult.available && !checkResult.error && (
                    <div className="update-status-row success">
                      <Codicon name="pass" />
                      <span>{t('VersionDock is up to date (v{0})', APP_CURRENT_VERSION)}</span>
                    </div>
                  )}

                  {!checking && checkResult?.error && (
                    <div className="update-error-box">
                      <div className="update-status-row error">
                        <Codicon name="warning" />
                        <span className="update-error-text">
                          {t('Update check error: {0}', checkResult.error)}
                        </span>
                      </div>
                      <div className="update-error-actions">
                        <Button size="xs"
                          type="button"
                          onClick={() => void openExternalLink(GITHUB_RELEASES_URL)}
                        >
                          <Codicon name="link-external" />
                          <span>{t('View Releases on GitHub')}</span>
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* 发现新版本 */}
                  {!checking && checkResult?.available && (
                    <div className="update-available-box">
                      <div className="update-available-header">
                        <span className="update-badge">{t('New Version Available')}</span>
                        <strong className="update-version-label">
                          v{checkResult.latestVersion}
                        </strong>
                        {checkResult.releaseDate && (
                          <span className="update-date">
                            {new Date(checkResult.releaseDate).toLocaleDateString()}
                          </span>
                        )}
                      </div>

                      {checkResult.releaseNotes ? (
                        <div className="update-notes-preview">
                          <Markdown components={{ a: ({ href, children }) => <a href={href} onClick={(event) => {
                            event.preventDefault();
                            if (href && /^https?:\/\//i.test(href)) void openExternalLink(href);
                          }}>{children}</a>, img: () => null }}>{checkResult.releaseNotes}</Markdown>
                        </div>
                      ) : (
                        <p className="about-muted">{t('No release notes provided for this version.')}</p>
                      )}

                      {downloading && downloadProgress && (
                        <div className="update-progress-wrap">
                          <div className="update-progress-bar">
                            <div
                              className="update-progress-fill"
                              style={{ width: `${downloadProgress.percent}%` }}
                            />
                          </div>
                          <div className="update-progress-label">
                            <span>{t('Downloading update…')}</span>
                            <span>{downloadProgress.percent}%</span>
                          </div>
                        </div>
                      )}

                      {readyToRestart ? (
                        <div className="update-actions">
                          <Button variant="primary"
                            type="button"
                            disabled={phase === 'restarting'}
                            onClick={() => void restart().catch((error: unknown) => {
                              void confirmDialog({ title: t('Software Update'), message: t('Restart failed: {0}', error instanceof Error ? error.message : String(error)) });
                            })}
                          >
                            <Codicon name="refresh" />
                            <span>{t(phase === 'restarting' ? 'Restarting…' : 'Restart to Install Update')}</span>
                          </Button>
                        </div>
                      ) : (
                        <div className="update-actions">
                          <Button variant="primary"
                            type="button"
                            disabled={downloading || !checkResult.canInstall}
                            onClick={() => void handleDownloadAndInstall()}
                          >
                            <Codicon name="cloud-download" />
                            <span>
                              {downloading
                                ? t('Downloading…')
                                : t('Download and Install Update')}
                            </span>
                          </Button>
                          {checkResult.latestVersion && (
                            <Button
                              type="button"
                              disabled={downloading}
                              onClick={() => handleSkipVersion(checkResult.latestVersion!)}
                            >
                              <span>{t('Skip this version')}</span>
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>

              {/* 作者与项目信息 */}
              <section className="about-card author-card">
                <div className="about-card-header">
                  <div className="about-card-title">
                    <Codicon name="account" />
                    <strong>{t('Author & Project')}</strong>
                  </div>
                </div>
                <div className="about-card-content author-details">
                  <div className="author-grid">
                    <div className="author-item">
                      <span className="author-label">{t('Author')}:</span>
                      <Button variant="link" size="xs"
                        type="button"
                        onClick={() => void openExternalLink(AUTHOR_GITHUB_URL)}
                      >
                        <Codicon name="github" />
                        <span>{AUTHOR_NAME}</span>
                      </Button>
                    </div>
                    <div className="author-item">
                      <span className="author-label">{t('License')}:</span>
                      <span>{LICENSE_NAME}</span>
                    </div>
                  </div>
                  <div className="about-quick-links">
                    <Button size="xs"
                      type="button"
                      onClick={() => void openExternalLink(GITHUB_REPO_URL)}
                    >
                      <Codicon name="repo" />
                      <span>{t('GitHub Repository')}</span>
                    </Button>
                    <Button size="xs"
                      type="button"
                      onClick={() => void openExternalLink(GITHUB_ISSUES_URL)}
                    >
                      <Codicon name="feedback" />
                      <span>{t('Submit Issue / Feedback')}</span>
                    </Button>
                    <Button size="xs"
                      type="button"
                      onClick={() => void openExternalLink(SPONSOR_URL)}
                    >
                      <Codicon name="heart" />
                      <span>{t('Sponsor Project')}</span>
                    </Button>
                  </div>
                </div>
              </section>

              {/* 系统诊断信息 */}
              <section className="about-card diagnostics-card">
                <div className="about-card-header">
                  <div className="about-card-title">
                    <Codicon name="server-process" />
                    <strong>{t('Environment & Diagnostics')}</strong>
                  </div>
                  <Button variant="link" size="xs"
                    type="button"
                    onClick={() => void handleCopyDiagnostics()}
                  >
                    <Codicon name={copiedDiag ? 'check' : 'copy'} />
                    <span>{copiedDiag ? t('Copied to Clipboard!') : t('Copy Diagnostics')}</span>
                  </Button>
                </div>
                <div className="about-card-content diag-grid">
                  <div className="diag-item">
                    <span className="diag-name">Git:</span>
                    <span className="diag-val">
                      {t(diagnosticToolStatus(tools?.git))}
                    </span>
                  </div>
                  <div className="diag-item">
                    <span className="diag-name">SVN:</span>
                    <span className="diag-val">
                      {t(diagnosticToolStatus(tools?.svn))}
                    </span>
                  </div>
                  <div className="diag-item">
                    <span className="diag-name">{t(snapshot ? 'Repositories' : 'Workspace')}:</span>
                    <span className="diag-val">{snapshot ? snapshot.repositories.length : t('Not opened')}</span>
                  </div>
                  <div className="diag-item">
                    <span className="diag-name">{t('Theme')}:</span>
                    <span className="diag-val">
                      {settings?.theme === 'dark2026'
                        ? t('2026 Dark')
                        : settings?.theme === 'light2026'
                          ? t('2026 Light')
                          : settings?.theme === 'githubDarkDimmed'
                            ? t('GitHub Dark Dimmed')
                            : settings?.theme === 'oneDarkPro'
                              ? t('One Dark Pro')
                              : settings?.theme === 'dracula'
                                ? t('Dracula')
                                : settings?.theme === 'nord'
                                  ? t('Nord')
                                  : settings?.theme === 'light'
                                    ? t('Classic Light')
                                    : settings?.theme === 'dark'
                                      ? t('Classic Dark')
                                      : t('System (Default 2026)')}
                    </span>
                  </div>
                </div>
                <div className="about-diag-actions">
                  <Button size="xs"
                    type="button"
                    onClick={() => {
                      onClose();
                      useAppStore.getState().setLogPanelOpen(true);
                    }}
                  >
                    <Codicon name="output" />
                    <span>{t('View Output & Logs')}</span>
                  </Button>
                  <Button size="xs"
                    type="button"
                    onClick={() => void useAppStore.getState().openLogFolder()}
                  >
                    <Codicon name="folder-opened" />
                    <span>{t('Open Log Folder')}</span>
                  </Button>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'changelog' && (
            <div className="about-content-scroll changelog-tab">
              <div className="changelog-header-row">
                <h3>{t('VersionDock Release History')}</h3>
                <Button variant="link" size="xs"
                  type="button"
                  onClick={() => void openExternalLink(GITHUB_RELEASES_URL)}
                >
                  <Codicon name="link-external" />
                  <span>{t('View All Releases on GitHub')}</span>
                </Button>
              </div>

              <div className="changelog-list">
                {releaseHistory.map((item) => (
                  <div key={item.version} className="changelog-entry">
                    <div className="changelog-entry-header">
                      <strong className="changelog-ver">v{item.version}</strong>
                      <span className="changelog-date">{item.date}</span>
                    </div>
                    <ul className="changelog-highlights">
                      {item.highlights[language].map((highlight, idx) => (
                        <li key={idx}>{highlight}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
    </DialogSurface>
  );
}
