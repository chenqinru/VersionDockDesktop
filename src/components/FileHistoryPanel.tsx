import { useEffect, useState } from 'react';
import type { DiffDocument, FileHistoryEntry, FileHistoryPage, FileRevisionDocument } from '../bindings/generated';
import { useBridge } from '../platform/context';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { ContextMenu } from './ContextMenu';
import { DiffPlaceholder } from './DiffPlaceholder';
import { SourceCodeView } from './SourceCodeView';
import { UnifiedDiffView } from './UnifiedDiffView';
import { isAbortError } from '../platform/bridge';

export function FileHistoryPanel() {
  const bridge = useBridge();
  const target = useAppStore((state) => state.fileHistoryTarget);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const close = useAppStore((state) => state.closeFileHistory);
  const [entries, setEntries] = useState<FileHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileHistoryEntry>();
  const [document, setDocument] = useState<FileRevisionDocument>();
  const [diff, setDiff] = useState<DiffDocument>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [context, setContext] = useState<{ x: number; y: number; entry: FileHistoryEntry }>();
  const { t } = useI18n();

  useEffect(() => {
    if (!target || !workspaceId) return;
    const controller = new AbortController();
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setEntries([]);
      setCursor(null);
      setSelected(undefined);
      setDocument(undefined);
      setDiff(undefined);
      setError(undefined);
      setLoading(true);
    });
    void bridge.request<FileHistoryPage>({ type: 'fileHistory', payload: { workspace_id: workspaceId, repo_id: target.repoId, relative_path: target.path, cursor: null, limit: 100 } }, { signal: controller.signal })
      .then((page) => { if (active) { setEntries(page.entries); setCursor(page.nextCursor); setSelected(page.entries[0]); } })
      .catch((reason) => { if (active && !isAbortError(reason)) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [bridge, target, workspaceId]);

  useEffect(() => {
    if (!target || !workspaceId || !selected) return;
    const controller = new AbortController();
    let active = true;
    queueMicrotask(() => { if (active) setLoading(true); });
    const deleted = selected.status.startsWith('D') && Boolean(selected.previousRevision);
    const contentPath = deleted ? selected.previousPath ?? selected.path : selected.path;
    const contentRevision = deleted ? selected.previousRevision! : selected.revision;
    const content = bridge.request<FileRevisionDocument>({ type: 'fileRevisionContent', payload: { workspace_id: workspaceId, repo_id: target.repoId, relative_path: contentPath, revision: contentRevision } }, { signal: controller.signal });
    const comparison = selected.previousRevision ? bridge.request<DiffDocument>({ type: 'fileDiff', payload: { workspace_id: workspaceId, repo_id: target.repoId, relative_path: selected.path, staged: false, revision: null, from_revision: selected.previousRevision, to_revision: selected.revision } }, { signal: controller.signal }).catch(() => undefined) : Promise.resolve(undefined);
    void Promise.all([content, comparison]).then(([value, difference]) => { if (active) { setDocument(value); setDiff(difference); } }).catch((reason) => { if (active && !isAbortError(reason)) setError(String(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [bridge, selected, target, workspaceId]);

  if (!target || !workspaceId) return null;
  const choose = (entry: FileHistoryEntry) => { setSelected(entry); setDocument(undefined); setDiff(undefined); setError(undefined); setLoading(true); };
  const loadMore = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await bridge.request<FileHistoryPage>({ type: 'fileHistory', payload: { workspace_id: workspaceId, repo_id: target.repoId, relative_path: target.path, cursor, limit: 100 } });
      setEntries((current) => [...current, ...page.entries]); setCursor(page.nextCursor);
    } catch (reason) { setError(String(reason)); } finally { setLoading(false); }
  };
  const binary = Boolean(document?.binary || diff?.binary);
  const truncated = Boolean(document?.truncated || diff?.truncated);
  return <div className="file-history-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="file-history-panel" role="dialog" aria-modal="true" aria-label={t('File history')}>
      <header className="file-history-header">
        <Codicon name="history" />
        <strong>{t('File history')}</strong>
        <span className="file-history-path" title={target.path}>{target.path}</span>
        <button aria-label={t('Close')} title={t('Close')} onClick={close}><Codicon name="close" /></button>
      </header>
      <div className="file-history-layout">
        <aside>{entries.map((entry) => <button className={selected?.revision === entry.revision ? 'active' : ''} key={`${entry.revision}:${entry.path}`} onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY, entry }); }} onClick={() => choose(entry)}><b>{entry.revision.slice(0, 10)}</b><span>{entry.message}</span><small>{entry.author} · {entry.date}</small></button>)}{cursor && <button className="load-more" disabled={loading} onClick={() => void loadMore()}>{t('Load more')}</button>}</aside>
        <main>
          {loading && <div className="detail-loading"><Codicon name="loading codicon-modifier-spin" />{t('Loading files...')}</div>}
          {error && <div className="error-row">{error}</div>}
          {document && <>
            {binary ? <DiffPlaceholder kind="binary" path={document.path} /> : truncated ? <DiffPlaceholder kind="truncated" path={document.path} lineCount={diff?.lineCount} /> : diff?.content ? <UnifiedDiffView className="file-history-diff" content={diff.content} path={diff.path} language={diff.language} splitBreakpoint={900} /> : <SourceCodeView content={document.content} path={document.path} />}
          </>}
        </main>
      </div>
      {context && <ContextMenu x={context.x} y={context.y} items={[{ id: 'open', label: t('Open Revision'), icon: 'go-to-file' }, ...(context.entry.previousRevision ? [{ id: 'diff', label: t('Show Diff'), icon: 'diff' } as const] : []), { id: 'copy', label: t('Copy Revision Number'), icon: 'copy' }]} onSelect={(id) => { if (id === 'open' || id === 'diff') choose(context.entry); if (id === 'copy') void navigator.clipboard?.writeText(context.entry.revision).catch(() => undefined); setContext(undefined); }} onClose={() => setContext(undefined)} />}
    </section>
  </div>;
}
