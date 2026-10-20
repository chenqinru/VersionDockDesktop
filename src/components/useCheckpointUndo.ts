import { useEffect, useRef, useState } from 'react';
import type { Checkpoint, RestorePreview } from '../bindings/generated';
import { runCheckpointAction, useCheckpointStore } from '../checkpoints/store';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { confirmDialog } from './dialogService';

/** Prepare and confirm undo or redo in place, without loading a diff. */
export function useCheckpointUndo(workspaceId: string | undefined, taskId: string | undefined, independent: boolean) {
  const { t } = useI18n();
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const [progress, setProgress] = useState<{ scope: string; kind: 'undo' | 'redo'; phase: 'checking' | 'confirming' | 'executing' }>();
  const scope = JSON.stringify([workspaceId, taskId]);
  const [operationScope, setOperationScope] = useState(scope);
  if (operationScope !== scope) { setOperationScope(scope); setProgress(undefined); }
  useEffect(() => () => { sequence.current += 1; inFlight.current = false; }, [workspaceId, taskId]);
  const restore = async (point?: Checkpoint, following = 0) => {
    const initial = useCheckpointStore.getState();
    if (!workspaceId || !taskId || inFlight.current || initial.busy || initial.workspaceId !== workspaceId || initial.selectedTaskId !== taskId) return;
    const ticket = ++sequence.current;
    const owns = () => ticket === sequence.current && useCheckpointStore.getState().workspaceId === workspaceId && useCheckpointStore.getState().selectedTaskId === taskId && (independent || useAppStore.getState().snapshot?.workspace.id === workspaceId);
    const kind = point ? 'undo' : 'redo';
    inFlight.current = true; setProgress({ scope, kind, phase: 'checking' });
    try {
      const preview = await runCheckpointAction<RestorePreview>(point ? { type: 'preview', task_id: taskId, checkpoint_id: point.id, bring_back: false } : { type: 'previewRedo', task_id: taskId });
      if (!preview || !owns() || preview.taskId !== taskId || (!point && !preview.redoOf) || preview.conflicts.length || !preview.files.length) return;
      setProgress({ scope, kind, phase: 'confirming' });
      const files = new Set(preview.files.map(file => JSON.stringify([file.repository, file.path]))).size;
      const count = preview.checkpointCount || following + 1;
      const confirmed = await confirmDialog({ title: t(point ? 'Confirm undo' : 'Redo last undo'), danger: true, confirmLabel: t(point ? 'Confirm undo' : 'Redo last undo'), message: point ? t('Undo {0} turns affecting {1} files? Stop external writes before continuing. Later non-overlapping edits are kept, and your current state will be backed up.', count, files) : t('Reapply the changes from the last undo, affecting {0} files? Stop external writes before continuing. Later non-overlapping edits are kept, and your current state will be backed up.', files) });
      const current = useCheckpointStore.getState();
      if (!confirmed || !owns() || current.busy || current.preview?.id !== preview.id || current.detailsCheckpointId !== (point ? point.id : initial.detailsCheckpointId)) return;
      setProgress({ scope, kind, phase: 'executing' });
      const result = await runCheckpointAction({ type: 'execute', preview_id: preview.id });
      if (result && owns()) void useAppStore.getState().refresh(true);
    } finally {
      if (ticket === sequence.current) { inFlight.current = false; setProgress(undefined); }
    }
  };
  return { undo: (point: Checkpoint, following: number) => restore(point, following), redo: () => restore(), phase: progress?.scope === scope ? progress.phase : undefined, kind: progress?.scope === scope ? progress.kind : undefined };
}
