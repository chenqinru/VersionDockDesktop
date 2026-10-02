import { IconButton } from './IconButton';
import { useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { FileIcon } from './FileIcon';
import { DiffPlaceholder } from './DiffPlaceholder';
import { commitComparisonBase } from '../history/commitDetails';
import { UnifiedDiffView } from './UnifiedDiffView';

export function DiffWorkspace() {
  const systemOpen = useAppStore((state) => state.systemOpen);
  const openFileHistory = useAppStore((state) => state.openFileHistory);
  const diff = useAppStore((state) => state.diff);
  const back = useAppStore((state) => state.backToHistory);
  const comparisonTarget = useAppStore((state) => state.comparisonTarget);
  const diffReturnMode = useAppStore((state) => state.diffReturnMode);
  const [context, setContext] = useState<{ x: number; y: number; selection?: string }>();
  const lastRangeRef = useRef<Range | null>(null);
  const { t } = useI18n();

  const syncSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.toString().length > 0) {
      lastRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  };
  const file = useAppStore((state) => state.selectedFile);
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const externalEditor = useAppStore((state) => state.bootstrap?.state.settings?.externalEditor ?? state.bootstrap?.state.externalEditor);
  const snapshot = useAppStore((state) => state.snapshot);
  const repo = snapshot?.repositories.find((item) => item.meta.id === file?.repoId);
  const contextItems: ContextMenuEntry[] = [
    { id: 'copy', label: t('Copy'), icon: 'copy' },
  ];
  if (!diff) return null;
  const fileName = diff.path.split('/').pop() ?? diff.path;
  const revisionLabel = file && !file.revision ? t(file.staged ? 'Index ↔ HEAD' : 'Working tree') : undefined;
  const isWorking = file?.toRevision === 'WORKTREE' || file?.toRevision === 'WORKING' || (!file?.revision && !file?.toRevision);
  const commit = selectedCommits.find((item) => item.repoId === file?.repoId && item.hash === file?.revision);
  const kind = repo?.meta.kind ?? 'git';
  const oldRevision = file?.fromRevision ?? (commit ? commitComparisonBase(commit, kind)
    : file?.revision ? kind === 'svn' ? commitComparisonBase({ hash: file.revision, parents: [] }, kind) : `${file.revision}~1` : kind === 'svn' ? 'BASE' : file?.staged ? 'HEAD' : 'INDEX');
  const newRevision = isWorking ? file?.staged && kind === 'git' ? 'INDEX' : kind === 'svn' ? 'WORKING' : 'WORKTREE' : (file?.toRevision ?? file?.revision);
  const backLabel = comparisonTarget
    ? t('Back to compare')
    : diffReturnMode === 'commit-detail'
      ? t('Back to commit details')
      : diffReturnMode === 'changes'
        ? t('Back to changes')
        : t('Back to history');
  return <section className="diff-workspace">
    <header className="diff-header">
      <button className="diff-back-button" onClick={back}><Codicon name="arrow-left" /><span>{backLabel}</span></button>
      <div className="diff-file-heading" title={diff.path}>
        <FileIcon name={fileName} />
        <span className="diff-file-path">{diff.path}</span>
        {revisionLabel && <em>{revisionLabel}</em>}
      </div>
      <div className="diff-header-actions">
        <span className="diff-line-count">{diff.lineCount} {t('Lines')}</span>
        {repo && file && <>
          <i className="diff-header-divider" />
          <IconButton className="diff-header-action" aria-label={t('File history')} title={t('File history')} onClick={() => openFileHistory(repo.meta.id, file.path)}><Codicon name="history" /></IconButton>
          {externalEditor && <IconButton className="diff-header-action" aria-label={t('Open in external editor')} title={t('Open in external editor')} onClick={() => void systemOpen(repo.meta.id, file.path, false, true)}><Codicon name="code" /></IconButton>}
          <IconButton className="diff-header-action" aria-label={t('Open')} title={t('Open')} onClick={() => void systemOpen(repo.meta.id, file.path, false)}><Codicon name="go-to-file" /></IconButton>
          <IconButton className="diff-header-action" aria-label={t('Reveal')} title={t('Reveal')} onClick={() => void systemOpen(repo.meta.id, file.path, true)}><Codicon name="folder-opened" /></IconButton>
        </>}
      </div>
    </header>
    <div
      className="diff-content-context"
      onMouseUp={syncSelection}
      onKeyUp={syncSelection}
      onContextMenu={(event) => {
        event.preventDefault();
        syncSelection();
        const sel = window.getSelection();
        if ((!sel || sel.isCollapsed || !sel.toString()) && lastRangeRef.current) {
          sel?.removeAllRanges();
          try {
            sel?.addRange(lastRangeRef.current);
          } catch {
            // ignore range reset errors if DOM mutated
          }
        }
        const selection = window.getSelection()?.toString() || '';
        setContext({ x: event.clientX, y: event.clientY, selection });
      }}
    >
      {diff.truncated ? <DiffPlaceholder kind="truncated" path={diff.path} lineCount={diff.lineCount} /> : diff.binary ? <DiffPlaceholder kind="binary" path={diff.path} /> : !diff.content ? <DiffPlaceholder kind="empty" path={diff.path} /> : <UnifiedDiffView repoId={file?.repoId ?? comparisonTarget?.repoId ?? repo?.meta.id} oldRevision={oldRevision} newRevision={newRevision} content={diff.content} path={diff.path} language={diff.language} />}
    </div>
    {context && <ContextMenu
      x={context.x}
      y={context.y}
      items={contextItems}
      onSelect={() => {
        const text = context.selection || window.getSelection()?.toString() || diff.content;
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        setContext(undefined);
      }}
      onClose={() => setContext(undefined)}
    />}
  </section>;
}
