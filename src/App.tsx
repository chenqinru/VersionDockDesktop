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
import { useAppStore } from './store/appStore';
import { createTranslator, I18nContext, resolveLanguage } from './i18n';
import { applyTheme, resolveTheme } from './theme';
import { useResizable } from './hooks/useResizable';
import { useBridge } from './platform/context';
import { DialogHost } from './components/DialogHost';
import { FileHistoryPanel } from './components/FileHistoryPanel';
import { StatusBar } from './components/StatusBar/StatusBar';
import { IdentityPanel } from './components/IdentityPanel';
import { RemoteManager } from './components/RemoteManager';
import { isAbortError } from './platform/bridge';

const UI_FONT_SIZE = {
  minimum: { pixels: '11px', scale: '0.8461538462' },
  small: { pixels: '12px', scale: '0.9230769231' },
  standard: { pixels: '13px', scale: '1' },
  large: { pixels: '14px', scale: '1.0769230769' },
  maximum: { pixels: '15px', scale: '1.1538461538' },
} as const;

export function App() {
  const bridge = useBridge();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const snapshot = useAppStore((state) => state.snapshot);
  const mode = useAppStore((state) => state.mode);
  const comparisonTarget = useAppStore((state) => state.comparisonTarget);
  const ready = useAppStore((state) => state.ready);
  const busy = useAppStore((state) => state.busy);
  const error = useAppStore((state) => state.error);
  const clearError = useAppStore((state) => state.clearError);
  const errorDetails = useAppStore((state) => state.errorDetails);
  const notice = useAppStore((state) => state.notice);
  const clearNotice = useAppStore((state) => state.clearNotice);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const setPanelSize = useAppStore((state) => state.setPanelSize);
  const identityPanelRepoId = useAppStore((state) => state.identityPanelRepoId);
  const closeIdentityPanel = useAppStore((state) => state.closeIdentityPanel);
  const remoteManagerRepoId = useAppStore((state) => state.remoteManagerRepoId);
  const closeRemoteManager = useAppStore((state) => state.closeRemoteManager);
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

  useEffect(() => { const block = (event: MouseEvent) => event.preventDefault(); document.addEventListener('contextmenu', block); return () => document.removeEventListener('contextmenu', block); }, []);

  return <I18nContext.Provider value={{ language, preference: languagePreference, t }}>
    <div className="app-shell">
      <TitleBar />
      {!ready ? <div className="startup"><Codicon name="loading codicon-modifier-spin" />{t('Loading workspace…')}</div> : !snapshot ? <WorkspaceChooser /> : (
        <main className="main-workspace">
          <div style={{ width: commitWidth }} className="commit-slot"><CommitPanel /></div>
          <div className="resize-handle" onPointerDown={resizeCommit} />
          <div className="workspace-slot">{missingTools ? <div className="workspace-empty"><Codicon name="tools" /><strong>{t('Git and SVN are not installed')}</strong><span>{t('Install at least one command-line tool to load repositories.')}</span></div> : noRepositories ? <div className="workspace-empty"><Codicon name="repo" /><strong>{t('No repositories found')}</strong><span>{t('No repositories were found in this workspace.')}</span></div> : mode === 'history' || comparisonDiffOpen ? <><HistoryWorkspace />{comparisonDiffOpen && <div className="comparison-diff-overlay"><DiffWorkspace /></div>}</> : mode === 'commit-detail' ? <CommitDetailWorkspace /> : mode === 'diff' ? <DiffWorkspace /> : mode === 'changes' ? <CommitChangesWorkspace /> : <MergeWorkspace />}</div>
        </main>
      )}
      {busy && <div className="busy-line" />}
      {error && !isAbortError(error) && (
        <div className="toast error" role="alert">
          <div className="toast-icon">
            <Codicon name="error" />
          </div>
          <div className="toast-content">
            <div className="toast-header">
              <strong className="toast-title">{t('Operation failed')}</strong>
            </div>
            <div className="toast-message">{error}</div>
            {errorDetails && (
              <details className="toast-details">
                <summary>Technical details</summary>
                <pre>{errorDetails}</pre>
              </details>
            )}
          </div>
          <button type="button" className="toast-close" aria-label={t('Close')} title={t('Close')} onClick={clearError}>
            <Codicon name="close" />
          </button>
        </div>
      )}
      {notice && (
        <div className="toast info" role="status">
          <div className="toast-icon">
            <Codicon name="bell" />
          </div>
          <div className="toast-content">
            <div className="toast-header">
              <strong className="toast-title">VersionDock Desktop</strong>
            </div>
            <div className="toast-message">{notice}</div>
          </div>
          <button type="button" className="toast-close" aria-label={t('Close')} title={t('Close')} onClick={clearNotice}>
            <Codicon name="close" />
          </button>
        </div>
      )}
      {dropActive && <div className="drop-overlay"><Codicon name="folder-opened" /><strong>{t('Drop folders anywhere in this window')}</strong></div>}
      <StatusBar />
      <DialogHost />
      <FileHistoryPanel />
      {identityPanelRepoId && <IdentityPanel repoId={identityPanelRepoId} close={closeIdentityPanel} />}
      {remoteManagerRepoId && <RemoteManager repoId={remoteManagerRepoId} close={closeRemoteManager} />}
    </div>
  </I18nContext.Provider>;
}
