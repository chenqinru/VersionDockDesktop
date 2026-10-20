import { useEffect, useRef, useState } from 'react';
import type { CheckpointDiffSource, DiffDocument, RestoreFile } from '../bindings/generated';
import { useI18n } from '../i18n';
import { isAbortError } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { useResizable } from '../hooks/useResizable';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { DiffPlaceholder } from './DiffPlaceholder';
import { LoadingState } from './LoadingState';
import { UnifiedDiffView } from './UnifiedDiffView';

const fileKey = (file: RestoreFile) => JSON.stringify([file.repository, file.layer, file.path]);

/** Snapshot comparisons use the same renderer as repository diffs, without repository history actions. */
export function CheckpointChangesView({ files, source, workspaceId: projectId }: { files: RestoreFile[]; source: CheckpointDiffSource; workspaceId?: string }) {
  const { t } = useI18n();
  const bridge = useAppStore(state => state.bridge);
  const activeWorkspaceId = useAppStore(state => state.snapshot?.workspace.id);
  const workspaceId = projectId ?? activeWorkspaceId;
  const layout = useRef<HTMLDivElement>(null);
  const [filesWidth, setFilesWidth] = useState(250);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const maxFilesWidth = Math.max(150, Math.min(480, layoutWidth ? layoutWidth - 260 : 480));
  const width = Math.min(filesWidth, maxFilesWidth);
  const resizeFiles = useResizable(width, 150, maxFilesWidth, setFilesWidth);
  useEffect(() => {
    const element = layout.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setLayoutWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const sourceKey = JSON.stringify(source);
  const scope = JSON.stringify([workspaceId, sourceKey]);
  const [selection, setSelection] = useState<{ scope: string; key: string }>();
  const [retry, setRetry] = useState(0);
  const file = files.find(file => selection?.scope === scope && fileKey(file) === selection.key) ?? files[0];
  const selected = file ? fileKey(file) : undefined;
  const repository = file?.repository;
  const path = file?.path;
  const layer = file?.layer;
  const requestKey = JSON.stringify([workspaceId, sourceKey, selected, retry]);
  const [result, setResult] = useState<{ key: string; document?: DiffDocument; error?: string }>();
  const groups = new Map<string, RestoreFile[]>();
  for (const file of files) {
    if (!groups.has(file.repository)) groups.set(file.repository, []);
    groups.get(file.repository)!.push(file);
  }

  useEffect(() => {
    if (!bridge || !workspaceId || repository === undefined || path === undefined || layer === undefined) return;
    const controller = new AbortController();
    void bridge.request<DiffDocument>({ type: 'checkpoint', payload: { workspace_id: workspaceId, action: {
      type: 'diff', source: JSON.parse(sourceKey) as CheckpointDiffSource,
      repository, path, layer,
    } } }, { signal: controller.signal, showProgress: false, context: { workspaceId } }).then(document => {
      if (!controller.signal.aborted) setResult({ key: requestKey, document });
    }).catch(error => {
      if (!controller.signal.aborted && !isAbortError(error)) setResult({ key: requestKey, error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [bridge, workspaceId, repository, path, layer, sourceKey, requestKey]);

  const current = result?.key === requestKey ? result : undefined;
  return <div ref={layout} className="checkpoint-changes" style={{ gridTemplateColumns: `${width}px 4px minmax(0, 1fr)` }}>
    <nav className="checkpoint-changed-files vd-row-scope" aria-label={t('Changed files')}>
      {[...groups].map(([repository, files]) => <details open key={repository} className="checkpoint-repository-group">
        <summary title={repository}><Codicon name="chevron-right" /><Codicon name="repo" /><strong>{repository.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}</strong><span>{files.length}</span></summary>
        <div className="checkpoint-repository-path" title={repository}>{repository}</div>
        {files.map(file => <button type="button" key={fileKey(file)} className="vd-row checkpoint-changed-file" aria-pressed={selected === fileKey(file)} data-row-selected={selected === fileKey(file)} title={`${file.path}\n${t(file.layer === 'index' ? 'Staged changes' : 'Working tree')}`} onClick={() => setSelection({ scope, key: fileKey(file) })}>
          <FileIcon name={file.path} /><span className="checkpoint-changed-file-label"><span>{file.path.split(/[\\/]/).pop()}</span><small title={file.path}>{file.path.split(/[\\/]/).slice(0, -1).join('/') || '.'} · {t(file.layer === 'index' ? 'Staged changes' : 'Working tree')}</small></span><span className="checkpoint-file-status" data-status={file.status}>{t(file.status)}</span>
        </button>)}
      </details>)}
    </nav>
    <div className="inner-resize-handle" role="separator" tabIndex={0} aria-label={t('Resize changed files')} aria-orientation="vertical" aria-valuemin={150} aria-valuemax={Math.round(maxFilesWidth)} aria-valuenow={Math.round(width)} onPointerDown={resizeFiles} onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        setFilesWidth(event.key === 'Home' ? 150 : event.key === 'End' ? maxFilesWidth : Math.min(maxFilesWidth, Math.max(150, width + (event.key === 'ArrowRight' ? 10 : -10))));
      }
    }} />
    <section className="checkpoint-file-diff" aria-label={t('Show Diff')}>
      {!file ? <DiffPlaceholder kind="select" /> : <>
        <div className="checkpoint-diff-heading"><strong title={file.path}>{file.path}</strong><span>{t(file.layer === 'index' ? 'Staged changes' : 'Working tree')}</span></div>
        {current?.error ? <DiffPlaceholder kind="error" error={t(current.error)} onRetry={() => setRetry(value => value + 1)} /> : !current?.document ? <LoadingState>{t('Loading…')}</LoadingState> : current.document.binary ? <DiffPlaceholder kind="binary" path={file.path} /> : current.document.truncated ? <DiffPlaceholder kind="truncated" path={file.path} lineCount={current.document.lineCount} /> : !current.document.content ? <DiffPlaceholder kind="empty" path={file.path} /> : <UnifiedDiffView key={requestKey} content={current.document.content} path={file.path} language={current.document.language} />}
      </>}
    </section>
  </div>;
}
