import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import { isTaskActive, sortedTasks, taskStatusKey, useTaskProgressStore } from '../../progress/taskProgressStore';
import { Codicon } from '../Codicon';
import { TaskProgressBar } from './TaskProgressBar';
import { TaskProgressPopover } from './TaskProgressPopover';

export function OperationStatusBarItem() {
  const { t } = useI18n();
  const tasks = useTaskProgressStore((state) => state.tasks);
  const open = useTaskProgressStore((state) => state.open);
  const setOpen = useTaskProgressStore((state) => state.setOpen);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id ?? null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(Date.now);
  const [visibleId, setVisibleId] = useState<string>();
  const [seen] = useState(() => new Set<string>());
  const active = useMemo(() => sortedTasks(Object.values(tasks).filter(isTaskActive), workspaceId), [tasks, workspaceId]);
  const candidate = active[0];
  const immediate = Boolean(candidate && (candidate.immediate || candidate.children.length > 1));
  const candidateId = candidate?.id, candidateAt = candidate?.startedAt;
  useEffect(() => {
    if (!candidateId || candidateAt === undefined) return;
    const delay = immediate || seen.size ? 0 : Math.max(0, candidateAt + 250 - Date.now());
    const timer = window.setTimeout(() => { seen.add(candidateId); setVisibleId(candidateId); }, delay);
    return () => window.clearTimeout(timer);
  }, [candidateId, candidateAt, immediate, seen]);
  const newestFinish = Math.max(0, ...Object.values(tasks).filter((task) => seen.has(task.id)).map((task) => task.finishedAt ?? 0));
  useEffect(() => {
    if (!newestFinish) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, newestFinish + 2000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [newestFinish]);
  useEffect(() => {
    if (Object.values(tasks).some((task) => isTaskActive(task) || seen.has(task.id) && (task.finishedAt ?? 0) + 2000 > now)) return;
    seen.clear();
  }, [tasks, seen, now]);
  useEffect(() => () => setOpen(false), [setOpen]);
  const previous = tasks[visibleId ?? ''];
  const finished = Object.values(tasks).filter((item) => !isTaskActive(item) && seen.has(item.id) && (item.finishedAt ?? 0) + 2000 > now)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  const task = active.length ? previous && isTaskActive(previous) ? previous : seen.size || immediate ? candidate : undefined : finished;
  const otherCount = active.filter((item) => item.workspaceId && item.workspaceId !== workspaceId).length;
  const onlyOthers = active.length > 0 && otherCount === active.length;
  if (!task && !open) return null;
  const label = task ? onlyOthers ? t('Other projects · {0} tasks', otherCount) : t(isTaskActive(task) ? task.title : taskStatusKey(task.status)) : t('Task progress');
  return <>
    {task && <button ref={anchorRef} type="button" className="statusbar-operation" title={task ? `${t(task.title)} · ${task.workspaceName} · ${t(task.message)}` : label}
      aria-label={t('Task progress')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Codicon name={!task ? 'check-all' : isTaskActive(task) ? 'loading codicon-modifier-spin' : task.status === 'succeeded' ? 'check' : task.status === 'failed' || task.status === 'timedOut' ? 'error' : task.status === 'partial' ? 'warning' : 'circle-slash'} />
      <span className="statusbar-operation-label">{label}</span>
      {task && !onlyOthers && task.total !== null && task.total > 0 && <span className="statusbar-operation-fraction">{Math.min(task.total, task.completed ?? 0)}/{task.total}</span>}
      {task && <TaskProgressBar completed={onlyOthers ? null : task.completed} total={onlyOthers ? null : task.total} active={isTaskActive(task)} />}
      {!onlyOthers && active.length > 1 && <span className="statusbar-operation-count" title={otherCount ? t('Other projects · {0} tasks', otherCount) : undefined}>+{active.length - 1}</span>}
    </button>}
    {open && <TaskProgressPopover anchorRef={anchorRef} currentWorkspaceId={workspaceId} onClose={() => setOpen(false)} />}
  </>;
}
