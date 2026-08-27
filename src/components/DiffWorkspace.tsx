import { useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { FileIcon } from './FileIcon';
import { DiffPlaceholder } from './DiffPlaceholder';
import { UnifiedDiffView } from './UnifiedDiffView';

export function DiffWorkspace() {
  const systemOpen = useAppStore((state) => state.systemOpen);
  const openFileHistory = useAppStore((state) => state.openFileHistory);
  const diff = useAppStore((state) => state.diff);
  const back = useAppStore((state) => state.backToHistory);
  const comparisonTarget = useAppStore((state) => state.comparisonTarget);
  const [context, setContext] = useState<{ x: number; y: number }>();
  const { t } = useI18n();
  const file = useAppStore((state) => state.selectedFile);
  const externalEditor = useAppStore((state) => state.bootstrap?.state.settings?.externalEditor ?? state.bootstrap?.state.externalEditor);
  const snapshot = useAppStore((state) => state.snapshot);
  const repo = snapshot?.repositories.find((item) => item.meta.id === file?.repoId);
  const contextItems: ContextMenuEntry[] = [
    { id: 'copy', label: t('Copy'), icon: 'copy' },
  ];
  if (!diff) return null;
  const fileName = diff.path.split('/').pop() ?? diff.path;
  const revisionLabel = file && !file.revision ? t(file.staged ? 'Index ↔ HEAD' : 'Working tree') : undefined;
  return <section className="diff-workspace">
    <header className="diff-header">
      <button className="diff-back-button" onClick={back}><Codicon name="arrow-left" /><span>{t(comparisonTarget ? 'Back to compare' : 'Back to history')}</span></button>
      <div className="diff-file-heading" title={diff.path}>
        <FileIcon name={fileName} />
        <span className="diff-file-path">{diff.path}</span>
        {revisionLabel && <em>{revisionLabel}</em>}
      </div>
      <div className="diff-header-actions">
        <span className="diff-line-count">{diff.lineCount} {t('Lines')}</span>
        {repo && file && <>
          <i className="diff-header-divider" />
          <button className="diff-header-action" aria-label={t('File history')} title={t('File history')} onClick={() => openFileHistory(repo.meta.id, file.path)}><Codicon name="history" /></button>
          {externalEditor && <button className="diff-header-action" aria-label={t('Open in external editor')} title={t('Open in external editor')} onClick={() => void systemOpen(repo.meta.id, file.path, false, true)}><Codicon name="code" /></button>}
          <button className="diff-header-action" aria-label={t('Open')} title={t('Open')} onClick={() => void systemOpen(repo.meta.id, file.path, false)}><Codicon name="go-to-file" /></button>
          <button className="diff-header-action" aria-label={t('Reveal')} title={t('Reveal')} onClick={() => void systemOpen(repo.meta.id, file.path, true)}><Codicon name="folder-opened" /></button>
        </>}
      </div>
    </header>
    <div className="diff-content-context" onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY }); }}>{diff.truncated ? <DiffPlaceholder kind="truncated" path={diff.path} lineCount={diff.lineCount} /> : diff.binary ? <DiffPlaceholder kind="binary" path={diff.path} /> : !diff.content ? <DiffPlaceholder kind="empty" path={diff.path} /> : <UnifiedDiffView content={diff.content} path={diff.path} language={diff.language} />}</div>
    {context && <ContextMenu x={context.x} y={context.y} items={contextItems} onSelect={() => { const selection = window.getSelection()?.toString(); void navigator.clipboard?.writeText(selection || diff.content).catch(() => undefined); setContext(undefined); }} onClose={() => setContext(undefined)} />}
  </section>;
}
