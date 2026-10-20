import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Checkpoint, RecordingMode, RepositoryMeta, TaskIsolation, TaskWorkspace, WorkspaceDescriptor } from '../bindings/generated';
import { useAppStore, workspacePathsEqual } from '../store/appStore';
import { useI18n } from '../i18n';
import { checkpointWorkspaceChanged, refreshCheckpoints, runCheckpointAction, cancelCheckpointAction, selectCheckpointTask, useCheckpointStore } from '../checkpoints/store';
import { DialogSurface } from './DialogSurface';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';
import { Input } from './Input';
import { useCheckpointHistory } from './useCheckpointHistory';
import { CheckpointStorage } from './CheckpointStorage';
import { taskConnection, compactConnectionLabel, connectionLabel as hookConnectionLabel } from '../checkpoints/connection';
import { FormField } from './FormField';
import { Select } from './Select';
import { Checkbox } from './Checkbox';
import { ErrorNotice } from './ErrorNotice';
import { EmptyState } from './EmptyState';
import { LoadingState } from './LoadingState';
import { confirmDialog, promptDialog } from './dialogService';
import { formatHistoryDate } from '../history/dates';
import { CheckpointChangesView } from './CheckpointChangesView';
import { CheckpointPrompt } from './CheckpointPrompt';
import { CheckpointHistoryToolbar } from './CheckpointHistoryToolbar';
import { useCheckpointUndo } from './useCheckpointUndo';
import { ContextMenu } from './ContextMenu';
import './CheckpointPanel.css';

const unfinished = (point: Checkpoint) => ['recording', 'incomplete', 'interrupted'].includes(point.status);
const pending = (task: TaskWorkspace) => task.checkpoints.some(unfinished);
const emptyPoint = (point: Checkpoint) => Boolean(point.after && point.summary?.files === 0 && ['completed', 'undone', 'applied', 'abandoned'].includes(point.status) && !point.error);
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function repositoryDisplayPath(path: string, roots: string[]) {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = normalize(path);
  const root = roots.map(normalize).sort((a, b) => b.length - a.length).find(root => normalized === root || normalized.startsWith(`${root}/`));
  return root === undefined ? path : normalized.slice(root.length + 1) || '.';
}

function CopyTaskPathButton({ path, disabled }: { path: string; disabled: boolean }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied'>('idle');
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);
  const copy = async () => {
    clearTimeout(timer.current);
    setStatus('copying');
    const errorMessage = t('Copy failed; select and copy the task path.');
    try {
      await navigator.clipboard.writeText(path);
      if (!mounted.current) return;
      setStatus('copied');
      useCheckpointStore.setState(state => state.error === errorMessage ? { error: null } : state);
      timer.current = setTimeout(() => setStatus('idle'), 2000);
    } catch {
      if (!mounted.current) return;
      setStatus('idle');
      useCheckpointStore.setState({ error: errorMessage });
    }
  };
  return <IconButton title={t(status === 'copied' ? 'Copied' : 'Copy Codex project path')} style={status === 'copied' ? { color: 'var(--versiondock-success)' } : undefined} disabled={disabled || status === 'copying'} onClick={() => void copy()}>
    <Codicon name={status === 'copied' ? 'check' : status === 'copying' ? 'loading codicon-modifier-spin' : 'copy'} />
  </IconButton>;
}

export function CheckpointPanel({ onClose, project, projectRepositories, navigation, projectSelection, projectLoading = false, projectTasks, onTaskCreated, onCreatingChange, managementContent, managementBusy = false, onOpenGlobalSettings }: { onClose: () => void; project?: WorkspaceDescriptor; projectRepositories?: { meta: RepositoryMeta }[]; navigation?: (newTask: () => void, blocked: boolean, showTask: () => void) => ReactNode; projectSelection?: ReactNode; projectLoading?: boolean; projectTasks?: TaskWorkspace[]; onTaskCreated?: () => void; onCreatingChange?: (creating: boolean) => void; managementContent?: ReactNode; managementBusy?: boolean; onOpenGlobalSettings?: () => void }) {
  const { t, language } = useI18n();
  const currentWorkspace = useAppStore(state => state.snapshot?.workspace);
  const workspace = project ?? currentWorkspace;
  const independent = Boolean(project);
  const repositorySnapshot = useAppStore(state => state.snapshot?.repositories);
  const repositories = projectRepositories ?? repositorySnapshot ?? [];
  const bridge = useAppStore(state => state.bridge);
  const openWorkspace = useAppStore(state => state.openWorkspace);
  const state = useCheckpointStore();
  const [creating, setCreatingValue] = useState(false);
  const setCreating = (value: boolean) => { setCreatingValue(value); onCreatingChange?.(value); };
  const [settingsTask, setSettingsTask] = useState<string | null>(null);
  const [connectionTask, setConnectionTask] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [isolation, setIsolation] = useState<TaskIsolation>('original');
  const [mode, setMode] = useState<RecordingMode>('manual');
  const [selected, setSelected] = useState<string[]>([]);
  const [ignoredFiles, setIgnoredFiles] = useState('');
  const [recordingName, setRecordingName] = useState('');
  const [keepRecent, setKeepRecent] = useState('10');
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyRepository, setHistoryRepository] = useState('');
  const [historyOffset, setHistoryOffset] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [reviewSelection, setReviewSelection] = useState<{ taskId: string; point: Checkpoint; following?: number }>();

  const [menu, setMenu] = useState<{ workspaceId: string; taskId: string; pointId: string; anchor: DOMRect } | null>(null);
  const [directoryMenu, setDirectoryMenu] = useState<{ workspaceId: string; taskId: string; anchor: DOMRect } | null>(null);
  const closeMenu = useCallback(() => { setMenu(null); setDirectoryMenu(null); }, []);
  const task = state.listing?.tasks.find(task => task.id === state.selectedTaskId);
  const filterScope = `${workspace?.id}:${task?.id}`;
  const [historyScope, setHistoryScope] = useState(filterScope);
  if (historyScope !== filterScope) {
    setHistoryScope(filterScope); setHistoryQuery(''); setHistoryRepository(''); setHistoryOffset(0); setReviewSelection(undefined);
  }
  const repositoryScope = JSON.stringify([workspace?.id, repositories.map(repo => repo.meta.id)]);
  const [selectedRepositoryScope, setSelectedRepositoryScope] = useState(repositoryScope);
  if (selectedRepositoryScope !== repositoryScope) {
    setSelectedRepositoryScope(repositoryScope);
    setSelected(repositories.filter(repo => repo.meta.kind === 'git' && !repo.meta.isSubmodule).map(repo => repo.meta.id));
    setIgnoredFiles('');
  }
  const eligibleRepositories = repositories.filter(repo => repo.meta.kind === 'git' && !repo.meta.isSubmodule);
  const selectedRepositories = eligibleRepositories.filter(repo => selected.includes(repo.meta.id));
  const originalTasks = isolation === 'original' ? (state.workspaceId === workspace?.id && state.listing ? state.listing.tasks : projectTasks)?.filter(item => item.isolation === 'original' && (item.workspaceId === workspace?.id || item.repositories.some(repo => selectedRepositories.some(selected => selected.meta.rootPath === repo.taskPath)))) ?? [] : [];
  const nameError = nameTouched && !name.trim() ? t('Task name cannot be empty or whitespace') : undefined;
  const active = task ? pending(task) : false;
  const recovery = state.listing?.recovery.filter(report => ['failed', 'pending'].includes(report.status)) ?? [];
  const blocked = state.busy || managementBusy || recovery.length > 0;
  const inlinePreview = state.preview && !state.preview.bringBack ? state.preview : null;
  const displayedPreview = inlinePreview ? null : state.preview;
  const changes = displayedPreview?.files ?? state.details;
  const undo = useCheckpointUndo(workspace?.id, task?.id, independent);
  const showSettings = settingsTask === (task?.id ?? 'global');
  const showConnection = connectionTask === (task?.id ?? 'global');
  const reviewing = Boolean(task && changes && !creating && !showSettings && !showConnection && !managementContent);
  const reviewPoint = task?.checkpoints.find(point => point.id === state.detailsCheckpointId) ?? (reviewSelection && task && reviewSelection.taskId === task.id ? reviewSelection.point : undefined);
  const redoCheckpoints = task ? state.listing?.redoCheckpoints?.[task.id] ?? [] : [];
  const canRedoReview = Boolean(reviewPoint?.status === 'undone' && task && state.listing?.redoTasks?.includes(task.id) && redoCheckpoints.includes(reviewPoint.id));
  const followingTurns = reviewSelection?.point.id === reviewPoint?.id && reviewSelection?.following !== undefined ? reviewSelection.following : task && reviewPoint ? task.checkpoints.slice(task.checkpoints.indexOf(reviewPoint) + 1).filter(point => point.status === 'completed').length : 0;
  const connection = taskConnection(task, state.listing?.connections);
  const hookConnected = connection.status === 'verified';
  const connectionStatus = hookConnected ? 'connected' : ['error', 'invalid'].includes(connection.status) ? 'error' : connection.status;
  const connectionLabel = t(hookConnectionLabel(connection.status));
  const connectionDetail = connection.error ? t(connection.error) : t(hookConnected ? 'A matching hook round was recorded successfully.' : hookConnectionLabel(connection.status));
  const history = useCheckpointHistory(task, state.listing, historyQuery, historyRepository, onlyChanges, historyOffset, !creating && !showSettings && !showConnection && !reviewing && !managementContent, workspace?.id);
  if (history.page && history.page.offset !== historyOffset) setHistoryOffset(history.page.offset);
  const historyPoints = history.page?.points ?? task?.checkpoints ?? [];
  const visiblePoints = history.page ? historyPoints : [...historyPoints].reverse().filter(point => !onlyChanges || !emptyPoint(point));
  const historyGroups = new Map<string, Checkpoint[]>();
  for (const point of visiblePoints) {
    const day = Number.isNaN(new Date(point.createdAt).getTime()) ? '' : formatHistoryDate(point.createdAt).split(' ')[0];
    if (!historyGroups.has(day)) historyGroups.set(day, []);
    historyGroups.get(day)!.push(point);
  }
  const menuPoint = menu && !blocked && !reviewing && !creating && !showSettings && menu?.workspaceId === workspace?.id && menu?.taskId === task?.id ? visiblePoints.find(point => point.id === menu.pointId) : undefined;
  useEffect(() => useCheckpointStore.subscribe((next, previous) => {
    if (next.workspaceId !== previous.workspaceId || next.selectedTaskId !== previous.selectedTaskId || next.busy || next.preview || next.details) closeMenu();
  }), [closeMenu]);
  const directoryMenuOpen = Boolean(directoryMenu && task && !showConnection && !showSettings && !creating && !managementContent && !blocked && directoryMenu.workspaceId === workspace?.id && directoryMenu.taskId === task.id);
  const taskOpenHere = Boolean(task && currentWorkspace && workspacePathsEqual(currentWorkspace.paths, task.roots));
  const activePoint = task?.checkpoints.find(point => ['recording', 'interrupted', 'incomplete'].includes(point.status));
  const activePointId = activePoint?.id;
  useEffect(() => { if (!activePointId) return; const first = window.setTimeout(() => setNow(Date.now()), 0); const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => { window.clearTimeout(first); window.clearInterval(timer); }; }, [activePointId]);
  const pointName = (point: Checkpoint) => point.promptHash ? (['Image attachment', 'File attachment', 'Reply annotation', 'Selected text', 'User message'].includes(point.name) ? t(point.name) : point.name) : ['Codex turn', 'Checkpoint'].includes(point.name) && point.summary?.paths.length ? point.summary.paths.map(path => path.split(/[\\/]/).pop()).join(' · ') : t(point.name);
  const recordingDescription = (value: RecordingMode) => t(value === 'manual' ? 'Click Start recording before editing, then Finish recording when done to save all changes in between.' : 'Codex Hooks record changes at the start and end of each turn. Complete connection verification before use.');
  const clearReview = () => { closeMenu(); useCheckpointStore.setState({ preview: null, details: null, detailsCheckpointId: null }); };
  const viewChanges = (point: Checkpoint) => {
    if (!task || blocked || !point.after) return;
    setReviewSelection({ taskId: task.id, point, following: history.page?.followingTurns?.[point.id] });
    closeMenu(); void runCheckpointAction({ type: 'detail', task_id: task.id, checkpoint_id: point.id });
  };
  const undoCheckpoint = (point: Checkpoint) => {
    if (!task || blocked || active) return;
    void undo.undo(point, history.page?.followingTurns?.[point.id] ?? task.checkpoints.slice(task.checkpoints.findIndex(item => item.id === point.id) + 1).filter(item => item.status === 'completed').length);
  };
  const newTask = () => {
    clearReview(); setSettingsTask(null); setConnectionTask(null); setCreating(true); setNameTouched(false);
    setSelected(repositories.filter(repo => repo.meta.kind === 'git' && !repo.meta.isSubmodule).map(repo => repo.meta.id));
  };
  const openSettings = () => { clearReview(); setCreating(false); setConnectionTask(null); setSettingsTask(task?.id ?? 'global'); };
  const openConnection = () => { clearReview(); setCreating(false); setSettingsTask(null); setConnectionTask(task?.id ?? 'global'); };
  const showTask = () => { clearReview(); setCreating(false); setSettingsTask(null); setConnectionTask(null); setExpandedPrompt(null); setRecordingName(''); };

  useEffect(() => {
    checkpointWorkspaceChanged(workspace?.id ?? null, independent);
    void refreshCheckpoints();
  }, [workspace?.id, independent]);

  const create = async () => {
    if (!name.trim() || !selectedRepositories.length || originalTasks.length || blocked || projectLoading || !workspace) return;
    const result = await runCheckpointAction<TaskWorkspace>({ type: 'create', name, repo_ids: selectedRepositories.map(repo => repo.meta.id), mode, isolation, include_ignored: isolation === 'worktree' ? ignoredFiles.split(';').map(path => path.trim()).filter(Boolean) : [] });
    if (result && useCheckpointStore.getState().workspaceId === workspace?.id) { selectCheckpointTask(result.id); setCreating(false); setName(''); setIgnoredFiles(''); onTaskCreated?.(); }
  };
  const remove = async () => {
    if (!task) return;
    if (await confirmDialog({ title: t('Remove checkpoint task'), message: t('Remove this task and its checkpoint history? Original directories and task branches are kept. Isolated worktrees are removed only after results have been brought back.') })) await runCheckpointAction({ type: 'remove', task_id: task.id });
  };
  const finish = async () => {
    if (task && await confirmDialog({ title: t('Finish recording'), message: t('Confirm that Codex and other programs have stopped writing to these repositories before capturing the final state.') })) await runCheckpointAction({ type: 'finish', task_id: task.id });
  };
  const abandon = async () => {
    if (task && await confirmDialog({ title: t('Abandon recording'), message: t('Stop tracking this interval without changing code. This incomplete interval will not be undoable.') })) await runCheckpointAction({ type: 'abandon', task_id: task.id });
  };
  const renameTask = async () => {
    if (!task || blocked) return;
    const name = await promptDialog({ title: t('Rename task'), message: t('Enter a new name for this task.'), inputLabel: t('Task name'), initialValue: task.name, validateInput: value => !value.trim() || [...value.trim()].length > 100 || /\p{Cc}/u.test(value.trim()) ? t('Enter a single-line task name of 1 to 100 characters') : undefined });
    if (name !== null && name.trim() !== task.name && (project ? useCheckpointStore.getState().workspaceId : useAppStore.getState().snapshot?.workspace.id) === workspace?.id && useCheckpointStore.getState().selectedTaskId === task.id) await runCheckpointAction({ type: 'renameTask', task_id: task.id, name });
  };
  const rename = async (point: Checkpoint) => {
    if (!task) return;
    const name = await promptDialog({ title: t('Rename checkpoint'), message: t('Give this checkpoint a name that describes its changes.'), inputLabel: t('Checkpoint name'), initialValue: !point.promptHash && (point.name === 'Codex turn' || point.name === 'Checkpoint') ? '' : point.name, validateInput: value => !value.trim() || [...value.trim()].length > 100 || /[\r\n\t]/.test(value) ? t('Enter a single-line checkpoint name of 1 to 100 characters') : undefined });
    if (name !== null && (project ? useCheckpointStore.getState().workspaceId : useAppStore.getState().snapshot?.workspace.id) === workspace?.id && useCheckpointStore.getState().selectedTaskId === task.id) await runCheckpointAction({ type: 'rename', task_id: task.id, checkpoint_id: point.id, name });
  };
  const cleanup = async () => {
    const preview = state.cleanupPreview;
    if (!task || !preview || preview.taskId !== task.id) return;
    const confirmed = await confirmDialog({ title: t('Clean checkpoint history'), danger: true, confirmLabel: t('Clean history'), message: t('Delete {0} checkpoint records and obsolete operation backups? Deleted history cannot be restored. The task, project files and protected snapshots are kept.', preview.removeCount) });
    if (confirmed && useCheckpointStore.getState().cleanupPreview?.fingerprint === preview.fingerprint && (project ? useCheckpointStore.getState().workspaceId : useAppStore.getState().snapshot?.workspace.id) === workspace?.id) {
      await runCheckpointAction({ type: 'cleanup', task_id: preview.taskId, keep_recent: preview.keepRecent, fingerprint: preview.fingerprint });
    }
  };
  const previewApplyLabel = state.preview && !state.preview.redoOf && !state.preview.bringBack ? 'Confirm undo' : 'Apply restore preview';
  const execute = async () => {
    const preview = state.preview;
    if (preview && await confirmDialog({ title: t(preview.redoOf ? 'Redo last undo' : previewApplyLabel), message: t('Stop external writes to the target directories. Apply this preview to all listed repositories? A recovery record will be saved first.') }) && useCheckpointStore.getState().preview?.id === preview.id && useCheckpointStore.getState().workspaceId === workspace?.id && (project ? useCheckpointStore.getState().workspaceId : useAppStore.getState().snapshot?.workspace.id) === workspace?.id) {
      await runCheckpointAction({ type: 'execute', preview_id: preview.id });
      void useAppStore.getState().refresh(true);
    }
  };
  return <DialogSurface size="large" onClose={onClose} closeDisabled={managementBusy} className={`checkpoint-panel${navigation ? ' checkpoint-center' : ''}`} aria-label={t('Tasks and checkpoints')}>
    <header className="file-history-header checkpoint-header">
      <Codicon name="checkpoint" className="checkpoint-heading-icon" /><strong>{t('Tasks and checkpoints')}</strong>
      <span className="file-history-path checkpoint-workspace-name" title={managementContent ? undefined : workspace?.name}>{!managementContent && workspace?.name}</span>
      {!managementContent && <IconButton title={t('Refresh')} disabled={state.busy} onClick={() => void refreshCheckpoints()}><Codicon name="refresh" /></IconButton>}
      <IconButton aria-label={t('Close')} disabled={managementBusy} onClick={onClose}><Codicon name="close" /></IconButton>
    </header>
    <div className={`checkpoint-layout${reviewing ? ' checkpoint-layout-review' : ''}`}>
      {!reviewing && (navigation ? navigation(newTask, blocked, showTask) : <aside className="settings-sidebar checkpoint-sidebar">
        <div className="checkpoint-sidebar-heading"><strong>{t('Tasks')}</strong><span>{state.listing?.tasks.length ?? 0}</span><IconButton title={t('New checkpoint task')} disabled={blocked} onClick={newTask}><Codicon name="add" /></IconButton></div>
        <nav className="settings-nav checkpoint-tasks" aria-label={t('Checkpoint tasks')}>
          {state.listing?.tasks.map(item => <button type="button" className="vd-selectable settings-nav-item checkpoint-task-button" aria-label={item.name} aria-describedby={`checkpoint-task-meta-${item.id}`} aria-pressed={!creating && item.id === task?.id} disabled={state.busy} key={item.id} onClick={() => { closeMenu(); selectCheckpointTask(item.id); setCreating(false); setSettingsTask(null); setConnectionTask(null); }}>
            <span className="settings-nav-icon-badge"><Codicon name={item.isolation === 'original' ? 'folder' : 'git-branch'} /></span>
            <span className="checkpoint-task-nav-label"><span className="settings-nav-text" title={item.name}>{item.name}</span><small id={`checkpoint-task-meta-${item.id}`} title={`${t(item.isolation === 'original' ? 'Original directories' : 'Isolated worktrees')} · ${t(item.mode === 'automatic' ? 'Automatic recording' : 'Manual recording')}`}>{t(item.isolation === 'original' ? item.mode === 'automatic' ? 'Original · Automatic' : 'Original · Manual' : item.mode === 'automatic' ? 'Isolated · Automatic' : 'Isolated · Manual')}</small></span>
            {pending(item) && <span className="checkpoint-activity-dot" aria-label={t('Recording in progress')} />}
          </button>)}
          {state.listing && !state.listing.tasks.length && <p className="checkpoint-sidebar-empty">{t('Your tasks appear here')}</p>}
        </nav>
        <Button variant="ghost" className="checkpoint-connection-link" aria-label={t('Codex connection')} aria-describedby={state.listing ? 'checkpoint-connection-status' : undefined} title={state.listing ? `${task ? `${task.name} · ` : ''}${connectionDetail}` : undefined} aria-pressed={showConnection} onClick={openConnection}><Codicon name="plug" /><span className="checkpoint-connection-label">{t('Codex connection')}</span>{state.listing && <span className="checkpoint-connection-status" id="checkpoint-connection-status" data-status={connectionStatus}>{t(compactConnectionLabel(connection.status))}</span>}<Codicon name="chevron-right" /></Button>
      </aside>)}
      <main className="checkpoint-main">
        {!managementContent && (state.error || state.listingError || recovery.length > 0) && <div className="checkpoint-notices">
          {(state.error || state.listingError) && <ErrorNotice onRetry={() => void refreshCheckpoints()}>{t((state.error || state.listingError)!)}</ErrorNotice>}
          {recovery.map(report => <ErrorNotice key={report.id} actions={<Button disabled={state.busy} onClick={() => void runCheckpointAction({ type: 'recover', transaction_id: report.id })}>{t('Recover previous state')}</Button>}><strong>{t('Restore needs recovery')}</strong><p>{report.completed}/{report.total} {report.error && t(report.error)}</p></ErrorNotice>)}
        </div>}
        {managementContent ? managementContent : creating ? <>
          <div className="checkpoint-page-heading"><h3>{t('New checkpoint task')}</h3><p>{t('Choose where to work and which repositories to protect.')}</p></div>
          <div className="checkpoint-scroll"><section className="checkpoint-create">
            {projectSelection}
            <FormField label={t('Task name')} required error={nameError} description={!name.trim() && !nameError ? t('Enter a task name to enable creation.') : undefined}><Input autoFocus value={name} placeholder={t('e.g. Fix login validation')} onChange={e => setName(e.target.value)} onBlur={() => setNameTouched(true)} /></FormField>
            <div className="checkpoint-form-columns">
              <FormField label={t('Working directory mode')} description={t(isolation === 'original' ? 'Keep developing in the existing Codex project. Only one chat may record these directories at a time.' : 'Create a separate worktree for every selected repository. Add the task directory to Codex as a local project.')}><Select value={isolation} onChange={v => setIsolation(v as TaskIsolation)} options={[{ value: 'original', label: t('Original directories (default)') }, { value: 'worktree', label: t('Isolated task worktrees') }]} /></FormField>
              <FormField label={t('Recording mode')} description={recordingDescription(mode)}><Select value={mode} onChange={v => setMode(v as RecordingMode)} options={[{ value: 'manual', label: t('Manual recording') }, { value: 'automatic', label: t('Automatic recording') }]} /></FormField>
            </div>
            {originalTasks.length > 0 && <div className="checkpoint-create-overlap" role="status">
              <Codicon name="info" /><div><p>{t('An original-directory task already protects these repositories; use that task or create an isolated task')}</p><div className="checkpoint-create-overlap-actions">{originalTasks.map(item => <Button key={item.id} size="xs" disabled={blocked} onClick={() => { selectCheckpointTask(item.id); setCreating(false); }}>{t('Use task: {0}', item.name)}</Button>)}<Button size="xs" disabled={blocked} onClick={() => setIsolation('worktree')}>{t('Switch to isolated mode')}</Button></div></div>
            </div>}
            {projectLoading && <LoadingState>{t('Loading project repositories…')}</LoadingState>}
            <fieldset className="checkpoint-repositories" aria-label={t('Protected Git repositories')}>
              <div className="checkpoint-repository-heading"><strong>{t('Protected Git repositories')}</strong><span>{t('Selected {0} / {1}', selectedRepositories.length, eligibleRepositories.length)}</span><div className="checkpoint-repository-batch"><Button variant="link" size="xs" disabled={blocked || !eligibleRepositories.length || selectedRepositories.length === eligibleRepositories.length} onClick={() => setSelected(eligibleRepositories.map(repo => repo.meta.id))}>{t('Select all repositories')}</Button><Button variant="link" size="xs" disabled={blocked || !selectedRepositories.length} onClick={() => setSelected([])}>{t('Deselect all repositories')}</Button></div></div>
              {repositories.map(repo => <label className="checkpoint-repository" key={repo.meta.id}><Checkbox disabled={blocked || repo.meta.kind !== 'git' || repo.meta.isSubmodule} checked={selected.includes(repo.meta.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, repo.meta.id] : ids.filter(id => id !== repo.meta.id))} /><Codicon name="repo" /><span><strong>{repo.meta.name}</strong><small title={repo.meta.rootPath}>{repositoryDisplayPath(repo.meta.rootPath, workspace?.paths ?? [])}</small></span>{(repo.meta.kind !== 'git' || repo.meta.isSubmodule) && <small>{t('Not supported')}</small>}</label>)}
            </fieldset>
            {!selectedRepositories.length && <p className="checkpoint-form-hint" role="status">{t('Select at least one Git repository')}</p>}
            <p className="checkpoint-form-hint">{t('Only files inside selected Git repositories are protected. Ignored files are excluded. Submodules and nested repositories are not supported.')}</p>
            {isolation === 'worktree' && <FormField label={t('Local configuration path')} description={t('Optional absolute file paths separated by semicolons. These setup files are copied but ignored files are not protected by checkpoints.')}><Input value={ignoredFiles} onChange={e => setIgnoredFiles(e.target.value)} /></FormField>}
          </section></div>
        </> : !workspace ? <div className="checkpoint-empty"><EmptyState icon="checkpoint" description={t('Choose a project or folder to create a checkpoint task.')}><strong>{t('No checkpoint tasks yet')}</strong></EmptyState><Button variant="primary" disabled={blocked} onClick={newTask}><Codicon name="add" />{t('New checkpoint task')}</Button></div> : !state.listing ? <div className="checkpoint-empty">{!state.error && !state.listingError && <LoadingState>{t('Loading checkpoints…')}</LoadingState>}</div> : showConnection ? <>
          <div className="checkpoint-page-heading checkpoint-settings-heading"><IconButton title={t('Back to checkpoints')} onClick={() => setConnectionTask(null)}><Codicon name="arrow-left" /></IconButton><h3>{t('Connection details')}</h3>{task && <span className="checkpoint-settings-task-name">· {task.name}</span>}</div>
          <div className="checkpoint-scroll checkpoint-settings">
            <section className="checkpoint-settings-section">
              <div className="checkpoint-settings-section-heading"><h4><Codicon name="plug" />{t('Codex connection')}</h4><span className="checkpoint-connection-status" data-status={connectionStatus} title={connectionDetail}>{connectionLabel}</span></div>
              {connection.verifiedAt && <p className="checkpoint-settings-note">{t('Last successful verification: {0}', new Date(connection.verifiedAt).toLocaleString(language))}</p>}
              {task?.lastHookAt && <p className="checkpoint-settings-note">{t('Last event: {0}', new Date(task.lastHookAt).toLocaleString(language))}</p>}
              {connection.error && <ErrorNotice>{t(connection.error)}</ErrorNotice>}
              {!!task?.hookEvents.length && <details className="checkpoint-scope" key={`diagnostics:${workspace?.id}:${task?.id}`}><summary>{t('Connection diagnostics')}</summary><code className="checkpoint-full-path">{task.hookEvents.join(', ')}</code></details>}
            </section>
            {onOpenGlobalSettings && <Button size="xs" onClick={onOpenGlobalSettings}>{t('Checkpoint settings')}</Button>}
          </div>
        </> : showSettings ? <>
          <div className="checkpoint-page-heading checkpoint-settings-heading"><IconButton title={t('Back to checkpoints')} onClick={() => { closeMenu(); setSettingsTask(null); }}><Codicon name="arrow-left" /></IconButton><h3>{t('Task settings')}</h3>{task && <><span className="checkpoint-settings-task-name" title={task.name}>· {task.name}</span></>}</div>
          <div className="checkpoint-scroll checkpoint-settings">
            {task && <section className="checkpoint-settings-section">
              <div className="checkpoint-settings-section-heading"><h4>{t('Working directory')}</h4><span className="checkpoint-settings-directory-mode">{t(task.isolation === 'original' ? 'Original directories' : 'Isolated worktrees')}</span></div><code className="selectable-text checkpoint-full-path">{task.path}</code>

              <div className="checkpoint-settings-row"><FormField label={t('Recording mode')} description={recordingDescription(task.mode)}><Select disabled={blocked || active} value={task.mode} onChange={v => void runCheckpointAction({ type: 'setMode', task_id: task.id, mode: v as RecordingMode })} options={[{ value: 'manual', label: t('Manual recording') }, { value: 'automatic', label: t('Automatic recording') }]} /></FormField></div>
              <details className="checkpoint-scope"><summary>{t('Protected Git repositories')} · {task.repositories.length}</summary>{task.repositories.map(repo => <p key={repo.taskPath} className="checkpoint-full-path selectable-text"><Codicon name="repo" /><code>{repo.taskPath}</code></p>)}</details>
            </section>}
            {task && <section className="checkpoint-settings-section">
              <h4>{t('Checkpoint storage')}</h4>
              <CheckpointStorage workspaceId={workspace?.id} taskId={task.id} revision={state.cleanupReport} />
              <p className="checkpoint-settings-note">{t('Clean old history while keeping this task. Shared snapshots, active recordings, recovery backups and results not yet brought back are protected.')}</p>
              <div className="checkpoint-settings-row"><FormField label={t('History to keep')}><Select disabled={blocked || active} value={keepRecent} onChange={value => { setKeepRecent(value); useCheckpointStore.setState({ cleanupPreview: null, cleanupReport: null }); }} options={[10, 30, 100, 0].map(count => ({ value: String(count), label: t(count ? 'Keep latest {0} records' : 'Clean all eligible history', count) }))} /></FormField></div>
              <Button disabled={blocked || active} onClick={() => void runCheckpointAction({ type: 'previewCleanup', task_id: task.id, keep_recent: Number(keepRecent) })}>{t('Preview cleanup')}</Button>
              {active && <p className="checkpoint-settings-note">{t('Finish the active recording before cleaning checkpoints')}</p>}
              {state.cleanupPreview?.taskId === task.id && <div className="checkpoint-cleanup-preview" role="status">
                {!state.cleanupPreview.removeCount && !state.cleanupPreview.reclaimableBytes ? <p className="checkpoint-settings-note">{t('No eligible history to clean')}</p> : <>
                  <div className="checkpoint-cleanup-summary"><p>{t('{0} records to remove · {1} protected · Estimated space to free: {2} MiB', state.cleanupPreview.removeCount, state.cleanupPreview.protectedCount, ((state.cleanupPreview.reclaimableBytes ?? 0) / 1048576).toFixed(2))}</p><Button danger disabled={blocked || active} onClick={() => void cleanup()}>{t('Clean history')}</Button></div>
                  <p className="checkpoint-settings-note">{t('Task baselines and shared recovery data may keep storage in use. Outstanding restore previews for this task will expire.')}</p>
                </>}
              </div>}
              {state.cleanupReport && <p role="status" className="checkpoint-settings-note">{t('Removed {0} records · Freed {1} MiB', state.cleanupReport.removedCount, ((state.cleanupReport.freedBytes ?? 0) / 1048576).toFixed(2))}</p>}
              {state.cleanupReport?.error && <ErrorNotice>{t('History was cleaned, but some unused files could not be removed. Preview cleanup again to retry.')}{' '}{t(state.cleanupReport.error)}</ErrorNotice>}
            </section>}
            {task && <section className="checkpoint-settings-section checkpoint-danger-zone"><div><h4>{t('Remove checkpoint task')}</h4><p className="checkpoint-settings-note">{t('Remove this task and its checkpoint history. Original project files are kept.')}</p></div><Button danger disabled={blocked || active} onClick={() => void remove()}>{t('Remove')}</Button></section>}
          </div>
        </> : task ? <>
          {!changes && <header className="checkpoint-task-overview">
            <div className="checkpoint-task-heading">
              <div className="checkpoint-task-title"><h3>{task.name}</h3><IconButton title={t('Rename task')} disabled={blocked} onClick={() => void renameTask()}><Codicon name="edit" /></IconButton></div>
              <div className="checkpoint-task-actions">
                {state.listing?.redoTasks?.includes(task.id) && <Button size="xs" aria-label={t('Redo last undo')} disabled={blocked || Boolean(undo.phase) || active} loading={Boolean(undo.kind === 'redo' && undo.phase !== 'confirming')} onClick={() => void undo.redo()}><Codicon name="redo" />{t('Redo last undo')}</Button>}
                <Button size="xs" aria-label={t('Undo latest turn')} disabled={blocked || Boolean(undo.phase) || active || !task.checkpoints.some(point => point.status === 'completed')} loading={Boolean(undo.kind === 'undo' && undo.phase !== 'confirming')} onClick={() => { const point = task.checkpoints.filter(point => point.status === 'completed').at(-1); if (point) undoCheckpoint(point); }}><Codicon name="discard" />{t('Undo latest turn')}</Button>
                {task.isolation === 'worktree' && <Button size="xs" aria-label={t('Preview bring back')} disabled={blocked || active} onClick={() => void runCheckpointAction({ type: 'preview', task_id: task.id, checkpoint_id: null, bring_back: true })}><Codicon name="arrow-swap" />{t('Bring back')}</Button>}
                <IconButton title={t('Task settings')} onClick={openSettings}><Codicon name="settings-gear" /></IconButton>
              </div>
            </div>
            <div className="checkpoint-task-meta">
              <div className="checkpoint-task-summary">
                <span>{t(task.isolation === 'original' ? 'Original directories' : 'Isolated worktrees')}</span>
                <span className="checkpoint-meta-separator" aria-hidden="true">·</span>
                <span>{t('{0} repositories', task.repositories.length)}</span>
                <span className="checkpoint-meta-separator" aria-hidden="true">·</span>
                <span>{t(task.mode === 'automatic' ? 'Automatic recording' : 'Manual recording')}</span>
                {task.mode === 'automatic' && <><span className="checkpoint-meta-separator" aria-hidden="true">·</span><Button className="checkpoint-hook-indicator" variant="link" size="xs" title={t(hookConnected ? 'A matching hook round was recorded successfully.' : 'Connection details')} onClick={openConnection} data-connected={hookConnected}><span className="checkpoint-status-dot" />{t(hookConnectionLabel(connection.status))}</Button></>}
              </div>
              <div className="checkpoint-task-path-actions">
                <span className="checkpoint-task-location" title={task.path}><Codicon name="folder-opened" /><span className="selectable-text">{task.path}</span></span>
                <CopyTaskPathButton key={JSON.stringify([workspace?.id, task.id, task.path])} path={task.path} disabled={blocked} />
                <IconButton title={t('Open task')} disabled={blocked} aria-haspopup="menu" aria-expanded={directoryMenuOpen} onClick={event => setDirectoryMenu(directoryMenuOpen ? null : { workspaceId: workspace?.id ?? task.workspaceId, taskId: task.id, anchor: event.currentTarget.getBoundingClientRect() })}><Codicon name="link-external" /></IconButton>
              </div>
            </div>
            {task.mode === 'automatic' && task.hookError && <ErrorNotice actions={<Button variant="link" size="xs" onClick={openConnection}>{t('Connection details')}</Button>}>{t(task.hookError)}</ErrorNotice>}
          </header>}
          {task.error && <div className="checkpoint-notices"><ErrorNotice>{t(task.error)}</ErrorNotice></div>}
          {!changes && inlinePreview && (inlinePreview.conflicts.length > 0 || !inlinePreview.files.length) && <div className="checkpoint-notices" role="status">
            {inlinePreview.conflicts.map(conflict => <ErrorNotice key={conflict}>{conflict}</ErrorNotice>)}
            {!inlinePreview.conflicts.length && !inlinePreview.files.length && <p className="checkpoint-form-hint">{t('No changes to apply')}</p>}
          </div>}
          {changes ? <>
            <header className="checkpoint-review-header" aria-label={t(displayedPreview ? displayedPreview.redoOf ? 'Redo preview' : displayedPreview.bringBack ? 'Bring-back preview' : 'Undo preview' : 'View changes')}>
              <IconButton className="checkpoint-review-back" title={t('Back to checkpoints')} disabled={state.busy} onClick={clearReview}><Codicon name="arrow-left" /></IconButton>
              <div className="checkpoint-review-info">
                <h3 title={reviewPoint ? pointName(reviewPoint) : task.name}>{reviewPoint ? pointName(reviewPoint) : task.name}</h3>
                <div className="checkpoint-review-meta">
                  {reviewPoint && <span className="checkpoint-review-task" title={task.name}>{task.name}</span>}
                  {displayedPreview && <span>{t(displayedPreview.redoOf ? 'Redo preview' : displayedPreview.bringBack ? 'Bring-back preview' : 'Undo preview')}</span>}
                  {reviewPoint && <><time dateTime={reviewPoint.createdAt} title={new Date(reviewPoint.createdAt).toLocaleString(language)}>{formatHistoryDate(reviewPoint.createdAt)}</time><code title={reviewPoint.id}>#{reviewPoint.id.slice(0, 8)}</code><CheckpointStatus status={reviewPoint.status} /></>}
                  <span>{t('{0} changes', changes.length)}</span>
                </div>
              </div>
              <div className="checkpoint-review-actions">
                {reviewPoint?.promptHash && <IconButton title={t(expandedPrompt === reviewPoint.id ? 'Hide message' : 'View message')} aria-expanded={expandedPrompt === reviewPoint.id} onClick={() => setExpandedPrompt(expandedPrompt === reviewPoint.id ? null : reviewPoint.id)}><Codicon name="comment" /></IconButton>}
              </div>
              {reviewPoint?.promptHash && expandedPrompt === reviewPoint.id && <div className="checkpoint-review-extra"><CheckpointPrompt workspaceId={workspace?.id} key={`${workspace?.id}:${task.id}:${reviewPoint.id}`} taskId={task.id} checkpointId={reviewPoint.id} revision={state.listing?.historyRevisions?.[task.id]} /></div>}
              {reviewPoint?.status === 'completed' && followingTurns > 0 && <p className="checkpoint-form-hint checkpoint-review-extra">{t('Undoing this checkpoint also undoes {0} later completed turns.', followingTurns)}</p>}
            </header>
            <div className="checkpoint-review">
              {state.preview && !inlinePreview && <><p className="checkpoint-form-hint">{t(state.preview.redoOf ? 'Reapply the changes from the most recent undo. Later non-overlapping edits are kept.' : state.preview.bringBack ? 'Review changes before bringing them back to the original directories.' : 'Returning to an earlier turn also undoes all following completed turns.')}</p>{state.preview.conflicts.map(conflict => <ErrorNotice key={conflict}>{conflict}</ErrorNotice>)}</>}
              {inlinePreview && (inlinePreview.conflicts.length > 0 || !inlinePreview.files.length) && <div className="checkpoint-undo-check" role="status">
                {inlinePreview.conflicts.map(conflict => <ErrorNotice key={conflict}>{conflict}</ErrorNotice>)}
                {!inlinePreview.conflicts.length && !inlinePreview.files.length && <p className="checkpoint-form-hint">{t('No changes to apply')}</p>}
              </div>}
              {!changes.length ? <EmptyState compact icon="check">{t('No changes to apply')}</EmptyState> : (displayedPreview || state.detailsCheckpointId) && <CheckpointChangesView workspaceId={workspace?.id} key={displayedPreview?.id ?? state.detailsCheckpointId!} files={changes} source={displayedPreview ? { type: 'preview', preview_id: displayedPreview.id } : { type: 'checkpoint', task_id: task.id, checkpoint_id: state.detailsCheckpointId! }} />}
            </div>
          </> : <>
            {(active || task.mode === 'manual') && <div className="checkpoint-record-actions">
              {!active && task.mode === 'manual' && <><Input aria-label={t('Checkpoint name')} placeholder={t('Checkpoint name (optional)')} value={recordingName} onChange={e => setRecordingName(e.target.value)} /><Button variant="primary" disabled={blocked || Boolean(task.error)} onClick={() => void runCheckpointAction({ type: 'begin', task_id: task.id, name: recordingName })}><Codicon name="record" />{t('Start recording')}</Button></>}
              {active && <><Button variant="primary" disabled={blocked} onClick={() => void finish()}><Codicon name="debug-stop" />{t('Finish recording')}</Button><Button variant="ghost" disabled={blocked} onClick={() => void abandon()}>{t('Abandon recording')}</Button></>}
            </div>}
            {activePoint && <div className="checkpoint-recording-notice" data-status={activePoint.status}><Codicon name={activePoint.status === 'recording' ? 'record' : 'info'} /><span>{t(activePoint.status === 'recording' ? 'Changes are being recorded across the protected repositories.' : activePoint.status === 'interrupted' && task.mode === 'automatic' ? 'The next message in this chat will finish this recording and start a new one. Stop background writes before sending.' : activePoint.status === 'incomplete' ? 'This recording is incomplete. Stop file writes, then finish or abandon it manually before continuing.' : 'Recording paused. Finish after all file writes have stopped.')}</span></div>}
            {activePoint && <div className="checkpoint-unfinished-details">
              <strong>{pointName(activePoint)}</strong><span>{t('Started: {0}', formatHistoryDate(activePoint.createdAt))}</span>
              <span>{t('Unfinished for {0} minutes', Math.max(0, Math.floor((now - Date.parse(activePoint.createdAt)) / 60000)) || 0)}</span>
              {task.lastHookAt && <span>{t('Last event: {0}', formatHistoryDate(task.lastHookAt))}</span>}
              {now - Date.parse(activePoint.createdAt) >= 600000 && <p>{t('This interval is still open. Verify that all writes have stopped before finishing; elapsed time does not prove Codex has stopped.')}</p>}
              <Button variant="link" size="xs" onClick={openConnection}>{t('Connection details')}</Button>
            </div>}
            <CheckpointHistoryToolbar key={filterScope} count={history.page ? `${history.page.matching}/${history.page.total}` : onlyChanges ? `${visiblePoints.length}/${history.total}` : String(history.total)}
              query={historyQuery} onQueryChange={value => { closeMenu(); setHistoryQuery(value); setHistoryOffset(0); }}
              repository={historyRepository} repositories={task.repositories.map(repo => ({ value: repo.taskPath, label: repositoryDisplayPath(repo.taskPath, task.roots) }))}
              onRepositoryChange={value => { closeMenu(); setHistoryRepository(value); setHistoryOffset(0); }}
              onlyChanges={onlyChanges} onOnlyChangesChange={value => { closeMenu(); setOnlyChanges(value); setHistoryOffset(0); }} disabled={blocked} />
            <div className="checkpoint-scroll checkpoint-history">
              {history.loading ? <LoadingState>{t('Loading checkpoints…')}</LoadingState> : history.error ? <ErrorNotice onRetry={history.retry}>{t(history.error)}</ErrorNotice> : !history.total ? <EmptyState icon="git-commit" description={t(task.mode === 'automatic' ? 'Completed Codex turns will appear here.' : 'Start recording before making changes.')}><strong>{t('No checkpoints yet')}</strong></EmptyState> : !visiblePoints.length ? <EmptyState icon="filter" description={t('Records without file changes are hidden.')} actions={<Button onClick={() => setOnlyChanges(false)}>{t('Show all records')}</Button>}><strong>{t('No checkpoints with changes')}</strong></EmptyState> : <ol className="checkpoint-day-list vd-row-scope">
                {[...historyGroups].map(([day, points]) => <li key={day} className="checkpoint-day">
                  <h5 className="checkpoint-day-heading">{day ? <time dateTime={day.replaceAll('/', '-')}>{day}</time> : t('Date unavailable')}</h5>
                  <ol className="checkpoint-list">
                    {points.map(point => <li key={point.id} className="vd-row checkpoint-entry" data-status={point.status} data-empty={emptyPoint(point) || undefined} data-row-context={menuPoint?.id === point.id}>
                      <button type="button" className="checkpoint-entry-open" aria-label={t('View changes')} aria-busy={state.loadingDetailsId === point.id} aria-describedby={`checkpoint-title-${point.id} checkpoint-meta-${point.id}`} title={pointName(point)} disabled={blocked || !point.after} onClick={() => viewChanges(point)}>
                        <Codicon name={state.loadingDetailsId === point.id ? 'loading codicon-modifier-spin' : point.error ? 'error' : point.status === 'recording' ? 'record' : point.status === 'interrupted' || point.status === 'incomplete' ? 'debug-pause' : point.status === 'undone' || point.status === 'abandoned' ? 'history' : 'git-commit'} />
                        <span className="checkpoint-entry-label">
                          <strong className="checkpoint-entry-title" id={`checkpoint-title-${point.id}`} title={point.summary?.paths.join('\n')}>{pointName(point)}</strong>
                          <span className="checkpoint-entry-meta" id={`checkpoint-meta-${point.id}`}>
                            <time dateTime={point.createdAt} title={formatHistoryDate(point.createdAt)}>{day ? formatHistoryDate(point.createdAt).split(' ')[1] : '—'}</time>
                            <CheckpointStatus status={point.status} />
                            {point.summary && <span>{t(point.summary.files ? '{0} changed files' : 'No file changes', point.summary.files)}</span>}
                            <code title={point.id}>#{point.id.slice(0, 8)}</code>
                            {!!point.summary?.paths.length && pointName(point) !== point.summary.paths.map(fileName).join(' · ') && <span className="checkpoint-entry-files" title={point.summary.paths.join('\n')}>{point.summary.paths.map(fileName).join(' · ')}</span>}
                          </span>
                        </span>
                      </button>
                      <div className="checkpoint-entry-actions">
                        {point.promptHash && <IconButton title={t(expandedPrompt === point.id ? 'Hide message' : 'View message')} aria-expanded={expandedPrompt === point.id} onClick={() => setExpandedPrompt(expandedPrompt === point.id ? null : point.id)}><Codicon name="comment" /></IconButton>}
                        {point.status === 'completed' && <IconButton aria-label={t('Undo to before this turn')} title={t('Undo to before this turn')} disabled={blocked || Boolean(undo.phase) || active} onClick={() => undoCheckpoint(point)}><Codicon name="discard" /></IconButton>}
                        {point.status === 'applied' && <IconButton title={t('Undo bring back')} disabled={blocked || active} onClick={() => { void confirmDialog({ title: t('Undo bring back'), message: t('Restore the source files changed by this bring-back operation? Later overlapping edits will block recovery.') }).then(confirmed => { if (confirmed && (project ? useCheckpointStore.getState().workspaceId : useAppStore.getState().snapshot?.workspace.id) === workspace?.id && useCheckpointStore.getState().selectedTaskId === task.id) void runCheckpointAction({ type: 'recover', transaction_id: point.id }); }); }}><Codicon name="discard" /></IconButton>}
                        <IconButton title={t('More actions')} aria-describedby={`checkpoint-title-${point.id}`} aria-haspopup="menu" aria-expanded={menuPoint?.id === point.id} disabled={blocked} onClick={event => setMenu(menuPoint?.id === point.id ? null : { workspaceId: task.workspaceId, taskId: task.id, pointId: point.id, anchor: event.currentTarget.getBoundingClientRect() })}><Codicon name="ellipsis" /></IconButton>
                      </div>
                      {point.promptHash && expandedPrompt === point.id && <CheckpointPrompt workspaceId={workspace?.id} key={`${workspace?.id}:${task.id}:${point.id}`} taskId={task.id} checkpointId={point.id} revision={state.listing?.historyRevisions?.[task.id]} />}
                      {point.error && <div className="checkpoint-entry-error"><ErrorNotice>{t(point.error)}</ErrorNotice></div>}
                    </li>)}
                  </ol>
                </li>)}
              </ol>}
            </div>
            {history.page && history.page.matching > 50 && <div className="checkpoint-history-pagination">
              <Button size="xs" disabled={blocked || history.loading || history.page.offset === 0} onClick={() => setHistoryOffset(Math.max(0, history.page!.offset - 50))}>{t('Previous page')}</Button>
              <span>{t('Page {0} of {1}', Math.floor(history.page.offset / 50) + 1, Math.ceil(history.page.matching / 50))}</span>
              <Button size="xs" disabled={blocked || history.loading || history.page.offset + 50 >= history.page.matching} onClick={() => setHistoryOffset(history.page!.offset + 50)}>{t('Next page')}</Button>
            </div>}
          </>}
        </> : <div className="checkpoint-empty"><EmptyState icon="checkpoint" description={t('Use your existing directories, or isolate a task for parallel work.')}><strong>{t('No checkpoint tasks yet')}</strong></EmptyState><Button variant="primary" disabled={blocked} onClick={newTask}><Codicon name="add" />{t('Create your first task')}</Button></div>}
      </main>
    </div>
    {menuPoint && menu && <ContextMenu x={menu.anchor.right} y={menu.anchor.bottom} anchorRect={menu.anchor} items={[{ id: 'rename', label: t('Rename checkpoint'), icon: 'edit' }]} onSelect={id => { if (id === 'rename') void rename(menuPoint); }} onClose={closeMenu} />}
    {directoryMenuOpen && directoryMenu && task && <ContextMenu x={directoryMenu.anchor.right} y={directoryMenu.anchor.bottom} anchorRect={directoryMenu.anchor} items={[
      { id: 'codex', label: t('Open in Codex'), icon: 'codex', disabled: bridge?.platform() !== 'macos', disabledReason: t('Opening task directories in Codex is currently supported on macOS.') },
      { separator: true },
      { id: 'currentWindow', label: t('Open in current window'), icon: 'window', disabled: taskOpenHere, disabledReason: t('Already open in this window') },
      { id: 'newWindow', label: t('Open in new window'), icon: 'link-external' },
    ]} onSelect={id => {
      if (id === 'codex') void runCheckpointAction({ type: 'openInCodex', task_id: task.id });
      else if (id === 'newWindow' && bridge) void bridge.openInNewWindow(task.roots).catch(error => {
        if (useCheckpointStore.getState().workspaceId === workspace?.id && useCheckpointStore.getState().selectedTaskId === task.id) useCheckpointStore.setState({ error: error instanceof Error ? error.message : String(error) });
      });
      else if (id === 'currentWindow' && !taskOpenHere) void openWorkspace(task.roots);
    }} onClose={closeMenu} />}
    <footer className="checkpoint-footer">
      {reviewing && canRedoReview && <span className="checkpoint-form-hint checkpoint-footer-note">{t('Reapplies all {0} turns from the last undo.', redoCheckpoints.length)}</span>}
      {reviewing && state.preview && !inlinePreview && <span className="checkpoint-form-hint checkpoint-footer-note">{t(state.preview.conflicts.length ? 'Resolve conflicts before applying.' : 'Your current state is backed up before applying.')}</span>}
      {state.busy && !undo.phase && <LoadingState>{t(state.loadingDetailsId ? 'Loading changed files…' : 'Working…')}</LoadingState>}
      <div className="checkpoint-footer-actions">
        {state.busy && <Button size="xs" onClick={cancelCheckpointAction}>{t('Cancel operation')}</Button>}
        {!managementContent && creating ? <><Button disabled={state.busy} onClick={() => setCreating(false)}>{t('Cancel')}</Button><Button variant="primary" disabled={blocked || projectLoading || !workspace || !name.trim() || !selectedRepositories.length || Boolean(originalTasks.length)} onClick={() => void create()}>{t('Create task')}</Button></> : !reviewing && <Button disabled={managementBusy} onClick={onClose}>{t('Close')}</Button>}
        {reviewing && (!state.preview || inlinePreview) && reviewPoint && task && <Button variant="primary" danger loading={Boolean(undo.phase && undo.phase !== 'confirming')} disabled={blocked || Boolean(undo.phase) || active || Boolean(task.error) || (!canRedoReview && !['completed', 'applied'].includes(reviewPoint.status))} onClick={() => {
          if (canRedoReview) {
            void undo.redo();
          } else if (reviewPoint.status === 'applied') {
            void confirmDialog({ title: t('Undo bring back'), message: t('Restore the source files changed by this bring-back operation? Later overlapping edits will block recovery.') }).then(confirmed => {
              if (confirmed && (project ? useCheckpointStore.getState().workspaceId : useAppStore.getState().snapshot?.workspace.id) === workspace?.id && useCheckpointStore.getState().selectedTaskId === task.id) void runCheckpointAction({ type: 'recover', transaction_id: reviewPoint.id });
            });
          } else { void undo.undo(reviewPoint, followingTurns); }
        }}><Codicon name={canRedoReview ? 'redo' : 'discard'} />{t(undo.phase === 'checking' ? 'Checking…' : undo.phase === 'executing' ? 'Working…' : canRedoReview ? 'Redo last undo' : reviewPoint.status === 'applied' ? 'Undo bring back' : 'Undo to before this turn')}</Button>}
        {reviewing && state.preview && !inlinePreview && <Button variant="primary" disabled={blocked || Boolean(state.preview.conflicts.length) || !state.preview.files.length} onClick={() => void execute()}><Codicon name={state.preview.redoOf ? 'redo' : 'discard'} />{t(previewApplyLabel)}</Button>}
      </div>
    </footer>
  </DialogSurface>;
}

function CheckpointStatus({ status }: { status: string }) {
  const { t } = useI18n();
  const label = t(`Checkpoint status: ${status}`);
  return <span className="checkpoint-status" data-status={status} title={label}>{label}</span>;
}

