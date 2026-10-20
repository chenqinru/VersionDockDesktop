import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { checkpointWorkspaceChanged, refreshCheckpointActivity, refreshCheckpoints, selectCheckpointTask, useCheckpointStore } from '../../checkpoints/store';
import { checkpointStatus } from '../../checkpoints/status';
import { Codicon } from '../Codicon';
import { CheckpointPanel } from '../CheckpointPanel';

export function CheckpointStatusBarItem() {
  const { t } = useI18n();
  const workspace = useAppStore(state => state.snapshot?.workspace);
  const bridge = useAppStore(state => state.bridge);
  const checkpoints = useCheckpointStore();
  const [open, setOpen] = useState(false);
  const workspaceId = workspace?.id;

  // Keep hooks visible while the panel is closed. The panel shares this one poller.
  useEffect(() => {
    checkpointWorkspaceChanged(workspaceId ?? null);
    if (!bridge || !workspaceId) return;
    const refresh = () => {
      const { details, preview } = useCheckpointStore.getState();
      if (open && !details && !preview) void refreshCheckpoints();
      else void refreshCheckpointActivity();
    };
    refresh();
    const interval = window.setInterval(refresh, 3000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); };
  }, [workspaceId, bridge, open]);

  if (!workspace) return null;
  const current = checkpoints.workspaceId === workspace.id;
  const status = checkpointStatus(current ? checkpoints.activity : null, current && checkpoints.busy, current ? checkpoints.listingError || checkpoints.error : null);
  const task = current ? checkpoints.activity?.tasks.find(task => task.id === status.taskId) : undefined;
  const label = `${t('Checkpoints')} · ${t(status.label)}${(status.count ?? 0) > 1 ? ` (${status.count})` : ''}`;
  const title = [t('Tasks and checkpoints'), workspace.name, task?.name, t(status.label), current ? checkpoints.listingError || checkpoints.error : null,
    task?.error || task?.hookError, status.state === 'recording' ? t('Recording tracks this interval; it does not indicate whether Codex is still running.') : null].filter(Boolean).join('\n');

  return <>
    <button type="button" className={`statusbar-item checkpoint-status-item${open ? ' active' : ''}`} data-checkpoint-status={status.state}
      title={title} aria-label={`${t('Tasks and checkpoints')} · ${t(status.label)}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { if (status.taskId) selectCheckpointTask(status.taskId); setOpen(true); }}>
      <Codicon name={status.icon} />
      <span className="checkpoint-status-label" role="status">{label}</span>
    </button>
    {open && <CheckpointPanel onClose={() => setOpen(false)} />}
  </>;
}
