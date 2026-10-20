import { useEffect, useRef, useState } from 'react';
import type { CheckpointListing, CheckpointPage, TaskWorkspace } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { isAbortError } from '../platform/bridge';

export function useCheckpointHistory(task: TaskWorkspace | undefined, listing: CheckpointListing | null, query: string, repository: string, onlyChanges: boolean, offset: number, enabled: boolean, projectId?: string) {
  const bridge = useAppStore(s => s.bridge);
  const activeWorkspaceId = useAppStore(s => s.snapshot?.workspace.id);
  const workspaceId = projectId ?? activeWorkspaceId;
  const [retry, setRetry] = useState(0);
  const taskId = task?.id;
  const total = task ? listing?.historyCounts?.[task.id] ?? task.checkpoints.length : 0;
  const needed = Boolean(task && enabled && (listing?.historyCounts || query || repository || offset));
  const version = listing?.historyRevisions?.[task?.id ?? ''] ?? JSON.stringify(task?.checkpoints);
  const key = JSON.stringify([workspaceId, task?.id, query, repository, onlyChanges, offset, retry, version]);
  const revisions = useRef<{ scope: string; value: string }>();
  const revisionScope = JSON.stringify([workspaceId, task?.id, query, repository, onlyChanges]);
  const [result, setResult] = useState<{ key: string; page?: CheckpointPage; error?: string }>();
  useEffect(() => {
    if (!needed || !taskId || !bridge || !workspaceId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void bridge.request<CheckpointPage>({ type: 'checkpoint', payload: { workspace_id: workspaceId, action: { type: 'history', task_id: taskId, query, repository: repository || null, only_changes: onlyChanges, offset, revision: revisions.current?.scope === revisionScope ? revisions.current.value : null } } }, { signal: controller.signal, showProgress: false, context: { workspaceId } }).then(page => {
        if (!controller.signal.aborted) {
          if (!Array.isArray(page.points)) throw new Error('History is unavailable');
          revisions.current = { scope: revisionScope, value: page.revision };
          setResult({ key, page });
        }
      }).catch(error => { if (!controller.signal.aborted && !isAbortError(error)) setResult({ key, error: error instanceof Error ? error.message : String(error) }); });
    }, query ? 250 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [needed, bridge, workspaceId, taskId, version, query, repository, onlyChanges, offset, key, revisionScope]);
  const current = result?.key === key ? result : undefined;
  return { page: needed ? current?.page : undefined, error: needed ? current?.error : undefined, loading: needed && !current, total, retry: () => setRetry(value => value + 1) };
}
