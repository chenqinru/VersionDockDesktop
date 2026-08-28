import { useEffect, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import {
  APP_CURRENT_VERSION,
  AUTHOR_GITHUB_URL,
  AUTHOR_NAME,
  GITHUB_ISSUES_URL,
  GITHUB_RELEASES_URL,
  GITHUB_REPO_URL,
  LICENSE_NAME,
  SPONSOR_URL,
  checkAppUpdate,
  downloadAndInstallAppUpdate,
  generateDiagnosticReport,
  openExternalLink,
  restartApp,
  type AppUpdateCheckResult,
  type UpdateDownloadProgress,
} from '../services/updater';

interface AboutDialogProps {
  onClose: () => void;
  initialTab?: 'about' | 'changelog';
}

const BUILTIN_CHANGELOG = [
  {
    version: '0.1.0',
    date: '2026-08-28',
    highlights: [
      '🚀 Initial release of VersionDock Desktop',
      '✨ Unified workbench for Git and Subversion (SVN)',
      '📑 Multi-tab workspace management with cross-window drag & drop',
      '🔍 Visual 3-way Merge Conflict Editor and Diff Viewer',
      '📦 Native Shelve and Stash management',
      '🔄 Auto-fetch, background repository scanning and smart status bar',
      '🎨 Light / Dark / System theme and customizable UI font sizes',
    ],
  },
];

export function AboutDialog({ onClose, initialTab = 'about' }: AboutDialogProps) {
  const { t } = useI18n();
  const snapshot = useAppStore((state) => state.snapshot);
  const settings = useAppStore((state) => state.bootstrap?.state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);

  const [activeTab, setActiveTab] = useState<'about' | 'changelog'>(initialTab);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<AppUpdateCheckResult | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<UpdateDownloadProgress | null>(null);
  const [readyToRestart, setReadyToRestart] = useState(false);
  const [copiedDiag, setCopiedDiag] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleCheckUpdate = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await checkAppUpdate();
      setCheckResult(result);
    } catch (error) {
      setCheckResult({
        available: false,
        currentVersion: APP_CURRENT_VERSION,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setChecking(false);
    }
  };

  const handleDownloadAndInstall = async () => {
    setDownloading(true);
    setDownloadProgress(null);
    try {
      if (checkResult?.rawUpdate) {
        await downloadAndInstallAppUpdate((progress) => {
          setDownloadProgress(progress);
        });
        setReadyToRestart(true);
      } else {
        // 如果没有原生 rawUpdate（如开发模式或降级模式），直接打开浏览器下载
        await openExternalLink(GITHUB_RELEASES_URL);
      }
    } catch (error) {
      alert(t('Update download failed: {0}', error instanceof Error ? error.message : String(error)));
    } finally {
      setDownloading(false);
    }
  };

  const handleSkipVersion = (version: string) => {
    void updateSettings({ skippedUpdateVersion: version });
    setCheckResult((prev) => (prev ? { ...prev, available: false } : null));
  };

  const handleCopyDiagnostics = async () => {
    const report = generateDiagnosticReport(snapshot, settings);
    try {
      await navigator.clipboard.writeText(report);
      setCopiedDiag(true);
      setTimeout(() => setCopiedDiag(false), 2500);
    } catch {
      // 忽略复制异常
    }
  };

  return (
    <div
      className="about-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="about-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="about-header">
          <div className="about-brand-header">
            <img src="/icons/versiondock-logo-dark.png" alt="VersionDock Logo" className="about-brand-logo" />
            <div className="about-brand-text">
              <h2 id="about-dialog-title">VersionDock Desktop</h2>
              <div className="about-brand-meta">
                <span className="about-version-badge">v{APP_CURRENT_VERSION}</span>
                <span className="about-tagline">{t('Independent Git & SVN Workbench')}</span>
              </div>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="about-close-btn"
            aria-label={t('Close')}
            title={t('Close')}
            onClick={onClose}
          >
            <Codicon name="close" />
          </button>
        </header>

        <nav className="about-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'about'}
            className={`about-tab-btn ${activeTab === 'about' ? 'active' : ''}`}
            onClick={() => setActiveTab('about')}
          >
            <Codicon name="info" />
            <span>{t('About & Updates')}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'changelog'}
            className={`about-tab-btn ${activeTab === 'changelog' ? 'active' : ''}`}
            onClick={() => setActiveTab('changelog')}
          >
            <Codicon name="history" />
            <span>{t('Release Notes')}</span>
          </button>
        </nav>

        <div className="about-body">
          {activeTab === 'about' && (
            <div className="about-content-scroll">
              {/* 更新状态区块 */}
              <section className="about-card update-card">
                <div className="about-card-header">
                  <div className="about-card-title">
                    <Codicon name="cloud-download" />
                    <strong>{t('Software Update')}</strong>
                  </div>
                  {!checking && !downloading && !readyToRestart && (
                    <button
                      type="button"
                      className="about-action-link"
                      onClick={() => void handleCheckUpdate()}
                    >
                      <Codicon name="refresh" />
                      <span>{t('Check for Updates')}</span>
                    </button>
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
                        <button
                          type="button"
                          className="about-inline-btn"
                          onClick={() => void openExternalLink(GITHUB_RELEASES_URL)}
                        >
                          <Codicon name="link-external" />
                          <span>{t('View Releases on GitHub')}</span>
                        </button>
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

                      {checkResult.releaseNotes && (
                        <div className="update-notes-preview">
                          <pre>{checkResult.releaseNotes}</pre>
                        </div>
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
                          <button
                            type="button"
                            className="about-btn primary"
                            onClick={() => void restartApp()}
                          >
                            <Codicon name="refresh" />
                            <span>{t('Restart to Install Update')}</span>
                          </button>
                        </div>
                      ) : (
                        <div className="update-actions">
                          <button
                            type="button"
                            className="about-btn primary"
                            disabled={downloading}
                            onClick={() => void handleDownloadAndInstall()}
                          >
                            <Codicon name="cloud-download" />
                            <span>
                              {downloading
                                ? t('Downloading…')
                                : t('Download and Install Update')}
                            </span>
                          </button>
                          {checkResult.latestVersion && (
                            <button
                              type="button"
                              className="about-btn secondary"
                              disabled={downloading}
                              onClick={() => handleSkipVersion(checkResult.latestVersion!)}
                            >
                              <span>{t('Skip this version')}</span>
                            </button>
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
                      <button
                        type="button"
                        className="about-link-btn"
                        onClick={() => void openExternalLink(AUTHOR_GITHUB_URL)}
                      >
                        <Codicon name="github" />
                        <span>{AUTHOR_NAME}</span>
                      </button>
                    </div>
                    <div className="author-item">
                      <span className="author-label">{t('License')}:</span>
                      <span>{LICENSE_NAME}</span>
                    </div>
                  </div>
                  <div className="about-quick-links">
                    <button
                      type="button"
                      className="about-pill-btn"
                      onClick={() => void openExternalLink(GITHUB_REPO_URL)}
                    >
                      <Codicon name="repo" />
                      <span>{t('GitHub Repository')}</span>
                    </button>
                    <button
                      type="button"
                      className="about-pill-btn"
                      onClick={() => void openExternalLink(GITHUB_ISSUES_URL)}
                    >
                      <Codicon name="feedback" />
                      <span>{t('Submit Issue / Feedback')}</span>
                    </button>
                    <button
                      type="button"
                      className="about-pill-btn sponsor"
                      onClick={() => void openExternalLink(SPONSOR_URL)}
                    >
                      <Codicon name="heart" />
                      <span>{t('Sponsor Project')}</span>
                    </button>
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
                  <button
                    type="button"
                    className={`about-action-link ${copiedDiag ? 'copied' : ''}`}
                    onClick={() => void handleCopyDiagnostics()}
                  >
                    <Codicon name={copiedDiag ? 'check' : 'copy'} />
                    <span>{copiedDiag ? t('Copied to Clipboard!') : t('Copy Diagnostics')}</span>
                  </button>
                </div>
                <div className="about-card-content diag-grid">
                  <div className="diag-item">
                    <span className="diag-name">Git:</span>
                    <span className="diag-val">
                      {snapshot?.tools.git ? t('Available') : t('Not installed')}
                    </span>
                  </div>
                  <div className="diag-item">
                    <span className="diag-name">SVN:</span>
                    <span className="diag-val">
                      {snapshot?.tools.svn ? t('Available') : t('Not installed')}
                    </span>
                  </div>
                  <div className="diag-item">
                    <span className="diag-name">{t('Repositories')}:</span>
                    <span className="diag-val">{snapshot?.repositories.length ?? 0}</span>
                  </div>
                  <div className="diag-item">
                    <span className="diag-name">{t('Theme')}:</span>
                    <span className="diag-val">
                      {settings?.theme === 'light'
                        ? t('Light')
                        : settings?.theme === 'dark'
                          ? t('Dark')
                          : t('System')}
                    </span>
                  </div>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'changelog' && (
            <div className="about-content-scroll changelog-tab">
              <div className="changelog-header-row">
                <h3>{t('VersionDock Release History')}</h3>
                <button
                  type="button"
                  className="about-action-link"
                  onClick={() => void openExternalLink(GITHUB_RELEASES_URL)}
                >
                  <Codicon name="link-external" />
                  <span>{t('View All Releases on GitHub')}</span>
                </button>
              </div>

              <div className="changelog-list">
                {BUILTIN_CHANGELOG.map((item) => (
                  <div key={item.version} className="changelog-entry">
                    <div className="changelog-entry-header">
                      <strong className="changelog-ver">v{item.version}</strong>
                      <span className="changelog-date">{item.date}</span>
                    </div>
                    <ul className="changelog-highlights">
                      {item.highlights.map((highlight, idx) => (
                        <li key={idx}>{highlight}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
