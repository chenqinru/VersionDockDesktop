import { useEffect, useRef, useState } from 'react';
import type { DiffDocument, FileHistoryEntry, FileHistoryPage, FileRevisionDocument } from '../bindings/generated';
import { useBridge } from '../platform/context';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';
import { formatHistoryDate } from '../history/dates';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { ContextMenu } from './ContextMenu';
import { DiffPlaceholder } from './DiffPlaceholder';
import { SourceCodeView } from './SourceCodeView';
import { UnifiedDiffView } from './UnifiedDiffView';
import { isAbortError } from '../platform/bridge';

type View = 'source' | 'diff';
const defaultView = (entry: FileHistoryEntry): View => entry.previousRevision ? 'diff' : 'source';

export function FileHistoryPanel() {
  const target = useAppStore((state) => state.fileHistoryTarget);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  return target && workspaceId ? <FileHistoryDialog key={`${workspaceId}\0${target.repoId}\0${target.path}`} workspaceId={workspaceId} repoId={target.repoId} path={target.path} /> : null;
}

function FileHistoryDialog({ workspaceId, repoId, path }: { workspaceId: string; repoId: string; path: string }) {
  const bridge = useBridge();
  const close = useAppStore((state) => state.closeFileHistory);
  const openHistoryForPath = useAppStore((state) => state.openHistoryForPath);
  const dialog = useDialogFocusTrap(true, close);
  const { t } = useI18n();
  const [entries, setEntries] = useState<FileHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileHistoryEntry>();
  const [view, setView] = useState<View>('diff');
  const [preview, setPreview] = useState<{ document?: FileRevisionDocument; diff?: DiffDocument; loading: boolean; error?: string }>({ loading: false });
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string>();
  const [listRetry, setListRetry] = useState(0);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [context, setContext] = useState<{ x: number; y: number; entry: FileHistoryEntry }>();
  const pageController = useRef<AbortController>();

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    queueMicrotask(() => { if (active) { setListLoading(true); setListError(undefined); } });
    void bridge.request<FileHistoryPage>({ type: 'fileHistory', payload: { workspace_id: workspaceId, repo_id: repoId, relative_path: path, cursor: null, limit: 100 } }, { signal: controller.signal })
      .then((page) => {
        if (!active) return;
        setEntries(page.entries); setCursor(page.nextCursor); setSelected(page.entries[0]);
        if (page.entries[0]) setView(defaultView(page.entries[0]));
      })
      .catch((reason) => { if (active && !isAbortError(reason)) setListError(String(reason)); })
      .finally(() => { if (active) setListLoading(false); });
    return () => { active = false; controller.abort(); pageController.current?.abort(); };
  }, [bridge, workspaceId, repoId, path, listRetry]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    let active = true;
    queueMicrotask(() => { if (active) setPreview({ loading: true }); });
    const deleted = selected.status.startsWith('D') && selected.previousRevision;
    const request = view === 'diff' && selected.previousRevision
      ? bridge.request<DiffDocument>({ type: 'fileDiff', payload: { workspace_id: workspaceId, repo_id: repoId, relative_path: selected.path, staged: false, revision: null, from_revision: selected.previousRevision, to_revision: selected.revision } }, { signal: controller.signal }).then((diff) => ({ diff }))
      : bridge.request<FileRevisionDocument>({ type: 'fileRevisionContent', payload: { workspace_id: workspaceId, repo_id: repoId, relative_path: deleted ? selected.previousPath ?? selected.path : selected.path, revision: deleted ? selected.previousRevision! : selected.revision } }, { signal: controller.signal }).then((document) => ({ document }));
    void request.then((value) => { if (active) setPreview({ ...value, loading: false }); })
      .catch((reason) => { if (active && !isAbortError(reason)) setPreview({ loading: false, error: String(reason) }); });
    return () => { active = false; controller.abort(); };
  }, [bridge, workspaceId, repoId, selected, view, previewRetry]);

  const choose = (entry: FileHistoryEntry, nextView = selected === entry ? view : defaultView(entry)) => {
    if (selected === entry && view === nextView) return;
    setPreview({ loading: true }); setSelected(entry); setView(nextView);
  };
  const loadMore = async () => {
    if (!cursor || pageController.current) return;
    const controller = new AbortController(); pageController.current = controller;
    setListLoading(true); setListError(undefined);
    try {
      const page = await bridge.request<FileHistoryPage>({ type: 'fileHistory', payload: { workspace_id: workspaceId, repo_id: repoId, relative_path: path, cursor, limit: 100 } }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setEntries((current) => [...current, ...page.entries]); setCursor(page.nextCursor);
    } catch (reason) { if (!controller.signal.aborted && !isAbortError(reason)) setListError(String(reason)); }
    finally { if (!controller.signal.aborted) setListLoading(false); if (pageController.current === controller) pageController.current = undefined; }
  };
  const resource = preview.diff ?? preview.document;
  const displayPath = selected?.path ?? path;
  return <div className="file-history-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} className="file-history-panel" role="dialog" aria-modal="true" aria-label={t('File history')}>
      <header className="file-history-header">
        <Codicon name="history" /><strong>{t('File history')}</strong>
        <FileIcon name={displayPath.split('/').pop() ?? displayPath} />
        <span className="file-history-path" title={displayPath}>{displayPath}</span>
        {selected && <><IconButton aria-label={t('Open Revision')} title={t('Open Revision')} aria-pressed={view === 'source'} onClick={() => choose(selected, 'source')}><Codicon name="file-code" /></IconButton>
          <IconButton aria-label={t('Show Diff')} title={t('Show Diff')} aria-pressed={view === 'diff'} disabled={!selected.previousRevision} onClick={() => choose(selected, 'diff')}><Codicon name="diff" /></IconButton></>}
        <IconButton aria-label={t('Show in commit history')} title={t('Show in commit history')} onClick={() => { close(); void openHistoryForPath(repoId, path); }}><Codicon name="git-commit" /></IconButton>
        <IconButton aria-label={t('Close')} title={t('Close')} onClick={close}><Codicon name="close" /></IconButton>
      </header>
      <div className="file-history-layout">
        <aside>
          {entries.map((entry) => <button className={selected?.revision === entry.revision ? 'active' : ''} key={`${entry.revision}:${entry.path}`} onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY, entry }); }} onClick={() => choose(entry)}>
            <b>{entry.revision.slice(0, 10)}</b><span title={entry.message}>{entry.message}</span><small title={`${entry.author} · ${entry.date}`}>{entry.author} · {formatHistoryDate(entry.date)}</small>
          </button>)}
          {cursor && <button className="load-more" disabled={listLoading} onClick={() => void loadMore()}>{t('Load more')}</button>}
        </aside>
        <main>
          {listLoading && !entries.length && <div className="detail-loading"><Codicon name="loading codicon-modifier-spin" />{t('Loading files...')}</div>}
          {listError && <div className="error-row" role="alert"><span>{listError}</span><button onClick={() => { if (entries.length) void loadMore(); else setListRetry((value) => value + 1); }}>{t('Retry')}</button></div>}
          {!listLoading && !listError && !entries.length && <div className="file-history-empty"><Codicon name="history" /><span>{t('No history')}</span></div>}
          {selected && <>
            {preview.loading && <div className="detail-loading"><Codicon name="loading codicon-modifier-spin" />{t('Loading files...')}</div>}
            {preview.error && <div className="error-row" role="alert"><span>{preview.error}</span><button onClick={() => setPreviewRetry((value) => value + 1)}>{t('Retry')}</button></div>}
            {resource?.binary ? <DiffPlaceholder kind="binary" path={resource.path} /> : resource?.truncated ? <DiffPlaceholder kind="truncated" path={resource.path} lineCount={preview.diff?.lineCount} /> : preview.diff ? <UnifiedDiffView className="file-history-diff" repoId={repoId} oldPath={selected.previousPath ?? undefined} oldRevision={selected.previousRevision ?? undefined} newRevision={selected.revision} onShowSelectionHistory={(range, revision, targetPath) => { close(); void useAppStore.getState().openHistoryForLineRange(repoId, targetPath ?? (range.side === 'old' ? selected.previousPath ?? selected.path : selected.path), range, revision); }} content={preview.diff.content} path={preview.diff.path} language={preview.diff.language} splitBreakpoint={900} /> : preview.document && <SourceCodeView content={preview.document.content} path={preview.document.path} />}
          </>}
        </main>
      </div>
      {context && <ContextMenu x={context.x} y={context.y} items={[{ id: 'open', label: t('Open Revision'), icon: 'go-to-file' }, ...(context.entry.previousRevision ? [{ id: 'diff', label: t('Show Diff'), icon: 'diff' } as const] : []), { id: 'copy', label: t('Copy Revision Number'), icon: 'copy' }]} onSelect={(id) => { if (id === 'open' || id === 'diff') choose(context.entry, id === 'open' ? 'source' : 'diff'); if (id === 'copy') void navigator.clipboard?.writeText(context.entry.revision).catch(() => undefined); setContext(undefined); }} onClose={() => setContext(undefined)} />}
    </section>
  </div>;
}
