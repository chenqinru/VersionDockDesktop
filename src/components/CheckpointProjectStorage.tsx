import { useEffect, useRef, useState } from 'react';
import type { CheckpointCleanupReport, ProjectCleanupPreview, ProjectStorageUsage, WorkspaceDescriptor } from '../bindings/generated';
import { useI18n } from '../i18n';
import { useCheckpointManagement } from './useCheckpointManagement';
import { Button } from './Button';
import { FormField } from './FormField';
import { Select } from './Select';
import { LoadingState } from './LoadingState';
import { ErrorNotice } from './ErrorNotice';
import { EmptyState } from './EmptyState';
import { confirmDialog } from './dialogService';

export function CheckpointProjectStorage({ project, onBusyChange, onChanged }: { project: WorkspaceDescriptor; onBusyChange: (busy: boolean) => void; onChanged: () => void }) {
  const { t } = useI18n();
  const { request, busy, error } = useCheckpointManagement(onBusyChange);
  const [usage, setUsage] = useState<ProjectStorageUsage>();
  const [keep, setKeep] = useState('10');
  const [preview, setPreview] = useState<ProjectCleanupPreview>();
  const [report, setReport] = useState<CheckpointCleanupReport>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async () => { const result = await request<ProjectStorageUsage>({ type: 'checkpoint', payload: { workspace_id: project.id, action: { type: 'projectStorageUsage' } } }); if (result) setUsage(result); };
  useEffect(() => { void request<ProjectStorageUsage>({ type: 'checkpoint', payload: { workspace_id: project.id, action: { type: 'projectStorageUsage' } } }).then(result => { if (result) setUsage(result); }); }, [request, project.id]);
  const inspect = async () => {
    setPreview(undefined); setReport(undefined);
    const result = await request<ProjectCleanupPreview>({ type: 'checkpoint', payload: { workspace_id: project.id, action: { type: 'previewProjectCleanup', keep_recent: Number(keep) } } });
    if (result) setPreview(result);
  };
  const clean = async () => {
    if (!preview || !await confirmDialog({ title: t('Clean project history'), danger: true, confirmLabel: t('Clean history'), message: t('Delete {0} eligible records from {1}? Other projects and project files are kept. Deleted history cannot be restored.', preview.removeCount, project.name) }) || !alive.current) return;
    setPreview(undefined);
    const result = await request<CheckpointCleanupReport>({ type: 'checkpoint', payload: { workspace_id: project.id, action: { type: 'projectCleanup', keep_recent: preview.keepRecent, fingerprint: preview.fingerprint } } }, true);
    if (result) { setReport(result); setPreview(undefined); onChanged(); void load(); }
  };
  const blocked = usage?.tasks.find(task => task.blockedReason)?.blockedReason;
  return <>
    <div className="checkpoint-page-heading checkpoint-settings-heading"><h3>{t('Project storage')}</h3><span className="checkpoint-settings-task-name">· {project.name}</span></div>
    <div className="checkpoint-scroll checkpoint-settings">
      {error && <ErrorNotice onRetry={() => void load()}>{t(error)}</ErrorNotice>}
      {!usage && busy && <LoadingState>{t('Loading storage usage…')}</LoadingState>}
      {usage && <>
        <section className="checkpoint-settings-section">
          <div className="checkpoint-storage-summary"><div><small>{t('Project referenced space')}</small><strong>{(usage.referencedBytes! / 1048576).toFixed(2)} MiB</strong></div><div><small>{t('Reclaimable space')}</small><strong>{usage.reclaimableBytes === null ? '—' : `${(usage.reclaimableBytes / 1048576).toFixed(2)} MiB`}</strong></div></div>
          <p className="checkpoint-settings-note">{t('Shared snapshots count toward each referencing project. Referenced space cannot be added together; only unreferenced objects are reclaimed.')}</p>
          <p className="checkpoint-settings-note">{t('All projects: {0} MiB', (usage.totalBytes! / 1048576).toFixed(1))}</p>
          <Button size="xs" disabled={busy} onClick={() => void load()}>{t('Refresh storage usage')}</Button>
        </section>
        <section className="checkpoint-settings-section"><h4>{t('Tasks')} · {usage.tasks.length}</h4>
          {usage.tasks.length ? <ul className="checkpoint-storage-tasks">{usage.tasks.map(task => <li key={task.taskId}><span title={task.name}>{task.name}<small>{t('{0} checkpoint records', task.checkpoints)}{task.blockedReason && ` · ${t('Protected')}`}</small></span><code>{(task.referencedBytes! / 1048576).toFixed(2)} MiB</code></li>)}</ul> : <EmptyState compact>{t('No checkpoint tasks yet')}</EmptyState>}
        </section>
        <section className="checkpoint-settings-section"><h4>{t('Clean project history')}</h4>
          <div className="checkpoint-settings-row"><FormField label={t('History to keep per task')}><Select disabled={busy} value={keep} onChange={value => { setKeep(value); setPreview(undefined); setReport(undefined); }} options={[10, 30, 100, 0].map(count => ({ value: String(count), label: t(count ? 'Keep latest {0} records' : 'Clean all eligible history', count) }))} /></FormField></div>
          {blocked && <p className="checkpoint-settings-note">{t(blocked)}</p>}
          <Button disabled={busy || !usage.tasks.length || Boolean(blocked)} loading={busy} onClick={() => void inspect()}>{t('Preview cleanup')}</Button>
          {preview && <div className="checkpoint-cleanup-preview" role="status"><p>{t('{0} records to remove · {1} protected · Estimated space to free: {2} MiB', preview.removeCount, preview.protectedCount, (preview.reclaimableBytes! / 1048576).toFixed(2))}</p>{(preview.removeCount || preview.reclaimableBytes) ? <Button danger disabled={busy} onClick={() => void clean()}>{t('Clean history')}</Button> : <p>{t('No eligible history to clean')}</p>}</div>}
          {report && <p role="status">{t('Removed {0} records · Freed {1} MiB', report.removedCount, (report.freedBytes! / 1048576).toFixed(2))}</p>}
          {report?.error && <ErrorNotice>{t(report.error)}</ErrorNotice>}
        </section>
      </>}
    </div>
  </>;
}
