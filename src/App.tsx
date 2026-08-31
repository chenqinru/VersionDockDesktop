import { useEffect, useMemo, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { WorkspaceChooser } from './components/WorkspaceChooser';
import { CommitPanel } from './components/CommitPanel';
import { HistoryWorkspace } from './components/HistoryWorkspace';
import { DiffWorkspace } from './components/DiffWorkspace';
import { CommitChangesWorkspace } from './components/CommitChangesWorkspace';
import { CommitDetailWorkspace } from './components/CommitDetailWorkspace';
import { MergeWorkspace } from './components/MergeWorkspace';
import { Codicon } from './components/Codicon';
import { resolveNotificationText, useAppStore } from './store/appStore';
import { createTranslator, I18nContext, resolveLanguage, useI18n } from './i18n';
import { applyTheme, resolveTheme } from './theme';
import { useResizable } from './hooks/useResizable';
import { useBridge } from './platform/context';
import { DialogHost } from './components/DialogHost';
import { FileHistoryPanel } from './components/FileHistoryPanel';
import { StatusBar } from './components/StatusBar/StatusBar';
import { IdentityPanel } from './components/IdentityPanel';
import { RemoteManager } from './components/RemoteManager';
import { AboutDialog } from './components/AboutDialog';
import { OutputPanel } from './components/OutputPanel/OutputPanel';
import { choiceDialog } from './components/dialogService';

const UI_FONT_SIZE = {
  minimum: { pixels: '11px', scale: '0.8461538462' },
  small: { pixels: '12px', scale: '0.9230769231' },
  standard: { pixels: '13px', scale: '1' },
  large: { pixels: '14px', scale: '1.0769230769' },
  maximum: { pixels: '15px', scale: '1.1538461538' },
} as const;

export function NotificationToast() {
  const { t } = useI18n();
  const notifications = useAppStore((state) => state.notifications);
  const toastNotificationIds = useAppStore((state) => state.toastNotificationIds ?? []);
  const dismissToast = useAppStore((state) => state.dismissToast);
  const performNotificationAction = useAppStore((state) => state.performNotificationAction);
  const notification = notifications.find((item) => item.id === toastNotificationIds[0]);

  useEffect(() => {
    if (!notification || notification.type === 'warning' || notification.type === 'error') return;
    const timer = window.setTimeout(dismissToast, 5_000);
    return () => window.clearTimeout(timer);
  }, [dismissToast, notification]);

  if (!notification) return null;
  return <div className={`toast ${notification.type}`} role="alert">
    <div className={`notification-severity-icon ${notification.type}`}><Codicon name={notification.type === 'error' ? 'error' : notification.type === 'warning' ? 'warning' : notification.type === 'success' ? 'pass' : 'info'} /></div>
    <div className="toast-content">
      <div className="toast-header"><strong className="toast-title">{resolveNotificationText(notification.title, t)}</strong></div>
      <div className="toast-message">{resolveNotificationText(notification.message, t)}</div>
      {notification.actions.length > 0 && <div className="notification-item-actions">
        {notification.actions.map((action, index) => <button type="button" className="notification-item-action-btn" key={`${action.type}-${index}`} onClick={() => void performNotificationAction(notification.id, index)}>{resolveNotificationText(action.label, t)}</button>)}
      </div>}
      {notification.details && <details className="toast-details"><summary>{t('Technical details')}</summary><pre>{notification.details}</pre></details>}
    </div>
    <button type="button" className="toast-close" aria-label={t('Close')} title={t('Close')} onClick={dismissToast}><Codicon name="close" /></button>
  </div>;
}

export function App() {
  const bridge = useBridge();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const snapshot = useAppStore((state) => state.snapshot);
  const mode = useAppStore((state) => state.mode);
  const comparisonTarget = useAppStore((state) => state.comparisonTarget);
  const ready = useAppStore((state) => state.ready);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const initializeRepository = useAppStore((state) => state.initializeRepository);
  const setPanelSize = useAppStore((state) => state.setPanelSize);
  const identityPanelRepoId = useAppStore((state) => state.identityPanelRepoId);
  const closeIdentityPanel = useAppStore((state) => state.closeIdentityPanel);
  const remoteManagerRepoId = useAppStore((state) => state.remoteManagerRepoId);
  const closeRemoteManager = useAppStore((state) => state.closeRemoteManager);
  const aboutOpen = useAppStore((state) => state.aboutOpen);
  const aboutInitialTab = useAppStore((state) => state.aboutInitialTab);
  const closeAbout = useAppStore((state) => state.closeAbout);
  const [pluginMessages, setPluginMessages] = useState<Record<string, string>>({});
  const [dropActive, setDropActive] = useState(false);
  const themePreference = bootstrap?.state.settings?.theme ?? bootstrap?.state.theme ?? 'system';
  const languagePreference = bootstrap?.state.settings?.language ?? bootstrap?.state.language ?? 'system';
  const uiFontSize = bootstrap?.state.settings?.uiFontSize ?? bootstrap?.state.uiFontSize ?? 'standard';
  const language = resolveLanguage(languagePreference);
  const t = useMemo(() => createTranslator(language, pluginMessages), [language, pluginMessages]);
  const commitWidth = bootstrap?.state.layout?.panelSizes.commit ?? bootstrap?.state.panelSizes?.commit ?? 360;
  const missingTools = snapshot && !snapshot.tools.git && !snapshot.tools.svn;
  const noRepositories = snapshot && !snapshot.repositories.length;
  const initializeAvailable = bootstrap?.capabilities.availability?.initializeRepository?.available ?? bootstrap?.tools.git ?? false;
  const initialize = async () => {
    if (!snapshot || !initializeAvailable) return;
    const target = snapshot.workspace.paths.length === 1 ? snapshot.workspace.paths[0] : await choiceDialog({ title: t('Initialize Repository'), message: t('Select the workspace root to initialize.'), choices: snapshot.workspace.paths.map((path) => ({ id: path, label: path, icon: 'folder' })) });
    if (target) await initializeRepository(target);
  };
  const comparisonDiffOpen = mode === 'diff' && Boolean(comparisonTarget);
  const resizeCommit = useResizable(commitWidth, 280, 620, (value) => setPanelSize('commit', value));

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(resolveTheme(themePreference, media.matches));
    update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update);
  }, [themePreference]);

  useEffect(() => {
    const size = UI_FONT_SIZE[uiFontSize];
    // 清理旧版本曾写入的内联 zoom，避免热更新或旧页面状态把整个窗口缩小。
    document.documentElement.style.removeProperty('zoom');
    document.body.style.removeProperty('zoom');
    document.getElementById('root')?.style.removeProperty('zoom');
    document.documentElement.style.setProperty('--versiondock-ui-font-size', size.pixels);
    document.documentElement.style.setProperty('--versiondock-ui-font-scale', size.scale);
  }, [uiFontSize]);

  useEffect(() => {
    document.documentElement.lang = language;
    const source = language === 'zh-CN' ? '/l10n/bundle.l10n.zh-cn.json' : '/l10n/bundle.l10n.json';
    void fetch(source).then((response) => response.json()).then(setPluginMessages).catch(() => setPluginMessages({}));
  }, [language]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void bridge.window.onDragDrop((paths) => { setDropActive(false); void openWorkspace(paths); }).then((value) => { dispose = value; });
    const over = (event: DragEvent) => { event.preventDefault(); setDropActive(true); };
    const leave = () => setDropActive(false);
    window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', leave);
    return () => { dispose?.(); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', leave); };
  }, [bridge, openWorkspace]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isCmdOrCtrl = event.metaKey || event.ctrlKey;
      if (isCmdOrCtrl && event.key.toLowerCase() === 'w' && !event.shiftKey && !event.altKey) {
        const activeId = useAppStore.getState().activeTabId;
        if (activeId) {
          event.preventDefault();
          void useAppStore.getState().closeTab(activeId);
        }
      } else if (isCmdOrCtrl && event.shiftKey && event.key.toLowerCase() === 'n' && !event.altKey) {
        event.preventDefault();
        void bridge.openInNewWindow();
      } else if (isCmdOrCtrl && event.shiftKey && event.key.toLowerCase() === 'o' && !event.altKey) {
        event.preventDefault();
        void (async () => {
          const paths = await bridge.selectWorkspaceFolders(t('Open Workspace'));
          if (paths.length) {
            await bridge.openInNewWindow(paths);
          }
        })();
      } else if (isCmdOrCtrl && event.shiftKey && event.key.toLowerCase() === 'u' && !event.altKey) {
        event.preventDefault();
        useAppStore.getState().toggleLogPanel();
      } else if (isCmdOrCtrl && event.key.toLowerCase() === 'o' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        void (async () => {
          const paths = await bridge.selectWorkspaceFolders(t('Open Workspace'));
          if (paths.length) await openWorkspace(paths);
        })();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [bridge, openWorkspace, t]);

  const hasSnapshot = Boolean(snapshot);
  useEffect(() => {
    if (!ready) return;
    if (hasSnapshot) {
      void bridge.window.setSize(0, 0, true);
    } else {
      void bridge.window.setSize(880, 540, true);
    }
  }, [bridge, ready, hasSnapshot]);

  useEffect(() => { const block = (event: MouseEvent) => event.preventDefault(); document.addEventListener('contextmenu', block); return () => document.removeEventListener('contextmenu', block); }, []);

  return <I18nContext.Provider value={{ language, preference: languagePreference, t }}>
    <div className="app-shell">
      <TitleBar />
      {!ready ? <div className="startup"><Codicon name="loading codicon-modifier-spin" />{t('Loading workspace…')}</div> : !snapshot ? <WorkspaceChooser /> : (
        <main className="main-workspace">
          <div style={{ width: commitWidth }} className="commit-slot"><CommitPanel /></div>
          <div className="resize-handle" role="separator" tabIndex={0} aria-label={t('Resize commit panel')} aria-orientation="vertical" aria-valuemin={280} aria-valuemax={620} aria-valuenow={commitWidth} onPointerDown={resizeCommit} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPanelSize('commit', Math.min(620, Math.max(280, commitWidth + (event.key === 'ArrowRight' ? 10 : -10)))); } }} />
          <div className="workspace-slot">{missingTools ? <div className="workspace-empty"><Codicon name="tools" /><strong>{t('Git and SVN are not installed')}</strong><span>{t('Install at least one command-line tool to load repositories.')}</span></div> : noRepositories ? <div className="workspace-empty"><Codicon name="repo" /><strong>{t('No repositories found')}</strong><span>{t('No repositories were found in this workspace.')}</span><button className="primary" disabled={!initializeAvailable} title={bootstrap?.capabilities.availability?.initializeRepository?.detail ?? undefined} onClick={() => void initialize()}><Codicon name="repo-create" />{t('Initialize Repository')}</button></div> : mode === 'history' || comparisonDiffOpen ? <><HistoryWorkspace />{comparisonDiffOpen && <div className="comparison-diff-overlay"><DiffWorkspace /></div>}</> : mode === 'commit-detail' ? <CommitDetailWorkspace /> : mode === 'diff' ? <DiffWorkspace /> : mode === 'changes' ? <CommitChangesWorkspace /> : <MergeWorkspace />}</div>
        </main>
      )}
      <OutputPanel />
      <NotificationToast />
      {dropActive && <div className="drop-overlay"><Codicon name="folder-opened" /><strong>{t('Drop folders anywhere in this window')}</strong></div>}
      <StatusBar />
      <DialogHost />
      <FileHistoryPanel />
      {identityPanelRepoId && <IdentityPanel repoId={identityPanelRepoId} close={closeIdentityPanel} />}
      {remoteManagerRepoId && <RemoteManager repoId={remoteManagerRepoId} close={closeRemoteManager} />}
      {aboutOpen && <AboutDialog onClose={closeAbout} initialTab={aboutInitialTab} />}
    </div>
  </I18nContext.Provider>;
}
