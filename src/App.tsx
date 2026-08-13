import { useEffect, useMemo, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { WorkspaceChooser } from './components/WorkspaceChooser';
import { CommitPanel } from './components/CommitPanel';
import { HistoryWorkspace } from './components/HistoryWorkspace';
import { DiffWorkspace } from './components/DiffWorkspace';
import { MergeWorkspace } from './components/MergeWorkspace';
import { Codicon } from './components/Codicon';
import { useAppStore } from './store/appStore';
import { createTranslator, I18nContext, resolveLanguage } from './i18n';
import { applyTheme, resolveTheme } from './theme';
import { useResizable } from './hooks/useResizable';
import { useBridge } from './platform/context';

export function App() {
  const bridge = useBridge();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const snapshot = useAppStore((state) => state.snapshot);
  const mode = useAppStore((state) => state.mode);
  const ready = useAppStore((state) => state.ready);
  const busy = useAppStore((state) => state.busy);
  const error = useAppStore((state) => state.error);
  const clearError = useAppStore((state) => state.clearError);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const setPanelSize = useAppStore((state) => state.setPanelSize);
  const [pluginMessages, setPluginMessages] = useState<Record<string, string>>({});
  const [dropActive, setDropActive] = useState(false);
  const themePreference = bootstrap?.state.theme ?? 'system';
  const languagePreference = bootstrap?.state.language ?? 'system';
  const language = resolveLanguage(languagePreference);
  const t = useMemo(() => createTranslator(language, pluginMessages), [language, pluginMessages]);
  const commitWidth = bootstrap?.state.panelSizes.commit ?? 360;
  const missingTools = snapshot && !snapshot.tools.git && !snapshot.tools.svn;
  const noRepositories = snapshot && !snapshot.repositories.length;
  const resizeCommit = useResizable(commitWidth, 280, 620, (value) => setPanelSize('commit', value));

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(resolveTheme(themePreference, media.matches));
    update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update);
  }, [themePreference]);

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

  useEffect(() => { const block = (event: MouseEvent) => event.preventDefault(); document.addEventListener('contextmenu', block); return () => document.removeEventListener('contextmenu', block); }, []);

  return <I18nContext.Provider value={{ language, preference: languagePreference, t }}>
    <div className="app-shell">
      <TitleBar />
      {!ready ? <div className="startup"><Codicon name="loading codicon-modifier-spin" />{t('Loading workspace…')}</div> : !snapshot ? <WorkspaceChooser /> : (
        <main className="main-workspace">
          <div style={{ width: commitWidth }} className="commit-slot"><CommitPanel /></div>
          <div className="resize-handle" onPointerDown={resizeCommit} />
          <div className="workspace-slot">{missingTools ? <div className="workspace-empty"><Codicon name="tools" /><strong>{t('Git and SVN are not installed')}</strong><span>{t('Install at least one command-line tool to load repositories.')}</span></div> : noRepositories ? <div className="workspace-empty"><Codicon name="repo" /><strong>{t('No repositories found')}</strong><span>{t('No repositories were found in this workspace.')}</span></div> : mode === 'history' ? <HistoryWorkspace /> : mode === 'diff' ? <DiffWorkspace /> : <MergeWorkspace />}</div>
        </main>
      )}
      {busy && <div className="busy-line" />}
      {error && <div className="toast error"><Codicon name="error" /><span><strong>{t('Operation failed')}</strong>{error}</span><button onClick={clearError}><Codicon name="close" /></button></div>}
      {dropActive && <div className="drop-overlay"><Codicon name="folder-opened" /><strong>{t('Drop folders anywhere in this window')}</strong></div>}
    </div>
  </I18nContext.Provider>;
}
