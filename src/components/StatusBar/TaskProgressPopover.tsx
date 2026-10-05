import { scrollbarContains } from '../../scrollbars/ownership';
import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useI18n } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import { isTaskActive, sortedTasks, taskStatusKey, useTaskProgressStore, type ProgressTask } from '../../progress/taskProgressStore';
import { IconButton } from '../IconButton';
import { Codicon } from '../Codicon';
import { TaskProgressBar } from './TaskProgressBar';

export function TaskProgressPopover({ anchorRef, currentWorkspaceId, onClose }: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  currentWorkspaceId: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tasks = useTaskProgressStore((state) => state.tasks);
  const cancel = useTaskProgressStore((state) => state.cancel);
  const openLog = useAppStore((state) => state.setLogPanelOpen);
  const [scope, setScope] = useState<'current' | 'all'>(() => Object.values(tasks).some((task) => !task.workspaceId || task.workspaceId === currentWorkspaceId) ? 'current' : 'all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [position, setPosition] = useState({ right: 8, bottom: 28 });
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  const panelId = useId();
  const available = sortedTasks(Object.values(tasks).filter((task) => !task.detailsDismissed), currentWorkspaceId);
  const current = available.filter((task) => !task.workspaceId || task.workspaceId === currentWorkspaceId);
  const displayed = scope === 'current' ? current : available;

  useEffect(() => {
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      setPosition({ right: rect ? Math.max(8, window.innerWidth - rect.right) : 8, bottom: rect ? Math.max(28, window.innerHeight - rect.top + 5) : 28 });
    };
    update(); window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchorRef]);
  useEffect(() => {
    const panel = panelRef.current, anchor = anchorRef.current;
    panel?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!scrollbarContains(panel, event.target as Node) && !scrollbarContains(anchor, event.target as Node)) closeRef.current(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[aria-modal="true"], [role="menu"]')) { event.preventDefault(); closeRef.current(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key);
      if (panel?.contains(document.activeElement) || document.activeElement === document.body) {
        if (anchor?.isConnected) anchor.focus({ preventScroll: true });
        else document.querySelector<HTMLElement>('.statusbar-right button')?.focus({ preventScroll: true });
      }
    };
  }, [anchorRef]);

  const row = (task: ProgressTask) => <article key={task.id} tabIndex={0} className={`task-progress-row ${task.status}`}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget || !['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
      event.preventDefault();
      const rows = [...panelRef.current!.querySelectorAll<HTMLElement>('.task-progress-row')], index = rows.indexOf(event.currentTarget);
      if (['Enter', 'ArrowRight', 'ArrowLeft'].includes(event.key)) { if (task.children.length) setExpanded((value) => { const next = new Set(value); if (event.key === 'ArrowLeft' || event.key === 'Enter' && next.has(task.id)) next.delete(task.id); else next.add(task.id); return next; }); }
      else { const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))); rows[next]?.focus(); }
    }}>
    <div className="task-progress-row-heading">
      <Codicon name={task.status === 'failed' || task.status === 'timedOut' ? 'error' : task.status === 'partial' ? 'warning' : task.status === 'succeeded' ? 'check' : task.status === 'cancelled' ? 'circle-slash' : 'loading codicon-modifier-spin'} />
      <strong title={t(task.title)}>{t(task.title)}</strong>
      <span className="task-progress-status">{t(taskStatusKey(task.status))}</span>
      {task.cancellable && isTaskActive(task) && <IconButton title={t('Cancel task')} disabled={task.status === 'cancelling'} onClick={() => void cancel(task.id)}><Codicon name="close" /></IconButton>}
    </div>
    <div className="task-progress-owner" title={[task.workspaceName, task.repoName].filter(Boolean).join(' · ')}>{[task.workspaceName, task.repoName].filter(Boolean).join(' · ')}</div>
    <div className="task-progress-message">{t(task.message || taskStatusKey(task.status))}</div>
    {task.status === 'cancelling' && <p className="task-progress-cancel-note">{t('Waiting for the operation and local recovery to finish.')}</p>}
    <div className="task-progress-row-meter"><TaskProgressBar completed={task.completed} total={task.total} active={isTaskActive(task)} />
      {task.total !== null && task.total > 0 && <span>{Math.min(task.total, task.completed ?? 0)}/{task.total}</span>}
    </div>
    {task.children.length > 0 && <button type="button" className="task-progress-expand" aria-expanded={expanded.has(task.id)} aria-controls={`${panelId}-${task.id}`} onClick={() => setExpanded((value) => { const next = new Set(value); if (!next.delete(task.id)) next.add(task.id); return next; })}>
      <Codicon name={expanded.has(task.id) ? 'chevron-down' : 'chevron-right'} />{t('Repositories')}<span>{task.children.length}</span>
    </button>}
    {expanded.has(task.id) && <ul className="task-progress-children" id={`${panelId}-${task.id}`}>{task.children.map((child) => <li key={child.repoId}>
      <div><span title={child.repoName}>{child.repoName}</span><span>{t(taskStatusKey(child.status))}</span></div>
      <p>{t(child.message)}</p>{child.error && <pre className="selectable-text">{t(child.error)}</pre>}
    </li>)}</ul>}
    {task.error && <pre className="task-progress-error selectable-text">{t(task.error)}</pre>}
    {task.cancelError && <p role="alert" className="task-progress-error">{t(task.cancelError)}</p>}
    {['failed', 'partial', 'timedOut'].includes(task.status) && <button type="button" className="task-progress-log" onClick={() => { onClose(); openLog(true); }}>{t('View Log')}</button>}
  </article>;

  return createPortal(<div ref={panelRef} className="task-progress-popover" role="dialog" tabIndex={-1} aria-label={t('Task progress')}
    style={{ right: position.right, bottom: position.bottom, maxHeight: `calc(100vh - ${position.bottom + 8}px)` }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), article[tabindex]')].filter((element) => element.tabIndex >= 0);
      const first = items[0], last = items.at(-1); if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
    }}>
    <header><strong>{t('Task progress')}</strong><IconButton title={t('Close')} onClick={onClose}><Codicon name="chevron-down" /></IconButton></header>
    <nav role="tablist" aria-label={t('Task progress')} onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')], index = tabs.indexOf(event.target as HTMLButtonElement); if (index < 0) return;
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      setScope(next === 0 ? 'current' : 'all'); tabs[next].focus();
    }}>
      {(['current', 'all'] as const).map((value) => <button type="button" key={value} role="tab" id={`${panelId}-${value}`} aria-selected={scope === value} aria-controls={panelId} tabIndex={scope === value ? 0 : -1} onClick={() => setScope(value)}>
        {t(value === 'current' ? 'Current Project' : 'All Projects')}<span>{(value === 'current' ? current : available).filter(isTaskActive).length}</span>
      </button>)}
    </nav>
    <div className="task-progress-list" role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${scope}`}>
      {displayed.length ? displayed.map(row) : <div className="task-progress-empty"><Codicon name="check-all" />{t('No tasks in progress')}</div>}
    </div>
  </div>, document.body);
}
