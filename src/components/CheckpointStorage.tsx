import { useEffect, useState } from 'react';
import type { CheckpointStorageUsage } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { isAbortError } from '../platform/bridge';
import { Button } from './Button';
import { LoadingState } from './LoadingState';
import { ErrorNotice } from './ErrorNotice';

export function CheckpointStorage({ taskId, revision, workspaceId: projectId }: { taskId?: string; revision?: unknown; workspaceId?: string }) {
  const { t } = useI18n();
  const bridge = useAppStore(s => s.bridge);
  const activeWorkspaceId = useAppStore(s => s.snapshot?.workspace.id);
  const workspaceId = projectId ?? activeWorkspaceId;
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([workspaceId, taskId, retry, revision]);
  const [result, setResult] = useState<{ key: string; usage?: CheckpointStorageUsage; error?: string }>();
  useEffect(() => {
    if (!bridge || !workspaceId) return;
    const controller = new AbortController();
    void bridge.request<CheckpointStorageUsage>({ type: 'checkpoint', payload: { workspace_id: workspaceId, action: { type: 'storageUsage', task_id: taskId ?? null } } }, { signal: controller.signal, showProgress: false, context: { workspaceId } }).then(usage => {
      if (!controller.signal.aborted) {
        if (typeof usage.totalBytes !== 'number' || typeof usage.taskBytes !== 'number') throw new Error('Storage statistics are unavailable');
        setResult({ key, usage });
      }
    }).catch(error => { if (!controller.signal.aborted && !isAbortError(error)) setResult({ key, error: error instanceof Error ? error.message : String(error) }); });
    return () => controller.abort();
  }, [bridge, workspaceId, taskId, key]);
  const current = result?.key === key ? result : undefined;
  return <div className="checkpoint-storage-details">
    {!current ? <LoadingState>{t('Loading storage usage…')}</LoadingState> : current.error ? <ErrorNotice onRetry={() => setRetry(v => v + 1)}>{t(current.error)}</ErrorNotice> : current.usage && <>
      {taskId && <p>{t('Referenced by this task: {0} MiB', (current.usage.taskBytes! / 1048576).toFixed(1))}</p>}
      {current.usage.reclaimableBytes !== null && <p>{t('Eligible history could free: {0} MiB', (current.usage.reclaimableBytes / 1048576).toFixed(1))}</p>}
      {taskId && <p className="checkpoint-settings-note">{t('Shared snapshots may be referenced by more than one task; task usage cannot be added together.')}</p>}
    </>}
    <div className="checkpoint-toolbar"><Button size="xs" onClick={() => setRetry(v => v + 1)}>{t('Refresh storage usage')}</Button></div>
  </div>;
}
