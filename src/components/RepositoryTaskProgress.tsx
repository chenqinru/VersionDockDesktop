import { Button } from './Button';
import { useI18n } from '../i18n';
import { isTaskActive, useTaskProgressStore } from '../progress/taskProgressStore';
import { TaskProgressBar } from './StatusBar/TaskProgressBar';

/** The same task and native cancellation used by the workspace status bar. */
export function RepositoryTaskProgress({ operationId }: { operationId?: string }) {
  const task = useTaskProgressStore(state => operationId ? state.tasks[operationId] : undefined);
  const cancel = useTaskProgressStore(state => state.cancel);
  const { t } = useI18n();
  if (!task || !isTaskActive(task)) return null;
  return <div className="repository-task-progress" aria-live="polite">
    <span>{t(task.message || 'Processing')}</span>
    <TaskProgressBar completed={task.completed} total={task.total} active />
    <Button variant="ghost" size="xs" type="button" disabled={!task.cancellable || task.status === 'cancelling'} onClick={() => void cancel(task.id)}>{t(task.status === 'cancelling' ? 'Cancelling…' : 'Cancel Operation')}</Button>
    {task.cancelError && <small className="dialog-error">{task.cancelError}</small>}
  </div>;
}
