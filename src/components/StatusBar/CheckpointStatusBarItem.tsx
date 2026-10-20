import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { useCheckpointStore } from '../../checkpoints/store';
import { openCheckpointCenter, useCheckpointCenter } from '../../checkpoints/center';
import type { CheckpointActivity } from '../../bindings/generated';
import { checkpointStatus } from '../../checkpoints/status';
import { Codicon } from '../Codicon';

export function CheckpointStatusBarItem() {
  const { t } = useI18n();
  const workspace = useAppStore(state => state.snapshot?.workspace);
  const bridge = useAppStore(state => state.bridge);
  const checkpoints = useCheckpointStore();
  const open = useCheckpointCenter(state => state.open);
  const [result, setResult] = useState<{ id: string; activity?: CheckpointActivity; error?: string }>();
  const workspaceId = workspace?.id;

  // Current-project status is independent of the project selected in the center.
  useEffect(() => {
    if (!bridge || !workspaceId) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const activity = await bridge.request<CheckpointActivity>({ type: 'checkpoint', payload: { workspace_id: workspaceId, action: { type: 'activity' } } }, { signal: controller.signal, timeoutMs: 15000, showProgress: false, context: { workspaceId } });
        if (!Array.isArray(activity.tasks)) throw new Error('History is unavailable');
        if (!controller.signal.aborted) setResult({ id: workspaceId, activity });
      } catch (error) { if (!controller.signal.aborted) setResult({ id: workspaceId, error: String(error) }); }
      finally { pending = false; }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener('focus', focus); };
  }, [workspaceId, bridge]);

  if (!workspace) return null;
  const current = checkpoints.workspaceId === workspace.id;
  const activity = result?.id === workspace.id ? result.activity ?? null : null;
  const error = result?.id === workspace.id ? result.error ?? null : null;
  const status = checkpointStatus(activity, current && checkpoints.busy, error || (current ? checkpoints.error : null));
  const task = activity?.tasks.find(task => task.id === status.taskId);
  const label = `${t('Checkpoints')} · ${t(status.label)}${(status.count ?? 0) > 1 ? ` (${status.count})` : ''}`;
  const title = [t('Tasks and checkpoints'), workspace.name, task?.name, t(status.label), error || (current ? checkpoints.error : null),
    task?.error || task?.hookError, status.state === 'recording' ? t('Recording tracks this interval; it does not indicate whether Codex is still running.') : null].filter(Boolean).join('\n');

  return <>
    <button type="button" className={`statusbar-item checkpoint-status-item${open ? ' active' : ''}`} data-checkpoint-status={status.state}
      title={title} aria-label={`${t('Tasks and checkpoints')} · ${t(status.label)}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { openCheckpointCenter(workspace.id, status.taskId); }}>
      <Codicon name={status.icon} />
      <span className="checkpoint-status-label" role="status">{label}</span>
    </button>
  </>;
}
